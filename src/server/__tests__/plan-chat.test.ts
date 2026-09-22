import { describe, it, expect, vi } from "vitest";
import { buildPlanChatHandler } from "../plan-chat.js";
import type { PlanStreamFn } from "../plan-chat.js";
import type { ExecutionPlan } from "../../agent/types.js";

/** RequestHandler 需 3 参；测试直接双参调用 —— cast 成薄签名（同 rag-ask.test.ts） */
type BareHandler = (req: unknown, res: unknown) => Promise<void>;

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

const plan: ExecutionPlan = {
  goal: "g", currentStepIndex: 0, createdAt: 1, updatedAt: 2,
  steps: [{ id: "s1", description: "d", status: "pending" }],
};

describe("buildPlanChatHandler", () => {
  it("streamFn 未装配 → 503（fail-closed，绝不回退全量工具集）", async () => {
    const handler = buildPlanChatHandler(undefined) as unknown as BareHandler;
    const res = fakeRes();
    await handler({ body: { question: "x" }, headersSent: false } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.write).not.toHaveBeenCalled();
  });

  it("缺 question → 400", async () => {
    const fn: PlanStreamFn = async function* () { yield* []; };
    const handler = buildPlanChatHandler(fn) as unknown as BareHandler;
    const res = fakeRes();
    await handler({ body: {}, headersSent: false } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("空白 question → 400（trim 后为空同样拒绝）", async () => {
    const fn: PlanStreamFn = async function* () { yield* []; };
    const handler = buildPlanChatHandler(fn) as unknown as BareHandler;
    const res = fakeRes();
    await handler({ body: { question: "   " }, headersSent: false } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("按序写 plan → tool → answer → done，并以 res.end() 收尾", async () => {
    const fn: PlanStreamFn = async function* () {
      yield { plan };
      yield { intermediateSteps: [{ action: { tool: "read_file", toolInput: {} }, observation: "A" }] as any };
      yield { output: "答案" };
    };
    const handler = buildPlanChatHandler(fn) as unknown as BareHandler;
    const res = fakeRes();
    await handler({ body: { question: "q" }, headersSent: false } as any, res as any);

    const types = res.writes.map((w: string) => w.split("\n")[0].replace("event: ", ""));
    expect(types).toEqual(["plan", "tool", "answer", "done"]);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(res.end).toHaveBeenCalled();
  });

  it("生成器抛错 → 写 error 帧但仍然 end（连接不留挂）", async () => {
    const fn: PlanStreamFn = async function* () {
      throw new Error("boom");
    };
    const handler = buildPlanChatHandler(fn) as unknown as BareHandler;
    const res = fakeRes();
    await handler({ body: { question: "q" }, headersSent: false } as any, res as any);
    expect(res.writes.join("")).toContain('"type":"error"');
    expect(res.writes.join("")).toContain("boom");
    expect(res.end).toHaveBeenCalled();
  });

  it("客户端 close 后停止写帧", async () => {
    let closed = false;
    const fn: PlanStreamFn = async function* () {
      for (let i = 0; i < 5; i++) {
        if (closed) yield { output: `late-${i}` };
        else yield { plan };
      }
    };
    const handler = buildPlanChatHandler(fn) as unknown as BareHandler;
    const res = fakeRes();
    // 捕获 close 回调，第一次 write 后就触发 abort
    (res.on as any).mockImplementation((evt: string, cb: () => void) => {
      if (evt === "close") (res as any).__close = cb;
    });
    (res.write as any).mockImplementation((s: string) => {
      res.writes.push(s);
      if (!closed && res.__close) { closed = true; res.__close(); }
      return true;
    });
    await handler({ body: { question: "q" }, headersSent: false } as any, res as any);
    expect(res.writes.join("")).not.toContain("late-");
  });
});
