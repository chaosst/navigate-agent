/**
 * TrackingToolNode — 带中间步骤追踪的 ToolNode。
 *
 * 问题：LangGraph prebuilt 的 ToolNode 只返回 `{ messages }`（ToolMessage 列表），
 * 不会产出 `intermediateSteps` 字段——而 AgentState/PtcState 的该字段是自定义
 * reducer，只有节点显式返回才更新。因此 stream() 里 `value.tools.intermediateSteps`
 * 恒为空，TUI 永远看不到工具中间步骤（普通模式与 PTC 模式均受影响）。
 *
 * 本节点包装 ToolNode：执行工具后，从输入的最后一条 AIMessage.tool_calls
 * （含 name/args）与输出的 ToolMessage（含 name/content/tool_call_id）配对，
 * 构造 AgentStep[] 并随 `{ messages, intermediateSteps }` 一起返回，
 * 使 updates-mode 流能产出中间步骤（设计文档 §5.7）。
 */
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { AgentStep } from "@langchain/core/agents";

export class TrackingToolNode extends ToolNode {
  /**
   * 执行工具并附加 intermediateSteps。
   * input 为 `{ messages }` 或 BaseMessage[]（与 ToolNode 一致）；返回结构在
   * ToolNode 的 `{ messages }` 之上追加 `intermediateSteps`。
   */
  async run(input: unknown, config?: any): Promise<Record<string, unknown>> {
    // 1. 委托给原 ToolNode 执行工具（直接调用时 config 可为空，补默认值避免 runTool 读 config.context 崩溃）
    const result = (await super.run(input, config ?? { configurable: {} })) as {
      messages?: unknown[];
    };

    // 2. 从输入取最后一条 AIMessage（含 tool_calls：name/args）
    const rawMessages: unknown[] = Array.isArray(input)
      ? input
      : Array.isArray((input as { messages?: unknown[] })?.messages)
        ? ((input as { messages: unknown[] }).messages)
        : [];
    let lastAi: { tool_calls?: Array<{ id?: string; name?: string; args?: unknown }> } | undefined;
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const m = rawMessages[i] as { _getType?: () => string };
      if (m?._getType?.() === "ai") {
        lastAi = m as typeof lastAi;
        break;
      }
    }
    const callById = new Map<string, { id?: string; name?: string; args?: unknown }>(
      (lastAi?.tool_calls ?? []).map((tc) => [tc.id ?? "", tc]),
    );

    // 3. 从输出 ToolMessage 构造 AgentStep[]（name/content ↔ tool_call_id）
    const steps: AgentStep[] = [];
    for (const msg of result.messages ?? []) {
      const m = msg as {
        _getType?: () => string;
        name?: string;
        content: unknown;
        tool_call_id?: string;
      };
      if (m?._getType?.() !== "tool") continue;
      const tc = callById.get(m.tool_call_id ?? "");
      steps.push({
        action: {
          tool: m.name ?? tc?.name ?? "?",
          toolInput: (tc?.args ?? {}) as Record<string, unknown>,
          log: "",
        },
        observation: m.content as AgentStep["observation"],
      });
    }

    return { ...result, intermediateSteps: steps };
  }
}
