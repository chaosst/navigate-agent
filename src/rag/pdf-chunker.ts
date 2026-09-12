/**
 * pdf-chunker.ts — PDF 抽取（碰 fs，薄）+ 去噪 / 换行重建 / 页感知切块（纯函数）
 *
 * 设计要点：
 *   - 页是**原子单位**：页边界是作者意图，也是用户能验证的引用坐标（"第 12 页那段"）。
 *   - `getTable()` **不作为切块输入**（它不提供表格在文本流中的插入位置，硬插会重复/错位）；
 *     表格由 `cellSeparator` 默认的 `\t` 在文本流里天然标记，`reflowLines` 只需保护含 `\t` 的行。
 *   - PDF 是"语义已被排版吃过一遍"的格式，启发式收益递减极快：**宁可不做，不要做错。**
 */
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { readFileSync } from "node:fs";
import { PLAIN_SEPARATORS } from "./plain-chunker.js";
import type { ChunkMetadata, LoadedChunk } from "./types.js";

export interface PdfPage {
  /** 物理页号（1-based） */
  num: number;
  text: string;
  /** 正文标注页码（如 "iii" / "A-1"），无则 undefined */
  label?: string;
}

/** 阈值集中定义，便于调参 + 单测 */
export const PDF_DEFAULTS = {
  headerFooterPageRatio: 0.5, // 一行在 >= 50% 的不同页里重复 → 页眉/页脚
  headerFooterMaxLineLen: 60, // 长行不可能是页眉
  headerFooterMinPages: 3, // 页数太少，统计没有意义
  minFillRatio: 0.5, // 累积 chunk 不足 chunkSize 的 50% → 尝试回并
  mergeOverflowFactor: 1.5, // 回并后允许的最大溢出倍数（软上限）
} as const;

/**
 * ★ 全局开关：PDF 视觉换行重建（reflow）。
 *
 * 默认 **false**。理由（实测，见计划 2.6）：reflow 的收益是实的（切点落在标点后的比例
 * 35% → 71%），但它的失效代价是**列错位**——表格行被粘成"一行 101 个格子"，
 * LLM 会把「状态01 进行中02」读成同一行，导致**自信地答错**（比检索落空更糟）。
 * 白名单护栏能挡住已知形态，但真实 PDF 的排版花样多，先只吃「页感知 + 去噪」的确定性收益，
 * 观察一轮再打开。打开前请确认 `reflowLines` 的单测与护栏都覆盖到位。
 */
export const PDF_REFLOW_ENABLED = false;

/**
 * 抽取 PDF 页级文本。**本模块唯一碰 fs 的函数**。
 *
 * ★ P0：v2 的 data 必须给在**构造函数**里。
 *   ✅ new PDFParse({ data: new Uint8Array(readFileSync(filePath)) }) → getText({})
 *   ❌ new PDFParse({}) → load(buf)   // 旧写法，抛 "getDocument - no `url` parameter provided"
 * 旧代码还把 getText() 的返回值断言成了 string，实际是 TextResult 对象（{ pages, text, total }）。
 *
 * `pageLabel` 是尽力而为：`getInfo({ parsePageInfo: true })` → `pages[].pageLabel`，
 * 无标注的文档该字段为 undefined（实测最小 PDF 就是如此）→ 必须容错，不能让它拖垮抽取。
 */
export async function extractPdfPages(filePath: string): Promise<PdfPage[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) });
  try {
    const result = await parser.getText({});
    const labels = await readPageLabels(parser);
    return result.pages.map((p) => {
      const label = labels[p.num];
      return label ? { num: p.num, text: p.text, label } : { num: p.num, text: p.text };
    });
  } finally {
    // 释放 pdfjs worker，别漏
    await parser.destroy();
  }
}

/**
 * 尽力收集正文标注页码。任何失败都吞掉并返回空表——
 * 引用展示是锦上添花，不该让整条抽取路径失败。
 */
