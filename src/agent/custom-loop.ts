import { ChatOpenAI } from "@langchain/openai";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentStep } from "@langchain/core/agents";
import { logAgent } from "./logger.js";
import type { ToolStatsRegistry } from "../tools/stats-registry.js";
import { ToolFilter } from "../tools/tool-filter.js";
import type { PermissionWrapper } from "../tools/permission.js";
import { Tracer, type TraceEntry } from "./tracer.js";

/**
 * CustomAgent — 手写 Agent Loop，完全替代 LangChain AgentExecutor。
 *
 * 核心循环（ReAct 模式）：
 *
 *   for iteration in 0..maxIterations:
 *     1. LLM.invoke(messages, tools)  ──→ 得到 response
 *     2. if response.tool_calls:
 *          for each tool_call:
 *            执行工具 → ToolMessage(结果) → append 到 messages
 *          continue  ← 回到第 1 步
 *     3. else:
 *          yield { output: response.content }  ← 这是最终答案
 *         return
 *
 * 对比 AgentExecutor：
 *   - ❌ 不再黑盒：每行代码都可见、可控
 *   - ❌ 不再依赖 langchain/agents 包
 *   - ✅ 兼容现有 .stream() 调用方（TUI、Server）
 */
export class CustomAgent {
  private llm: ChatOpenAI;
  private allTools: StructuredToolInterface[];
  private toolMap: Map<string, StructuredToolInterface>;
  private systemPrompt: string;
  private maxIterations: number;
  /** 可选：中央工具统计注册表 */
  private toolStatsRegistry?: ToolStatsRegistry;
  /** 可选：动态工具过滤器 */
  private toolFilter?: ToolFilter;
  /** 可选：执行轨迹记录器 */
  tracer?: Tracer;

  constructor(
    llm: ChatOpenAI,
    tools: StructuredToolInterface[],
    systemPrompt: string,
    maxIterations: number,
    toolStatsRegistry?: ToolStatsRegistry,
    toolFilter?: ToolFilter,
    tracer?: Tracer,
  ) {
    this.llm = llm;
    this.allTools = tools;
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
    this.systemPrompt = systemPrompt;
    this.maxIterations = maxIterations;
    this.toolStatsRegistry = toolStatsRegistry;
    this.toolFilter = toolFilter;
    this.tracer = tracer ?? new Tracer();
  }

  /**
   * 流式执行 Agent 循环，产出与 AgentExecutor.stream() 兼容的块。
   *
   * 产出的每个 chunk:
   *   { output?: string; intermediateSteps?: AgentStep[] }
   *
   * - 每完成一次工具调用，产出一个带 intermediateSteps 的 chunk
   * - 得到最终答案时，产出一个带 output 的 chunk
   */
  async *stream(params: {
    messages: BaseMessage[];
  }): AsyncGenerator<{
    output?: string;
    intermediateSteps?: AgentStep[];
  }> {
    // ── 1. 组装完整消息链 ──
    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      ...params.messages,
    ];

    const intermediateSteps: AgentStep[] = [];

    // 提取原始用户输入（用于动态工具过滤）
    const userInput = params.messages
      .filter((m): m is HumanMessage => m.constructor.name === "HumanMessage" || m._getType() === "human")
      .map((m) => (m as HumanMessage).content)
      .filter((c): c is string => typeof c === "string")
      .join(" ");

    // 开始追踪
    if (userInput) {
      this.tracer?.startSession(userInput);
    }

    // ── 2. 主循环：Think → Act → Observe ──
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      logAgent({
        type: "info",
        message: `Iteration ${iteration + 1}/${this.maxIterations}`,
      });

      // ── 工具过滤：只暴露与当前输入相关的工具 ──
      let activeTools = this.allTools;
      if (this.toolFilter && userInput) {
        // createTools() 已保证所有工具都是 PermissionWrapper，直接断言
        const filtered = this.toolFilter.filter(
          this.allTools as PermissionWrapper[],
          userInput,
        );
        if (filtered.length > 0) {
          activeTools = filtered;
          logAgent({
            type: "info",
            message: `Filtered to ${filtered.length}/${this.allTools.length} tools`,
          });
        }
        // 过滤后为空时降级到全部工具（安全第一）
      }

