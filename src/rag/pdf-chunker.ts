/**
 * pdf-chunker.ts — PDF 抽取（碰 fs，薄）+ 去噪 / 换行重建 / 页感知切块（纯函数）
 *
 * 设计要点：
 *   - 页是**原子单位**：页边界是作者意图，也是用户能验证的引用坐标（"第 12 页那段"）。
 *   - `getTable()` **不作为切块输入**（它不提供表格在文本流中的插入位置，硬插会重复/错位）；
 *     表格由 `cellSeparator` 默认的 `\t` 在文本流里天然标记，`reflowLines` 只需保护含 `\t` 的行。
 *   - PDF 是"语义已被排版吃过一遍"的格式，启发式收益递减极快：**宁可不做，不要做错。**
 */
import { readFileSync } from "node:fs";
import type { LoadedChunk } from "./types.js";

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

/** 跨页高频行判定 + 剔除（页眉 / 页脚 / 页码）。纯函数。 */
export function stripRepeatedLines(
  pages: PdfPage[],
  opts?: { pageRatio?: number; maxLineLen?: number; minPages?: number },
): PdfPage[] {
  throw new Error("TODO: not implemented");
}

/**
 * PDF 视觉换行重建（纯函数）。PDF 文本是排版结果而非语义段落，每一视觉行都以 \n 结尾。
 */
export function reflowLines(text: string): string {
  throw new Error("TODO: not implemented");
}

/**
 * 页感知切块（纯函数）。**页是原子单位**。
 */
export function chunkPdfPages(
  pages: PdfPage[],
  opts: { chunkSize: number; chunkOverlap: number; filename: string; source?: string; reflow?: boolean },
): LoadedChunk[] {
  throw new Error("TODO: not implemented");
}
