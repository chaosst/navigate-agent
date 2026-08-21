/**
 * PTC 流式块 → TUI 消息的转换纯函数。
 *
 * 与 React/Ink 解耦：输入 stream 产出的 `{ ptcProgram }` / `{ ptcDispatch }` 块，
 * 输出标准 `OutputMessage`（携带 ptc 结构化数据），由 MessageItem 渲染卡片。
 * 普通模式 / plan 模式不会产出这些块，调用零副作用。
 *
 * 对应设计文档 §5.10（TUI 扩展）与 §5.7（stream() 块契约）。
 */
import type { PtcDispatchEvent } from "../ptc/dispatch-bridge.js";
import type { OutputMessage } from "./output.js";

/** stream 的 { ptcProgram } 块形状 */
export interface PtcProgramChunk {
  code: string;
  description: string;
}

/** 将 ptcProgram 块转为 OutputMessage（run_code 卡片，expanded 时展开源码） */
export function ptcProgramToMessage(p: PtcProgramChunk): OutputMessage {
  return {
    role: "tool",
    name: "run_code",
    content: p.description || "run_code",
    timestamp: new Date(),
    ptc: { kind: "program", data: { code: p.code, description: p.description } },
  };
}

/** 将 ptcDispatch 子调用事件转为 OutputMessage（⚡/❌ tools["x"](...)） */
export function ptcDispatchToMessage(ev: PtcDispatchEvent): OutputMessage {
  return {
    role: "tool",
    name: ev.tool,
    content: `${ev.isError ? "❌" : "✅"} tools["${ev.tool}"](${JSON.stringify(ev.input)})`,
    timestamp: new Date(),
    ptc: {
      kind: "dispatch",
      data: { tool: ev.tool, input: ev.input, output: ev.output, isError: ev.isError },
    },
  };
}

/**
 * 从 run_code 工具返回的 observation 提取失败类别徽章。
 * 工具失败时返回形如 `[run_code exception] ...` 的文本 → 提取 "exception"。
 */
export function extractRunCodeErrorKind(observation: unknown): string | null {
  const m = /^\[run_code (\w+)\]/.exec(String(observation ?? ""));
  return m ? m[1] : null;
}
