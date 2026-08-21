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

interface MessageItemProps {
  msg: OutputMessage;
  agentName?: string;
}

/**
 * Renders a single message.
 *
 * Used in two places:
 * 1. Inside <Static> — for finalized messages (written to terminal once,
 *    never cleared/rewritten by Ink).
 * 2. In the dynamic area — for running tool calls (re-rendered on each
 *    Ink render cycle).
 *
 * The `running` flag controls presentation:
 * - running=true  → shows full content (truncated to 500 chars), with ▼
 * - running=false → shows first line only (truncated to 80 chars), with ▶
 */
export function MessageItem({ msg, agentName = "Agent" }: MessageItemProps) {
  switch (msg.role) {
    case "user":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="white" backgroundColor="#555555">
            {">"} {msg.content}
          </Text>
        </Box>
      );

    case "tool": {
      const detail = msg.expanded
        ? msg.content
        : msg.content.split("\n")[0].slice(0, 80);
      return (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          <Text color="#888888">
            {msg.running ? "  ▼" : msg.expanded ? "  ▼" : "  ▶"} ⚡{" "}
            {msg.name || "tool"}
          </Text>
          {msg.running || msg.expanded ? (
            <Text color="#888888">
              {msg.content.length > 500
                ? msg.content.slice(0, 500) + "..."
                : msg.content}
            </Text>
          ) : (
            <Text color="#888888">{detail}</Text>
          )}
        </Box>
      );
    }

    case "system":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">  {msg.content}</Text>
        </Box>
      );

    default:
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box paddingY={1}>
            <Text bold color="#4FC3F7">
              {agentName}:
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text color="white">{msg.content}</Text>
          </Box>
        </Box>
      );
  }
}
