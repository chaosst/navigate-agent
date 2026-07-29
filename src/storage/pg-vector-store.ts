import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { randomUUID } from "node:crypto";
import type { RagDocument } from "../rag/types.js";
import type { DocMeta } from "./types.js";

export class PgVectorStore {
  constructor(
    private pool: Pool,
    private embeddings: OpenAIEmbeddings,
  ) {}

  async addChunks(
    chunks: { content: string; metadata: Record<string, unknown> }[],
    docId: string,
  ): Promise<void> {
    if (chunks.length === 0) return;

    // 为 chunks 预计算 embedding
    const texts = chunks.map((c) => c.content);
    let vectors: number[][] = [];
    try {
      vectors = await this.embeddings.embedDocuments(texts);
    } catch (e) {
      console.warn(`[pgvector] Embeddings unavailable, storing ${chunks.length} chunks text-only:`, (e as Error).message);
    }

    // 批量插入（单条 INSERT 避免 ORM 开销）
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        const embedding = vectors[i]
          ? `[${vectors[i].join(",")}]`
          : null;
        await client.query(
          `INSERT INTO doc_chunks (id, doc_id, content, embedding, chunk_index, metadata)
           VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [
            chunkId,
            docId,
            chunks[i].content,
            embedding,
            i,
            JSON.stringify(chunks[i].metadata),
          ],
        );
      }

      // 更新文档的 chunk_count
      await client.query(
        `UPDATE documents SET chunk_count = chunk_count + $1 WHERE id = $2`,
        [chunks.length, docId],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteDoc(docId: string): Promise<void> {
    // CASCADE 会自动删除关联的 doc_chunks
    await this.pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  }

  async getDocMeta(docId: string): Promise<DocMeta | null> {
    const { rows } = await this.pool.query(
      `SELECT filename, stored_filename, chunk_count, indexed_at,
              wiki_page_id, owner, project, tags, visibility, permissions, metadata
       FROM documents WHERE id = $1`,
      [docId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      filename: r.filename,
      storedFilename: r.stored_filename,
      chunkCount: r.chunk_count,
      indexedAt: r.indexed_at,
      wikiPageId: r.wiki_page_id,
      owner: r.owner,
      project: r.project,
      tags: r.tags,
      visibility: r.visibility,
      permissions: r.permissions,
      metadata: r.metadata,
    };
  }

  async listDocs(): Promise<RagDocument[]> {
    const { rows } = await this.pool.query(
      `SELECT id, filename, chunk_count, indexed_at
       FROM documents ORDER BY indexed_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      pages: 0,
      chunkCount: r.chunk_count,
      indexedAt: r.indexed_at,
    }));
  }

  async saveDocMeta(docId: string, meta: DocMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO documents (id, filename, stored_filename, chunk_count, owner, project, tags, visibility, permissions, metadata, indexed_at, wiki_page_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         filename = EXCLUDED.filename,
         stored_filename = EXCLUDED.stored_filename,
         chunk_count = EXCLUDED.chunk_count,
         owner = EXCLUDED.owner,
         project = EXCLUDED.project,
         tags = EXCLUDED.tags,
         visibility = EXCLUDED.visibility,
         permissions = EXCLUDED.permissions,
         metadata = EXCLUDED.metadata,
         wiki_page_id = EXCLUDED.wiki_page_id`,
      [
        docId,
        meta.filename,
        meta.storedFilename ?? null,
        meta.chunkCount,
        meta.owner ?? "admin",
        meta.project ?? "",
        meta.tags ?? [],
        meta.visibility ?? "private",
        JSON.stringify(meta.permissions ?? []),
        JSON.stringify(meta.metadata ?? {}),
        meta.indexedAt.toISOString(),
        meta.wikiPageId ?? null,
      ],
    );
  }

  async deleteDocMeta(docId: string): Promise<void> {
    await this.pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  }

  async getChunkCount(): Promise<number> {
    const { rows } = await this.pool.query("SELECT count(*)::int AS cnt FROM doc_chunks");
    return rows[0]?.cnt ?? 0;
  }

  async listDocIds(): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT id FROM documents");
    return rows.map((r) => r.id);
  }
}
