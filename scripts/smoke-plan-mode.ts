/**
 * plan 模式端到端冒烟：真实 LLM + 真实工具集，跑一个需要读文件的多步任务。
 *
 * 观察点（对应 2026-09-17 的四项修复）：
 *  1. 任务列表里是**可读的步骤描述**，不是 "step_1"
 *  2. 第一步完成后**继续推进**到第二步（预算不再被二次累加、单步不再超线性膨胀）
 *  3. token 消耗回落（此前工具密集单步实测 163k）
 *  4. 若中断，输出说清因什么中断、停在哪一步
 *
 * 运行：npx tsx scripts/smoke-plan-mode.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { HumanMessage } from "@langchain/core/messages";
import { loadConfig } from "../src/config/index.js";
import { createChatModel } from "../src/agent/langchain.js";
import { createTools } from "../src/tools/registry.js";
import { ToolStatsRegistry } from "../src/tools/stats-registry.js";
import { buildApproval, resolveApprovalMode } from "../src/tools/human-channel.js";
import { createHierarchicalAgent } from "../src/agent/loop.js";
import type { ExecutionPlan } from "../src/agent/types.js";

const LOG_FILE = "rag_data/agent.log";
const logSizeBefore = (() => {
  try { return readFileSync(LOG_FILE, "utf-8").length; } catch { return 0; }
})();

const config = loadConfig();
console.log(
  `[装配] provider=${config.provider} model=${config.modelName} `
  + `budget=${config.planMaxTokens} tokens / ${config.planMaxTimeMs}ms / ${config.planMaxSteps} steps`,
);

const registry = new ToolStatsRegistry();
const { channel, policy } = buildApproval(resolveApprovalMode("deny", "deny"));
const tools = createTools(registry, channel, policy);
console.log(`[装配] 工具面 ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);

const agent = createHierarchicalAgent(
  createChatModel(config),
  tools,
  undefined,
  registry,
  config.llmTimeoutMs,
  undefined,
  {
    maxTokens: config.planMaxTokens,
    maxTimeMs: config.planMaxTimeMs,
    maxSteps: config.planMaxSteps,
  },
);

const question = "读取 package.json 的 name 与 version 字段，再读取 README.md 的一级标题，"
  + "最后用一句话总结这个项目是做什么的。";

let lastPlan: ExecutionPlan | null = null;
let finalOutput = "";
const startedAt = Date.now();

for await (const chunk of agent.stream({ messages: [new HumanMessage(question)] }) as AsyncIterable<any>) {
  if (chunk.plan) lastPlan = chunk.plan as ExecutionPlan;
  if (chunk.output) finalOutput += chunk.output as string;
}

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log("\n=== 任务列表 ===");
if (lastPlan) {
  console.log(`目标：${lastPlan.goal}`);
  (lastPlan.steps as ExecutionPlan["steps"]).forEach((s, i) => {
    const mark = { pending: "⏳", in_progress: "🔄", completed: "✅", failed: "❌", skipped: "⏭️" }[s.status];
    console.log(`${i + 1}. ${mark} ${s.description}${s.error ? `（${s.error}）` : ""}`);
  });
} else {
  console.log("（无计划产出）");
}

console.log("\n=== 最终回答 ===");
console.log(finalOutput.trim() || "（空）");

console.log(`\n=== 耗时 ${elapsedSec}s ===`);

try {
  const appended = readFileSync(LOG_FILE, "utf-8").slice(logSizeBefore);
  const interesting = appended.split("\n").filter((l) =>
    /步骤执行完成|资源检查|上下文窗口裁剪|执行后路由/.test(l));
  console.log("\n=== 本次执行记录 ===");
  if (interesting.length === 0) console.log("（无）");
  interesting.forEach((l) => console.log(l.replace(/^\[[^\]]+\]\s*/, "").replace(/^\[info\]\s*|^\[error\]\s*/, "")));
} catch {
  console.log("（读取日志失败）");
}
