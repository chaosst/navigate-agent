/**
 * plan-events.ts — plan 模式（HierarchicalAgentLangGraph）流式 chunk → SSE 事件的纯适配层。
 *
 * 为什么要这一层：
 *   /api/resume/chat 直接在路由里 if/else 拼 SSE 帧，能跑但不可单测（要起 Express、要真 LLM）。
 *   这里把「chunk 长什么样 → 前端该收到什么」压成一个纯函数，路由只负责 write()。
 *
 * ⚠️ 与 ParallelEvent（src/rag/parallel-answer.ts:17-22）的 type 名有重叠
 *    （"plan" / "answer" / "error"），但两者是独立通道、独立 union，
 *    不要共用 handler，也不要用 rag-ask 的 formatSseEvent 序列化本 union。
 */
import type { AgentStep } from "@langchain/core/agents";
import type { ExecutionPlan } from "../agent/types.js";

/**
 * 引擎 stream() 实际会吐出的 chunk 形状
 * （HierarchicalAgentLangGraph.stream，src/agent/hierarchical-agent-langgraph.ts:1093-1207）。
 *
 * 保留 outputPreview 字段仅为与引擎契约对齐 —— 它在 plan 模式下恒不产生：
 * 该分支要求节点返回 messages，而只有 finalizeNode(:996) / fallbackNode(:1024) 返回 messages，
 * 且这两个走的是 output 分支。plannerNode(:297) / executorNode(:417) 都不返回 messages。
 */
export interface PlanStreamChunk {
  plan?: ExecutionPlan;
  intermediateSteps?: AgentStep[];
  /** finalize / fallback 的权威最终回答（整段，非逐 token） */
  output?: string;
  /** 仅为契约对齐；plan 模式下永不出现，见上方说明 */
  outputPreview?: string;
}

export type WorkflowEvent =
  | { type: "plan"; plan: ExecutionPlan }
  | { type: "tool"; tool: string; input: unknown; observation: string }
  | { type: "answer"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** 单事件 → SSE 帧。与 src/server/rag-ask.ts 的 formatSseEvent 同构。 */
export function formatSseFrame(ev: { type: string }): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** observation 上限：防止一次工具返回把前端 DOM / 内存打爆 */
export const MAX_OBSERVATION_CHARS = 4000;

/** 统一把 observation 折成有上限的字符串（对象 → JSON，超长 → 截断加标记） */
export function toObservationString(obs: unknown): string {
  const s = typeof obs === "string" ? obs : JSON.stringify(obs ?? "");
  return s.length > MAX_OBSERVATION_CHARS
    ? s.slice(0, MAX_OBSERVATION_CHARS) + "…(截断)"
    : s;
}

/**
 * chunk → 事件数组，保序：plan 在前，tool 居中，answer 收尾。
 * 顺序与引擎 yield 顺序一致（langgraph.ts:1169 → 1177 → 1188），前端的
 * 「工具归属哪一步」依赖这个顺序（见 agent-plan.html 的 applyTool 注释）。
 */
export function chunkToEvents(chunk: PlanStreamChunk): WorkflowEvent[] {
  const out: WorkflowEvent[] = [];

  if (chunk.plan) out.push({ type: "plan", plan: chunk.plan });

  for (const step of chunk.intermediateSteps ?? []) {
    const tool = step.action?.tool;
    // 无 action 的步骤无法归属到任何工具，直接丢弃（否则前端要处理空 tool 名）
    if (!tool) continue;
    out.push({
      type: "tool",
      tool,
      input: step.action?.toolInput ?? null,
      observation: toObservationString(step.observation),
    });
  }

  if (chunk.output) out.push({ type: "answer", text: String(chunk.output) });

  return out;
}
