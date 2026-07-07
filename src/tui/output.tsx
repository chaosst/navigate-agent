import React from "react";
import { Box, Text } from "ink";

export interface OutputMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  timestamp: Date;
}

interface OutputProps {
  messages: OutputMessage[];
  streamingText?: string;
}

export function Output({ messages, streamingText }: OutputProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg, i) => {
        const time = msg.timestamp.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        switch (msg.role) {
          case "user":
            return (<Box key={i} flexDirection="column" marginBottom={1}>
              <Text dimColor>[{time}]</Text>
              <Text bold color="blue">&gt; {msg.content}</Text>
            </Box>);
          case "tool":
            return (<Box key={i} flexDirection="column" marginBottom={1} paddingLeft={2}>
              <Text dimColor>[{time}]</Text>
              <Text color="cyan">  ⚡ {msg.name || "tool"}</Text>
              <Text dimColor color="gray">{msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content}</Text>
            </Box>);
          case "system":
            return (<Box key={i} flexDirection="column" marginBottom={1}>
              <Text dimColor>[{time}]</Text>
              <Text color="yellow">  {msg.content}</Text>
            </Box>);
          default:
            return (<Box key={i} flexDirection="column" marginBottom={1}>
              <Text dimColor>[{time}]</Text>
              <Text color="green">{msg.content}</Text>
            </Box>);
        }
      })}
      {streamingText ? (<Box flexDirection="column" marginBottom={1}>
        <Text dimColor>[streaming]</Text>
        <Text color="green">{streamingText}</Text>
      </Box>) : null}
    </Box>
  );
}
