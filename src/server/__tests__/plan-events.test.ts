import { describe, it, expect } from "vitest";
import {
  chunkToEvents,
  formatSseFrame,
  toObservationString,
  MAX_OBSERVATION_CHARS,
} from "../plan-events.js";
import type { PlanStreamChunk } from "../plan-events.js";
import type { ExecutionPlan } from "../../agent/types.js";

const plan: ExecutionPlan = {
  goal: "整理 docs",
  currentStepIndex: 0,
  createdAt: 1,
  updatedAt: 2,
  steps: [
    { id: "s1", description: "读文件", status: "completed", result: "14 个文件" },
    { id: "s2", description: "归类", status: "pending" },
  ],
};

describe("formatSseFrame", () => {
  it("序列化成 SSE 帧（与 rag-ask 的 formatSseEvent 同构）", () => {
    const ev = { type: "done" };
    expect(formatSseFrame(ev)).toBe(`event: done\ndata: ${JSON.stringify(ev)}\n\n`);
  });
});

describe("toObservationString", () => {
  it("字符串原样返回", () => {
    expect(toObservationString("hello")).toBe("hello");
  });
  it("对象 JSON 化", () => {
    expect(toObservationString({ a: 1 })).toBe('{"a":1}');
  });
  it("null / undefined 折成空串，不抛", () => {
    expect(toObservationString(null)).toBe('""');
    expect(toObservationString(undefined)).toBe('""');
  });
  it("超长截断并加标记", () => {
    const long = "x".repeat(MAX_OBSERVATION_CHARS + 100);
    const out = toObservationString(long);
    expect(out.startsWith("x".repeat(MAX_OBSERVATION_CHARS))).toBe(true);
    expect(out).toContain("截断");
  });
});

describe("chunkToEvents", () => {
  it("空 chunk → 空数组（绝不产出 undefined 事件）", () => {
    expect(chunkToEvents({})).toEqual([]);
  });

  it("plan → 一个 plan 事件", () => {
    expect(chunkToEvents({ plan })).toEqual([{ type: "plan", plan }]);
  });

  it("intermediateSteps → 每个 step 一个 tool 事件，保序", () => {
    const evs = chunkToEvents({
      intermediateSteps: [
        { action: { tool: "read_file", toolInput: { path: "a.md" } }, observation: "A" },
        { action: { tool: "list_files", toolInput: { dir: "docs" } }, observation: "B" },
      ] as any,
    });
    expect(evs).toEqual([
      { type: "tool", tool: "read_file", input: { path: "a.md" }, observation: "A" },
      { type: "tool", tool: "list_files", input: { dir: "docs" }, observation: "B" },
    ]);
  });

  it("无 action 的步骤被丢弃（无法归属的工具调用不渲染）", () => {
    const evs = chunkToEvents({ intermediateSteps: [{ observation: "孤儿" }] as any });
    expect(evs).toEqual([]);
  });

  it("output → answer 事件；顺序恒为 plan → tool… → answer", () => {
    const chunk: PlanStreamChunk = {
      plan,
      intermediateSteps: [
        { action: { tool: "read_file", toolInput: {} }, observation: "A" },
      ] as any,
      output: "最终答案",
    };
    expect(chunkToEvents(chunk).map((e) => e.type)).toEqual(["plan", "tool", "answer"]);
  });

  it("outputPreview 不产出任何事件（plan 模式下恒不产生，见 §2 说明）", () => {
    expect(chunkToEvents({ outputPreview: "中间叙述" })).toEqual([]);
  });
});
