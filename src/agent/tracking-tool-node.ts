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
import { ToolMessage } from "@langchain/core/messages";
import type { Tracer } from "./tracer.js";

/**
 * 工具结果进上下文前的体积上限（字符）。
 * 真实案底：search_files 在整仓库搜词命中 node_modules/dist，产出近 10MB
 * 结果原样塞进 ToolMessage → 下一轮 LLM 请求 140 万 token → DeepSeek 400。
 * 这里在 LangGraph 工具节点出口统一截断：只保留头尾 + 截断标记。
 * 可经 MAX_TOOL_RESULT_CHARS 覆盖（0 或非法 → 回退默认 20000）。
 */
const MAX_TOOL_RESULT_CHARS = (() => {
  const n = parseInt(process.env.MAX_TOOL_RESULT_CHARS ?? "20000", 10);
  return Number.isFinite(n) && n > 0 ? n : 20000;
})();

/** 超长字符串保留头尾的截断；非字符串或未超限原样返回 */
function capResultContent(content: unknown, maxChars: number): unknown {
  if (typeof content !== "string" || content.length <= maxChars) return content;
  const headLen = Math.ceil(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  const head = content.slice(0, headLen);
  const tail = content.slice(content.length - tailLen);
  return `${head}\n…[工具输出过长已截断：原始 ${content.length} 字符，仅保留首尾 ${maxChars}]…\n${tail}`;
}

export class TrackingToolNode extends ToolNode {
  private maxToolResultChars: number;
  private tracer?: Tracer;

  /** 工具执行 + 结果截断 + 工具轨迹记录。maxToolResultChars/tracer 供调用方注入（tracer 缺省不记） */
  constructor(tools: ConstructorParameters<typeof ToolNode>[0], opts?: { maxToolResultChars?: number; tracer?: Tracer }) {
    super(tools);
    this.maxToolResultChars = opts?.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS;
    this.tracer = opts?.tracer;
  }

  /**
   * 执行工具并附加 intermediateSteps + 向 Tracer 记录 tool_call/tool_result。
   * input 为 `{ messages, iteration }` 或 BaseMessage[]（与 ToolNode 一致）；返回结构在
   * ToolNode 的 `{ messages }` 之上追加 `intermediateSteps`。
   */
  async run(input: unknown, config?: any): Promise<Record<string, unknown>> {
    // 轮次（LangGraph 工具节点收到的 input 是完整 state，含 iteration）
    const iterRaw = !Array.isArray(input) ? (input as { iteration?: number })?.iteration : undefined;
    const iteration = typeof iterRaw === "number" ? iterRaw : 0;

    // 1. 委托给原 ToolNode 执行工具（直接调用时 config 可为空，补默认值避免 runTool 读 config.context 崩溃）
    //    记录每个工具在本次运行前的调用窗口数，结束后做差得到本次耗时（PermissionWrapper 有 stats.calls）
    const beforeCount = new Map<string, number>();
    for (const tool of this.tools as Array<{ name?: string; stats?: { calls?: Array<{ start: number; dur: number }> } }>) {
      if (tool?.name && Array.isArray(tool.stats?.calls)) beforeCount.set(tool.name, tool.stats.calls.length);
    }
    const result = (await super.run(input, config ?? { configurable: {} })) as {
      messages?: unknown[];
    };

    // 每个工具本次新增调用窗口的总耗时（供逐条 ToolMessage 归因）
    const toolAddedMs = new Map<string, number>();
    for (const tool of this.tools as Array<{ name?: string; stats?: { calls?: Array<{ start: number; dur: number }> } }>) {
      const calls = tool?.stats?.calls;
      if (!tool?.name || !Array.isArray(calls)) continue;
      const n0 = beforeCount.get(tool.name) ?? 0;
      let sum = 0;
      for (let i = n0; i < calls.length; i++) sum += calls[i]?.dur ?? 0;
      if (sum > 0) toolAddedMs.set(tool.name, sum);
    }

    // 1.5 截断工具结果再进上下文/状态：超长 ToolMessage 只保留头尾 + 标记
    //     （防止大结果滚雪球：本轮结果塞进 messages → 下轮 prefill/请求直接爆掉）
    const cappedMessages = (result.messages ?? []).map((m) => {
      const msg = m as { _getType?: () => string; tool_call_id?: string; name?: string; content: unknown };
      if (msg?._getType?.() !== "tool") return m;
      const capped = capResultContent(msg.content, this.maxToolResultChars);
      if (capped === msg.content) return m;
      // 重建 ToolMessage（避免依赖 .content setter；构造签名对齐 loop.ts parseHistory 的用法）
      return new ToolMessage(capped as string, msg.tool_call_id ?? "", msg.name);
    });

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

    // 3. 从输出 ToolMessage 构造 AgentStep[]（name/content ↔ tool_call_id）——用截断后的 messages
    //    并同步向 Tracer 记 tool_call/tool_result（LangGraph 路径此前从不记录，eval 工具统计恒空）
    const toolMsgs = cappedMessages.filter(
      (m) => (m as { _getType?: () => string })?._getType?.() === "tool",
    ) as Array<{ _getType?: () => string; name?: string; content: unknown; tool_call_id?: string }>;
    const nameCount = new Map<string, number>();
    for (const m of toolMsgs) {
      const n = m.name ?? callById.get(m.tool_call_id ?? "")?.name ?? "?";
      nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
    }

    const steps: AgentStep[] = [];
    for (const m of toolMsgs) {
      const tc = callById.get(m.tool_call_id ?? "");
      const toolName = m.name ?? tc?.name ?? "?";
      const strContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const added = toolAddedMs.get(toolName) ?? 0;
      const share = nameCount.get(toolName) ?? 1;
      const durationMs = share > 0 ? added / share : 0;
      const success = !/^Error:/.test(strContent);
      steps.push({
        action: { tool: toolName, toolInput: (tc?.args ?? {}) as Record<string, unknown>, log: "" },
        observation: m.content as AgentStep["observation"],
      });
      this.tracer?.addToolCall(iteration, toolName, (tc?.args ?? {}) as Record<string, unknown>, "main");
      this.tracer?.completeToolCall(strContent, success, durationMs, "main");
    }

    return { ...result, messages: cappedMessages, intermediateSteps: steps };
  }
}
