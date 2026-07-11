import { AgentExecutor, createOpenAIToolsAgent } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ChatOpenAI } from "@langchain/openai";
import type { AgentStep } from "@langchain/core/agents";
import type { AgentEvents, AgentMessage } from "./types.js";
import { logAgent } from "./logger.js";

/**
 * Create an agent executor using OpenAI tools agent with streaming support.
 */
export async function createAgentExecutor(
  llm: ChatOpenAI,
  tools: StructuredToolInterface[],
  systemPrompt: string,
  maxIterations: number,
): Promise<AgentExecutor> {
  const prompt = ChatPromptTemplate.fromMessages([
    new SystemMessage(systemPrompt),
    new MessagesPlaceholder("messages"),
    new MessagesPlaceholder("agent_scratchpad"),
  ]);
  const agent = await createOpenAIToolsAgent({
    llm,
    tools,
    prompt,
    streamRunnable: true,
  });
  return new AgentExecutor({
    agent,
    tools,
    maxIterations,
    returnIntermediateSteps: true,
    earlyStoppingMethod: "generate",
    handleParsingErrors: true,
  });
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
  executor: AgentExecutor,
  input: string,
  history?: AgentMessage[],
  events?: AgentEvents,
): Promise<string> {
  logAgent({ type: "info", message: `User: ${input.slice(0, 200)}` });
  const messageHistory: BaseMessage[] = history
    ? parseHistory(history)
    : [];
  messageHistory.push(new HumanMessage(input));
  let output = "";
  let previousStepCount = 0;
  try {
    const stream = await executor.stream(
      { messages: messageHistory },
    );
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
