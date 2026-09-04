import "dotenv/config";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/index.js";
import { getPool, closePool } from "../src/storage/pool.js";
import { createEmbeddings } from "../src/agent/langchain.js";
import { AgentMemory } from "../src/memory/index.js";
import type { ChatOpenAI } from "@langchain/openai";

// stub LLM：返回固定摘要，避免依赖 deepseek 网络/成本，只测记忆管线本身
const stubLLM = {
  invoke: async (): Promise<{ content: string }> => ({
    content: "测试摘要：导航项目用 PostgreSQL+pgvector 存储对话记忆，embedding 用 nomic-embed-text(768维)。",
  }),
} as unknown as ChatOpenAI;

async function main() {
  const config = loadConfig();
  const pool = await getPool(config);
  const embeddings = createEmbeddings(config);

  // 短窗口：verbatimWindow=2 + summaryBatchSize=2 → 少量消息即可触发滚动摘要
  const memory = await AgentMemory.create(pool, embeddings, undefined,
    { verbatimWindow: 2, summaryBatchSize: 2, recallTopK: 2 },
    stubLLM);
  // 自建全新 session，避免复用 dev 库里的旧会话
  const fresh = await memory.store.createSession();
  memory.activeSessionId = fresh.id;
  const sid = memory.activeSessionId;
  console.log("[smoke] activeSessionId:", sid);

  const seeds: [string, string][] = [
    ["导航项目的对话记忆用什么数据库？", "PostgreSQL + pgvector，摘要自动向量化。"],
    ["embedding 模型是什么？", "nomic-embed-text，768 维。"],
    ["上下文截断怎么做的？", "字符估算 token，不用 tiktoken。"],
    ["连接池谁在管？", "src/storage/pool.ts 单例。"],
  ];
  for (const [u, a] of seeds) {
    await memory.addUserMessage(u);
    await memory.addAssistantMessage(a);
  }
  const persisted = await memory.store.getMessages(sid);
  assert.equal(persisted.length, 8, "应持久化 8 条消息");
  console.log("[smoke] OK: persisted", persisted.length, "messages");

  // 1) prepareTurn：无摘要 → 无 system 记忆块；query 恰好一次
  const query = "对话记忆存在哪里？";
  const before = await memory.prepareTurn(query);
  const types = before.messages.map((m) => m._getType());
  console.log("[smoke] prepareTurn types:", types.join(","));
  assert.ok(!types.includes("system"), "无摘要时不应注入 system 记忆块");
  const qCount = before.messages.filter(
    (m) => m._getType() === "human" && String((m as any).content) === query,
  ).length;
  assert.equal(qCount, 1, `query 必须恰好出现一次，实际 ${qCount}`);

  // 2) recent 窗口语义：应是最新消息，而非最旧消息（getMessages LIMIT 语义探针）
  const texts = before.messages.map((m) => String((m as any).content));
  console.log("[smoke] recent contents:", texts);
  const hasNew = texts.some((t) => t.includes("连接池谁在管") || t.includes("pool.ts 单例"));
  const hasOld = texts.some((t) => t.includes("对话记忆用什么数据库"));
  assert.ok(hasNew, "recent 窗口应包含最新消息");
  assert.ok(!hasOld, "recent 窗口不应包含最旧消息（若失败=> getMessages LIMIT 取到的是最旧 N 条）");

  // 3) rememberAfterTurn → 滚动摘要
  await memory.rememberAfterTurn();
  const s1 = await memory.store.getSummaries(sid);
  assert.ok(s1.length >= 1, `应生成 >=1 条摘要，实际 ${s1.length}`);
  console.log("[smoke] OK: summaries created:", s1.length, "| sample:", String(s1[0]?.content).slice(0, 40));

  // 4) 有摘要后再 prepareTurn → 应注入 system 记忆块，且 query 仍只一次
  const after = await memory.prepareTurn(query);
  const sys = after.messages.find((m) => m._getType() === "system");
  assert.ok(sys, "有摘要后应注入 system 记忆块");
  console.log("[smoke] OK: memoryBlock:", String((sys as any).content).slice(0, 50));
  const qCount2 = after.messages.filter(
    (m) => m._getType() === "human" && String((m as any).content) === query,
  ).length;
  assert.equal(qCount2, 1, "有记忆块时 query 仍只能一次");

  // 清理
  await memory.store.deleteSession(sid);
  await closePool();
  console.log("[smoke] ALL PASS ✓");
}

main().catch((e) => { console.error("[smoke] FAIL:", e); process.exit(1); });