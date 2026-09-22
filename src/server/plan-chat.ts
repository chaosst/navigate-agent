/**
 * plan-chat.ts — /api/agent/plan 的 SSE 处理器。
 *
 * 形态刻意镜像 src/server/rag-ask.ts 的 buildRagAskHandler：
 * 同样的 header / AbortController-on-close / try-catch-finally + res.end()。
 * 不发明新写法 —— 一个仓库里只应该有一种 SSE 处理器骨架。
 *
 * 安全：streamFn === undefined（agent 未装配）→ 503。
 * 绝不回退到全量工具集（见 src/server-entry.ts:156-162 的既有不变量）。
 */
import type { Request, Response, RequestHandler } from "express";
import { chunkToEvents, formatSseFrame } from "./plan-events.js";
import type { PlanStreamChunk } from "./plan-events.js";

/** 单参驱动函数：给出问题，产出 plan 引擎的流式 chunk（装配方负责注入 agent） */
export type PlanStreamFn = (question: string) => AsyncGenerator<PlanStreamChunk>;

export function buildPlanChatHandler(streamFn: PlanStreamFn | undefined): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    if (!streamFn) {
      res.status(503).json({
        error: "Plan agent 未装配（H5_PLAN_AGENT 未开启或装配失败）",
      });
      return;
    }

    const body = (req.body ?? {}) as { question?: unknown };
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (question.length === 0) {
      res.status(400).json({ error: "Missing question" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // 反代（Caddy）不得缓冲，否则流式失效

    // ⚠️ 这个 signal 只用于「处理器侧提前停写」，**不会**向上游传播：
    // 引擎的 generateFinalAnswer / executeStep 目前不接 signal，生成器会在后台跑完。
    // 与 rag-ask 的现有行为一致；如需真取消，先给引擎的 stream() 加 signal 参数。
    const ac = new AbortController();
    const onClose = () => ac.abort();
    res.on("close", onClose);

    try {
      for await (const chunk of streamFn(question)) {
        if (ac.signal.aborted) break;
        for (const ev of chunkToEvents(chunk)) {
          res.write(formatSseFrame(ev));
        }
        if (typeof (res as { flush?: () => void }).flush === "function") {
          (res as unknown as { flush: () => void }).flush();
        }
      }
      if (!ac.signal.aborted) {
        res.write(formatSseFrame({ type: "done" }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (!ac.signal.aborted) {
        res.write(formatSseFrame({ type: "error", message }));
      }
    } finally {
      res.removeListener("close", onClose);
      res.end();
    }
  };
}
