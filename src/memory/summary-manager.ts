import { OpenAIEmbeddings } from "@langchain/openai";
import type { Summary } from "./types.js";
import type { PgSessionStore } from "../storage/pg-session-store.js";

/**
 * SummaryManager — 摘要管理器
 *
 * 职责：
 *   1. 存储 LLM 生成的对话摘要到 PostgreSQL（持久化，自动向量化）
 *   2. 根据当前查询返回相关摘要（向量语义检索 → 关键词降级）
 *   3. 管理摘要的生命周期（最多保留 N 条，超过自动合并）
 */
export class SummaryManager {
  private store: PgSessionStore;
  private maxSummariesPerSession: number;

  constructor(
    store: PgSessionStore,
    maxSummariesPerSession = 10,
    private embeddings?: OpenAIEmbeddings,
  ) {
    this.store = store;
    this.maxSummariesPerSession = maxSummariesPerSession;
  }

  /**
   * 保存一条摘要到 PgSessionStore（自动计算 embedding）
   */
  async save(
    sessionId: string,
    content: string,
    msgRange: [startIndex: number, endIndex: number],
    originalTokens: number,
  ): Promise<Summary> {
    const summary = await this.store.saveSummary(
      sessionId,
      content,
      msgRange[0],
      msgRange[1],
      originalTokens,
    );

    // 超过上限时删掉最旧的
    await this.enforceLimit(sessionId);

    return summary;
  }

  /**
   * 获取 session 的所有摘要（从旧到新）
   */
  async getSummaries(sessionId: string): Promise<Summary[]> {
    return this.store.getSummaries(sessionId);
  }

  /**
   * 根据查询语句查找相关摘要
   *
   * 策略：
   *   - 如果有 embedding 模型，优先做向量语义检索（pgvector <=>）
   *   - 降级到关键词匹配
   */
  async findRelevant(
    sessionId: string,
    query: string,
    maxResults = 3,
  ): Promise<Summary[]> {
    // 如果有 embedding 模型，做向量检索
    if (this.embeddings) {
      try {
        const vec = await this.embeddings.embedQuery(query);
        const { rows } = await (this.store as any).pool.query(
          `SELECT id, session_id, content, msg_start_id, msg_end_id, original_chars, created_at
           FROM summaries
           WHERE session_id = $1 AND embedding IS NOT NULL
           ORDER BY embedding <=> $2::vector
           LIMIT $3`,
          [sessionId, `[${vec.join(",")}]`, maxResults],
        );
        if (rows.length > 0) {
          return rows.map((r: any) => ({
            id: r.id,
            sessionId: r.session_id,
            content: r.content,
            msgStartId: r.msg_start_id,
            msgEndId: r.msg_end_id,
            originalTokens: r.original_chars,
            createdAt: r.created_at,
          }));
        }
      } catch (e) {
        console.warn("[summary] Vector search failed, falling back to keyword:", (e as Error).message);
      }
    }

    // 降级：关键词匹配
    return this.keywordFindRelevant(sessionId, query, maxResults);
  }

  private async keywordFindRelevant(
    sessionId: string,
    query: string,
    maxResults = 3,
  ): Promise<Summary[]> {
    const summaries = await this.store.getSummaries(sessionId);
    if (summaries.length === 0 || !query) return [];

    const keywords = query
      .toLowerCase()
      .split(/[\s,，。；;：:！!？?]+/)
      .filter((k) => k.length > 1);

    if (keywords.length === 0) return [];

    const scored = summaries
      .map((s) => {
        const lower = s.content.toLowerCase();
        const matches = keywords.filter((k) => lower.includes(k));
        return { summary: s, score: matches.length / keywords.length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return scored.map((s) => s.summary);
  }

  /** 删除 session 的所有摘要 */
  async clear(sessionId: string): Promise<void> {
    await this.store.deleteSummaries(sessionId);
  }

  /** 限制每个 session 的摘要数量，超出的删最旧的 */
  private async enforceLimit(sessionId: string): Promise<void> {
    const all = await this.store.getSummaries(sessionId);
    if (all.length <= this.maxSummariesPerSession) return;

    const keep = all.slice(-this.maxSummariesPerSession);
    await this.store.deleteSummaries(sessionId);
    for (const s of keep) {
      await this.store.saveSummary(sessionId, s.content, s.msgStartId, s.msgEndId, s.originalTokens);
    }
  }
}
