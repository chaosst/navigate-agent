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

/** 流式块的 output 相关字段（app.tsx 中 StreamChunk 的子集） */
export interface StreamOutputChunk {
  /** 最终回答（finalize/fallback 产出） */
  output?: string;
  /** 中间轮次叙述（仅动态预览） */
  outputPreview?: string;
}

/**
 * PTC / plan 模式流式块的输出累积器。
 *
 * 关键约束：中间叙述（outputPreview）只进入预览 buffer，绝不进入最终 output；
 * 否则 agent 每轮工具调用前的说明文字会与 finalize 的完整回答拼接，
 * 导致最终 assistant 消息重复、乱序（历史问题）。
 */
export class StreamAccumulator {
  /** 最终回答（进入 <Static> 的 assistant 消息） */
  output = "";
  /** 预览文本（动态区域流式显示，循环结束后清空） */
  private preview = "";

  push(chunk: StreamOutputChunk): void {
    if (chunk.outputPreview) {
      this.preview += chunk.outputPreview;
    }
    if (chunk.output) {
      this.output += chunk.output;
      this.preview += chunk.output;
    }
  }

  get previewText(): string {
    return this.preview;
  }

  reset(): void {
    this.output = "";
    this.preview = "";
  }
}

/**
 * 动态区流式预览裁剪：只保留尾部，但**按整行**切，绝不切在词/行中间。
 *
 * 旧的 `"…" + text.slice(-800)` 会切出 `…ckage.json` 这种半截词 —— 看起来像画面被
 * 撕裂，这是 2026-09-11 排查流式布局问题时直接看到的证据。
 * 只有「单行本身就超过字符预算」这种无行可退的情况才硬切。
 */
export function clipPreview(text: string, maxChars = 1200, maxLines = 16): string {
  if (!text) return "";
  const lines = text.split("\n");
  let body = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
  if (body.length > maxChars) {
    const cut = body.length - maxChars;
    const nl = body.indexOf("\n", cut);
    // 退到下一个整行边界；找不到换行说明是单行超长，只能硬切
    body = nl >= 0 ? body.slice(nl + 1) : body.slice(-maxChars);
  }
  const dropped = text.length - body.length;
  if (dropped <= 0) return text;
  return `⋯ 预览已省略前 ${dropped} 字符\n${body}`;
}
