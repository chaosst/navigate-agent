export interface Session {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}

export interface MemoryConfig {
  dbPath: string;
  sessionId?: string;
  maxContextMessages?: number;
}

export interface SearchResult {
  content: string;
  score: number;
  source: string;
}

export interface Summary {
  id: number;
  sessionId: string;
  content: string;
  msgStartId: number | null;
  msgEndId: number | null;
  originalTokens: number;
  createdAt: Date;
}
