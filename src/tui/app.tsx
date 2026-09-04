import { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, Static } from "ink";
import { Input } from "./input.js";
import { MessageItem, type OutputMessage } from "./output.js";
import {
  ptcProgramToMessage,
  ptcDispatchToMessage,
  extractRunCodeErrorKind,
  StreamAccumulator,
} from "./ptc.js";
import { handleCommand } from "./commands.js";
import { createAgentExecutor, createHierarchicalAgent, createPtcAgent, runAgentMessages } from "../agent/loop.js";
import type { AgentMemory } from "../memory/index.js";
import { GraphAgentExecutor } from "../agent/graph-agent-executor.js";
import { HierarchicalAgentLangGraph } from "../agent/hierarchical-agent-langgraph.js";
import { PtcAgentLangGraph } from "../ptc/ptc-agent-langgraph.js";
import type { ChatOpenAI } from "@langchain/openai";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentStep } from "@langchain/core/agents";
import type { ExecutionPlan } from "../agent/types.js";
import type { PtcDispatchEvent } from "../ptc/dispatch-bridge.js";
import { AgentMode, AppConfig } from "../config/index.js";
import { Tracer } from "../agent/tracer.js";
import { ToolStatsRegistry } from "../tools/stats-registry.js"
import { ToolFilter } from "../tools/tool-filter.js"

/** 统一流式块（三种模式并集；各模式只产出相关字段，见设计文档 §5.2 AgentStreamChunk） */
interface StreamChunk {
  plan?: ExecutionPlan;
  intermediateSteps?: AgentStep[];
  /** 最终回答（finalize/fallback 产出；累积进最终 assistant 消息） */
  output?: string;
  /** 中间轮次的叙述文字（agent 思考/说明，仅动态预览，不进入最终消息） */
  outputPreview?: string;
  ptcProgram?: { code: string; description: string };
  ptcDispatch?: PtcDispatchEvent;
}

interface AppProps {
  config: AppConfig;
  memory: AgentMemory;
  agentName?: string;
  llm: ChatOpenAI;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  tracer?: Tracer;
  toolStatsRegistry?: ToolStatsRegistry;
  toolFilter?: ToolFilter
}

