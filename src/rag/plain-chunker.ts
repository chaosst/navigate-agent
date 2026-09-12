/**
 * plain-chunker.ts — 旧字符切块策略的**唯一实现**
 *
 * 三处共用这一份，保证行为绝对一致：
 *   ① `.txt` 主路径（含未知扩展名）；
 *   ② `.md` 无标题结构时的 fail-safe 兜底；
 *   ③ wiki 同步路径无标题时的兜底。
 *
 * ★ 除分隔符表外的逻辑与改动前逐字一致，不要在这里加任何"优化"。
 */
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import type { LoadedChunk } from "./types.js";

/**
 * 中文标点感知分隔符表。
 *
 * 默认表里的 `" "` 是**英文词边界**，而中文没有空格 → 一段几千字、中间没有换行的
 * 中文会一路走到最后的 `""`，**按字符硬切、切点落在句子中间**。新增的 5 个中文标点
 * 只匹配中文，因此**纯 ASCII 文本的切块结果与旧实现逐片完全一致**（已实测）。
 *
 * ⚠️ 必须保留 `keepSeparator` 的默认值 `true`：实测设 `false` 会把切点处的标点
 *    **直接丢弃**（标点总量 24 → 22）。
 */
export const PLAIN_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""];

/**
 * 纯文本 → chunks（字符切块）。
 * 函数体与旧 `loader.ts` 的 default 分支一致，唯一差异是 `separators: PLAIN_SEPARATORS`。
 */
export async function chunkPlainText(
  text: string,
  opts: { chunkSize: number; chunkOverlap: number; filename: string; source?: string },
): Promise<LoadedChunk[]> {
  const doc = new Document({ pageContent: text, metadata: { filename: opts.filename } });
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
    separators: PLAIN_SEPARATORS,
  });
  const splitDocs = await splitter.splitDocuments([doc]);
  return splitDocs.map((d) => ({
    content: d.pageContent,
    metadata: {
      ...d.metadata,
      filename: opts.filename,
      source: opts.source ?? opts.filename,
      strategy: "text-char",
    },
  }));
}
