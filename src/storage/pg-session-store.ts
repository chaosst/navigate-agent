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

  async createSession(
    name?: string,
    options?: {
      owner?: string;
      project?: string;
      tags?: string[];
      visibility?: "private" | "team" | "public";
      permissions?: { user: string; role: "reader" | "editor" | "admin" }[];
    },
  ): Promise<Session> {
    const id = randomUUID();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO sessions (id, name, owner, project, tags, visibility, permissions, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        id,
        name || "New Chat",
        options?.owner ?? "admin",
        options?.project ?? "",
        options?.tags ?? [],
        options?.visibility ?? "private",
        JSON.stringify(options?.permissions ?? []),
        now.toISOString(),
      ],
    );
    return {
      id, name: name || "New Chat", createdAt: now, updatedAt: now,
      owner: options?.owner ?? "admin", project: options?.project ?? "",
      tags: options?.tags ?? [], visibility: options?.visibility ?? "private",
      permissions: options?.permissions ?? [],
    };
  }

  async getSession(id: string): Promise<Session | null> {
    // L1: 尝试缓存命中
    const cached = this.cache.getSession(id);
    if (cached) return cached as Session;

    // L2: 数据库查询
    const { rows } = await this.pool.query(
      `SELECT id, name, owner, project, tags, visibility, permissions, created_at, updated_at
       FROM sessions WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const session: Session = {
      id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
      owner: r.owner, project: r.project, tags: r.tags ?? [], visibility: r.visibility ?? "private",
      permissions: r.permissions ?? [],
    };
    // 回填 L1 缓存
    this.cache.setSession(id, session);
    return session;
  }

  async listSessions(): Promise<Session[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, owner, project, tags, visibility, permissions, created_at, updated_at
       FROM sessions ORDER BY updated_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
      owner: r.owner, project: r.project, tags: r.tags ?? [], visibility: r.visibility ?? "private",
      permissions: r.permissions ?? [],
    }));
  }

  async deleteSession(id: string): Promise<void> {
    this.cache.invalidateSession(id);
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
    // created_at 仅毫秒精度（now().toISOString()），同一毫秒插入的多条消息排序不确定，
    // 追加 BIGSERIAL id 作第二排序键，保证消息按实际插入顺序稳定返回（重启加载不乱序）。
    let sql = `SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC`;
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

  /** 限制 session 的摘要数量，超出上限的删除（供 SummaryManager 使用） */
  async pruneSummaries(sessionId: string, maxCount: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM summaries WHERE session_id = $1 AND id NOT IN (
        SELECT id FROM summaries WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2
      )`,
      [sessionId, maxCount],
    );
  }

  /** 执行摘要向量检索（供 SummaryManager 使用） */
  async searchSummaries(sessionId: string, embedding: number[], limit: number): Promise<any[]> {
    const vec = `[${embedding.join(",")}]`;
    const { rows } = await this.pool.query(
      `SELECT id, session_id, content, msg_start_id, msg_end_id, original_chars, created_at
       FROM summaries WHERE session_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector LIMIT $3`,
      [sessionId, vec, limit],
    );
    return rows;
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
