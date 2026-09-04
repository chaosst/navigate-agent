import { ToolStatsRegistry } from './../tools/stats-registry.js';
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ChatOpenAI } from "@langchain/openai";
import type { AgentStep } from "@langchain/core/agents";
import type { AgentEvents, AgentMessage } from "./types.js";
import { logAgent } from "./logger.js";
import { GraphAgentExecutor } from "./graph-agent-executor.js";
import { Tracer } from "./tracer.js";
import { HierarchicalAgentLangGraph } from "./hierarchical-agent-langgraph.js";
import { WorkerThreadCodeRuntime } from "../ptc/code-runtime-worker.js";
import { DispatchBridge } from "../ptc/dispatch-bridge.js";
import { RunCodeTool } from "../ptc/run-code-tool.js";
import { PtcAgentLangGraph } from "../ptc/ptc-agent-langgraph.js";
import { ToolFilter } from "../tools/tool-filter.js";

/** PTC 运行时配置（由 config/index.ts 的 PTC_* 字段聚合） */
export interface PtcAgentConfig {
  maxProgramLength: number;
  maxWallMs: number;
  maxOutputBytes: number;
  maxParallelSubCalls: number;
  mode: "code" | "both";
}

/**
 * 创建 PTC 模式 Agent（程序化工具调用）。
 *
 * 构造顺序（设计文档 §6.1）：runtime → bridge(全量 tools) → runCodeTool → visibleTools → PtcAgentLangGraph。
 * 注意：全量 tools 只进 DispatchBridge（程序内 tools.x() 调用目标），**不进图**；
 * 进图的只有按 mode 组装的 visibleTools（code 模式下仅 run_code）。
 */
export function createPtcAgent(
  llm: ChatOpenAI,
  tools: StructuredToolInterface[],
  config: {
    maxIterations: number;
    ptc: PtcAgentConfig;
    toolFilter?: ToolFilter;
    tracer?: Tracer;
    toolStatsRegistry?: ToolStatsRegistry;
    llmTimeoutMs?: number;
  },
): PtcAgentLangGraph {
  const tracer = config.tracer;

  // 1. 沙箱运行时：持有预算
  const runtime = new WorkerThreadCodeRuntime({
    maxWallMs: config.ptc.maxWallMs,
    maxOutputBytes: config.ptc.maxOutputBytes,
  });

  // 2. 分发桥：持有全量工具；变更类工具（shell/写/编辑）排他串行
  const bridge = new DispatchBridge(
    tools,
    config.toolFilter,
    undefined,
    tracer,
    config.ptc.maxParallelSubCalls,
    ["execute_command", "write_file", "edit_file"],
  );

  // 3. run_code 工具：注入 bridge + runtime
  const runCodeTool = new RunCodeTool({
    dispatch: bridge,
    runtime,
    maxProgramLength: config.ptc.maxProgramLength,
    tracer: tracer ?? new Tracer(),
  });

  // 4. 模型可见工具集：code → [run_code]；both → [run_code, ...tools]
  const visibleTools: StructuredToolInterface[] =
    config.ptc.mode === "code"
      ? [runCodeTool]
      : [runCodeTool, ...tools];

  // 5. 状态机（runtime 仅用于 dispose）
  return new PtcAgentLangGraph(
    llm,
    visibleTools,
    config.maxIterations,
    runtime,
    bridge,
    config.llmTimeoutMs,
    config.toolStatsRegistry,
  );
}


export function createHierarchicalAgent(
  llm: ChatOpenAI,
  tools: StructuredToolInterface[],
  tracer?: Tracer,
  toolStatsRegistry?: ToolStatsRegistry,
  llmTimeoutMs?: number,
): HierarchicalAgentLangGraph {
  return new HierarchicalAgentLangGraph(llm, tools, tracer, toolStatsRegistry, llmTimeoutMs);
}

/**
 * Create an agent executor using OpenAI tools agent with streaming support.
 */
export function createAgentExecutor(
  llm: ChatOpenAI,
  tools: StructuredToolInterface[],
  systemPrompt: string,
  maxIterations: number,
  toolStatsRegistry?: ToolStatsRegistry,
  toolFilter?: ToolFilter,
  tracer?: Tracer,
  llmTimeoutMs?: number,
): GraphAgentExecutor {
  
  return new GraphAgentExecutor(
    llm,
    tools,
    systemPrompt,
    maxIterations,
    toolStatsRegistry,
    toolFilter,
    tracer,
    llmTimeoutMs,
  );
}

function normalizeToolInput(
  input: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return { input };
    }
  }
  return input;
}

/**
 * Run the agent executor with streaming, emitting events for tool calls,
 * tokens, and completion.
 */
export async function runAgent(
  executor: GraphAgentExecutor,
  input: string,
  history?: AgentMessage[],
  events?: AgentEvents,
  timeoutMs = 30_000,
): Promise<string> {
  logAgent({ type: "info", message: `User: ${input.slice(0, 200)}` });
  const messageHistory: BaseMessage[] = history
    ? parseHistory(history)
    : [];
  messageHistory.push(new HumanMessage(input));
  return runAgentMessages(executor, messageHistory, events, timeoutMs)
}

export async function runAgentMessages(
  executor: GraphAgentExecutor,
  messages: BaseMessage[],
  events?: AgentEvents,
  timeoutMs = 30_000,
) {
  let output = "";
  let previousStepCount = 0;
  try {
    // 整体流超时包装（单次 LLM 调用超时由 executor 内部 llmTimeoutMs 控制）
    const streamPromise = executor.stream({ messages });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Agent execution timeout (${timeoutMs}ms)`)), timeoutMs)
    );
    const stream = await Promise.race([streamPromise, timeoutPromise]);
    for await (const chunk of stream) {
      const steps =
        (chunk.intermediateSteps as AgentStep[] | undefined) ?? [];
      if (steps.length > previousStepCount) {
        for (let i = previousStepCount; i < steps.length; i++) {
          const step = steps[i];
          const action = step.action;
          const toolInput = normalizeToolInput(action.toolInput);
          logAgent({ type: "tool_call", message: `${action.tool}`, details: toolInput });
          events?.onToolStart?.(action.tool, toolInput);
          const observation = step.observation?.toString() ?? "";
          logAgent({ type: "tool_result", message: `${action.tool}`, details: observation.slice(0, 500) });
          events?.onToolEnd?.({
            tool: action.tool,
            input: toolInput,
            output: observation,
            success: true,
            durationMs: 0,
          });
        }
        previousStepCount = steps.length;
      }
      if (chunk.output !== undefined && chunk.output !== null) {
        const chunkOutput = String(chunk.output);
        output += chunkOutput;
        events?.onToken?.(chunkOutput);
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logAgent({ type: "error", message: err.message, details: err.stack });
    events?.onError?.(err);
    throw err;
  }
  logAgent({ type: "llm_response", message: `Output: ${output.slice(0, 200)}` });
  events?.onFinish?.(output);
  return output;
}

/**
 * Parse an array of AgentMessage objects into LangChain BaseMessage objects.
 */
export function parseHistory(history: AgentMessage[]): BaseMessage[] {
  return history.map((msg: AgentMessage) => {
    switch (msg.role) {
      case "user":
        return new HumanMessage(msg.content);
      case "assistant":
        return new AIMessage(msg.content);
      case "system":
        return new SystemMessage(msg.content);
      case "tool":
        return new ToolMessage(msg.content, msg.tool_call_id ?? "");
      default:
        return new HumanMessage(msg.content);
    }
  });
}
