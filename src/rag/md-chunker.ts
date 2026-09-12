/**
 * md-chunker.ts — markdown 标题感知切块（`.md` / `.docx` / wiki 同步 三处共用）
 *
 * **关键认知：`.md` 和 `.docx` 在切块阶段是同一个问题。** 两者只差一个「怎么拿到 markdown」
 * （`.md` 直接读、`.docx` 由 mammoth 转换），之后的 `splitByHeadings` → `chunkMdSections`
 * 完全一致。所以只需要**一个**结构化切块器，而不是给每个格式写一套。
 *
 * 相对字符切块的收益：
 *   ① 标题不作切点 → 标题与它的正文总在同一 chunk 内，不会成孤儿；
 *   ② 代码块保护 —— ``` 围栏不在 `RecursiveCharacterTextSplitter` 的分隔符表里，
 *      大代码块必被拦腰切断；只认标题行后，代码块整体落在同一节内；
 *   ③ 表格不裂 —— 表格行之间是单 `\n`（可分点），按标题切分后表格与所属节共进退。
 */
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { chunkPlainText, PLAIN_SEPARATORS } from "./plain-chunker.js";
import type { LoadedChunk } from "./types.js";

export interface MdSection {
  /** 标题面包屑（含自身）；前言块为 [] */
  headingPath: string[];
  /** 该节正文（不含标题行本身） */
  body: string;
}

/** 标题行：`#`..`######` + 至少一个空白 + 标题文本 */
const HEADING_RE = /^#{1,6}\s+(.+)$/;
/** 代码围栏开关（``` 或 ```lang） */
const isFenceLine = (line: string): boolean => line.trimStart().startsWith("```");

/**
 * markdown → 按标题切分节（纯函数，与来源无关）。
 *
 *   - 命中 HEADING_RE → 更新标题栈（level 及更深层清空），开新节
 *   - 其余行 → 追加进当前节 body
 *   - 首个标题之前的行 → 一个 headingPath 为 [] 的"前言"节
 *   - body.trim() 为空的节丢弃（避免"有标题没内容"的空 chunk）
 *   - ★ 代码围栏内的行一律进 body，不参与标题识别（否则代码里的 `# 注释` 会变成标题）
 */
