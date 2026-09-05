import { AgentStep } from "@langchain/core/agents";
import { AIMessage, BaseMessage } from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import { PtcStats } from "../ptc/types.js";
import type { ToolStatsRegistry } from "../tools/stats-registry.js";
import type { Tracer } from "./tracer.js";


/** 从消息链提取最终回答文本（最后一条 AI 消息） */
export function extractFinalAnswer(messages: BaseMessage[]): string { 
    let output = extractText((messages.at(-1) as AIMessage).content)
    return output
}

/** 从 LLM 返回的 content（可能是 string 或复杂数组）中提取纯文本 */
export function extractText(content: string | Record<string, unknown>[]): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && "text" in c) return String(c.text);
          return "";
        })
        .join("");
    }
    return String(content);
}

/** 构造「迭代耗尽」兜底摘要（普通模式 / PTC 共用） */
export function buildIterationExhaustedSummary(
  iterations: number,
  steps: AgentStep[],
): string {
    const fallback = `I've used all ${iterations} iterations. Here's what I know:\n${steps
        .map(
          (s) =>
            `- ${s.action.tool}: ${String(s.observation).slice(0, 200)}`,
        )
        .join("\n")}`;

    return fallback
}

/** 格式化 PTC 统计报告（仅 PTC 使用，注入 finalize） */
export function formatPtcStatsReport(stats: PtcStats): string {    const { runCodeCalls, subCalls, programErrors, consecutiveErrors } = stats;

    if (runCodeCalls === 0) return "";   // 无 PTC 活动：不追加无意义报告
  
    const failedRuns = Math.min(programErrors, runCodeCalls);         // 防御截断
    const successRuns = runCodeCalls - failedRuns;
    const failureRate = Math.round((failedRuns / runCodeCalls) * 100);
    const avgSubCalls = (subCalls / runCodeCalls).toFixed(1);
  
    const lines = [
      "📦 PTC 执行统计",
      `- run_code 调用：${runCodeCalls} 次（成功 ${successRuns} / 失败 ${failedRuns}，失败率 ${failureRate}%）`,
      `- 工具子调用：${subCalls} 次（平均每次程序 ${avgSubCalls} 次）`,
    ];
  
    if (consecutiveErrors >= 3) {
      lines.push(`- ⚠️ 连续 ${consecutiveErrors} 次程序失败，已触发降级（可要求我改用更小的程序或逐步调用）`);
    } else if (consecutiveErrors > 0) {
      lines.push(`- 当前连续失败 ${consecutiveErrors} 次`);
    }
  
    return lines.join("\n");
}

/** 折叠保留的最近「工具轮」数：AGENT_TOOL_WINDOW_ROUNDS 可调，0 = 禁用折叠 */
const OLD_TOOL_WINDOW_ROUNDS = (() => {
  const n = parseInt(process.env.AGENT_TOOL_WINDOW_ROUNDS ?? "4", 10);
  return Number.isFinite(n) && n >= 0 ? n : 4;
})();

/** 旧 ToolMessage 折叠后保留的开头字符数 */
const FOLD_SNIPPET = 300;

/**
 * 轮内上下文收敛：多步任务随轮次增长，把所有历史工具结果原样带进下一轮 prefill 会让
 * 输入 token 线性膨胀。本函数把「超过最近 keepRounds 轮」的旧 ToolMessage 内容折叠成
 * 开头 300 字符 + 标记（只砍载荷、保留消息结构与 tool_call_id/name），供 agentNode 发给
 * LLM 前对副本调用——不改动 state.messages，不影响 no-progress 检测与最终 stats。
 */
export function foldOldToolResults(
  messages: BaseMessage[],
  keepRounds: number = OLD_TOOL_WINDOW_ROUNDS,
): BaseMessage[] {
  if (keepRounds <= 0 || messages.length === 0) return messages;

  // 标轮次：带 tool_calls 的 AI 消息开新轮；ToolMessage 归属最近一次开轮
  const roundOf: number[] = new Array(messages.length).fill(-1);
  let round = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m._getType() === "ai" && (m as { tool_calls?: unknown[] }).tool_calls?.length) {
      round++;
    } else if (m._getType() === "tool") {
      roundOf[i] = round;
    }
  }
  const cutoffRound = round - keepRounds;
  if (cutoffRound < 0) return messages; // 工具轮数没超过窗口，全保留

  return messages.map((m, i) => {
    if (m._getType() !== "tool" || roundOf[i] > cutoffRound) return m;
    const content = m.content;
    if (typeof content !== "string" || content.length <= FOLD_SNIPPET) return m;
    const tm = m as ToolMessage;
    return new ToolMessage(
      content.slice(0, FOLD_SNIPPET) +
        `\n…[旧工具结果已折叠：原始 ${content.length} 字符，仅保留开头 ${FOLD_SNIPPET}]…`,
      tm.tool_call_id ?? "",
      tm.name,
    );
  });
}

/**
 * 统计消息链「末尾连续 search_documents 空命中」的次数（中间有其它工具结果即停止）。
 * RAG 空检索常每轮换关键词（args 变化），detectNoProgressLoop 抓不到；
 * 用连续空命中次数做收敛判定。与检索工具的空命中措辞耦合（/No relevant documents found/i）。
 */
export function countFutileRagSearch(messages: BaseMessage[]): number {
  const EMPTY_RE = /No relevant documents found/i;
  let empty = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType() !== "tool") continue; // AI/Human/System 跳过
    const tm = messages[i] as unknown as { name?: string; content: unknown };
    if (tm.name === "search_documents" && typeof tm.content === "string" && EMPTY_RE.test(tm.content)) {
      empty += 1;
      continue;
    }
    return empty; // 非空 search_documents 命中或其它工具介入 → 结束累计
  }
  return empty;
}

export function extractUserText(messages: BaseMessage[]): string {
    return messages
        .filter((m) => m._getType() === "human")
        .map((m) => toText(m.content))
        .join(" ");
}

function toText(content: BaseMessage["content"]): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c === "string" ? c : "text" in c ? String(c.text) : ""))
        .join("");
    }
    return String(content);
}

/**
 * 生成最终输出的统计脚注：工具调用统计（若 registry 有调用记录）+ token 消耗。
 *
 * 三种模式（normal / plan / ptc）的 finalize/fallback 共用；返回空串表示无统计可显示。
 * 注意：必须在 tracer.finishSession() 之前调用（读取当前 session 的 token 累计）。
 */
export function buildStatsFooter(
  toolStatsRegistry?: ToolStatsRegistry,
  tracer?: Tracer,
): string {
  const parts: string[] = [];

  const toolReport = toolStatsRegistry?.getReport();
  if (toolReport) parts.push(toolReport);

  const session = tracer?.getCurrentSession();
  if (session && (session.totalInputTokens > 0 || session.totalOutputTokens > 0)) {
    parts.push(`Tokens: ${session.totalInputTokens} in / ${session.totalOutputTokens} out`);
  }

  return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
}