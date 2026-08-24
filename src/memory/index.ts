import { PgSessionStore } from "../storage/pg-session-store.js";
import { ContextManager } from "./context-manager.js";
import { SummaryManager } from "./summary-manager.js";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Pool } from "pg";
import type { ChatOpenAI } from "@langchain/openai";
import type { Session, MemoryConfig } from "./types.js";
import type { AgentMessage } from "../agent/types.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

const SUMMARY_PROMPT = `Summarize the key points of this conversation segment in Chinese.
Focus on: user's intent, decisions made, tools used, and conclusions.
Keep it under 200 characters. Return only the summary text, no prefix.`;

export class AgentMemory {
  public store: PgSessionStore;
  public context: ContextManager;
  public summary: SummaryManager;
  public activeSessionId: string;
  private llm?: ChatOpenAI;

  private constructor(
    store: PgSessionStore,
    context: ContextManager,
    summary: SummaryManager,
    sessionId: string,
  ) {
    this.store = store;
    this.context = context;
    this.summary = summary;
    this.activeSessionId = sessionId;
  }

  setLLM(llm: ChatOpenAI): void {
    this.llm = llm;
  }

  static async create(
    poolOrUrl: Pool | string,
    embedding: OpenAIEmbeddings,
    sessionId?: string,
    config?: MemoryConfig,
    llm?: ChatOpenAI,
  ): Promise<AgentMemory> {
    const pool = typeof poolOrUrl === "string"
      ? new Pool({ connectionString: poolOrUrl })
      : poolOrUrl;

    const store = new PgSessionStore(pool, embedding);
    const context = new ContextManager(
      config?.maxContextTokens,
      config?.responseReserve,
    );
    const summary = new SummaryManager(store, 10, embedding);
    let sid = sessionId;
    if (!sid) {
      const sessions = await store.listSessions();
      sid = sessions.length > 0 ? sessions[0].id : (await store.createSession()).id;
    } else if (!(await store.getSession(sid))) {
      await store.createSession("New Chat");
    }
    const mem = new AgentMemory(store, context, summary, sid);
    mem.llm = llm;
    return mem;
  }

  async summarizeAfterTurn(allMessages: AgentMessage[], batchSize = 8): Promise<void> {
    if (!this.llm || allMessages.length < batchSize) return;

    const existing = await this.summary.getSummaries(this.activeSessionId);
    const lastSummarizedIdx = existing.length > 0
      ? Math.max(...existing.map(s => s.msgEndId ?? -1))
      : -1;

    const startIdx = lastSummarizedIdx + 1;
    const endIdx = startIdx + batchSize - 1;

    if (endIdx >= allMessages.length) return;

    const batch = allMessages.slice(startIdx, endIdx + 1);
    const text = batch
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    try {
      const response = await this.llm.invoke([
        new SystemMessage(SUMMARY_PROMPT),
        new HumanMessage(text),
      ]);
      const summary = typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

      this.summary.save(this.activeSessionId, summary, [startIdx, endIdx], text.length);
    } catch (err) {
      console.error("[summarizer] Failed to generate summary:", (err as Error).message);
    }
  }

  async getSession(): Promise<Session | null> {
    return this.store.getSession(this.activeSessionId);
  }

  async listSessions(): Promise<Session[]> {
    return this.store.listSessions();
  }

  async switchSession(id: string): Promise<Session | null> {
    const s = await this.store.getSession(id);
    if (s) this.activeSessionId = id;
    return s;
  }

  async addUserMessage(content: string): Promise<void> {
    await this.store.addMessage(this.activeSessionId, "user", content);
  }

  async addAssistantMessage(content: string): Promise<void> {
    await this.store.addMessage(this.activeSessionId, "assistant", content);
  }

  async getContextWindow(limit?: number): Promise<string> {
    return this.store.getRecentContext(this.activeSessionId, limit);
  }

  async summarizeAndStore(content: string): Promise<void> {
    this.summary.save(this.activeSessionId, content, [0, 0], content.length);
  }

  close(): void {
    // 连接池由 getPool/closePool 统一管理
  }
}
