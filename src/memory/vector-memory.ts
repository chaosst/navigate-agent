import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import type { SearchResult } from "./types.js";

export class VectorMemory {
  private embeddings: OpenAIEmbeddings;
  private store: MemoryVectorStore;

  constructor(embeddings: OpenAIEmbeddings) {
    this.embeddings = embeddings;
    this.store = new MemoryVectorStore(embeddings);
  }

  async storeSummary(sessionId: string, summary: string): Promise<void> {
    try {
      const doc = new Document({
        pageContent: summary,
        metadata: { sessionId, timestamp: Date.now() },
      });
      await this.store.addDocuments([doc]);
    } catch {
      // Embeddings not available (e.g. DeepSeek) — skip gracefully
    }
  }

  async search(query: string, k: number = 3): Promise<SearchResult[]> {
    try {
      const results = await this.store.similaritySearchWithScore(query, k);
      return results.map(([doc, score]) => ({
        content: doc.pageContent,
        score,
        source: (doc.metadata?.sessionId as string) || "",
      }));
    } catch {
      return [];
    }
  }

  async deleteSessionMemories(_sessionId: string): Promise<void> {
    this.store = new MemoryVectorStore(this.embeddings);
  }
}
