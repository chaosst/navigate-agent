import { describe, it, expect } from "vitest";
import { StructuredTool } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { TrackingToolNode } from "../tracking-tool-node.js";

class EchoTool extends StructuredTool {
  name = "echo";
  description = "echo the input";
  schema = z.object({ v: z.unknown() });
  async _call({ v }: { v: unknown }): Promise<string> {
    return JSON.stringify(v);
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
