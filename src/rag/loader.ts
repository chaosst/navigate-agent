/**
 * loader.ts — RAG 文档切块的**唯一入口**（按源格式分派）
 *
 * 入口签名保持不变（位置参数兼容；调用点只有 `server/index.ts` 的上传与 reindex 两处），
 * 所有实现都在各自的 chunker 模块里，本文件只做路由：
 *
 *   .pdf            → 页级抽取 → 去噪 → （可选 reflow）→ 页感知切块
 *   .docx           → convertToHtml + styleMap → markdown → 标题感知切块
 *   .md             → 直接读 → 标题感知切块（零转换）
 *   其余（含 .txt） → 字符切块（中文标点感知分隔符）
 *
 * 范围锁定这 4 种格式：html / csv / xlsx / json / 源码 / pptx / epub 一律落 default
 * 按纯文本处理（与改动前一致）。
 */
import path from "path";
import { readFileSync } from "node:fs";
import type { LoadedChunk } from "./types.js";
import { chunkPlainText } from "./plain-chunker.js";
import { chunkMarkdownText } from "./md-chunker.js";
import { extractDocxMarkdown } from "./docx-extract.js";
import { chunkPdfPages, extractPdfPages, stripRepeatedLines, PDF_REFLOW_ENABLED } from "./pdf-chunker.js";

// LoadedChunk / ChunkMetadata 的契约在 ./types.js；此处 re-export 保持既有 import 路径不破。
export type { LoadedChunk, ChunkMetadata } from "./types.js";

export async function loadDocument(
  filePath: string,
  filename: string,
  chunkSize = 1000,
  chunkOverlap = 200,
): Promise<LoadedChunk[]> {
  const ext = path.extname(filename).toLowerCase();
  const opts = { chunkSize, chunkOverlap, filename };

  if (ext === ".pdf") {
    // ★ 旧实现在这里直接抛错（PDFParse v2 要求 data 给在构造函数里）→ 上传返回 500。
    const pages = stripRepeatedLines(await extractPdfPages(filePath));
    return chunkPdfPages(pages, { ...opts, reflow: PDF_REFLOW_ENABLED });
  }

  if (ext === ".docx") {
    return chunkMarkdownText(await extractDocxMarkdown(filePath), opts);
  }

  if (ext === ".md") {
    return chunkMarkdownText(readFileSync(filePath, "utf-8"), opts);
  }

  return chunkPlainText(readFileSync(filePath, "utf-8"), opts);
}
