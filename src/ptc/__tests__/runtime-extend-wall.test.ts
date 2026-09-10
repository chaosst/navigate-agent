import { describe, it, expect } from "vitest";
import { WorkerThreadCodeRuntime } from "../code-runtime-worker.js";

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
