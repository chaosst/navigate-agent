import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RagResult } from "./types.js";

export class RagVectorStore {
  private store: MemoryVectorStore;
  private embeddings: OpenAIEmbeddings;
  private persistDir: string;
  /** Raw chunks for keyword fallback when embeddings API is unavailable */
  private rawChunks: { content: string; metadata: Record<string, unknown> }[] = [];

  constructor(embeddings: OpenAIEmbeddings, persistDir: string = "rag_data") {
    this.store = new MemoryVectorStore(embeddings);
    this.embeddings = embeddings;
    this.persistDir = persistDir;
    // Restore data from disk on startup
    this.loadFromDisk().catch(err => {
      if (err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[rag] Could not restore persisted data:`, (err as Error)?.message);
      }
    });
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
    // Persist to disk after every addition
    await this.saveToDisk();
  }

  async deleteDoc(docId: string): Promise<void> {
    // Remove from rawChunks
    this.rawChunks = this.rawChunks.filter(c => c.metadata?.docId !== docId);
    // Rebuild the vector store from remaining chunks
    const remaining = this.rawChunks.map((c, i) => new Document({
      pageContent: c.content,
      metadata: { ...c.metadata, docId: c.metadata?.docId || "unknown", chunkIndex: i },
    }));
    this.store = new MemoryVectorStore(this.embeddings);
    if (remaining.length > 0) {
      try {
        await this.store.addDocuments(remaining);
      } catch (e) {
        console.warn(`[rag] Could not re-embed after delete:`, (e as Error)?.message);
      }
    }
    await this.saveToDisk();
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

  /** Save raw chunks and metadata to disk */
  private async saveToDisk(): Promise<void> {
    mkdirSync(this.persistDir, { recursive: true });
    const data = {
      rawChunks: this.rawChunks,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(join(this.persistDir, "vectorstore.json"), JSON.stringify(data, null, 2), "utf-8");
  }

  /** Load raw chunks from disk and rebuild the vector store */
  private async loadFromDisk(): Promise<void> {
    const filePath = join(this.persistDir, "vectorstore.json");
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { rawChunks: { content: string; metadata: Record<string, unknown> }[] };
    if (!data.rawChunks || data.rawChunks.length === 0) return;

    this.rawChunks = data.rawChunks;

    // Re-add to the vector store (re-embeds all chunks via the API)
    const docs = this.rawChunks.map((c, i) => new Document({
      pageContent: c.content,
      metadata: { ...c.metadata, docId: "persisted", chunkIndex: i },
    }));
    try {
      await this.store.addDocuments(docs);
      console.log(`[rag] Restored ${this.rawChunks.length} chunks from disk`);
    } catch (e) {
      console.warn(`[rag] Could not re-embed persisted chunks, fallback to keyword only:`, (e as Error)?.message);
    }
  }

  /** Get raw chunk count for diagnostics */
  getChunkCount(): number {
    return this.rawChunks.length;
  }
}
