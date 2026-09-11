import { logAgent } from "../agent/logger.js";

/** console 方法 → agent.log 级别 */
const LEVEL = {
  log: "info",
  info: "info",
  debug: "info",
  warn: "warning",
  error: "error",
} as const;

export type ConsoleMethod = keyof typeof LEVEL;

/**
 * console 参数 → 单行文本。对象走紧凑 JSON，Error 取 stack，循环引用兜底 String。
 * 纯函数，便于单测（不碰真实 console）。
 */
export function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export interface ConsoleGuardOptions {
  /** 落盘收口；默认写 agent.log。测试可注入替身 */
  sink?: (level: "info" | "warning" | "error", message: string) => void;
}

/**
 * 把 console.* 从 stdout 改道到 agent.log。
 *
 * 为什么必须这么做：TUI 用 Ink 独占 stdout，靠「上一次画了几行」来擦帧重绘。
 * 任何绕过 Ink 的 stdout 写入都会让擦帧行数算错 → 残留/错位的行。表现就是
 * 流式回答被工具调用卡片「拦腰截断」，甚至在画面中间冒出裸日志
 * （`[AgentMemory] maybeSummarize ...`，2026-09-11 排查）。
 *
 * 只在 TUI 入口调用（render 之前）；库层不调用，避免污染 server / CLI / vitest 输出。
 * 返回 restore()：单测与优雅退出用。
 */
export function installConsoleGuard(opts: ConsoleGuardOptions = {}): () => void {
  const sink = opts.sink ?? ((level, message) => logAgent({ type: level, message }));
  const target = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of Object.keys(LEVEL) as ConsoleMethod[]) {
    originals.set(method, target[method]);
    target[method] = (...args: unknown[]) => sink(LEVEL[method], formatConsoleArgs(args));
  }

  return () => {
    for (const [method, original] of originals) {
      if (typeof original === "function") target[method] = original;
    }
  };
}
