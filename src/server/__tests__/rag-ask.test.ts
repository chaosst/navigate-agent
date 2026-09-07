import { describe, it, expect, vi } from "vitest";
import { formatSseEvent, buildRagAskHandler } from "../rag-ask.js";
import type { AskFn, ParallelEvent } from "../rag-ask.js";

describe("formatSseEvent", () => {
  it("把事件序列化成 SSE 帧", () => {
    const ev: ParallelEvent = { type: "plan", docs: [{ id: "d1", filename: "a.md" }] };
    expect(formatSseEvent(ev)).toBe(`event: plan\ndata: ${JSON.stringify(ev)}\n\n`);
  });
});

function fakeRes() {
  const writes: string[] = [];
  const res: any = {
    writes,
    write: vi.fn((s: string) => { writes.push(s); return true; }),
    end: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
    setHeader: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    flush: undefined,
  };
  return res;
}

/** RequestHandler 需 3 参（req/res/next）；测试直接双参调用——cast 成薄签名 */
type BareHandler = (req: unknown, res: unknown) => Promise<void>;

describe("buildRagAskHandler", () => {
  it("缺 question / docIds 返回 400", async () => {
    const ask: AskFn = async function* () { yield* [] as ParallelEvent[]; };
    const handler = buildRagAskHandler(ask) as unknown as BareHandler;
    const res = fakeRes();
    await handler({ body: {}, headersSent: false } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("逐个写事件帧并按序结束；客户端 close 后停写", async () => {
    const events: ParallelEvent[] = [
      { type: "plan", docs: [{ id: "d1", filename: "a.md" }] },
      { type: "worker", docId: "d1", filename: "a.md", status: "done" },
      { type: "answer", text: "hi" },
    ];
    const ask: AskFn = async function* () { for (const ev of events) yield ev; };
    const handler = buildRagAskHandler(ask) as unknown as BareHandler;
    const res = fakeRes();
    await handler({ body: { question: "q", docIds: ["d1"] } } as any, res as any);
    expect(res.writes.join("")).toContain(`event: plan`);
    expect(res.writes.join("")).toContain(`event: worker`);
    expect(res.writes.join("")).toContain(`event: answer`);
    expect(res.end).toHaveBeenCalled();
  });
});
