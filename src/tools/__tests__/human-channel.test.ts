import { describe, it, expect } from "vitest";
import {
  HumanChannel,
  ManualInteractor,
  NonInteractiveInteractor,
  ThresholdApprovalPolicy,
  buildApproval,
  resolveApprovalMode,
  type HumanInteractor,
  type HumanRequest,
  type HumanResponse,
} from "../human-channel.js";

/** 记录并发度与调用顺序的替身；固定返回同一 decision */
class Recorder implements HumanInteractor {
  order: string[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  count = 0;
  constructor(private delayMs = 10, private decision: "allow" | "always" | "deny" = "allow") {}
  async ask(req: HumanRequest): Promise<HumanResponse> {
    this.count++;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.order.push(req.kind === "approval" ? req.tool : req.question);
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.concurrent--;
    return req.kind === "approval"
      ? { kind: "approval", decision: this.decision }
      : { kind: "question", answer: "42" };
  }
}

const approval = (tool: string) =>
  ({ kind: "approval", tool, args: { v: 1 }, permission: "write" }) as const;

describe("HumanChannel", () => {
  it("并发请求被 FIFO 串行处理，任一时刻只有一个待答", async () => {
    const rec = new Recorder(10);
    const ch = new HumanChannel();
    ch.attach(rec);
    const results = await Promise.all([
      ch.request(approval("a")),
      ch.request(approval("b")),
      ch.request(approval("c")),
    ]);
    expect(rec.order).toEqual(["a", "b", "c"]);
    expect(rec.maxConcurrent).toBe(1);
    expect(results.every((r) => r.kind === "approval")).toBe(true);
  });

  it("未 attach → 无人值守兜底：审批拒绝、提问给可读文案", async () => {
    const ch = new HumanChannel();
    const ap = await ch.request(approval("write_file"));
    expect(ap).toEqual({
      kind: "approval",
      decision: "deny",
      reason: "non-interactive environment",
    });
    const q = await ch.request({ kind: "question", question: "选哪个？" });
    if (q.kind !== "question") throw new Error("expected question response");
    expect(q.answer).toContain("no user available");
  });

  it("decision=always 登记该工具，其它工具不受影响", async () => {
    const ch = new HumanChannel();
    ch.attach(new Recorder(1, "always"));
    await ch.request(approval("write_file"));
    expect(ch.isAlwaysAllowed("write_file")).toBe(true);
    expect(ch.isAlwaysAllowed("edit_file")).toBe(false);
  });

  it("交互器抛错 → 审批转 deny、提问转兜底，不冒泡", async () => {
    const boom: HumanInteractor = { async ask() { throw new Error("boom"); } };
    const ch = new HumanChannel();
    ch.attach(boom);
    const ap = await ch.request(approval("write_file"));
    expect(ap.kind).toBe("approval");
    if (ap.kind !== "approval") throw new Error("unreachable");
    expect(ap.decision).toBe("deny");
    expect(ap.reason).toContain("boom");
    const q = await ch.request({ kind: "question", question: "q" });
    if (q.kind !== "question") throw new Error("unreachable");
    expect(q.answer).toContain("no user available");
  });

  it("pending / subscribe 随请求生命周期变化", async () => {
    const manual = new ManualInteractor();
    const ch = new HumanChannel();
    ch.attach(manual);
    let notified = 0;
    const unsub = ch.subscribe(() => { notified++; });

    const p = ch.request(approval("t"));
    expect(ch.pending?.kind).toBe("approval");
    const id = ch.pending?.id ?? "";
    expect(id).not.toBe("");
    manual.answer(id, { kind: "approval", decision: "allow" });
    const res = await p;

    expect(res).toEqual({ kind: "approval", decision: "allow" });
    expect(ch.pending).toBeNull();
    expect(notified).toBe(2);
    unsub();
  });

  it("waitMs 累计人工等待时长", async () => {
    const gate = new ManualInteractor();
    const ch = new HumanChannel();
    ch.attach(gate);
    const p = ch.request(approval("t"));
    await new Promise((r) => setTimeout(r, 25));
    gate.answer(ch.pending?.id ?? "", { kind: "approval", decision: "allow" });
    await p;
    expect(ch.waitMs).toBeGreaterThanOrEqual(15);
  });
});

describe("ManualInteractor", () => {
  it("answer 未知 id 不抛、不影响后续请求", async () => {
    const m = new ManualInteractor();
    m.answer("nope", { kind: "approval", decision: "deny" });
    const p = m.ask({ id: "h1", kind: "approval", tool: "t", args: {}, permission: "write" });
    m.answer("h1", { kind: "approval", decision: "always" });
    expect(await p).toEqual({ kind: "approval", decision: "always" });
  });
});

describe("ThresholdApprovalPolicy", () => {
  it("write/dangerous 需要问、read 不问", () => {
    const p = new ThresholdApprovalPolicy("write");
    expect(p.shouldAsk("read_file", "read")).toBe(false);
    expect(p.shouldAsk("write_file", "write")).toBe(true);
    expect(p.shouldAsk("execute_command", "dangerous")).toBe(true);
  });
});

describe("resolveApprovalMode", () => {
  it("合法值原样返回", () => {
    expect(resolveApprovalMode("allow")).toBe("allow");
    expect(resolveApprovalMode("deny")).toBe("deny");
    expect(resolveApprovalMode("interactive")).toBe("interactive");
  });
  it("空 / 非法 → fallback（缺省 interactive）", () => {
    expect(resolveApprovalMode(undefined)).toBe("interactive");
    expect(resolveApprovalMode("yes")).toBe("interactive");
  });
  it("可指定 fallback（server 用 deny）", () => {
    expect(resolveApprovalMode(undefined, "deny")).toBe("deny");
    expect(resolveApprovalMode("", "deny")).toBe("deny");
  });
});

describe("buildApproval", () => {
  it("allow → 不返回 channel / policy（等价今天的全放行）", () => {
    const { channel, policy } = buildApproval("allow");
    expect(channel).toBeUndefined();
    expect(policy).toBeUndefined();
  });
  it("deny → 通道已挂无人值守交互器，审批直接拒绝", async () => {
    const { channel, policy } = buildApproval("deny");
    expect(channel).toBeInstanceOf(HumanChannel);
    expect(policy).toBeInstanceOf(ThresholdApprovalPolicy);
    const res = await channel!.request(approval("write_file"));
    if (res.kind !== "approval") throw new Error("unreachable");
    expect(res.decision).toBe("deny");
  });
  it("interactive → 通道 + 阈值策略，read 不问 write 问", () => {
    const { channel, policy } = buildApproval("interactive");
    expect(channel).toBeInstanceOf(HumanChannel);
    expect(policy!.shouldAsk("read_file", "read")).toBe(false);
    expect(policy!.shouldAsk("edit_file", "write")).toBe(true);
  });
});
