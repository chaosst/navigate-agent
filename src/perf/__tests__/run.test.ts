import { describe, expect, it } from "vitest";
import type { TraceSession } from "../../agent/tracer.js";
import { computePerfMetrics, unionWall } from "../run.js";

function makeSession(overrides: Partial<TraceSession> = {}): TraceSession {
  return {
    userInput: "task",
    startedAt: 1000,
    finishedAt: 5000, // totalMs = 4000
    steps: [
      {
        id: "llm_1", type: "llm_call", timestamp: 1000, durationMs: 2000,
        iteration: 0, llmToolCalls: ["list_files"], inputTokens: 100, outputTokens: 50,
      },
      {
        id: "tool_1", type: "tool_call", timestamp: 3000, durationMs: 0,
        iteration: 0, toolName: "list_files", toolInput: { path: "." },
      },
      {
        id: "tool_2", type: "tool_result", timestamp: 3000, durationMs: 500,
        iteration: 0, toolName: "list_files", toolResult: "a.ts", toolSuccess: true,
      },
    ],
    totalInputTokens: 100,
    totalOutputTokens: 50,
    ...overrides,
  };
}

describe("computePerfMetrics", () => {
  it("残差法：overhead = total − llm − tool，并拆出 route/outside", () => {
    const session = makeSession({ parseMs: 30, graphMs: 2600 });
    const m = computePerfMetrics(session, "t1", "cat");

    expect(m.totalMs).toBe(4000);
    expect(m.llmMs).toBe(2000);
    expect(m.toolMs).toBe(500);
    expect(m.overheadMs).toBe(1500);
    expect(m.overheadPct).toBeCloseTo(37.5, 1);
    expect(m.graphMs).toBe(2600);
    expect(m.parseMs).toBe(30);
    expect(m.routeMs).toBe(100); // 2600 − 2000 − 500
    expect(m.outsideMs).toBe(1370); // 4000 − 2600 − 30
    expect(m.iterations).toBe(1);
    expect(m.inputTokens).toBe(100);
    expect(m.outputTokens).toBe(50);
  });

  it("无 graphMs/parseMs 时返回 null，routeMs 不做越界负值", () => {
    const m = computePerfMetrics(makeSession(), "t1", "cat");
    expect(m.graphMs).toBeNull();
    expect(m.parseMs).toBeNull();
    expect(m.routeMs).toBeNull();
    expect(m.outsideMs).toBeNull();
    // llm(2000)+tool(500) > graph 无定义 → route 不计算
  });

  it("时间噪声不产生负 overhead", () => {
    const session = makeSession({
      steps: [
        {
          id: "llm_1", type: "llm_call", timestamp: 1000, durationMs: 4500,
          iteration: 0, inputTokens: 1, outputTokens: 1,
        },
      ],
    });
    const m = computePerfMetrics(session, "t1", "cat");
    // totalMs=4000 < llmMs=4500 → overhead 钳到 0
    expect(m.overheadMs).toBe(0);
    expect(m.overheadPct).toBe(0);
  });

  it("注入 tools 归属（registry 窗口）时 toolMs 用它，不再回落到 trace", () => {
    const m = computePerfMetrics(makeSession(), "t1", "cat", {
      tools: [
        { tool: "list_files", count: 1, totalMs: 8000 },
        { tool: "read_file", count: 2, totalMs: 1000 },
      ],
    });
    // tools 求和 9000 > total−llm(2000) → 防御钳制到 2000（不可能有超过墙钟的工具占用）
    expect(m.toolMs).toBe(2000);
    expect(m.tools).toHaveLength(2);
    expect(m.overheadMs).toBe(0);
    // trace 里原有一条 tool_result(500ms) 不应再被计入
    expect(m.tools.find((t) => t.tool === "list_files")?.totalMs).toBe(8000);
  });

  it("注入 toolWallMs（区间并集墙钟）优先于 tools 求和", () => {
    // 总耗时 10000、llm 2000：tools busy 8000 但真实墙钟 5000（两工具并行重叠）
    const session = makeSession({ finishedAt: 11000, graphMs: 9000 });
    const m = computePerfMetrics(session, "t1", "cat", {
      tools: [{ tool: "list_files", count: 1, totalMs: 8000 }],
      toolWallMs: 5000,
    });
    expect(m.toolMs).toBe(5000);
    expect(m.overheadMs).toBe(3000); // 10000 − 2000 − 5000
  });
});

describe("unionWall", () => {
  it("并行（重叠）区间不重复计墙钟，串行才等于求和", () => {
    // 两个工具 [0,3000) [1000,6000) 并行重叠 → 并集 6000
    expect(unionWall([{ start: 0, dur: 3000 }, { start: 1000, dur: 5000 }])).toBe(6000);
    // 串行相邻
    expect(unionWall([{ start: 0, dur: 100 }, { start: 100, dur: 200 }])).toBe(300);
    // 空
    expect(unionWall([])).toBe(0);
  });
});