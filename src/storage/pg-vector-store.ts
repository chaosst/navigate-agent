import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { randomUUID } from "node:crypto";
import type { RagDocument, RagResult } from "../rag/types.js";
import type { DocMeta } from "./types.js";
import { HotCache } from "./cache.js";

export class PgVectorStore {
  private cache: HotCache;
  private listDocsCache: { data: RagDocument[]; timestamp: number } | null = null;
  private readonly LIST_DOCS_CACHE_TTL = 5000; // 5 seconds

  constructor(
    private pool: Pool,
    private embeddings: OpenAIEmbeddings,
    cache?: HotCache,
  ) {
    this.cache = cache ?? new HotCache({ maxChunks: 5000 });
  }

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
    this.cache.invalidateDoc(docId);
    // CASCADE 会自动删除关联的 doc_chunks
    await this.pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  }

  async getDocMeta(docId: string): Promise<DocMeta | null> {
    // L1: 尝试缓存命中
    const cached = this.cache.getDocMeta(docId);
    if (cached) return cached as DocMeta;

    // L2: 数据库查询
    const { rows } = await this.pool.query(
      `SELECT filename, stored_filename, chunk_count, indexed_at,
              wiki_page_id, owner, project, tags, visibility, permissions, metadata
       FROM documents WHERE id = $1`,
      [docId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const meta: DocMeta = {
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
    // 回填 L1 缓存
    this.cache.setDocMeta(docId, meta);
    return meta;
  }

  async listDocs(): Promise<RagDocument[]> {
    if (this.listDocsCache && Date.now() - this.listDocsCache.timestamp < this.LIST_DOCS_CACHE_TTL) {
      return this.listDocsCache.data;
    }
    const { rows } = await this.pool.query(
      `SELECT id, filename, chunk_count, indexed_at
       FROM documents ORDER BY indexed_at DESC`,
    );
    const result = rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      pages: 0,
      chunkCount: r.chunk_count,
      indexedAt: r.indexed_at,
    }));
    this.listDocsCache = { data: result, timestamp: Date.now() };
    return result;
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
    return this.deleteDoc(docId);
  }

  async getChunkCount(): Promise<number> {
    const { rows } = await this.pool.query("SELECT count(*)::int AS cnt FROM doc_chunks");
    return rows[0]?.cnt ?? 0;
  }

  async listDocIds(): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT id FROM documents");
    return rows.map((r) => r.id);
  }

  // ═══════════════════════════════════════════════
  //  混合检索（向量 + FTS，RRF 融合）
  // ═══════════════════════════════════════════════

  async search(query: string, k: number = 5): Promise<RagResult[]> {
    const vectorResults: RagResult[] = [];
    const ftsResults: RagResult[] = [];

    // 1. 向量检索
    try {
      const embedding = await this.embeddings.embedQuery(query);
      if (!embedding || embedding.length === 0) {
        console.warn("[pgvector] Empty embedding from query, skipping vector search");
      } else {
        const { rows } = await this.pool.query(
          `SELECT id, content, doc_id, chunk_index,
                  1 - (embedding <=> $1::vector) AS score
           FROM doc_chunks
           WHERE embedding IS NOT NULL
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
          [`[${embedding.join(",")}]`, k * 2],
        );
        for (const r of rows) {
          vectorResults.push({
            content: r.content,
            score: r.score,
            source: "",
            docId: r.doc_id,
          });
        }
      }
    } catch (e) {
      console.warn("[pgvector] Vector search failed:", (e as Error).message);
    }

    // 2. 中文 FTS 检索（替代 BM25）
    try {
      const { rows } = await this.pool.query(
        `SELECT id, content, doc_id, chunk_index,
                ts_rank(fts_vector, plainto_tsquery('chinese_zh', $1)) AS score
         FROM doc_chunks
         WHERE fts_vector @@ plainto_tsquery('chinese_zh', $1)
         ORDER BY score DESC
         LIMIT $2`,
        [query, k * 2],
      );
      for (const r of rows) {
        ftsResults.push({
          content: r.content,
          score: r.score,
          source: "",
          docId: r.doc_id,
        });
      }
    } catch (e) {
      console.warn("[pgvector] FTS search failed:", (e as Error).message);
    }

    // 3. 诊断
    if (vectorResults.length === 0 && ftsResults.length === 0) {
      console.warn("[pgvector] Both vector and FTS searches returned zero results — check DB connection and data");
    }

    // 4. RRF 融合
    return this.rrfMerge(vectorResults, ftsResults, k);
  }

  /**
   * Reciprocal Rank Fusion
   * 与旧版 RagVectorStore.rrfMerge 完全兼容
   */
  private rrfMerge(
    vectorResults: RagResult[],
    ftsResults: RagResult[],
    k: number,
  ): RagResult[] {
    const K = 60;
    const combined = new Map<string, { result: RagResult; score: number }>();

    for (let i = 0; i < vectorResults.length; i++) {
      combined.set(vectorResults[i].docId + ":" + i, {
        result: vectorResults[i],
        score: 1 / (K + i + 1),
      });
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const key = ftsResults[i].docId + ":" + i;
      if (combined.has(key)) {
        combined.get(key)!.score += 1 / (K + i + 1);
      } else {
        combined.set(key, {
          result: ftsResults[i],
          score: 1 / (K + i + 1),
        });
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((e) => e.result);
  }
}
