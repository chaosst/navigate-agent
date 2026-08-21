import React from "react";
import { Box, Text } from "ink";

export interface OutputMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  timestamp: Date;
  running?: boolean;
  expanded?: boolean;
  /** PTC 变体：携带结构化数据，MessageItem 据此渲染专用卡片 */
  ptc?:
    | { kind: "program"; data: PtcProgramView }
    | { kind: "dispatch"; data: PtcDispatchView };
}

/** PTC run_code 程序卡片数据 */
export interface PtcProgramView {
  code: string;          // 程序源码
  description: string;   // 意图说明
  errorKind?: string;    // run_code 失败类别徽章（exception/timeout/...）
}

/** PTC 程序内子调用数据 */
export interface PtcDispatchView {
  tool: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

/** 值 → 预览字符串（截断） */
function preview(v: unknown, max: number): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "..." : v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > max ? s.slice(0, max) + "..." : s;
  } catch {
    return String(v);
  }
}

/** PTC run_code 程序卡片：意图说明 + 可展开源码 + 失败徽章 */
function PtcProgramCard({ data, expanded }: { data: PtcProgramView; expanded?: boolean }) {
  const code = data.code.length > 400 ? data.code.slice(0, 400) + "..." : data.code;
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text color="magenta">
        {"📦 run_code"}
        {data.errorKind ? <Text color="red">{` [${data.errorKind}]`}</Text> : null}
      </Text>
      {data.description ? <Text color="#888888">{data.description}</Text> : null}
      {expanded ? (
        <Box paddingLeft={2}>
          <Text color="#888888">{code}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** PTC 程序内子调用条目 */
function PtcDispatchItem({ data }: { data: PtcDispatchView }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={4}>
      <Text color={data.isError ? "red" : "#888888"}>
        {data.isError ? "❌" : "⚡"} tools[{`"${data.tool}"`}]({preview(data.input, 120)})
      </Text>
      <Text color="#888888">{"→ "}{preview(data.output, 200)}</Text>
    </Box>
  );
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
      // PTC 变体：run_code 程序卡片 / 程序内子调用
      if (msg.ptc?.kind === "program") {
        return <PtcProgramCard data={msg.ptc.data} expanded={msg.expanded} />;
      }
      if (msg.ptc?.kind === "dispatch") {
        return <PtcDispatchItem data={msg.ptc.data} />;
      }

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
