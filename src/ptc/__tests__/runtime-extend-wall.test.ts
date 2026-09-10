import { describe, it, expect } from "vitest";
import { WorkerThreadCodeRuntime } from "../code-runtime-worker.js";
import { HumanChannel, ManualInteractor } from "../../tools/human-channel.js";

/** 睡眠 600ms 的程序体（超过 maxWallMs=300） */
const SLEEP_600 = "await new Promise((r) => setTimeout(r, 600)); return 1;";

describe("WorkerThreadCodeRuntime.extendWall", () => {
  it("不延长 → 程序被墙钟超时杀掉（负向对照）", async () => {
    const runtime = new WorkerThreadCodeRuntime({ maxWallMs: 300, maxOutputBytes: 10_000 });
    const res = await runtime.run({ program: SLEEP_600, bindings: [] });
    expect(res.error?.kind).toBe("timeout");
    await runtime.dispose();
  });

  it("延长后程序能跑完，不再误杀", async () => {
    const runtime = new WorkerThreadCodeRuntime({ maxWallMs: 300, maxOutputBytes: 10_000 });
    const pending = runtime.run({ program: SLEEP_600, bindings: [] });
    setTimeout(() => runtime.extendWall(800), 100);
    const res = await pending;
    expect(res.error).toBeUndefined();
    expect(res.value).toBe(1);
    await runtime.dispose();
  });

  it("extendWall 在无在跑程序时是安全空操作", async () => {
    const runtime = new WorkerThreadCodeRuntime({ maxWallMs: 300, maxOutputBytes: 10_000 });
    expect(() => runtime.extendWall(1000)).not.toThrow();
    expect(() => runtime.extendWall(0)).not.toThrow();
    await runtime.dispose();
  });
});

describe("channel.onWaitStart/onWait 与 runtime.pauseWall/resumeWall 的集成", () => {
  /** 睡眠 500ms 的程序体 */
  const SLEEP_500 = "await new Promise((r) => setTimeout(r, 500)); return 1;";

  it("等待超过剩余墙钟预算时程序仍能跑完（暂停墙钟）", async () => {
    const runtime = new WorkerThreadCodeRuntime({ maxWallMs: 400, maxOutputBytes: 10_000 });
    const manual = new ManualInteractor();
    const channel = new HumanChannel();
    channel.attach(manual);
    channel.onWaitStart = () => runtime.pauseWall();
    channel.onWait = () => runtime.resumeWall();

    const running = runtime.run({ program: SLEEP_500, bindings: [] });

    // t≈100ms 发起审批 → 等待开始 → 暂停墙钟
    await new Promise((r) => setTimeout(r, 100));
    const asked = channel.request({ kind: "approval", tool: "t", args: {}, permission: "write" });
    // t≈450ms 才作答（已超过 maxWallMs=400，若不暂停定时器早已杀掉程序）
    await new Promise((r) => setTimeout(r, 350));
    manual.answer(channel.pending?.id ?? "", { kind: "approval", decision: "allow" });
    await asked;

    const res = await running;
    expect(res.error).toBeUndefined();
    expect(res.value).toBe(1);
    expect(channel.waitMs).toBeGreaterThanOrEqual(300);
    await runtime.dispose();
  });

  it("负向对照：不挂暂停钩子时，同样的等待会杀掉程序", async () => {
    const runtime = new WorkerThreadCodeRuntime({ maxWallMs: 400, maxOutputBytes: 10_000 });
    const manual = new ManualInteractor();
    const channel = new HumanChannel();
    channel.attach(manual);
    // 故意只挂 onWait（= 修复前的行为）：补偿迟到，来不及
    channel.onWait = () => runtime.resumeWall();

    const running = runtime.run({ program: SLEEP_500, bindings: [] });
    await new Promise((r) => setTimeout(r, 100));
    const asked = channel.request({ kind: "approval", tool: "t", args: {}, permission: "write" });
    await new Promise((r) => setTimeout(r, 350));
    manual.answer(channel.pending?.id ?? "", { kind: "approval", decision: "allow" });
    await asked;

    const res = await running;
    expect(res.error?.kind).toBe("timeout");
    await runtime.dispose();
  });
});
