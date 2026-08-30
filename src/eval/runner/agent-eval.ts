/**
 * agent-eval.ts — Agent 行为评估（无 LLM 成本，纯数据统计）
 *
 * 输入：TraceSession（来自 Tracer.getSessions() 或 JSONL 文件）
 * 输出：AgentMetrics（工具成功率/错误率/迭代轮次/token 效率/PTC 成功率）
 *
 * 核心设计：computeAgentMetrics 是纯函数 —— 不碰 IO，只读 session 对象，
 * 可徒手构造 TraceSession 做单测。
 */
import { readFileSync } from "node:fs";
import type { TraceSession } from "../../agent/tracer.js";

export interface AgentMetrics {
  userInput: string;
  /** 总步数（steps.length） */
  stepCount: number;
  /** 成功 tool_result / 全部 tool_result；无工具调用 → 0 */
  toolSuccessRate: number;
  /** type === "error" 的条数 */
  errorCount: number;
  /** errorCount / stepCount */
  errorRate: number;
  /** 去重后的迭代轮次数 */
  iterations: number;
  /** finishedAt - startedAt（session 未结束 → 0） */
  latencyMs: number;
  /** totalInputTokens + totalOutputTokens */
  totalTokens: number;
  /** totalTokens / iterations（每轮思考的平均 token 成本） */
  tokenEfficiency: number;
  /** ptc_result 中 ptcKind === "ok" 的比例；无 ptc_result → null（而非 0） */
  ptcOkRate: number | null;
}

/** 纯函数：TraceSession → 指标 */
export function computeAgentMetrics(session: TraceSession): AgentMetrics {
  const steps = session.steps;
  const stepCount = steps.length;

  // 只看 tool_result（结算）不看 tool_call（发起）
  const toolResults = steps.filter((s) => s.type === "tool_result");
  const toolSuccess = toolResults.filter((s) => s.toolSuccess === true).length;
  const toolSuccessRate = toolResults.length === 0 ? 0 : toolSuccess / toolResults.length;

  const errorCount = steps.filter((s) => s.type === "error").length;
  const errorRate = stepCount === 0 ? 0 : errorCount / stepCount;

  const iterations = new Set(steps.map((s) => s.iteration)).size;

  const latencyMs = session.finishedAt ? session.finishedAt - session.startedAt : 0;

  const totalTokens = session.totalInputTokens + session.totalOutputTokens;
  const tokenEfficiency = iterations === 0 ? 0 : totalTokens / iterations;

  const ptcResults = steps.filter((s) => s.type === "ptc_result");
  const ptcOk = ptcResults.filter((s) => s.ptcKind === "ok").length;
  const ptcOkRate = ptcResults.length === 0 ? null : ptcOk / ptcResults.length;

  return {
    userInput: session.userInput,
    stepCount,
    toolSuccessRate,
    errorCount,
    errorRate,
    iterations,
    latencyMs,
    totalTokens,
    tokenEfficiency,
    ptcOkRate,
  };
}

/** 从 JSONL 读回 sessions（坏行跳过，不中断） */
export function loadSessionsFromJsonl(filePath: string): TraceSession[] {
  const content = readFileSync(filePath, "utf-8");
  const sessions: TraceSession[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      sessions.push(JSON.parse(trimmed) as TraceSession);
    } catch {
      // 坏行跳过：观测数据不能因为一条脏数据全盘作废
    }
  }
  return sessions;
}
