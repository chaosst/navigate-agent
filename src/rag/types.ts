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
}
