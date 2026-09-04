import { PgSessionStore } from "../storage/pg-session-store.js";
import { ContextManager } from "./context-manager.js";
import { SummaryManager } from "./summary-manager.js";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Pool } from "pg";
import type { ChatOpenAI } from "@langchain/openai";
import type { Session, MemoryConfig, Summary, MemoryMessage } from "./types.js";
import type { AgentMessage } from "../agent/types.js";
import { SystemMessage, HumanMessage, BaseMessage, AIMessage } from "@langchain/core/messages";

const SUMMARY_PROMPT = `Summarize the key points of this conversation segment in Chinese.
Focus on: user's intent, decisions made, tools used, and conclusions.
Keep it under 200 characters. Return only the summary text, no prefix.`;

export class AgentMemory {
  public store: PgSessionStore;
  public context: ContextManager;
  public summary: SummaryManager;
  public activeSessionId: string;
  private llm?: ChatOpenAI;
  private verbatimWindow: number = 20
  private summaryBatchSize: number = 8
  private recallTopK: number = 3

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
    mem.verbatimWindow = config?.verbatimWindow ?? mem.verbatimWindow
    mem.summaryBatchSize = config?.summaryBatchSize ?? mem.summaryBatchSize
    mem.recallTopK = config?.recallTopK ?? mem.recallTopK
    if (llm) {
      mem.setLLM(llm)
    } else {
      console.warn(`[AgentMemory] create warning: llm is null;`)
    }
    return mem;
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

  /** 组装本轮下发给 executor 的完整消息列表。上下文唯一入口。 */
  async prepareTurn(
    query: string,
    opts?: { window?: number, recallK?: number }
  ): Promise<{ messages: BaseMessage[], summaries: Summary[], dropped: number }> {
    const k = opts?.recallK ?? this.recallTopK
    const recent = await this.store.getMessages(this.activeSessionId, this.verbatimWindow + 1)
    // 去重：DB 已在 addUserMessage 时落了当前 query（addUserMessage 发生在 runAgent 之前）。
    if (recent.length > 0) {
      const last = recent[recent.length - 1]
      if (last.role === "user" && last.content === query) {
        recent.pop()
      }
    }

    // 记忆召回与历史构建相互独立：召回失败（embedding/DB 异常）只丢记忆块，不丢会话历史。
    let summaries: Summary[] = []
    let memoryBlockText: string | undefined
    let memoryBlock: SystemMessage | undefined
    try {
      summaries = await this.summary.findRelevant(this.activeSessionId, query, k)
      if (summaries.length > 0) {
        memoryBlockText = summaries.map(s => "• " + s.content).join("\n")
        memoryBlock = new SystemMessage("[会话记忆]\n" + memoryBlockText)
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[AgentMemory] prepareTurn.findRelevant error: ${error}`)
    }

    // 历史构建（token 截断，从预算中扣除记忆块占用）不依赖召回结果
    const memoryReserve = memoryBlockText !== undefined
      ? ContextManager.estimateTokens(memoryBlockText)
      : 0
    const agentRecent = this.context.truncate(recent, query, memoryReserve)
    const dropped = recent.length - agentRecent.length
    const recentAsMessages: BaseMessage[] = agentRecent.map((m): BaseMessage => {
      if (m.role === "assistant") return new AIMessage(m.content)
      if (m.role === "system") return new SystemMessage(m.content)
      return new HumanMessage(m.content)
    })

    const messages: BaseMessage[] = memoryBlock
      ? [memoryBlock, ...recentAsMessages, new HumanMessage(query)]
      : [...recentAsMessages, new HumanMessage(query)]

    return { messages, summaries, dropped }
  }

  /** 每轮回复落库后调用：触发滚动摘要调度。 */
  async rememberAfterTurn(): Promise<void> {
    await this.maybeSummarize()
  }

  private async maybeSummarize(){
    if (!this.llm) return
    const batchPerTurn = 2

    const all = await this.store.getMessages(this.activeSessionId)
    if (all.length === 0) {
      console.error(`[AgentMemory] maybeSummarize.getMessages result length is invalid`)
      return;
    }

    const summaries = await this.summary.getSummaries(this.activeSessionId)
    let lastEnd = 0
    summaries.forEach(s => {
      if (s.msgEndId) {
        lastEnd = Math.max(s.msgEndId, lastEnd)
      }
    })
    let w = all.length - this.verbatimWindow
    w = w >= 0 ? w : 0
    if (w <= 0) {
      console.info(`[AgentMemory] maybeSummarize all memory message's length is equal or less than this.verbatimWindow`)
      return;
    }
    const boundary = all[w - 1].id
    let candidate = all.filter(a => a.id <= boundary && a.id > lastEnd)
    let turn = 0
    while (candidate.length > 0 && turn < batchPerTurn) {
      const batch = candidate.slice(0, this.summaryBatchSize)
      const text = this.summarizeBatch(batch);
      try {
        const result = await this.llm?.invoke([
          new SystemMessage(SUMMARY_PROMPT),
          new HumanMessage(text)
        ])

        const summaryText = typeof result?.content === "string" ? result.content : JSON.stringify(result?.content)

        const startId = batch[0].id
        const endId = batch[batch.length - 1].id
        try {
          await this.summary.save(this.activeSessionId, summaryText, [startId, endId], summaryText.length)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          console.error(`[AgentMemory] maybeSummarize.summarySave error: ${error}`)
        }
        turn ++
        candidate = candidate.slice(this.summaryBatchSize)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error(`[AgentMemory] maybeSummarize.llm.invoke error: ${error}`)
        return ;
      }
    }
  }

  private summarizeBatch(batch: MemoryMessage[]){
    const text = batch
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    return text
  }
  

  close(): void {
    // 连接池由 getPool/closePool 统一管理
  }
}
