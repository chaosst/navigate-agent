import { describe, it, expect } from "vitest";
import {
  pushToolCallStart,
  settleToolCall,
  capTurnCards,
  isPlainToolCard,
  FOLD_CARD_KEY,
} from "../turn-cards.js";
import type { OutputMessage } from "../output.js";

const msg = (over: Partial<OutputMessage> = {}): OutputMessage => ({
  role: "tool",
  name: "read_file",
  content: "c",
  timestamp: new Date(),
  ...over,
});

describe("settleToolCall（plan 步骤卡路径）", () => {
  it("连续同名调用合并成 ×N 卡，content 压成单行最近摘要", () => {
    let buf = settleToolCall([], "read_file", "→ 第一次结果");
    expect(buf).toHaveLength(1);
    expect(buf[0].content).toBe("→ 第一次结果");

    buf = settleToolCall(buf, "read_file", "→ 第二次\n多行结果");
    expect(buf).toHaveLength(1);
    expect(buf[0].callCount).toBe(2);
    expect(buf[0].content).toBe("×2 · → 第二次 多行结果");
  });

  it("不同名调用不合并，各自一张卡", () => {
    let buf = settleToolCall([], "read_file", "→ a");
    buf = settleToolCall(buf, "search_files", "→ b");
    buf = settleToolCall(buf, "read_file", "→ c");
    expect(buf.map((m) => m.name)).toEqual(["read_file", "search_files", "read_file"]);
  });

  it("单次卡保持完整 detail（Static 历史不丢信息）", () => {
    const buf = settleToolCall([], "search_documents", "→ 很长很长的观测结果");
    expect(buf[0].content).toBe("→ 很长很长的观测结果");
  });
});

describe("pushToolCallStart + settleToolCall（normal 模式路径）", () => {
  it("新工具追加 running 卡；end 后结算为单次卡", () => {
    let buf = pushToolCallStart([], "read_file", '{"path":"a.ts"}');
    expect(buf).toHaveLength(1);
    expect(buf[0].running).toBe(true);
    expect(buf[0].content).toBe('Calling: read_file\n{"path":"a.ts"}');

    buf = settleToolCall(buf, "read_file", "→ 结果A");
    expect(buf).toHaveLength(1);
    expect(buf[0].running).toBeFalsy();
    expect(buf[0].content).toBe("→ 结果A");
  });

  it("同名第二次 start 原地复用卡片并保留计数，end 后 ×2", () => {
    let buf = pushToolCallStart([], "read_file", '{"path":"a.ts"}');
    buf = settleToolCall(buf, "read_file", "→ 结果A");

    buf = pushToolCallStart(buf, "read_file", '{"path":"b.ts"}');
    expect(buf).toHaveLength(1); // 没有新开卡
    expect(buf[0].running).toBe(true);
    expect(buf[0].callCount).toBe(1);
    expect(buf[0].content).toBe('Calling: read_file\n{"path":"b.ts"}');

    buf = settleToolCall(buf, "read_file", "→ 结果B");
    expect(buf).toHaveLength(1);
    expect(buf[0].running).toBeFalsy();
    expect(buf[0].callCount).toBe(2);
    expect(buf[0].content).toBe("×2 · → 结果B");
  });

  it("同名第三次 end 后 ×3", () => {
    let buf = pushToolCallStart([], "read_file", "{}");
    buf = settleToolCall(buf, "read_file", "→ 1");
    buf = pushToolCallStart(buf, "read_file", "{}");
    buf = settleToolCall(buf, "read_file", "→ 2");
    buf = pushToolCallStart(buf, "read_file", "{}");
    buf = settleToolCall(buf, "read_file", "→ 3");
    expect(buf).toHaveLength(1);
    expect(buf[0].callCount).toBe(3);
    expect(buf[0].content).toBe("×3 · → 3");
  });
});

describe("capTurnCards", () => {
  it("超限时折叠最老的普通工具卡进折叠卡（新建折叠卡先占一槽，可再折叠一次）", () => {
    const buffer = [
      msg({ name: "a1", content: "→ 1" }),
      msg({ name: "a2", content: "→ 2" }),
      msg({ name: "a3", content: "→ 3" }),
    ];
    const next = capTurnCards(buffer, 2);
    expect(next).toHaveLength(2);
    const fold = next.find((m) => m.key === FOLD_CARD_KEY)!;
    expect(fold).toBeDefined();
    // a1、a2 先后折叠（新建折叠卡后总长仍超限 → 继续折叠直到 ≤ limit）
    expect(fold.callCount).toBe(2);
    expect(fold.content).toContain("2 次");
    expect(fold.content).toContain("a2");
    expect(next.some((m) => m.name === "a1")).toBe(false);
    expect(next.some((m) => m.name === "a2")).toBe(false);
  });

  it("折叠卡累计计数并更新最近工具名", () => {
    const buffer = [
      msg({ name: "a1" }),
      msg({ name: "a2" }),
      msg({ name: "a3" }),
      msg({ name: "a4" }),
    ];
    const next = capTurnCards(buffer, 2);
    const fold = next.find((m) => m.key === FOLD_CARD_KEY)!;
    expect(fold.callCount).toBe(3);
    expect(fold.content).toContain("3 次");
    expect(fold.content).toContain("a3");
  });

  it("running 卡 / 带 key 卡 / plan 卡不被折叠", () => {
    const buffer = [
      msg({ name: "delegate", key: "delegate:1", content: "🤖 委派 code 子 agent" }),
      msg({ name: "planner", running: true, content: "Calling: planner" }),
      { role: "system" as const, content: "🗺️ Plan: 目标", timestamp: new Date() },
      msg({ name: "t1" }),
      msg({ name: "t2" }),
    ];
    const next = capTurnCards(buffer, 2);
    // t1 被折叠；delegate / running / plan 都还在
    expect(next.some((m) => m.key === "delegate:1")).toBe(true);
    expect(next.some((m) => m.running)).toBe(true);
    expect(next.some((m) => m.content.startsWith("🗺️ Plan:"))).toBe(true);
  });

  it("全是关键卡时不死循环，容忍暂时超限", () => {
    const buffer = [
      msg({ name: "delegate", key: "delegate:1" }),
      { role: "system" as const, content: "🗺️ Plan: 目标", timestamp: new Date() },
    ];
    expect(capTurnCards(buffer, 1)).toHaveLength(2);
  });
});

describe("isPlainToolCard", () => {
  it("排除 running / 带 key / ptc / delegate 卡", () => {
    expect(isPlainToolCard(msg())).toBe(true);
    expect(isPlainToolCard(msg({ running: true }))).toBe(false);
    expect(isPlainToolCard(msg({ key: "delegate:1" }))).toBe(false);
    expect(isPlainToolCard(msg({ name: "delegate" }))).toBe(false);
    expect(isPlainToolCard(msg({ ptc: { kind: "dispatch", data: { tool: "x", input: 1, output: 2, isError: false } } }))).toBe(false);
  });
});
