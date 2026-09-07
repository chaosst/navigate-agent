import type { Request, Response, RequestHandler } from "express";
import type { ParallelEvent } from "../rag/parallel-answer.js";

// re-export：SSE 帧序列化与前端分发消费同一事件类型（测试/装配方从本模块取类型）
export type { ParallelEvent } from "../rag/parallel-answer.js";

export type AskFn = (question: string, docIds: string[]) => AsyncGenerator<ParallelEvent>;

/** 单事件 → SSE 帧文本（data 里放整个事件对象，前端按 type 分发） */
export function formatSseEvent(ev: ParallelEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** 组装 /api/rag/ask 处理器：入参校验 → SSE 流式写生成器事件；客户端断开即停 */
export function buildRagAskHandler(ask: AskFn): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { question?: unknown; docIds?: unknown };
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (question.length === 0) {
      res.status(400).json({ error: "Missing question" });
      return;
    }
    const docIds = Array.isArray(body.docIds)
      ? body.docIds.filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (docIds.length === 0) {
      res.status(400).json({ error: "Missing docIds" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const ac = new AbortController();
    const onClose = () => ac.abort();
    res.on("close", onClose);

    try {
      for await (const ev of ask(question, docIds)) {
        if (ac.signal.aborted) break;
        res.write(formatSseEvent(ev));
        if (typeof (res as any).flush === "function") (res as any).flush();
      }
    } catch (err) {
      res.write(formatSseEvent({ type: "error", message: err instanceof Error ? err.message : "Unknown error" }));
    } finally {
      res.removeListener("close", onClose);
      res.end();
    }
  };
}
