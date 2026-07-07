import { SqliteStore } from "./sqlite-store.js";
import { VectorMemory } from "./vector-memory.js";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { Session, SearchResult } from "./types.js";

export class AgentMemory {
  public store: SqliteStore;
  public vector: VectorMemory;
  public activeSessionId: string;

  private constructor(store: SqliteStore, vector: VectorMemory, sessionId: string) {
    this.store = store;
    this.vector = vector;
    this.activeSessionId = sessionId;
  }

  static async create(
    dbPath: string = "navigate.db",
    embedding: OpenAIEmbeddings,
    sessionId?: string,
  ): Promise<AgentMemory> {
    const store = await SqliteStore.create(dbPath);
    const vector = new VectorMemory(embedding);
    let sid = sessionId;
    if (!sid) {
      const sessions = store.listSessions();
      sid = sessions.length > 0 ? sessions[0].id : store.createSession().id;
    } else if (!store.getSession(sid)) {
      store.createSession("New Chat");
    }
    return new AgentMemory(store, vector, sid);
  }

  getSession(): Session | null {
    return this.store.getSession(this.activeSessionId);
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  switchSession(id: string): Session | null {
    const s = this.store.getSession(id);
    if (s) this.activeSessionId = id;
    return s;
  }

  addUserMessage(content: string): void {
    this.store.addMessage(this.activeSessionId, "user", content);
  }

  addAssistantMessage(content: string): void {
    this.store.addMessage(this.activeSessionId, "assistant", content);
  }

  getContextWindow(limit?: number): string {
    return this.store.getRecentContext(this.activeSessionId, limit);
  }

  async searchRelated(query: string, k?: number): Promise<SearchResult[]> {
    return this.vector.search(query, k);
  }

  async summarizeAndStore(summary: string): Promise<void> {
    return this.vector.storeSummary(this.activeSessionId, summary);
  }

  close(): void {
    this.store.close();
  }
}
