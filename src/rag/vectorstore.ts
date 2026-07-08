import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import type { RagResult } from "./types.js";

export class RagVectorStore {
  private store: MemoryVectorStore;
  /** Raw chunks for keyword fallback when embeddings API is unavailable */
  private rawChunks: { content: string; metadata: Record<string, unknown> }[] = [];

  constructor(embeddings: OpenAIEmbeddings) {
    this.store = new MemoryVectorStore(embeddings);
  }

  async addChunks(chunks: { content: string; metadata: Record<string, unknown> }[], docId: string): Promise<void> {
    const docs = chunks.map((c, i) => new Document({
      pageContent: c.content,
      metadata: { ...c.metadata, docId, chunkIndex: i },
    }));
    // Keep raw chunks for keyword fallback
    this.rawChunks.push(...chunks);
    try {
      await this.store.addDocuments(docs);
    } catch (e) {
      console.warn(`[rag] Embeddings unavailable, storing ${chunks.length} chunks as text-only:`, (e as Error)?.message);
    }
  }

  async search(query: string, k: number = 5): Promise<RagResult[]> {
    try {
      const results = await this.store.similaritySearchWithScore(query, k);
      if (results.length > 0) {
        return results.map(([doc, score]) => ({
          content: doc.pageContent,
          score,
          source: (doc.metadata?.filename as string) || "",
          docId: (doc.metadata?.docId as string) || "",
        }));
      }
    } catch {
      // Embeddings failed — fall through to keyword search
    }

    // Keyword fallback
    return this.keywordSearch(query, k);
  }

  private keywordSearch(query: string, k: number = 5): RagResult[] {
    // Build terms: English words + individual CJK characters (Chinese has no word boundaries)
    const terms: string[] = [];
    const lowerQ = query.toLowerCase();
    const engWords = lowerQ.match(/[a-z0-9_+#.-]+/gi) || [];
    terms.push(...engWords);
    for (const ch of lowerQ) {
      const code = ch.charCodeAt(0);
      if (code >= 0x4e00 && code <= 0x9fff) terms.push(ch);
    }
    if (terms.length === 0 || this.rawChunks.length === 0) return [];

    const scored = this.rawChunks.map((c) => {
      const lower = c.content.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (lower.includes(t)) score += 1;
      }
      return {
        content: c.content,
        score: score / terms.length,
        source: (c.metadata?.filename as string) || "",
        docId: (c.metadata?.docId as string) || "",
      };
    }).filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return scored;
  }

  listDocIds(): string[] {
    return [];
  }
}