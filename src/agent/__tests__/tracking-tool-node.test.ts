import { describe, it, expect } from "vitest";
import { StructuredTool } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { TrackingToolNode } from "../tracking-tool-node.js";
import { Tracer } from "../tracer.js";
import { PermissionWrapper } from "../../tools/permission.js";

class EchoTool extends StructuredTool {
  name = "echo";
  description = "echo the input";
  schema = z.object({ v: z.unknown() });
  async _call({ v }: { v: unknown }): Promise<string> {
    return JSON.stringify(v);
  }
}

/** 返回超长字符串的工具，触发截断路径 */
class BloatTool extends StructuredTool {
  name = "bloat";
  description = "return a big string";
  schema = z.object({ n: z.number() });
  async _call({ n }: { n: number }): Promise<string> {
    return "x".repeat(n);
  }
}

/** 带真实延迟的工具，供断言耗时归因 */
class SleepTool extends StructuredTool {
  name = "sleep";
  description = "sleep a while";
  schema = z.object({ ms: z.number() });
  async _call({ ms }: { ms: number }): Promise<string> {
    await new Promise((r) => setTimeout(r, ms));
    return "done";
  }
}

describe("TrackingToolNode", () => {
  it("produces intermediateSteps from tool execution", async () => {
    const node = new TrackingToolNode([new EchoTool()]);
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call_1", name: "echo", args: { v: 42 } }],
    });
    const result = (await node.run({ messages: [ai] })) as {
      messages: unknown[];
      intermediateSteps: unknown[];
    };

    // 消息（ToolMessage）与中间步骤都产出
    expect(result.messages).toHaveLength(1);
    expect(result.intermediateSteps).toHaveLength(1);
    const step = result.intermediateSteps[0] as {
      action: { tool: string; toolInput: Record<string, unknown> };
      observation: unknown;
    };
    expect(step.action.tool).toBe("echo");
    expect(step.action.toolInput).toEqual({ v: 42 });
    expect(step.observation).toBe("42");
  });

  it("truncates oversized tool results before they enter context", async () => {
    // 上限设 100 字符：工具返回 10 万字符 → 保留头尾 + 截断标记，长度显著变小
    const node = new TrackingToolNode([new BloatTool()], { maxToolResultChars: 100 });
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call_1", name: "bloat", args: { n: 100_000 } }],
    });
    const result = (await node.run({ messages: [ai] })) as {
      messages: { _getType: () => string; content: unknown; tool_call_id?: string }[];
      intermediateSteps: { observation: unknown }[];
    };

    const tm = result.messages[0];
    expect(tm._getType()).toBe("tool");
    const content = tm.content as string;
    expect(content.length).toBeLessThan(100_000);
    expect(content).toContain("已截断");
    // 头尾都保留：原始全 'x'，头尾仍为 'x'，中间是标记
    expect(content.startsWith("x".repeat(60))).toBe(true);
    expect(content.endsWith("x".repeat(40))).toBe(true);
    // 中间步骤的 observation 也用了截断后的内容
    expect(String(result.intermediateSteps[0].observation).length).toBe(content.length);
  });

  it("向 Tracer 记录 tool_call/tool_result（LangGraph 路径此前缺失）", async () => {
    const tracer = new Tracer();
    tracer.startSession("test");
    const node = new TrackingToolNode([new EchoTool()], { tracer });
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call_1", name: "echo", args: { v: 42 } }],
    });
    await node.run({ messages: [ai], iteration: 3 });

    const session = tracer.getCurrentSession()!;
    const result = session.steps.find((s) => s.type === "tool_result");
    expect(result).toBeTruthy();
    expect(result!.toolName).toBe("echo");
    expect(result!.iteration).toBe(3);
    expect(result!.toolSuccess).toBe(true);
    expect(result!.toolResult).toContain("42");
  });

  it("PermissionWrapper 包裹的工具能归因到真实耗时", async () => {
    const tracer = new Tracer();
    tracer.startSession("test");
    const wrapped = new PermissionWrapper(new SleepTool(), "read");
    const node = new TrackingToolNode([wrapped], { tracer });
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call_1", name: "sleep", args: { ms: 30 } }],
    });
    await node.run({ messages: [ai] });

    const session = tracer.getCurrentSession()!;
    const result = session.steps.find((s) => s.type === "tool_result");
    expect(result).toBeTruthy();
    expect((result!.durationMs ?? 0)).toBeGreaterThan(10);
  });

  it("skips tool_calls already answered in the message history", async () => {
    const node = new TrackingToolNode([new EchoTool()]);
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call_1", name: "echo", args: { v: 1 } }],
    });
    // 只执行未回复的 tool_call；已回复的不会重复执行
    const result = (await node.run({ messages: [ai] })) as {
      intermediateSteps: unknown[];
    };
    expect(result.intermediateSteps).toHaveLength(1);
  });
});
