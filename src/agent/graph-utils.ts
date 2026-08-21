import { AgentStep } from "@langchain/core/agents";
import { AIMessage, BaseMessage } from "langchain";
import { PtcStats } from "../ptc/type.js";


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
export function formatPtcStatsReport(stats: PtcStats): string {
    const { runCodeCalls, subCalls, programErrors, consecutiveErrors } = stats;

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