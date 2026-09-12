/**
 * citation.ts — 检索命中的"定位信息"（页码 / 标题路径）的提取与格式化
 *
 * 为什么单独成模块：提取侧（`pg-vector-store` 从 `doc_chunks.metadata` 取值）与
 * 展示侧（`retriever` 拼 Source 行）是同一份契约的两端，且 `pg-vector-store`
 * 不该为了格式化而 import 整个 retriever（那会把 LangChain 拉进存储层）。
 */
import type { RagResult } from "./types.js";

/** chunk 元数据里的定位字段（全部可选，缺失即 undefined） */
export interface ChunkCitation {
  pageStart?: number;
  pageEnd?: number;
  pageLabel?: string;
  headingPath?: string[];
}

/** 从 `doc_chunks.metadata`（JSONB，可能为 null / 老数据）里安全取出定位字段 */
export function pickCitationFields(metadata: unknown): ChunkCitation {
  const md = (metadata ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const headingPath = Array.isArray(md.headingPath)
    ? (md.headingPath as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  return {
    pageStart: num(md.pageStart),
    pageEnd: num(md.pageEnd),
    pageLabel: str(md.pageLabel),
    headingPath: headingPath && headingPath.length > 0 ? headingPath : undefined,
  };
}

/** 页码范围片段：优先用正文标注页码（pageLabel），否则用物理页号 */
function formatPage(r: RagResult): string | undefined {
  if (r.pageLabel) return `p.${r.pageLabel}`;
  if (r.pageStart === undefined) return undefined;
  if (r.pageEnd === undefined || r.pageEnd === r.pageStart) return `p.${r.pageStart}`;
  return `p.${r.pageStart}-${r.pageEnd}`;
}

/**
 * 拼接检索结果的来源行（纯函数）。
 *   PDF        → `[1] Source: 年报.pdf · p.12-13`
 *   MD / DOCX  → `[2] Source: 方案.docx · 四、专业技能 > 后端能力`
 *   无元数据   → `[1] Source: xxx`（向后兼容老 chunk）
 */
export function formatChunkSource(r: RagResult, index: number): string {
  const locators: string[] = [];
  if (r.headingPath && r.headingPath.length > 0) locators.push(r.headingPath.join(" > "));
  const page = formatPage(r);
  if (page) locators.push(page);

  const suffix = locators.length > 0 ? ` · ${locators.join(" · ")}` : "";
  return `[${index}] Source: ${r.source}${suffix}`;
}
