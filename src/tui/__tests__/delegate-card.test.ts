import { describe, it, expect } from "vitest";
import {
  delegateCardKey,
  findCardIndexByKey,
  patchCardByKey,
  renderDelegateBody,
  delegateFinalLine,
  delegateResultLine,
} from "../delegate-card.js";
import type { OutputMessage } from "../output.js";

const msg = (over: Partial<OutputMessage> = {}): OutputMessage => ({
  role: "tool",
  name: "delegate",
  content: "c",
  timestamp: new Date(),
  ...over,
});

describe("renderDelegateBody", () => {
  it("无子工具调用时只有标题 + 任务两行", () => {
    const body = renderDelegateBody({ agent: "code", task: "对比两个文件的设计差异", count: 0 });
    expect(body.split("\n")).toEqual(["🤖 委派 code 子 agent", "对比两个文件的设计差异"]);
  });

  it("有子工具调用时显示最近一次 + 累计次数", () => {
    const body = renderDelegateBody({ agent: "code", task: "t", count: 3, lastTool: 'read_file({"path":"src/a.ts"})' });
    expect(body.split("\n")[2]).toBe('⚡ read_file({"path":"src/a.ts"})（第 3 次工具调用）');
  });

  it("终态行存在时不再显示子工具行", () => {
    const body = renderDelegateBody(
      { agent: "docs", task: "t", count: 5, lastTool: "search_documents(x)" },
      "✓ 子 agent 完成：5 次工具调用 · 返回 800 字",
    );
    expect(body.split("\n")).toHaveLength(3);
    expect(body.split("\n")[2]).toContain("✓");
    expect(body).not.toContain("⚡");
  });

  it("任务超 100 字截断为一行", () => {
    const body = renderDelegateBody({ agent: "code", task: "长".repeat(150), count: 0 });
    const taskLine = body.split("\n")[1];
    expect(taskLine.length).toBe(101); // 100 + "…"
    expect(taskLine.endsWith("…")).toBe(true);
  });
});

describe("delegateFinalLine", () => {
  it("成功：带次数与产出规模", () => {
    expect(delegateFinalLine({ agent: "code", task: "t", count: 5 }, true, 12)).toBe(
      "✓ 子 agent 完成：5 次工具调用 · 返回 12 字",
    );
  });
  it("产出 >=1000 字换算 k", () => {
    expect(delegateFinalLine(undefined, true, 1500)).toContain("返回 1.5k 字");
  });
  it("activity 缺失时次数记 0 而不是 NaN", () => {
    expect(delegateFinalLine(undefined, true, 10)).toContain("0 次工具调用");
  });
  it("失败：带原因", () => {
    expect(delegateFinalLine(undefined, false, 0, "boom")).toBe("✗ 子 agent 失败：boom");
  });
});

describe("delegateResultLine", () => {
  it("剥掉来源标记前缀", () => {
    expect(delegateResultLine("[子 agent code 返回]\n结论在这里")).toBe("⤷ 结论在这里");
  });
  it("超 160 字截断", () => {
    const line = delegateResultLine("x".repeat(200));
    expect(line).toBe(`⤷ ${"x".repeat(160)}…`);
  });
});

describe("patchCardByKey", () => {
  it("按 key 原地替换，返回新 buffer", () => {
    const a = msg({ key: "delegate:1", content: "before" });
    const b = msg({ content: "other" });
    const next = patchCardByKey([a, b], "delegate:1", (m) => ({ ...m, content: "after" }));
    expect(next).not.toBeNull();
    expect(next![0].content).toBe("after");
    expect(next![1].content).toBe("other");
    expect(next![0]).not.toBe(a); // 不可变替换
  });

  it("key 不存在返回 null（卡已溢出进 Static 的信号）", () => {
    expect(patchCardByKey([msg()], "delegate:404", (m) => m)).toBeNull();
  });

  it("findCardIndexByKey / delegateCardKey 配套", () => {
    expect(findCardIndexByKey([msg({ key: "delegate:7" })], "delegate:7")).toBe(0);
    expect(delegateCardKey("delegate-3")).toBe("delegate:delegate-3");
  });
});
