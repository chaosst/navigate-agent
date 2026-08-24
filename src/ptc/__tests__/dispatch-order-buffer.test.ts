import { describe, it, expect } from "vitest";
import { DispatchOrderBuffer } from "../dispatch-order-buffer.js";
import type { PtcDispatchEvent } from "../dispatch-bridge.js";

function ev(parentId: string, seq: number, tool: string): PtcDispatchEvent {
  return { parentId, seq, tool, input: null, output: null, isError: false };
}

describe("DispatchOrderBuffer", () => {
  it("reorders out-of-order arrivals back to submission order", () => {
    const buf = new DispatchOrderBuffer();
    // 并发完成顺序：seq 2 先到，然后 0、1（最早提交的最后完成）
    buf.push(ev("run_1", 2, "read_file"));
    buf.push(ev("run_1", 0, "list_files"));
    buf.push(ev("run_1", 1, "write_file"));

    const out = buf.drain();
    expect(out.map((e) => e.tool)).toEqual(["list_files", "write_file", "read_file"]);
    expect(out.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("flushes chained arrivals once the gap is filled", () => {
    const buf = new DispatchOrderBuffer();
    buf.push(ev("run_1", 1, "b"));
    expect(buf.drain()).toHaveLength(0); // 0 未到，1 缓存
    buf.push(ev("run_1", 0, "a"));
    // 0 就绪 → 顺带把缓存的 1 也补发
    expect(buf.drain().map((e) => e.seq)).toEqual([0, 1]);
  });

  it("does not block different parentIds on each other", () => {
    const buf = new DispatchOrderBuffer();
    // run_1 的 seq 1 先到（缓存），run_2 的 seq 0 就绪（应立即输出，不受 run_1 影响）
    buf.push(ev("run_1", 1, "x"));
    buf.push(ev("run_2", 0, "y"));
    expect(buf.drain().map((e) => e.tool)).toEqual(["y"]);
    // 补上 run_1 的 seq 0 后，run_1 也按序输出
    buf.push(ev("run_1", 0, "z"));
    expect(buf.drain().map((e) => e.tool)).toEqual(["z", "x"]);
  });

  it("drain is FIFO across ready events", () => {
    const buf = new DispatchOrderBuffer();
    buf.push(ev("run_1", 0, "a"));
    buf.push(ev("run_2", 0, "b"));
    buf.push(ev("run_3", 0, "c"));
    expect(buf.drain().map((e) => e.tool)).toEqual(["a", "b", "c"]);
  });
});
