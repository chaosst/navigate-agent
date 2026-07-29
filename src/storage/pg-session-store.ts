import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { randomUUID } from "node:crypto";
import type { Session, MemoryMessage, Summary } from "../memory/types.js";
import { HotCache } from "./cache.js";

export class PgSessionStore {
  private pool: Pool;
  private embeddings?: OpenAIEmbeddings;
  private cache: HotCache;

  constructor(pool: Pool, embeddings?: OpenAIEmbeddings, cache?: HotCache) {
    this.pool = pool;
    this.embeddings = embeddings;
    this.cache = cache ?? new HotCache({ maxSessions: 50 });
  }

  /** 注入 embedding 模型（也可以在构造时传入） */
  setEmbeddings(emb: OpenAIEmbeddings): void {
    this.embeddings = emb;
  }

  async createSession(name?: string): Promise<Session> {
    const id = randomUUID();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO sessions (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [id, name || "New Chat", now.toISOString()],
    );
    return { id, name: name || "New Chat", createdAt: now, updatedAt: now };
  }

  async getSession(id: string): Promise<Session | null> {
    // L1: 尝试缓存命中
    const cached = this.cache.getSession(id);
    if (cached) return cached as Session;

    // L2: 数据库查询
    const { rows } = await this.pool.query(
      `SELECT id, name, created_at, updated_at FROM sessions WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const session: Session = { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
    // 回填 L1 缓存
    this.cache.setSession(id, session);
    return session;
  }

  async listSessions(): Promise<Session[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, created_at, updated_at FROM sessions ORDER BY updated_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  }

  async addMessage(sessionId: string, role: string, content: string): Promise<MemoryMessage> {
    this.cache.invalidateSession(sessionId);
    const now = new Date();
    await this.pool.query(
      `INSERT INTO messages (session_id, role, content, created_at) VALUES ($1, $2, $3, $4)`,
      [sessionId, role, content, now.toISOString()],
    );
    await this.pool.query(
      `UPDATE sessions SET updated_at = $1 WHERE id = $2`,
      [now.toISOString(), sessionId],
    );
    return { role: role as MemoryMessage["role"], content, createdAt: now };
  }

  async getMessages(sessionId: string, limit?: number): Promise<MemoryMessage[]> {
    let sql = `SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC`;
    const params: any[] = [sessionId];
    if (limit !== undefined) {
      sql += ` LIMIT $2`;
      params.push(limit);
    }
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      role: r.role as MemoryMessage["role"],
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  async getRecentContext(sessionId: string, limit?: number): Promise<string> {
    const msgs = await this.getMessages(sessionId, limit);
    return msgs
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
  }

  async saveSummary(
    sessionId: string,
    content: string,
    msgStartId: number | null,
    msgEndId: number | null,
    originalChars: number,
  ): Promise<Summary> {
    const now = new Date();

    // 如果有 embedding 模型，自动计算摘要向量
    let embeddingVec: string | null = null;
    if (this.embeddings) {
      try {
        const vec = await this.embeddings.embedQuery(content);
        embeddingVec = `[${vec.join(",")}]`;
      } catch (e) {
        // embedding 失败不阻塞主流程
        console.warn("[pg-session-store] Summary embedding failed:", (e as Error).message);
      }
    }

    const { rows } = await this.pool.query(
      `INSERT INTO summaries (session_id, content, msg_start_id, msg_end_id, original_chars, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
       RETURNING id`,
      [sessionId, content, msgStartId, msgEndId, originalChars, embeddingVec, now.toISOString()],
    );
    return {
      id: rows[0].id,
      sessionId,
      content,
      msgStartId,
      msgEndId,
      originalTokens: originalChars,
      createdAt: now,
    };
  }

  async getSummaries(sessionId: string, limit?: number): Promise<Summary[]> {
    let sql = `SELECT id, session_id, content, msg_start_id, msg_end_id, original_chars, created_at
               FROM summaries WHERE session_id = $1 ORDER BY created_at ASC`;
    const params: any[] = [sessionId];
    if (limit !== undefined) { sql += ` LIMIT $2`; params.push(limit); }
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      content: r.content,
      msgStartId: r.msg_start_id,
      msgEndId: r.msg_end_id,
      originalTokens: r.original_chars,
      createdAt: r.created_at,
    }));
  }

  async deleteSummaries(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM summaries WHERE session_id = $1", [sessionId]);
  }

  async close(): Promise<void> {
    // 连接池由 getPool/closePool 统一管理，这里不做操作
  }
}
