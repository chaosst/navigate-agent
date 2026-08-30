import { describe, expect, it } from "vitest";
import { computeAgentMetrics } from "../agent-eval.js";
import type { TraceEntry, TraceSession } from "../../../agent/tracer.js";

/** 构造一条 TraceEntry，必填字段兜底，extra 覆盖 */
function entry(
  type: TraceEntry["type"],
  iteration: number,
  extra: Partial<TraceEntry> = {},
): TraceEntry {
  return {
    id: `${type}_${iteration}`,
    type,
    timestamp: 0,
    durationMs: 0,
    iteration,
    ...extra,
  } as TraceEntry;
}

function makeSession(over: Partial<TraceSession> = {}): TraceSession {
  return {
    userInput: "测试任务",
    startedAt: 1000,
    finishedAt: 3000,
    steps: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...over,
  };
}

describe("computeAgentMetrics", () => {
  it("全场景：工具/错误/迭代/PTC 指标精确计算", () => {
    const session = makeSession({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      steps: [
        entry("llm_call", 0),
        entry("tool_call", 0),
        entry("tool_result", 0, { toolSuccess: true }),
        entry("tool_result", 1, { toolSuccess: true }),
        entry("tool_result", 1, { toolSuccess: false }),
        entry("error", 2),
        entry("ptc_program", 2),
        entry("ptc_result", 2, { ptcKind: "ok" }),
        entry("ptc_result", 3, { ptcKind: "exception" }),
      ],
    });

    const m = computeAgentMetrics(session);
    expect(m.stepCount).toBe(9);
    expect(m.toolSuccessRate).toBeCloseTo(2 / 3);
    expect(m.errorCount).toBe(1);
    expect(m.errorRate).toBeCloseTo(1 / 9);
    expect(m.iterations).toBe(4);
    expect(m.latencyMs).toBe(2000);
    expect(m.totalTokens).toBe(150);
    expect(m.tokenEfficiency).toBeCloseTo(37.5);
    expect(m.ptcOkRate).toBeCloseTo(0.5);
  });

  it("空 session：全部归零，ptcOkRate 为 null", () => {
    const m = computeAgentMetrics(makeSession());
    expect(m.stepCount).toBe(0);
    expect(m.toolSuccessRate).toBe(0);
    expect(m.errorRate).toBe(0);
    expect(m.iterations).toBe(0);
    expect(m.latencyMs).toBe(2000); // session 级字段，与步骤无关（默认构造 3000-1000）
    expect(m.tokenEfficiency).toBe(0);
    expect(m.ptcOkRate).toBeNull();
  });

  it("无 PTC 调用：ptcOkRate 为 null 而非 0", () => {
    const session = makeSession({
      steps: [entry("llm_call", 0), entry("tool_result", 0, { toolSuccess: true })],
    });
    const m = computeAgentMetrics(session);
    expect(m.ptcOkRate).toBeNull();
    expect(m.toolSuccessRate).toBe(1);
  });

  it("无工具调用：toolSuccessRate 为 0", () => {
    const session = makeSession({ steps: [entry("llm_call", 0)] });
    expect(computeAgentMetrics(session).toolSuccessRate).toBe(0);
  });

  it("session 未结束：latencyMs 为 0", () => {
    const session = makeSession({ finishedAt: undefined, steps: [entry("llm_call", 0)] });
    expect(computeAgentMetrics(session).latencyMs).toBe(0);
  });
});
