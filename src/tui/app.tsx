import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text } from "ink";
import { Input } from "./input.js";
import { Output, type OutputMessage } from "./output.js";
import { handleCommand } from "./commands.js";
import type { AgentExecutor } from "langchain/agents";
import { runAgent } from "../agent/loop.js";
import type { AgentMessage } from "../agent/types.js";
import type { AgentMemory } from "../memory/index.js";

interface AppProps { executor: AgentExecutor; memory: AgentMemory; }

export function App({ executor, memory }: AppProps) {
  const [messages, setMessages] = useState<OutputMessage[]>([]);
  const historyRef = useRef<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  // Load existing messages from memory on mount
  useEffect(() => {
    const session = memory.getSession();
    if (session) {
      const msgs = memory.store.getMessages(session.id);
      if (msgs.length > 0) {
        const loaded: OutputMessage[] = msgs.map(m => ({
          role: m.role as "user" | "assistant" | "system" | "tool",
          content: m.content,
          timestamp: m.createdAt,
        }));
        setMessages(loaded);
      }
    }
  }, [memory]);

  const onSubmit = useCallback(async (value: string) => {
    // Handle /session commands
    if (value.startsWith("/session")) {
      const parts = value.split(/\s+/);
      if (parts[1] === "new") {
        const s = memory.store.createSession();
        memory.switchSession(s.id);
        setMessages([]);
        historyRef.current = [];
      } else if (parts[1] === "switch" && parts[2]) {
        const s = memory.switchSession(parts[2]);
        if (s) {
          historyRef.current = [];
          const msgs = memory.store.getMessages(s.id);
          setMessages(msgs.map(m => ({
            role: m.role as "user" | "assistant" | "system" | "tool",
            content: m.content,
            timestamp: m.createdAt,
          })));
        }
      } else if (!parts[1] || parts[1] === "list") {
        const list = memory.listSessions().map(s => `${s.id.slice(0,8)}: ${s.name}`).join("\n");
        setMessages(prev => [...prev, { role: "system", content: `Sessions:\n${list}`, timestamp: new Date() }]);
      }
      return;
    }

    if (value.startsWith("/")) {
      const result = handleCommand(value);
      if (result === "CLEAR") { setMessages([]); historyRef.current = []; return; }
      if (result) setMessages(prev => [...prev, { role: "system", content: result, timestamp: new Date() }]);
      return;
    }

    setMessages(prev => [...prev, { role: "user", content: value, timestamp: new Date() }]);
    memory.addUserMessage(value);
    setRunning(true);
    setStreamingText("");
    try {
      const output = await runAgent(executor, value, historyRef.current, {
        onToolStart(tool, input) {
          setMessages(prev => [...prev, { role: "tool", content: `Calling: ${tool}\n${JSON.stringify(input, null, 2)}`, name: tool, timestamp: new Date() }]);
        },
        onToolEnd(result) {
          setMessages(prev => [...prev, { role: "tool", content: `Result: ${result.output}`, name: result.tool, timestamp: new Date() }]);
        },
        onToken(token) {
          setStreamingText(prev => prev + token);
        },
        onFinish() {
          // handled below
        },
      });
      setMessages(prev => [...prev, { role: "assistant", content: output, timestamp: new Date() }]);
      historyRef.current.push({ role: "user", content: value } as AgentMessage);
      historyRef.current.push({ role: "assistant", content: output } as AgentMessage);
      memory.addAssistantMessage(output);
      await memory.summarizeAndStore(`User: ${value}\nAssistant: ${output}`);
      setStreamingText("");
    } catch (error) {
      setMessages(prev => [...prev, { role: "system", content: `Error: ${(error as Error).message}`, timestamp: new Date() }]);
    } finally {
      setRunning(false);
    }
  }, [executor, memory]);

  const session = memory.getSession();

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="single" borderColor="green" paddingX={1}>
        <Text bold>Navigate Agent</Text>
        <Text dimColor> | {session?.name || "Chat"}</Text>
        <Text dimColor>  (/help)</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" minHeight={10}>
        <Output messages={messages} streamingText={running ? streamingText : undefined} />
      </Box>
      <Input value={input} onChange={setInput} onSubmit={onSubmit} disabled={running} />
      {running ? (<Box paddingX={1}><Text color="yellow">Agent is thinking...</Text></Box>) : null}
    </Box>
  );
}
