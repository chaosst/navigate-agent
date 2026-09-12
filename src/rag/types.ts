export interface RagDocument {
  id: string;
  filename: string;
  pages: number;
  chunkCount: number;
  indexedAt: Date;
}

export interface RagConfig {
  chunkSize: number;
  chunkOverlap: number;
  k: number;
}

export interface RagResult {
  content: string;
  score: number;
  source: string;
  docId: string;
  chunkIndex?: number;
  /** PDF：本 chunk 覆盖的物理页码范围（1-based，闭区间） */
  pageStart?: number;
  pageEnd?: number;
  /** PDF：正文标注页码（如 "iii" / "A-1"），无则 undefined；仅作引用展示 */
  pageLabel?: string;
  /** MD / DOCX：标题面包屑，如 ["四、专业技能", "后端能力"]；前言块为 [] */
  headingPath?: string[];
}

/**
 * chunk 的结构化来源信息。全部字段写进 `doc_chunks.metadata`（JSONB）。
 *
 * 注：`filename` / `source` 是 `PgVectorStore.addChunks` 反查文件名所必需的，
 * 任何切块路径都必须带上。
 */
export interface ChunkMetadata {
  /** 原文件名（`addChunks` 依赖它反查 documents.filename） */
  filename: string;
  /** 别名（`addChunks` 的第二兜底字段） */
  source: string;
  /** 切块路径标识，便于 reindex 与时序排查 */
  strategy: "text-char" | "pdf-page" | "md-heading";
  /** PDF：本 chunk 覆盖的物理页码范围（1-based，闭区间） */
  pageStart?: number;
  pageEnd?: number;
  /** PDF：正文标注页码（如 "iii" / "A-1"），无则 undefined */
  pageLabel?: string;
  /** MD / DOCX：标题面包屑，如 ["四、专业技能", "后端能力"]；前言块为 [] */
  headingPath?: string[];
  /** MD / DOCX：节内二次切分的位置（0-based），配合 headingPath 唯一定位 */
  partIndex?: number;
  partTotal?: number;
  [key: string]: unknown;
}

/** 切块产物：一条待入库的 chunk */
export interface LoadedChunk {
  content: string;
  metadata: ChunkMetadata;
}

/** 切块器通用入参 */
export interface ChunkOpts {
  chunkSize: number;
  chunkOverlap: number;
  filename: string;
  source?: string;
}
