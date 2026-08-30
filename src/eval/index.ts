/**
 * index.ts — 评估模块 CLI 入口
 *
 * 用法：
 *   npm run eval -- dataset --log rag_data/agent.log                # 抽候选问题 → candidates.json
 *   npm run eval -- rag --dataset src/eval/datasets/rag-qa.json --k 5  # RAG 评估（需 PG 就绪 + API key）
 *   npm run eval -- agent --file eval_output/traces.jsonl           # Agent 行为评估（读 JSONL）
 *
 * 依赖说明：
 *   - dataset / agent 子命令无外部依赖，随时可跑
 *   - rag 子命令懒加载 DB 与 LLM（避免其他子命令被拖累）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { extractCandidates } from "./datasets/extract-from-log.js";
import { loadSessionsFromJsonl, computeAgentMetrics } from "./runner/agent-eval.js";

async function main(): Promise<void> {
  const sub = process.argv[2] ?? "help";
  switch (sub) {
    case "dataset":
      await cmdDataset();
      break;
    case "rag":
      await cmdRag();
      break;
    case "agent":
      await cmdAgent();
      break;
    default:
      printHelp();
  }
}

// ── dataset：从 agent.log 抽候选问题 ──
async function cmdDataset(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { log: { type: "string" }, out: { type: "string" } },
  });
  const logPath = resolve(values.log ?? "rag_data/agent.log");
  const outPath = resolve(values.out ?? "eval_output/candidates.json");

  const candidates = extractCandidates(logPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(candidates, null, 2), "utf-8");

  console.log(`[dataset] ${logPath} → ${candidates.length} unique candidates`);
  for (const c of candidates.slice(0, 10)) {
    console.log(`  ${String(c.occurrences).padStart(2)}x  ${c.question}`);
  }
  console.log(`[dataset] written to ${outPath}`);
}

// ── rag：RAG 评估（懒加载重依赖）──
async function cmdRag(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { dataset: { type: "string" }, k: { type: "string" } },
  });
  const datasetPath = resolve(values.dataset ?? "src/eval/datasets/rag-qa.json");
  const k = parseInt(values.k ?? "5", 10) || 5;

  // 懒加载：只有 rag 子命令才引入 DB/LLM 依赖
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(datasetPath)) {
    console.error(`[rag] dataset not found: ${datasetPath}`);
    console.error(`[rag] 请先准备数据集（示例：src/eval/datasets/rag-qa.example.json）`);
    process.exit(1);
  }

  const { loadConfig } = await import("../config/index.js");
  const { createChatModel } = await import("../agent/langchain.js");
  const { getPool } = await import("../storage/pool.js");
  const { PgVectorStore } = await import("../storage/pg-vector-store.js");
  const { OpenAIEmbeddings } = await import("@langchain/openai");
  const { runRagEval } = await import("./runner/rag-eval.js");
  const { writeReports } = await import("./report/report.js");

  const config = loadConfig();
  const samples = JSON.parse(readFileSync(datasetPath, "utf-8")) as Parameters<typeof runRagEval>[0]["samples"];

  const llm = createChatModel(config);
  const embeddings = new OpenAIEmbeddings({
    apiKey: config.openAIApiKey,
    model: config.embeddingModel,
  });
  const pool = await getPool(config);
  const store = new PgVectorStore(pool, embeddings);

  console.log(`[rag] samples=${samples.length} k=${k}`);
  console.log(`[rag] dataset=${datasetPath}`);

  const { results } = await runRagEval({ samples, store, llm, k });
  const { mdPath, jsonPath } = writeReports(results, k);
  await pool.end();

  console.log(`[rag] report: ${mdPath}`);
  console.log(`[rag] json:   ${jsonPath}`);
}

// ── agent：Agent 行为评估（读 JSONL）──
async function cmdAgent(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { file: { type: "string" } },
  });
  const filePath = resolve(values.file ?? "eval_output/traces.jsonl");

  const { existsSync } = await import("node:fs");
  if (!existsSync(filePath)) {
    console.error(`[agent] file not found: ${filePath}`);
    console.error(`[agent] 先跑一次 Agent 任务并导出轨迹（JsonlTraceExporter），或指定 --file`);
    process.exit(1);
  }

  const sessions = loadSessionsFromJsonl(filePath);

  const metrics = sessions.map(computeAgentMetrics);
  for (const m of metrics) {
    const toolOk = `${(m.toolSuccessRate * 100).toFixed(0)}%`;
    const ptcOk = m.ptcOkRate === null ? "-" : `${(m.ptcOkRate * 100).toFixed(0)}%`;
    console.log(
      `[agent] "${m.userInput}" steps=${m.stepCount} toolOk=${toolOk} err=${m.errorCount} ` +
        `iters=${m.iterations} tokens=${m.totalTokens} latency=${m.latencyMs}ms ptcOk=${ptcOk}`,
    );
  }

  const avgToolOk = metrics.reduce((s, m) => s + m.toolSuccessRate, 0) / metrics.length;
  console.log(`[agent] avg toolSuccessRate=${(avgToolOk * 100).toFixed(1)}% over ${metrics.length} session(s)`);
}

function printHelp(): void {
  console.log(`navigate eval CLI
用法:
  npm run eval -- dataset [--log <path>] [--out <path>]  从 agent.log 抽候选问题
  npm run eval -- rag --dataset <path> [--k <n>]         RAG 评估（需 PG + API key）
  npm run eval -- agent [--file <jsonl>]                 Agent 行为评估（读 JSONL）
`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
