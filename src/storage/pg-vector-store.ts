import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { randomUUID } from "node:crypto";
import type { RagDocument, RagResult } from "../rag/types.js";
import { HotCache } from "./cache.js";

export class PgVectorStore {
  private queryCache: HotCache;
  private listDocsCache: { data: RagDocument[]; timestamp: number } | null = null;
  private readonly LIST_DOCS_CACHE_TTL = 5000; // 5 seconds
  /** embedding 记忆化：同文本只调一次 embedding 端点（有界，Map 头 = 最旧） */
  private embedMemo = new Map<string, number[]>();
  private readonly EMBED_MEMO_MAX = 512;

  constructor(
    private pool: Pool,
    private embeddings: OpenAIEmbeddings,
    queryCache?: HotCache,
  ) {
    this.queryCache = queryCache ?? new HotCache({ maxEntries: 200, ttlMs: 10 * 60 * 1000 });
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
      // 语料新增/追加 → 查询级 L1 缓存失效
      this.invalidateCaches();
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteDoc(docId: string): Promise<void> {
    this.invalidateCaches();
    // CASCADE 会自动删除关联的 doc_chunks
    await this.pool.query("DELETE FROM documents WHERE id = $1", [docId]);
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

  async getChunkCount(): Promise<number> {
    const { rows } = await this.pool.query("SELECT count(*)::int AS cnt FROM doc_chunks");
    return rows[0]?.cnt ?? 0;
  }

  /** 语料变化（增/删 chunks）→ 查询结果缓存 + listDocs 短缓存一起失效 */
  private invalidateCaches(): void {
    this.queryCache.clear();
    this.listDocsCache = null;
  }

  /** embedding 记忆化：同文本只调一次 embedding 端点。有界 LRU（Map 头 = 最旧）。 */
  private async memoizedEmbed(text: string): Promise<number[]> {
    const hit = this.embedMemo.get(text);
    if (hit) {
      this.embedMemo.delete(text);
      this.embedMemo.set(text, hit);
      return hit;
    }
    const vec = await this.embeddings.embedQuery(text);
    if (vec && vec.length > 0) {
      this.embedMemo.set(text, vec);
      if (this.embedMemo.size > this.EMBED_MEMO_MAX) {
        const oldest = this.embedMemo.keys().next().value;
        if (oldest !== undefined) this.embedMemo.delete(oldest);
      }
    }
    return vec;
  }

  async listDocIds(): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT id FROM documents");
    return rows.map((r) => r.id);
  }

  /** L1 缓存统计：查询结果缓存 + embedding 记忆化 */
  getCacheStats() {
    return {
      queryResults: this.queryCache.size,
      embedMemo: this.embedMemo.size,
      total: this.queryCache.size,
    };
  }

  // ═══════════════════════════════════════════════
  //  混合检索（向量 + FTS，RRF 融合）
  // ═══════════════════════════════════════════════

  async search(query: string, k: number = 5): Promise<RagResult[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const cacheKey = `hybrid:${k}:${q}`;
    const cached = this.queryCache.get<RagResult[]>(cacheKey);
    if (cached) return [...cached];

    const vectorResults: RagResult[] = [];
    const ftsResults: RagResult[] = [];

    // 1. 向量检索
    try {
      const embedding = await this.memoizedEmbed(q);
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
        [q, k * 2],
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
          [q, `%${q}%`, k * 2],
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

    // 5. RRF 融合 → 回填 L1 缓存
    const merged = this.rrfMerge(vectorResults, ftsResults, k);
    this.queryCache.set(cacheKey, merged);
    return merged;
  }

  /**
   * 纯关键词子串检索（ILIKE '%q%'）。
   * 与 search() 的混合检索相互独立：无 embedding、无 FTS、无 RRF。
   * 排序：位置优先 → 出现次数次之。
   */
  async searchKeyword(query: string, k: number = 5): Promise<RagResult[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const cacheKey = `keyword:${k}:${q}`;
    const cached = this.queryCache.get<RagResult[]>(cacheKey);
    if (cached) return [...cached];

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
      const results = rows.map((r) => ({
        content: r.content,
        score: Number(r.score),
        source: r.filename || "",
        docId: r.doc_id,
        chunkIndex: r.chunk_index,
      }));
      this.queryCache.set(cacheKey, results);
      return results;
    } catch (e) {
      // 单路检索,无其他腿兜底:让错误上抛,由端点返回 500 而非静默空结果
      console.warn("[pgvector] Keyword search failed:", (e as Error).message);
      throw e;
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
