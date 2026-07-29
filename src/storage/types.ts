import type { RagDocument, RagResult } from "../rag/types.js";

export { RagDocument, RagResult };

export interface DocMeta {
  filename: string;
  storedFilename?: string;
  chunkCount: number;
  indexedAt: Date;
  wikiPageId?: number;
  owner?: string;
  project?: string;
  tags?: string[];
  visibility?: "private" | "team" | "public";
  permissions?: { user: string; role: "reader" | "editor" | "admin" }[];
  metadata?: Record<string, unknown>;
}

export interface ChunkRecord {
  id: string;
  docId: string;
  content: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
}

// 与 PgSessionStore 共享的接口
export interface SessionRecord {
  id: string;
  name: string;
  owner: string;
  project: string;
  tags: string[];
  visibility: "private" | "team" | "public";
  permissions: { user: string; role: "reader" | "editor" | "admin" }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}
