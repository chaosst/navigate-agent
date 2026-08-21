import type { Summary } from "./types.js";
import type { SqliteStore } from "./sqlite-store.js";

/**
 * SummaryManager — 摘要管理器
 *
 * 职责：
 *   1. 存储 LLM 生成的对话摘要到 SQLite（持久化）
 *   2. 根据当前查询返回相关摘要（关键词匹配 → 后期升级为语义检索）
 *   3. 管理摘要的生命周期（最多保留 N 条，超过自动合并）
 *
 * 当前只完成了存储和查询的基础骨架。
 * Step 2 会加上 LLM 生成摘要的逻辑。
 * Step 3 会集成到 getContextWindow 中注入。
 */
export class SummaryManager {
  private store: SqliteStore;
  /** 每个 session 最多保留的摘要条数 */
  private maxSummariesPerSession: number;

  constructor(store: SqliteStore, maxSummariesPerSession = 10) {
    this.store = store;
    this.maxSummariesPerSession = maxSummariesPerSession;
  }

  /**
   * 保存一条摘要
   *
   * @param sessionId  会话 ID
   * @param content    摘要文本（LLM 生成的纯文本）
   * @param msgRange   摘要覆盖的消息在原数组中的索引范围
   * @param tokens     原始消息的总 token 数（用于判断压缩比）
   */
  save(
    sessionId: string,
    content: string,
    msgRange: [startIndex: number, endIndex: number],
    originalTokens: number,
  ): Summary {
    const summary = this.store.saveSummary(
      sessionId,
      content,
      msgRange[0],
      msgRange[1],
      originalTokens,
    );

    // 超过上限时删掉最旧的
    this.enforceLimit(sessionId);

    return summary;
  }

  /**
   * 获取 session 的所有摘要（从旧到新）
   */
  getSummaries(sessionId: string): Summary[] {
    return this.store.getSummaries(sessionId);
  }

  /**
   * 根据查询语句查找相关摘要
   *
   * 当前策略：简单关键词匹配（摘要内容包含查询中的任意关键词）
   * 后续升级：向量相似度检索
   *
   * @returns 按匹配度排序的摘要列表
   */
  findRelevant(sessionId: string, query: string, maxResults = 3): Summary[] {
    const summaries = this.getSummaries(sessionId);
    if (summaries.length === 0 || !query) return [];

    // 提取查询中的关键词（按空格/中文分词）
    const keywords = query
      .toLowerCase()
      .split(/[\s,，。；;：:！!？?]+/)
      .filter((k) => k.length > 1);

    if (keywords.length === 0) return [];

    // 给每条摘要打分：包含的关键词越多分越高
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
  clear(sessionId: string): void {
    this.store.deleteSummaries(sessionId);
  }

  /** 限制每个 session 的摘要数量，超出的删最旧的 */
  private enforceLimit(sessionId: string): void {
    const all = this.getSummaries(sessionId);
    if (all.length <= this.maxSummariesPerSession) return;

    const toDelete = all.slice(0, all.length - this.maxSummariesPerSession);
    for (const s of toDelete) {
      // 单条删除不方便（sql.js 没有便捷的 DELETE WHERE id < X），直接全删重建
    }

    // 更高效的做法：保留最新的 N 条
    const keep = all.slice(-this.maxSummariesPerSession);
    this.store.deleteSummaries(sessionId);
    for (const s of keep) {
      this.store.saveSummary(sessionId, s.content, s.msgStartId, s.msgEndId, s.originalTokens);
    }
  }
}
