import { describe, expect, it } from "vitest";
import { majorityScore, majorityVerdict } from "../llm-judge.js";

describe("majorityVerdict（claim 布尔多数表决）", () => {
  it("严格多数 yes → true，reason 取多数侧最后一票", () => {
    const v = majorityVerdict("c", [
      { supported: true, reason: "y1" },
      { supported: false, reason: "n1" },
      { supported: true, reason: "y2" },
    ]);
    expect(v.supported).toBe(true);
    expect(v.reason).toBe("y2");
  });

  it("多数 no → false", () => {
    const v = majorityVerdict("c", [
      { supported: false, reason: "n1" },
      { supported: false, reason: "n2" },
      { supported: true, reason: "y1" },
    ]);
    expect(v.supported).toBe(false);
    expect(v.reason).toBe("n2");
  });

  it("偶数轮平票保守取 false（§5.3 抖动场景：1 yes / 1 no → false）", () => {
    const v = majorityVerdict("c", [
      { supported: true, reason: "y1" },
      { supported: false, reason: "n1" },
    ]);
    expect(v.supported).toBe(false);
  });

  it("空票 → false 且 reason 标注 no-rounds", () => {
    const v = majorityVerdict("c", []);
    expect(v.supported).toBe(false);
    expect(v.reason).toBe("no-rounds");
  });

  it("全部一致时 reason 取唯一侧", () => {
    const v = majorityVerdict("c", [
      { supported: true, reason: "ok" },
      { supported: true, reason: "ok2" },
    ]);
    expect(v.supported).toBe(true);
    expect(v.reason).toBe("ok2");
  });
});

describe("majorityScore（分数众数档表决）", () => {
  it("两票 1 + 一票 0.5 → 1", () => {
    expect(majorityScore([1, 0.5, 1])).toBe(1);
  });

  it("两票 0 + 一票 1 → 0", () => {
    expect(majorityScore([0, 1, 0])).toBe(0);
  });

  it("三档各一票（无严格多数）→ 回退中位档 0.5，不武断归零", () => {
    expect(majorityScore([0, 0.5, 1])).toBe(0.5);
  });

  it("原始分接近档位边界时先离散再表决", () => {
    // 0.8 / 0.9 / 0.6 → 档位 1 / 1 / 0.5 → 多数 1
    expect(majorityScore([0.8, 0.9, 0.6])).toBe(1);
  });

  it("空输入 → 0.5 兜底", () => {
    expect(majorityScore([])).toBe(0.5);
  });
});
