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

      // 先确保 documents 行存在（FK 约束要求）
      // 从 chunk 元数据提取文件名
      const filename = (chunks[0]?.metadata?.filename as string)
        || (chunks[0]?.metadata?.source as string)
        || "untitled";
      await client.query(
        `INSERT INTO documents (id, filename, chunk_count, indexed_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE SET chunk_count = documents.chunk_count + $3`,
        [docId, filename, chunks.length],
      );

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
    // 预热 L1 缓存：列表查询后把每个文档的元数据写入 HotCache
    for (const r of rows) {
      if (!this.cache.getDocMeta(r.id)) {
        this.cache.setDocMeta(r.id, {
          filename: r.filename,
          chunkCount: r.chunk_count,
          indexedAt: r.indexed_at,
        });
      }
    }
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

  /** 获取 L1 缓存统计 */
  getCacheStats() {
    return this.cache.stats;
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
          `SELECT c.id, c.content, c.doc_id, c.chunk_index, d.filename,
                  1 - (c.embedding <=> $1::vector) AS score
           FROM doc_chunks c
           JOIN documents d ON d.id = c.doc_id
           WHERE c.embedding IS NOT NULL
           ORDER BY c.embedding <=> $1::vector
           LIMIT $2`,
          [`[${embedding.join(",")}]`, k * 2],
        );
        for (const r of rows) {
          vectorResults.push({
            content: r.content,
            score: r.score,
            source: r.filename || "",
            docId: r.doc_id,
            chunkIndex: r.chunk_index,
          });
        }
      }
    } catch (e) {
      console.warn("[pgvector] Vector search failed:", (e as Error).message);
    }

    // 2. 中文 FTS 检索（替代 BM25）
    try {
      const { rows } = await this.pool.query(
        `SELECT c.id, c.content, c.doc_id, c.chunk_index, d.filename,
                ts_rank(c.fts_vector, plainto_tsquery('chinese_zh', $1), 16) AS score
         FROM doc_chunks c
         JOIN documents d ON d.id = c.doc_id
         WHERE c.fts_vector @@ plainto_tsquery('chinese_zh', $1)
         ORDER BY score DESC
         LIMIT $2`,
        [query, k * 2],
      );
      for (const r of rows) {
        ftsResults.push({
          content: r.content,
          score: r.score,
          source: r.filename || "",
          docId: r.doc_id,
          chunkIndex: r.chunk_index,
        });
      }
    } catch (e) {
      console.warn("[pgvector] FTS search failed:", (e as Error).message);
    }

    // 3. 中文兜底：pg_trgm 模糊匹配（FTS 不识别中文时的备选）
    if (ftsResults.length === 0) {
      try {
        const { rows } = await this.pool.query(
          `SELECT c.id, c.content, c.doc_id, c.chunk_index, d.filename,
                  similarity(c.content, $1) AS score
           FROM doc_chunks c
           JOIN documents d ON d.id = c.doc_id
           WHERE c.content % $1
              OR c.content ILIKE $2
           ORDER BY score DESC
           LIMIT $3`,
          [query, `%${query}%`, k * 2],
        );
        for (const r of rows) {
          ftsResults.push({
            content: r.content,
            score: r.score ?? 0.01,
            source: r.filename || "",
            docId: r.doc_id,
            chunkIndex: r.chunk_index,
          });
        }
      } catch (e) {
        console.warn("[pgvector] pg_trgm fallback failed:", (e as Error).message);
      }
    }

    // 4. 诊断
    if (vectorResults.length === 0 && ftsResults.length === 0) {
      console.warn("[pgvector] Both vector and FTS searches returned zero results");
    }

    // 4. RRF 融合
    return this.rrfMerge(vectorResults, ftsResults, k);
  }

  /**
   * 纯关键词子串检索（ILIKE '%q%'）。
   * 与 search() 的混合检索相互独立：无 embedding、无 FTS、无 RRF。
   * 排序：位置优先 → 出现次数次之。
   */
  async searchKeyword(query: string, k: number = 5): Promise<RagResult[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    try {
      const { rows } = await this.pool.query(
        `SELECT c.id, c.content, c.doc_id, c.chunk_index, d.filename,
                strpos(LOWER(c.content), LOWER($1)) AS pos,
                1.0 / strpos(LOWER(c.content), LOWER($1)) AS score,
                (length(c.content) - length(replace(lower(c.content), lower($1), '')))
                   / NULLIF(length($1), 0) AS cnt
         FROM doc_chunks c
         JOIN documents d ON d.id = c.doc_id
         WHERE c.content ILIKE '%' || $1 || '%'
         ORDER BY pos ASC, cnt DESC
         LIMIT $2`,
        [q, k],
      );
      return rows.map((r) => ({
        content: r.content,
        score: Number(r.score),
        source: r.filename || "",
        docId: r.doc_id,
        chunkIndex: r.chunk_index,
      }));
    } catch (e) {
      console.warn("[pgvector] Keyword search failed:", (e as Error).message);
      return [];
    }
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
      const r = vectorResults[i];
      combined.set(r.docId + ":" + (r.chunkIndex ?? i), {
        result: r,
        score: 1 / (K + i + 1),
      });
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i];
      const key = r.docId + ":" + (r.chunkIndex ?? i);
      if (combined.has(key)) {
        combined.get(key)!.score += 1 / (K + i + 1);
      } else {
        combined.set(key, {
          result: r,
          score: 1 / (K + i + 1),
        });
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((e) => ({ ...e.result, score: e.score }));
  }
}