export function splitByHeadings(md: string): MdSection[] {
  const sections: MdSection[] = [];
  const stack: (string | undefined)[] = [];
  let body: string[] = [];
  let inFence = false;

  const closeSection = (): void => {
    const text = body.join("\n").trim();
    body = [];
    if (text.length === 0) return; // 只有标题没正文 → 丢弃
    sections.push({ headingPath: stack.filter((s): s is string => !!s), body: text });
  };

  for (const line of md.split("\n")) {
    if (isFenceLine(line)) {
      inFence = !inFence;
      body.push(line);
      continue;
    }

    const m = inFence ? null : line.match(HEADING_RE);
    if (m) {
      closeSection();
      const level = line.match(/^#+/)![0].length;
      stack.length = level - 1; // 清空 level 及更深层（层级跳跃时留下空洞，由 filter 兜掉）
      stack[level - 1] = m[1].trim();
      continue;
    }
    body.push(line);
  }
  closeSection();

  return sections;
}

/**
 * 把正文切成"原子块"：**代码围栏整体是一块**，普通散文连续行是一块。
 *
 * 这是"0 个 chunk 出现落单 ``` 围栏"的保证来源：只要代码块不被拆开，
 * 成对围栏就永远落在同一个 chunk 里。
 */
function toAtomicBlocks(body: string): { text: string; isCode: boolean }[] {
  const blocks: { text: string; isCode: boolean }[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flushBuf = (isCode: boolean): void => {
    if (buf.length > 0) {
      blocks.push({ text: buf.join("\n"), isCode });
      buf = [];
    }
  };

  for (const line of body.split("\n")) {
    if (isFenceLine(line)) {
      if (inFence) {
        buf.push(line);
        flushBuf(true); // 闭合围栏 → 代码块结束
        inFence = false;
      } else {
        flushBuf(false); // 开始围栏 → 结算前面的散文块
        inFence = true;
        buf.push(line);
      }
      continue;
    }
    buf.push(line);
  }
  flushBuf(inFence); // 未闭合围栏按代码块整体保留（宁可超长，不要拆开）

  return blocks;
}

/** 超长节内切：先按原子块贪心装箱，块本身超长时才动用字符切块器 */
async function splitBodyFenceAware(
  body: string,
  chunkSize: number,
  splitter: RecursiveCharacterTextSplitter,
): Promise<string[]> {
  const pieces: string[] = [];
  let pending = "";

  const flushPending = (): void => {
    if (pending.trim()) pieces.push(pending.trim());
    pending = "";
  };

  for (const block of toAtomicBlocks(body)) {
    // 单块就超预算：先结算，再单独处理
    if (block.text.length > chunkSize) {
      flushPending();
      if (block.isCode) {
        pieces.push(block.text.trim()); // 代码块不拆，宁可超长
      } else {
        for (const p of await splitter.splitText(block.text)) {
          if (p.trim()) pieces.push(p.trim());
        }
      }
      continue;
    }

    if (pending === "") {
      pending = block.text;
      continue;
    }
    if (pending.length + 1 + block.text.length <= chunkSize) {
      pending = `${pending}\n${block.text}`;
      continue;
    }
    flushPending();
    pending = block.text;
  }
  flushPending();

  return pieces;
}

/**
 * 标题感知切块（纯函数）。**标题是边界**——绝不跨标题拼。
 *
 *   body <= chunkSize → 整节 1 个 chunk
 *   body >  chunkSize → 节内切分（**围栏感知**：代码块整体不拆），每片同一 headingPath，
 *                       metadata.partIndex / partTotal
 *   content 组装：leaf = headingPath.at(-1)
 *                 leaf 非空 → `${leaf}\n\n${body}`；否则 body 原样
 *
 * 为什么把叶标题拼进 content：正文里往往不出现章节名（"三、核心亮点"），只存 metadata
 * 的话检索端拿不到（四处 SELECT 目前都不返回 metadata）。注入叶标题是最低成本的语义
 * 定位增强，对 FTS 也有正向作用。
 *
 * 节间不做 overlap —— 标题即语义边界。节内也不额外造 overlap，只有"单块超预算"
 * 落到字符切块器时才用 chunkOverlap。
 */
export async function chunkMdSections(
  sections: MdSection[],
  opts: { chunkSize: number; chunkOverlap: number; filename: string; source?: string },
): Promise<LoadedChunk[]> {
  const { chunkSize, chunkOverlap, filename } = opts;
  const source = opts.source ?? filename;
  const out: LoadedChunk[] = [];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: PLAIN_SEPARATORS,
  });

  for (const s of sections) {
    const leaf = s.headingPath.length > 0 ? s.headingPath[s.headingPath.length - 1] : "";
    const withLeaf = (body: string): string => (leaf ? `${leaf}\n\n${body}` : body);

    if (s.body.length <= chunkSize) {
      out.push({
        content: withLeaf(s.body),
        metadata: { filename, source, strategy: "md-heading", headingPath: s.headingPath },
      });
      continue;
    }

    const parts = await splitBodyFenceAware(s.body, chunkSize, splitter);
    parts.forEach((part, i) => {
      out.push({
        content: withLeaf(part),
        metadata: {
          filename,
          source,
          strategy: "md-heading",
          headingPath: s.headingPath,
          partIndex: i,
          partTotal: parts.length,
        },
      });
    });
  }

  return out;
}

/**
 * markdown 文本 → chunks 的**唯一入口**（`.md` 直读 / `.docx` 转换 / wiki 同步 三条路共用）。
 *
 * fail-safe 而非 fail-loud：整篇没有任何标题结构（例如纯表格 markdown）时退回字符切块，
 * 行为等价旧实现，`strategy` 标 `text-char` —— 排查时一眼就能看出这份文档没吃到结构红利。
 */
export async function chunkMarkdownText(
  md: string,
  opts: { chunkSize: number; chunkOverlap: number; filename: string; source?: string },
): Promise<LoadedChunk[]> {
  if (md.trim().length === 0) return [];

  const sections = splitByHeadings(md);
  const hasHeading = sections.some((s) => s.headingPath.length > 0);
  if (sections.length === 0 || !hasHeading) return chunkPlainText(md, opts);

  return chunkMdSections(sections, opts);
}