export function App({ config, memory, agentName = "Agent", llm, tools, systemPrompt, tracer, toolStatsRegistry, toolFilter }: AppProps) {
  // ------------------------------------------------------------------
  // Message storage — split into "static" and "dynamic" arrays.
  //
  // <Static> renders items once and never clears/rewrites them. This is
  // critical for performance: when the user types a character, Ink only
  // needs to clear and rewrite the small dynamic area (2-3 lines) instead
  // of the entire terminal output (potentially 50+ lines of messages).
  //
  // - staticMessages: finalized messages (user, assistant, system, completed
  //   tool calls). These are appended to <Static> and never updated.
  // - dynamicMessages: running tool calls. These stay in the dynamic area
  //   and are moved to staticMessages when the tool completes.
  // ------------------------------------------------------------------
  const [staticMessages, setStaticMessages] = useState<OutputMessage[]>([]);
  const [dynamicMessages, setDynamicMessages] = useState<OutputMessage[]>([]);

  // Ref mirror of dynamicMessages for synchronous access in callbacks
  const dynamicMsgRef = useRef<OutputMessage[]>([]);

  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingTools, setStreamingTools] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState("Chat");
  const [agentMode, setAgentMode] = useState<AgentMode>(config.agentMode);

  // Refs to keep values accessible inside stable callbacks without
  // causing the callback identity to change (which would tear down
  // and recreate the stdin handler in ControlledTextInput, breaking input).
  const llmRef = useRef(llm);
  const toolsRef = useRef(tools);
  const executorRef = useRef<PtcAgentLangGraph | HierarchicalAgentLangGraph | GraphAgentExecutor | null>(null);

  // 按当前模式动态创建 executor；切换/卸载时 cleanup 释放旧 PTC 实例（worker runtime）
  useEffect(() => {
    const exec =
      agentMode === "ptc"
        ? createPtcAgent(llm, tools, {
            maxIterations: config.maxIterations,
            ptc: {
              maxProgramLength: config.ptcMaxProgramLength,
              maxWallMs: config.ptcMaxWallMs,
              maxOutputBytes: config.ptcMaxOutputBytes,
              maxParallelSubCalls: config.ptcMaxParallelSubCalls,
              mode: config.ptcMode,
            },
            toolFilter,
            tracer,
            toolStatsRegistry,
            llmTimeoutMs: config.llmTimeoutMs,
          })
        : agentMode === "plan"
          ? createHierarchicalAgent(llmRef.current, toolsRef.current, tracer, toolStatsRegistry, config.llmTimeoutMs)
          : createAgentExecutor(
              llm,
              tools,
              systemPrompt,
              config.maxIterations,
              toolStatsRegistry,
              toolFilter,
              tracer,
              config.llmTimeoutMs,
            );
    executorRef.current = exec;
    return () => {
      if (exec instanceof PtcAgentLangGraph) {
        void exec.dispose();
      }
    };
  }, [agentMode, llm, tools, config, systemPrompt, toolStatsRegistry, toolFilter, tracer]);
  useEffect(() => { llmRef.current = llm; }, [llm]);
  useEffect(() => { toolsRef.current = tools; }, [tools]);

  // Streaming token buffer — tokens accumulate here and are flushed to
  // state on a 50 ms interval to prevent a re-render on every token
  // (~20 fps instead of hundreds of renders per second).
  const streamingBufferRef = useRef("");

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setStreamingText(streamingBufferRef.current);
    }, 50);
    return () => clearInterval(interval);
  }, [running]);

  // Load existing messages from memory on mount
  useEffect(() => {
    (async () => {
      const session = await memory.getSession();
      if (session) {
        setSessionName(session.name);
        const msgs = await memory.store.getMessages(session.id);
        if (msgs.length > 0) {
          setStaticMessages(
            msgs.map((m) => ({
              role: m.role as "user" | "assistant" | "system" | "tool",
              content: m.content,
              timestamp: m.createdAt,
            })),
          );
        }
      }
    })();
  }, [memory]);

  const handleToggleAgentMode = useCallback(() => {
    setAgentMode(prev => {
      const modes: AgentMode[] = ["normal", "plan", "ptc"]
      const next = modes[(modes.indexOf(prev)+1)%3];
      const label: Record<AgentMode, string> = {
        normal: "⚡ Standard ReAct mode. (Shift+Tab to toggle)",
        plan: "🗺️ Plan mode enabled. Agent will create a step-by-step plan before executing. (Shift+Tab to toggle)",
        ptc: "📦 PTC mode enabled. Agent writes TypeScript programs to batch tool calls. (Shift+Tab to toggle)",
      };
      setStaticMessages((msgs) => [
        ...msgs,
        {
          role: "system" as const,
          content: label[next],
          timestamp: new Date(),
        },
      ]);
      return next;
    });
  }, []);

  const onSubmit = useCallback(
    async (value: string) => {
      // Handle /session commands
      if (value.startsWith("/session")) {
        const parts = value.split(/\s+/);
        if (parts[1] === "new") {
          const s = await memory.store.createSession();
          await memory.switchSession(s.id);
          setSessionName(s.name);
          setStaticMessages([]);
          setDynamicMessages([]);
          dynamicMsgRef.current = [];
          setStreamingTools([]);
        } else if (parts[1] === "switch" && parts[2]) {
          const s = await memory.switchSession(parts[2]);
          if (s) {
            setSessionName(s.name);
            const msgs = await memory.store.getMessages(s.id);
            setStaticMessages(
              msgs.map((m) => ({
                role: m.role as "user" | "assistant" | "system" | "tool",
                content: m.content,
                timestamp: m.createdAt,
              })),
            );
            setDynamicMessages([]);
            dynamicMsgRef.current = [];
          }
        } else if (!parts[1] || parts[1] === "list") {
          const sessions = await memory.listSessions();
          const list = sessions
            .map((s) => `${s.id.slice(0, 8)}: ${s.name}`)
            .join("\n");
          setStaticMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `Sessions:\n${list}`,
              timestamp: new Date(),
            },
          ]);
        }
        return;
      }

      if (value.startsWith("/")) {
        const result = handleCommand(value);
        if (result === "CLEAR") {
          setStaticMessages([]);
          setDynamicMessages([]);
          dynamicMsgRef.current = [];
          setStreamingTools([]);
          return;
        }
        // /show is not supported with <Static> — static messages can't
        // be updated after rendering. Silently ignore.
        if (value.startsWith("/show")) return;
        if (result)
          setStaticMessages((prev) => [
            ...prev,
            { role: "system", content: result, timestamp: new Date() },
          ]);
        return;
      }

      // Add user message to static area
      setStaticMessages((prev) => [
        ...prev,
        { role: "user", content: value, timestamp: new Date() },
      ]);
      await memory.addUserMessage(value);
      setRunning(true);
      streamingBufferRef.current = "";
      setStreamingText("");
      setStreamingTools([]);

      try {
        let output: string;

        const exec = executorRef.current;
        if (!exec) {
          throw new Error("Agent executor not initialized yet");
        }
        const turn = await memory.prepareTurn(value)
        if (exec instanceof PtcAgentLangGraph) {
          // ---- PTC Mode: programmatic tool calling ----
          const streamAcc = new StreamAccumulator();

          const stream = exec.stream({ messages: turn.messages });
          for await (const rawChunk of stream) {
            const chunk = rawChunk as StreamChunk;
            // 中间叙述 → 仅动态预览；finalize 输出 → 进入最终回答（见 StreamAccumulator）
            streamAcc.push(chunk);
            streamingBufferRef.current = streamAcc.previewText;
            // run_code 程序卡片
            if (chunk.ptcProgram) {
              const p = chunk.ptcProgram;
              setStaticMessages((prev) => [
                ...prev,
                ptcProgramToMessage(p),
              ]);
            }
            // 程序内子调用事件
            if (chunk.ptcDispatch) {
              const ev = chunk.ptcDispatch;
              setStaticMessages((prev) => [
                ...prev,
                ptcDispatchToMessage(ev),
              ]);
            }
            if (chunk.intermediateSteps) {
              for (const step of chunk.intermediateSteps) {
                // run_code 步骤：卡片已由 ptcProgram 块展示，这里只补失败徽章
                if (step.action.tool === "run_code") {
                  const kind = extractRunCodeErrorKind(step.observation);
                  if (kind) {
                    setStaticMessages((prev) => [
                      ...prev,
                      {
                        role: "system",
                        content: `run_code failed: [${kind}]`,
                        timestamp: new Date(),
                      },
                    ]);
                  }
                  continue;
                }
                const msg: OutputMessage = {
                  role: "tool",
                  content: `Calling: ${step.action.tool}\n→ ${String(step.observation).slice(0, 200)}`,
                  name: step.action.tool,
                  timestamp: new Date(),
                };
                setStaticMessages((prev) => [...prev, msg]);
                setStreamingTools((prev) => [
                  ...prev,
                  `⚡ ${step.action.tool}`,
                ]);
              }
            }
          }
          output = streamAcc.output;
        } else if (exec instanceof HierarchicalAgentLangGraph) {
          // ---- Plan Mode: use HierarchicalAgentLangGraph ----
          const planExecutor = exec;
          const streamAcc = new StreamAccumulator();

          const stream = planExecutor.stream({ messages: turn.messages });
          for await (const rawChunk of stream) {
            const chunk = rawChunk as StreamChunk;
            // 中间叙述 → 仅动态预览；finalize 输出 → 进入最终回答
            streamAcc.push(chunk);
            streamingBufferRef.current = streamAcc.previewText;
            if (chunk.plan) {
              const plan = chunk.plan;
              const planText = [
                `🗺️ Plan: ${plan.goal}`,
                ...plan.steps.map(
                  (s: any, i: number) =>
                    `  ${i + 1}. [${s.status}] ${s.description}${s.result ? " → " + s.result.slice(0, 80) : ""}`,
                ),
              ].join("\n");
              setStaticMessages((prev) => [
                ...prev,
                { role: "system", content: planText, timestamp: new Date() },
              ]);
            }
            // PTC 块：run_code 程序卡片 / 程序内子调用（plan/普通模式不产生，零副作用；
            // PTC 模式接入后复用同一处理，见 5.7 stream 块契约）
            if (chunk.ptcProgram) {
              const p = chunk.ptcProgram;
              setStaticMessages((prev) => [
                ...prev,
                ptcProgramToMessage(p),
              ]);
            }
            if (chunk.ptcDispatch) {
              const ev = chunk.ptcDispatch;
              setStaticMessages((prev) => [
                ...prev,
                ptcDispatchToMessage(ev),
              ]);
            }
            if (chunk.intermediateSteps) {
              for (const step of chunk.intermediateSteps) {
                // run_code 步骤：卡片已由 ptcProgram 块展示，这里只补失败徽章
                if (step.action.tool === "run_code") {
                  const kind = extractRunCodeErrorKind(step.observation);
                  if (kind) {
                    setStaticMessages((prev) => [
                      ...prev,
                      {
                        role: "system",
                        content: `run_code failed: [${kind}]`,
                        timestamp: new Date(),
                      },
                    ]);
                  }
                  continue;
                }
                const msg: OutputMessage = {
                  role: "tool",
                  content: `Calling: ${step.action.tool}\n→ ${String(step.observation).slice(0, 200)}`,
                  name: step.action.tool,
                  timestamp: new Date(),
                };
                setStaticMessages((prev) => [...prev, msg]);
                setStreamingTools((prev) => [
                  ...prev,
                  `⚡ ${step.action.tool}`,
                ]);
              }
            }
          }
          output = streamAcc.output;
        } else {
          // ---- Normal Mode: use GraphAgentExecutor ----
          output = await runAgentMessages(exec as GraphAgentExecutor, turn.messages, {
            onToolStart(tool, input) {
              const msg: OutputMessage = {
                role: "tool",
                content: `Calling: ${tool}\n${JSON.stringify(input, null, 2)}`,
                name: tool,
                timestamp: new Date(),
                running: true,
              };
              dynamicMsgRef.current = [...dynamicMsgRef.current, msg];
              setDynamicMessages(dynamicMsgRef.current);
              setStreamingTools((prev) => [...prev, `⚡ ${tool}`]);
            },
            onToolEnd(result) {
              const runningTool = dynamicMsgRef.current.find((m) => m.running);
              if (runningTool) {
                const completed: OutputMessage = {
                  ...runningTool,
                  running: false,
                  content: `→ ${result.output}`,
                };
                setStaticMessages((prev) => [...prev, completed]);
                dynamicMsgRef.current = dynamicMsgRef.current.filter(
                  (m) => !m.running,
                );
                setDynamicMessages(dynamicMsgRef.current);
              }
              setStreamingTools((prev) => [
                ...prev,
                `  → ${result.output?.slice(0, 200)}`,
              ]);
            },
            onToken(token) {
              streamingBufferRef.current += token;
            },
            onFinish() {
              // handled below
            },
          }, config.llmTimeoutMs);
        }

        // Add final assistant response to static
        setStaticMessages((prev) => [
          ...prev,
          { role: "assistant", content: output, timestamp: new Date() },
        ]);
        await memory.addAssistantMessage(output);
        // 摘要后台生成，不阻塞回合收尾；顶层 .catch 兜住 DB/未预期异常
        void memory.rememberAfterTurn().catch((err) =>
          console.error(`[AgentMemory] rememberAfterTurn failed:`, err),
        );
        streamingBufferRef.current = "";
        setStreamingText("");
        setStreamingTools([]);
      } catch (error) {
        setStaticMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Error: ${(error as Error).message}`,
            timestamp: new Date(),
          },
        ]);
      } finally {
        setRunning(false);
      }
    },
    [memory],
  );

  // ------------------------------------------------------------------
  // Layout:
  //
  // <Static>  ← messages written once, never cleared/rewritten
  //   [user msg]
  //   [tool msg]
  //   [assistant msg]
  //   ...
  //
  // Dynamic area  ← only this part is cleared/rewritten on re-render
  //   status line (1 line)
  //   [running tool] (0-N lines, usually 0)
  //   [streaming tools] (0-N lines, usually 0)
  //   [streaming text] (0-N lines, usually 0)
  //   > input (1-2 lines)
  //   [Agent is thinking...] (0-1 lines)
  //
  // When typing (not running), dynamic area = 2-3 lines.
  // Clearing/rewriting 2-3 lines is nearly instant → no flicker.
  // ------------------------------------------------------------------
  return (
    <Box flexDirection="column">
      <Static items={staticMessages}>
        {(msg: OutputMessage, i: number) => (
          <MessageItem key={i} msg={msg} agentName={agentName} />
        )}
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {/* Status line */}
        <Text dimColor>
          {" "}Navigate Agent | {sessionName}
          {agentMode === "plan" ? (
            <Text color="magenta"> | 🗺️ Plan Mode</Text>
          ) : agentMode === "ptc" ? (
            <Text color="magenta"> | 📦 PTC Mode</Text>
          ) : null}
          {" "}(/help)
        </Text>

        {/* Running tool calls (dynamic) */}
        {dynamicMessages.map((msg, i) => (
          <MessageItem key={`dyn-${i}`} msg={msg} agentName={agentName} />
        ))}

        {/* Streaming tool calls (dynamic) */}
        {streamingTools.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            {streamingTools.map((t, i) => (
              <Text key={i} color="#888888">
                {t}
              </Text>
            ))}
          </Box>
        ) : null}

        {/* Streaming text (dynamic) */}
        {streamingText ? (
          <Box flexDirection="column" marginBottom={1}>
            <Box paddingY={1}>
              <Text bold color="#4FC3F7">
                {agentName}:
              </Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="white">
                {/* 中间叙述可能很长（PTC 模式 agent 逐步说明），截断尾部避免撑爆动态区域 */}
                {streamingText.length > 800
                  ? "…" + streamingText.slice(-800)
                  : streamingText}
              </Text>
            </Box>
          </Box>
        ) : null}

        {/* Input (dynamic) */}
        <Input
          onSubmit={onSubmit}
          disabled={running}
          agentMode={agentMode}
          onToggleAgentMode={handleToggleAgentMode}
        />

        {running ? (
          <Box paddingX={1}>
            <Text color="yellow">Agent is thinking...</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