async function readPageLabels(parser: { getInfo: (o: object) => Promise<unknown> }): Promise<Record<number, string>> {
  try {
    const info = (await parser.getInfo({ parsePageInfo: true })) as {
      pages?: { pageNumber: number; pageLabel?: string | null }[];
    };
    const map: Record<number, string> = {};
    for (const p of info.pages ?? []) {
      if (typeof p.pageLabel === "string" && p.pageLabel.length > 0) {
        map[p.pageNumber] = p.pageLabel;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * reflow 白名单：短于此长度的行视为标题 / 图注 / 单元格，**不参与合并**。
 * 短行是"这里不是连续散文"的信号，宁可少合并也不要粘错。
 */
export const REFLOW_MIN_LINE_LEN = 15;

/** 句末标点：上行以此收尾 → 段落边界 */
const SENTENCE_END_RE = /[.。！？!?：:；;”’"'）)\]】]$/;
/** 条目符号开头：下行以此开头 → 新条目，不合并 */
const ITEM_START_RE = /^([-*•·○●‣▪–—]\s|\d+[.)、]\s|[（(]\d+[）)])/;
/** CJK / 全角字符：决定行间是否插空格 */
const CJK_RE = /[\u2e80-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** 该行是"原子行"（表格行 / 位置敏感的排版行），前后都不得合并 */
function isAtomicLine(line: string): boolean {
  return line.includes("\t") || /^\s*\|.*\|\s*$/.test(line);
}

/** 软连字符断词：上行以「字母 + -」结尾，下行以小写字母开头 */
function isSoftHyphenJoin(prev: string, next: string): boolean {
  return /[A-Za-z]-$/.test(prev.trimEnd()) && /^[a-z]/.test(next);
}

/**
 * 白名单合并判定：**只接纳确定是连续散文的行**。
 *
 * 拿不准就不合并 —— 护栏失效时退化到"不 reflow"，而不是"错误 reflow"。
 */
function canMerge(prev: string, next: string): boolean {
  if (isSoftHyphenJoin(prev, next)) return true; // 断词是强证据，不受短行规则约束
  if (SENTENCE_END_RE.test(prev.trimEnd())) return false;
  if (ITEM_START_RE.test(next)) return false;
  if (prev.trim().length < REFLOW_MIN_LINE_LEN) return false;
  if (next.trim().length < REFLOW_MIN_LINE_LEN) return false;
  return true;
}

/** 合并两行：软连字符去连字符直拼；含 CJK 一侧不插空格；纯英文插一个空格 */
function joinLines(prev: string, next: string): string {
  const p = prev.replace(/\s+$/, "");
  const n = next.replace(/^\s+/, "");
  if (isSoftHyphenJoin(p, n)) return p.slice(0, -1) + n;
  const sep = CJK_RE.test(p.slice(-1)) || CJK_RE.test(n.slice(0, 1)) ? "" : " ";
  return p + sep + n;
}

/**
 * 跨页高频行判定 + 剔除（页眉 / 页脚 / 页码）。纯函数。
 *
 *   1) pages.length < minPages → 原样返回（样本不足，宁可不删）
 *   2) 每行归一化 key = trim + 连续数字折叠为 '#'（"第 12 页 / 共 20 页" ≡ "第 5 页 / 共 5 页"）
 *   3) 统计 key 出现在多少个**不同页** → ratio
 *   4) 判噪声（任一命中）：
 *      a) ratio >= pageRatio 且 行长 <= maxLineLen
 *      b) 纯页码行且位于该页首行 / 末行
 *   5) 按 key 集合从所有页剔除
 *
 * ⚠️ 已知误删风险：每页都带一个"当前章节名"条（重复但其实是真实内容）会被一并删掉；
 *    页末恰好是一个孤立数字的表格也可能被 rule b 误伤。阈值刻意保守（0.5 / 60 字 / ≥3 页），
 *    不要把 ratio 往下调。
 */
export function stripRepeatedLines(
  pages: PdfPage[],
  opts?: { pageRatio?: number; maxLineLen?: number; minPages?: number },
): PdfPage[] {
  const pageRatio = opts?.pageRatio ?? PDF_DEFAULTS.headerFooterPageRatio;
  const maxLineLen = opts?.maxLineLen ?? PDF_DEFAULTS.headerFooterMaxLineLen;
  const minPages = opts?.minPages ?? PDF_DEFAULTS.headerFooterMinPages;
  if (pages.length < minPages) return pages;

  const keyOf = (line: string): string => line.trim().replace(/\d+/g, "#");

  // 统计每个 key 出现在哪些页（按页去重）+ 其最长原始行长
  const stat = new Map<string, { pages: Set<number>; maxLen: number }>();
  pages.forEach((p, idx) => {
    for (const raw of p.text.split("\n")) {
      const t = raw.trim();
      if (!t) continue;
      const key = keyOf(t);
      let s = stat.get(key);
      if (!s) {
        s = { pages: new Set<number>(), maxLen: 0 };
        stat.set(key, s);
      }
      s.pages.add(idx);
      s.maxLen = Math.max(s.maxLen, t.length);
    }
  });

  const noise = new Set<string>();
  for (const [key, s] of stat) {
    if (s.pages.size / pages.length >= pageRatio && s.maxLen <= maxLineLen) noise.add(key);
  }

  const isBarePageNumber = (s: string): boolean => /^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(s);

  return pages.map((p) => {
    const lines = p.text.split("\n");
    let first = -1;
    let last = -1;
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      if (first < 0) first = i;
      last = i;
    });

    const kept = lines.filter((raw, i) => {
      const t = raw.trim();
      if (!t) return true; // 空行保留（段落边界）
      if (noise.has(keyOf(t))) return false;
      if (isBarePageNumber(t) && (i === first || i === last)) return false;
      return true;
    });
    return { ...p, text: kept.join("\n") };
  });
}

/**
 * PDF 视觉换行重建（纯函数）。PDF 文本是排版结果而非语义段落，每一视觉行都以 \n 结尾。
 *   - 软连字符：`docu-\nment` → `document`
 *   - 段内换行：上行末 CJK 或下行首 CJK → 直接拼接（**不插空格**）；否则拼一个空格
 *   - 段落边界：空行；或上行以句末标点收尾；或下行以条目符号开头
 *   - ★ 含 \t 的行（cellSeparator 产出的表格行）与 `| a | b |` 形状的行**原样保留、不参与合并**
 *   - 白名单优先：只接纳确定是连续散文的行，拿不准就不合并
 */
export function reflowLines(text: string): string {
  const out: string[] = [];
  let buf = "";

  const flush = (): void => {
    if (buf !== "") {
      out.push(buf);
      buf = "";
    }
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      flush();
      out.push(""); // 空行 = 段落边界，保留
      continue;
    }
    if (isAtomicLine(line)) {
      flush();
      out.push(line); // 表格行原样成块，前后都不合并
      continue;
    }
    if (buf === "") {
      buf = line;
      continue;
    }
    if (canMerge(buf, line)) {
      buf = joinLines(buf, line);
    } else {
      flush();
      buf = line;
    }
  }
  flush();

  return out.join("\n");
}

/**
 * 页感知切块（纯函数）。**页是原子单位**——页边界是作者意图，也是用户能验证的引用坐标。
 *
 *   贪心累积每页：
 *     单页 > chunkSize      → 先 flush 当前累积；该页单独用 splitter 页内切，
 *                             每片 metadata.pageStart = pageEnd = p.num
 *     累积为空              → cur = [p]
 *     累积 + p <= chunkSize → cur.push(p)
 *     否则                  → flush(cur); cur = [p]
 *   flush(cur)：正文以 "\n\n" 连接；
 *     若长度 < chunkSize * minFillRatio 且存在上一 chunk 且合并后不超过软上限
 *       → 回并进上一 chunk，并更新其 pageEnd
 *     否则独立输出，metadata { pageStart: cur[0].num, pageEnd: cur.at(-1).num }
 *
 * overlap 取舍：**页与页之间不额外制造 overlap**（页边界即语义边界，跨页重复只会放大
 * embedding 成本与重复命中）；只有页内切分沿用 chunkOverlap。
 *
 * 空文本页（扫描版 PDF 抽不到文本）直接过滤 → 全部为空时返回 [] 而非抛错，
 * 保持上传接口"返回 200"的既有行为。
 */
export async function chunkPdfPages(
  pages: PdfPage[],
  opts: { chunkSize: number; chunkOverlap: number; filename: string; source?: string; reflow?: boolean },
): Promise<LoadedChunk[]> {
  const { chunkSize, chunkOverlap, filename } = opts;
  const source = opts.source ?? filename;
  const useReflow = opts.reflow ?? PDF_REFLOW_ENABLED;

  const usable = pages
    .filter((p) => p.text.trim().length > 0)
    .map((p) => (useReflow ? { ...p, text: reflowLines(p.text) } : p));
  if (usable.length === 0) return [];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: PLAIN_SEPARATORS,
  });

  const buildMeta = (start: number, end: number, label?: string): ChunkMetadata => ({
    filename,
    source,
    strategy: "pdf-page",
    pageStart: start,
    pageEnd: end,
    ...(label ? { pageLabel: label } : {}),
  });

  const chunks: LoadedChunk[] = [];
  let cur: PdfPage[] = [];
  let curLen = 0;

  const flush = (): void => {
    if (cur.length === 0) return;
    const body = cur.map((p) => p.text).join("\n\n");
    const start = cur[0].num;
    const end = cur[cur.length - 1].num;
    const label = cur[0].label;
    cur = [];
    curLen = 0;

    const prev = chunks[chunks.length - 1];
    if (
      prev &&
      body.length < chunkSize * PDF_DEFAULTS.minFillRatio &&
      prev.content.length + body.length + 2 <= chunkSize * PDF_DEFAULTS.mergeOverflowFactor
    ) {
      prev.content = `${prev.content}\n\n${body}`;
      prev.metadata.pageEnd = end;
      return;
    }
    chunks.push({ content: body, metadata: buildMeta(start, end, label) });
  };

  for (const p of usable) {
    // 超长页：先结算累积，再页内切分
    if (p.text.length > chunkSize) {
      flush();
      const parts = await splitter.splitText(p.text);
      for (const part of parts) {
        chunks.push({ content: part, metadata: buildMeta(p.num, p.num, p.label) });
      }
      continue;
    }

    if (cur.length === 0) {
      cur.push(p);
      curLen = p.text.length;
      continue;
    }
    // 预算只算正文长度（页间 "\n\n" 是连接符，不计入 chunkSize）
    if (curLen + p.text.length <= chunkSize) {
      cur.push(p);
      curLen += p.text.length;
      continue;
    }
    flush();
    cur = [p];
    curLen = p.text.length;
  }
  flush();

  return chunks;
}
