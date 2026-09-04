export interface Session {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  owner: string;
  project: string;
  tags: string[];
  visibility: "private" | "team" | "public";
  permissions: { user: string; role: "reader" | "editor" | "admin" }[];
}

export interface MemoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
  id: number;
}

export interface MemoryConfig {
  dbPath: string;
  sessionId?: string;
  maxContextMessages?: number;
  /** Token 感知上下文预算（默认 6000） */
  maxContextTokens?: number;
  /** 为 LLM 回复预留的 token 数（默认 2000） */
  responseReserve?: number;
  verbatimWindow?: number
  summaryBatchSize?: number
  recallTopK?: number
}

export interface SearchResult {
  content: string;
  score: number;
  source: string;
}

/** 摘要记录 */
export interface Summary {
  id: number;
  sessionId: string;
  content: string;
  msgStartId: number | null;
  msgEndId: number | null;
  originalTokens: number;
  createdAt: Date;
}
