import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { existsSync, mkdirSync, readdirSync } from "fs";
import type { RagResult } from "./types.js";

export class RagVectorStore {
  private store: MemoryVectorStore;

  constructor(embeddings: OpenAIEmbeddings, _docsDir: string = "rag_data") {
    this.store = new MemoryVectorStore(embeddings);
  }

  async addChunks(chunks: { content: string; metadata: Record<string, unknown> }[], docId: string): Promise<void> {
    const docs = chunks.map((c, i) => new Document({
      pageContent: c.content,
      metadata: { ...c.metadata, docId, chunkIndex: i },
    }));
    await this.store.addDocuments(docs);
  }

  async search(query: string, k: number = 5): Promise<RagResult[]> {
    const results = await this.store.similaritySearchWithScore(query, k);
    return results.map(([doc, score]) => ({
      content: doc.pageContent,
      score,
      source: (doc.metadata?.filename as string) || "",
      docId: (doc.metadata?.docId as string) || "",
    }));
  }

  listDocIds(): string[] {
    return [];
  }
}
