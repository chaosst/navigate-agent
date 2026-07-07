import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { Input } from "./input.js";
import { Output, type OutputMessage } from "./output.js";
import { handleCommand } from "./commands.js";
import type { AgentExecutor } from "langchain/agents";
import { runAgent } from "../agent/loop.js";

interface AppProps { executor: AgentExecutor; }

export function App({ executor }: AppProps) {
  const [messages, setMessages] = useState<OutputMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  const onSubmit = useCallback(async (value: string) => {
    if (value.startsWith("/")) {
      const result = handleCommand(value);
      if (result === "CLEAR") { setMessages([]); return; }
      if (result) setMessages(prev => [...prev, { role: "system", content: result, timestamp: new Date() }]);
      return;
    }
    setMessages(prev => [...prev, { role: "user", content: value, timestamp: new Date() }]);
    setRunning(true);
    setStreamingText("");
    try {
      const output = await runAgent(executor, value, undefined, {
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
      setStreamingText("");
    } catch (error) {
      setMessages(prev => [...prev, { role: "system", content: `Error: ${(error as Error).message}`, timestamp: new Date() }]);
    } finally {
      setRunning(false);
    }
  }, [executor]);

 return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="single" borderColor="green" paddingX={1}>
        <Text bold>Navigate Agent</Text>
        <Text dimColor>  (type /help for commands)</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" minHeight={10}>
        <Output messages={messages} streamingText={running ? streamingText : undefined} />
      </Box>
      <Input value={input} onChange={setInput} onSubmit={onSubmit} disabled={running} />
      {running ? (<Box paddingX={1}><Text color="yellow">Agent is thinking...</Text></Box>) : null}
    </Box>
  );
}
