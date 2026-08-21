import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, Static } from "ink";
import { Input } from "./input.js";
import { MessageItem, type OutputMessage } from "./output.js";
import { handleCommand } from "./commands.js";
import { runAgent } from "../agent/loop.js";
import type { AgentMessage } from "../agent/types.js";
import type { AgentMemory } from "../memory/index.js";
import { GraphAgentExecutor } from "../agent/graph-agent-executor.js";
import { HierarchicalAgentLangGraph } from "../agent/hierarchical-agent-langgraph.js";
import type { ChatOpenAI } from "@langchain/openai";
import type { StructuredToolInterface } from "@langchain/core/tools";

interface AppProps {
  executor: GraphAgentExecutor;
  memory: AgentMemory;
  agentName?: string;
  llm: ChatOpenAI;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  maxIterations: number;
}

export function App({ executor, memory, agentName = "Agent", llm, tools, systemPrompt, maxIterations }: AppProps) {
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

  const historyRef = useRef<AgentMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingTools, setStreamingTools] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState("Chat");
  const [planMode, setPlanMode] = useState(false);
  const planExecutorRef = useRef<HierarchicalAgentLangGraph | null>(null);

  // Refs to keep values accessible inside stable callbacks without
  // causing the callback identity to change (which would tear down
  // and recreate the stdin handler in ControlledTextInput, breaking input).
  const planModeRef = useRef(false);
  const llmRef = useRef(llm);
  const toolsRef = useRef(tools);
  const executorRef = useRef(executor);
  useEffect(() => { planModeRef.current = planMode; }, [planMode]);
  useEffect(() => { llmRef.current = llm; }, [llm]);
  useEffect(() => { toolsRef.current = tools; }, [tools]);
  useEffect(() => { executorRef.current = executor; }, [executor]);

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

  const handleTogglePlanMode = useCallback(() => {
    setPlanMode(prev => {
      const next = !prev;
      setStaticMessages((msgs) => [
        ...msgs,
        {
          role: "system" as const,
          content: next
            ? "🗺️ Plan mode enabled. Agent will create a step-by-step plan before executing. (Shift+Tab to toggle)"
            : "⚡ Plan mode disabled. Using standard ReAct mode. (Shift+Tab to toggle)",
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
          historyRef.current = [];
        } else if (parts[1] === "switch" && parts[2]) {
          const s = await memory.switchSession(parts[2]);
          if (s) {
            setSessionName(s.name);
            historyRef.current = [];
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
          historyRef.current = [];
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
      memory.addUserMessage(value);
      setRunning(true);
      streamingBufferRef.current = "";
      setStreamingText("");
      setStreamingTools([]);

      try {
        let output: string;

        if (planModeRef.current) {
          // ---- Plan Mode: use HierarchicalAgentLangGraph ----
          if (!planExecutorRef.current) {
            planExecutorRef.current = new HierarchicalAgentLangGraph(llmRef.current, toolsRef.current);
          }
          const planExecutor = planExecutorRef.current;
          output = "";
          const { parseHistory: parseHist } = await import("../agent/loop.js");
          const messageHistory = parseHist([
            ...historyRef.current,
            { role: "user", content: value } as AgentMessage,
          ]);

          const stream = planExecutor.stream({ messages: messageHistory });
          for await (const chunk of stream) {
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
            if (chunk.intermediateSteps) {
              for (const step of chunk.intermediateSteps) {
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
            if (chunk.output) {
              output += String(chunk.output);
              streamingBufferRef.current += String(chunk.output);
            }
          }
        } else {
          // ---- Normal Mode: use GraphAgentExecutor ----
          output = await runAgent(executorRef.current, value, historyRef.current, {
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
          });
        }

        // Add final assistant response to static
        setStaticMessages((prev) => [
          ...prev,
          { role: "assistant", content: output, timestamp: new Date() },
        ]);
        historyRef.current.push({
          role: "user",
          content: value,
        } as AgentMessage);
        historyRef.current.push({
          role: "assistant",
          content: output,
        } as AgentMessage);
        memory.addAssistantMessage(output);
        try {
          await memory.summarizeAndStore(`User: ${value}\nAssistant: ${output}`);
        } catch {}
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
    [executor, memory],
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
          {planMode ? (
            <Text color="magenta"> | 🗺️ Plan Mode</Text>
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
              <Text color="white">{streamingText}</Text>
            </Box>
          </Box>
        ) : null}

        {/* Input (dynamic) */}
        <Input
          onSubmit={onSubmit}
          disabled={running}
          planMode={planMode}
          onTogglePlanMode={handleTogglePlanMode}
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
