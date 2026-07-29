import React from "react";
import { Box, Text } from "ink";

export interface OutputMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  timestamp: Date;
  running?: boolean;
  expanded?: boolean;
}

interface OutputProps {
  messages: OutputMessage[];
  streamingText?: string;
  streamingTools?: string[];
  agentName?: string;
}

export function Output({ messages, streamingText, streamingTools, agentName = "Agent" }: OutputProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg, i) => {
        const time = msg.timestamp.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        switch (msg.role) {
          case "user":
            return (
              <Box key={i} flexDirection="column" marginBottom={1}>
                <Text color="white" backgroundColor="#555555">&gt; {msg.content}</Text>
              </Box>
            );
          case "tool":
            const detail = msg.expanded ? msg.content : msg.content.split("\n")[0].slice(0, 80);
            return (
              <Box key={i} flexDirection="column" marginBottom={1} paddingLeft={2}>
                <Text dimColor>[{time}]</Text>
                <Text color="#888888">
                  {msg.running ? "  ▼" : msg.expanded ? "  ▼" : "  ▶"} ⚡ {msg.name || "tool"}
                </Text>
                {msg.running || msg.expanded ? (
                  <Text color="#888888">{msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content}</Text>
                ) : (
                  <Text color="#888888">{detail}</Text>
                )}
              </Box>
            );
          case "system":
            return (
              <Box key={i} flexDirection="column" marginBottom={1}>
                <Text dimColor>[{time}]</Text>
                <Text color="yellow">  {msg.content}</Text>
              </Box>
            );
          default:
            return (
              <Box key={i} flexDirection="column" marginBottom={1}>
                <Box paddingY={1}>
                  <Text bold color="#4FC3F7">{agentName}:</Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text color="white">{msg.content}</Text>
                </Box>
              </Box>
            );
        }
      })}
      {streamingTools && streamingTools.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {streamingTools.map((t, i) => (
            <Text key={i} color="#888888">{t}</Text>
          ))}
        </Box>
      ) : null}
      {streamingText ? (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingY={1}>
            <Text bold color="#4FC3F7">{agentName}:</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text color="white">{streamingText}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
