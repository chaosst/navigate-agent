import { describe, expect, it } from "vitest";
import { contextPrecision } from "../context-precision.js";

const ranked = ["a", "b", "c", "d"];

describe("contextPrecision", () => {
  it("相关项全部排在最前 → 1.0", () => {
    const r = contextPrecision(ranked, new Set(["a"]), 4);
    expect(r.score).toBe(1);
    expect(r.positions[0]).toEqual({ index: 0, relevant: true, precision: 1 });
  });

  it("相关项在第 2 位 → 0.5（位置惩罚生效）", () => {
    const r = contextPrecision(ranked, new Set(["b"]), 4);
    expect(r.score).toBeCloseTo(0.5);
  });

  it("相关项在第 3 位 → 更低（0.33）", () => {
    const r = contextPrecision(ranked, new Set(["c"]), 4);
    expect(r.score).toBeCloseTo(1 / 3);
  });

  it("全部不相关 → 0（分母为 0 保护）", () => {
    const r = contextPrecision(ranked, new Set(["x"]), 4);
    expect(r.score).toBe(0);
    expect(r.positions).toHaveLength(4);
  });

  it("相关项在 k 之外 → 0", () => {
    const r = contextPrecision(ranked, new Set(["d"]), 2);
    expect(r.score).toBe(0);
  });

  it("k 超过数组长度不越界", () => {
    const r = contextPrecision(ranked, new Set(["a"]), 99);
    expect(r.score).toBe(1);
    expect(r.positions).toHaveLength(4);
  });

  it("空数组 → 0 且无明细", () => {
    const r = contextPrecision([], new Set(["a"]), 5);
    expect(r.score).toBe(0);
    expect(r.positions).toHaveLength(0);
  });

  it("多相关项混合：位置越靠前贡献越高", () => {
    // relevant = {a, c}：a 在第 1 位，c 在第 3 位
    // i=0: a 相关, precision=1/1=1     → 分子 +1,   分母 +1
    // i=1: b 无关, precision=1/2
    // i=2: c 相关, precision=2/3≈0.667 → 分子 +0.667, 分母 +1
    // score = (1 + 0.667) / 2 = 0.833
    const r = contextPrecision(ranked, new Set(["a", "c"]), 4);
    expect(r.score).toBeCloseTo((1 + 2 / 3) / 2);
  });
});
