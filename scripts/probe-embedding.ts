#!/usr/bin/env node
/**
 * 探针：验证 createEmbeddings 是否可用（端到端 embedding 调用）。
 *
 * 用法：
 *   npx tsx scripts/probe-embedding.ts                 # 用当前 env（.env + shell 环境变量）
 *   OPENAI_API_KEY=sk-xxx npx tsx scripts/probe-embedding.ts
 *   PROVIDER=ollama npx tsx scripts/probe-embedding.ts # 本地后端（无需真实 key）
 *
 * 打印：provider / baseURL / embeddingModel / apiKey（脱敏）→ 工厂构造 → embedQuery 实测
 */
import "dotenv/config";
import { loadConfig } from "../src/config/index.js";
import { createEmbeddings } from "../src/agent/langchain.js";

async function main() {
  const config = loadConfig();
  const maskKey = (k: string) => (k ? `${k.slice(0, 4)}…(len ${k.length})` : "(empty)");
  console.log("[probe] provider       =", config.provider);
  console.log("[probe] baseURL        =", JSON.stringify(config.baseURL));
  console.log("[probe] embeddingModel =", config.embeddingModel);
  console.log("[probe] apiKey         =", maskKey(config.openAIApiKey));

  const embeddings = createEmbeddings(config);
  console.log("[probe] factory OK, instance =", embeddings.constructor.name);

  const text = "navigate embedding probe: 中文向量化测试";
  const t0 = Date.now();
  const vec = await embeddings.embedQuery(text);
  const ms = Date.now() - t0;
  console.log(`[probe] embedQuery OK in ${ms}ms, dim = ${vec.length}`);
  console.log("[probe] head:", vec.slice(0, 3).map((n) => n.toFixed(6)).join(", "));
  console.log("[probe] tail:", vec.slice(-3).map((n) => n.toFixed(6)).join(", "));
  console.log("[probe] PASS ✅");
}

main().catch((err) => {
  console.error("[probe] FAIL ❌", (err as Error).message);
  process.exit(1);
});