      const llmWithTools = this.llm.bindTools(activeTools);

      // ── 2a. Think：LLM 推理 ──
      let response;
      const llmStart = performance.now();
      try {
        response = await llmWithTools.invoke(messages, {
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logAgent({ type: "error", message: `LLM invoke failed: ${errMsg}` });
        this.tracer?.addError(errMsg);

        // 优雅降级：如果绑工具失败，去掉工具再试一次
        if (iteration === 0) {
          logAgent({
            type: "info",
            message: "Retrying without tool binding...",
          });
          response = await this.llm.invoke(messages, {
            signal: AbortSignal.timeout(30000),
          });
        } else {
          throw new Error(`Agent loop failed at iteration ${iteration + 1}: ${errMsg}`);
        }
      }
      const llmDuration = performance.now() - llmStart;

      // 记录 LLM 调用
      const toolCalls = response.tool_calls;
      const usage = (response as any).usage_metadata;
      this.tracer?.addLLMCall(
        iteration,
        `messages[${messages.length}]`,
        toolCalls?.length ? null : extractText(response.content),
        toolCalls?.map((tc: any) => tc.name as string) ?? null,
        llmDuration,
        usage?.input_tokens,
        usage?.output_tokens,
      );

      // ── 2b. 无 tool_calls → 这就是最终答案 ──
      if (!toolCalls || toolCalls.length === 0) {
        let output = extractText(response.content);
        logAgent({
          type: "llm_response",
          message: `Final answer (${output.length} chars)`,
        });
        // 在最终回复末尾附上工具调用统计（如果有注册表且有调用记录）
        if (this.toolStatsRegistry?.getTotalCalls() ?? 0 > 0) {
          const statsReport = this.toolStatsRegistry!.getReport();
          if (statsReport) {
            output += "\n\n" + statsReport;
          }
        }
        this.tracer?.finishSession();
        yield { output, intermediateSteps };
        return;
      }

      // ── 2c. 有 tool_calls → Act & Observe ──
      // 先把 AIMessage（含 tool_calls）入对话，否则后续 ToolMessage 会报：
      // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
      messages.push(response);

      // 并发执行所有工具调用（Promise.all 让网络 IO 并行）
      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          const toolName = tc.name as string;
          const toolArgs = (tc.args ?? {}) as Record<string, unknown>;

          logAgent({ type: "tool_call", message: `${toolName}`, details: toolArgs });
          this.tracer?.addToolCall(iteration, toolName, toolArgs);

          const tool = this.toolMap.get(toolName);
          if (!tool) {
            const errorMsg = `Tool "${toolName}" not found. Available: ${Array.from(this.toolMap.keys()).join(", ")}`;
            logAgent({ type: "error", message: errorMsg });
            return { tc, toolName, toolArgs, result: errorMsg, success: false, durationMs: 0 };
          }

          const startTime = Date.now();
          try {
            const result = await tool.invoke(toolArgs);
            const durationMs = Date.now() - startTime;
            logAgent({ type: "tool_result", message: `${toolName} (${durationMs}ms)`, details: result.slice(0, 500) });
            return { tc, toolName, toolArgs, result, success: true, durationMs };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logAgent({ type: "error", message: `❌ ${toolName}: ${errMsg}` });
            return { tc, toolName, toolArgs, result: `Error: ${errMsg}`, success: false, durationMs: Date.now() - startTime };
          }
        }),
      );

      // 收集结果：注入消息、记录追踪、产出流式块
      for (const r of toolResults) {
        intermediateSteps.push({
          action: { tool: r.toolName, toolInput: r.toolArgs, log: "" },
          observation: r.result,
        });

        messages.push(new ToolMessage({ content: r.result, tool_call_id: r.tc.id as string }));
        this.tracer?.completeToolCall(r.result, r.success, r.durationMs);

        yield { intermediateSteps: [{ action: { tool: r.toolName, toolInput: r.toolArgs, log: "" }, observation: r.result }] };
      }

      // ── 2d. 到了最后一步还没出答案，给个兜底消息 ──
      if (iteration === this.maxIterations - 1) {
        const fallback = `I've used all ${this.maxIterations} iterations. Here's what I know:\n${intermediateSteps
          .map(
            (s) =>
              `- ${s.action.tool}: ${String(s.observation).slice(0, 200)}`,
          )
          .join("\n")}`;
        yield { output: fallback, intermediateSteps };
        return;
      }
    }
  }

  /**
   * 同步执行：输入文本，输出最终回复（不流式，Worker 专用）
   */
  async run(input: string): Promise<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      new HumanMessage(input),
    ];
    const llmWithTools = this.llm.bindTools(this.allTools);
    const toolOutputs: string[] = [];

    // Worker 埋点：确保 tracer session 存在
    if (!this.tracer?.getCurrentSession()) {
      this.tracer?.startSession(`[worker] ${input}`);
    }

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // ── LLM 调用 ──
      const llmStart = performance.now();
      let response;
      try {
        response = await llmWithTools.invoke(messages, {
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logAgent({ type: "error", message: `[worker] LLM invoke failed: ${errMsg}` });
        this.tracer?.addError(errMsg, "worker");
        // 降级：尝试无工具再调用一次
        if (iteration === 0) {
          response = await this.llm.invoke(messages, {
            signal: AbortSignal.timeout(30000),
          });
        } else {
          throw new Error(`Worker agent loop failed at iteration ${iteration + 1}: ${errMsg}`);
        }
      }
      const llmDuration = performance.now() - llmStart;
      const toolCalls = response.tool_calls;
      const usage = (response as any).usage_metadata;

      this.tracer?.addLLMCall(
        iteration,
        `[worker] messages[${messages.length}]`,
        toolCalls?.length ? null : extractText(response.content),
        toolCalls?.map((tc: any) => tc.name as string) ?? null,
        llmDuration,
        usage?.input_tokens,
        usage?.output_tokens,
        "worker",
      );

      if (!toolCalls || toolCalls.length === 0) {
        return extractText(response.content);
      }

      messages.push(response);
      for (const tc of toolCalls) {
        const toolName = tc.name as string;
        const toolArgs = tc.args as Record<string, unknown>;
        this.tracer?.addToolCall(iteration, toolName, toolArgs, "worker");

        const tool = this.toolMap.get(toolName);
        if (!tool) {
          const errMsg = `Tool "${toolName}" not found`;
          messages.push(new ToolMessage({ content: errMsg, tool_call_id: tc.id as string }));
          this.tracer?.completeToolCall(errMsg, false, 0, "worker");
          continue;
        }
        try {
          const startTime = Date.now();
          const result = await tool.invoke(toolArgs);
          const durationMs = Date.now() - startTime;
          messages.push(new ToolMessage({ content: result, tool_call_id: tc.id as string }));
          toolOutputs.push(`[${toolName}] ${result.slice(0, 500)}`);
          this.tracer?.completeToolCall(result, true, durationMs, "worker");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          messages.push(new ToolMessage({ content: `Error: ${errMsg}`, tool_call_id: tc.id as string }));
          this.tracer?.completeToolCall(errMsg, false, 0, "worker");
        }
      }
    }

    // 超限：用 LLM 总结已收集的中间结果，不直接返回原始工具输出
    if (toolOutputs.length > 0) {
      try {
        // 构造总结 prompt，不带工具绑定，强制 LLM 输出纯文本总结
        const summaryPrompt = `You are summarizing the results of your work so far.
You ran out of iterations, but here are the tool outputs you collected:

${toolOutputs.join("\n")}

Please provide a clear summary of what you found so far. Be concise and focus on actionable information.`;
        messages.push(new HumanMessage(summaryPrompt));
        const summaryResponse = await this.llm.invoke(messages, {
          signal: AbortSignal.timeout(30000),
        });
        const summary = extractText(summaryResponse.content).trim();
        if (summary) {
          return `[Worker partial — iterations exhausted]\n${summary}`;
        }
      } catch {
        // 总结失败，降级到原始输出
      }
    }
    return `[Worker partial — ${this.maxIterations} iterations used, no summary available]`;
  }
}

/** 从 LLM 返回的 content（可能是 string 或复杂数组）中提取纯文本 */
function extractText(content: string | Record<string, unknown>[]): string {
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
