import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { MockModel } from "../mock-model.js";

const tools = [{ name: "list_files" }, { name: "read_file" }] as unknown[];

describe("MockModel 脚本推进", () => {
  it("第 0 轮返回 list_files，第 1 轮返回 read_file，之后直接回复", async () => {
    const m = new MockModel();
    const bound = m.bindTools(tools);

    const r0 = await bound.invoke([new SystemMessage("x"), new HumanMessage("t")]);
    expect(r0.tool_calls?.[0].name).toBe("list_files");
    expect(r0.tool_calls?.[0].args).toEqual({ path: "." });

    const r1 = await bound.invoke([
      new SystemMessage("x"),
      new HumanMessage("t"),
      new AIMessage({ content: "", tool_calls: [{ name: "list_files", args: {}, id: "c1", type: "tool_call" }] }),
      new ToolMessage("a.ts", "c1"),
    ]);
    expect(r1.tool_calls?.[0].name).toBe("read_file");

    const r2 = await bound.invoke([
      new SystemMessage("x"),
      new HumanMessage("t"),
      new AIMessage({ content: "", tool_calls: [{ name: "list_files", args: {}, id: "c1", type: "tool_call" }] }),
      new AIMessage({ content: "", tool_calls: [{ name: "read_file", args: {}, id: "c2", type: "tool_call" }] }),
    ]);
    expect(r2.tool_calls).toEqual([]); // 空数组 = 无工具调用，与真实 AIMessage 语义一致
    expect(typeof r2.content).toBe("string");
    expect(r2.usage_metadata?.total_tokens).toBe(0);
  });

  it("历史热身里的 assistant 回复（无 tool_calls）不推进脚本", async () => {
    const m = new MockModel();
    const bound = m.bindTools(tools);
    const r = await bound.invoke([
      new SystemMessage("x"),
      new HumanMessage("热身1"),
      new AIMessage("热身回答1"),
      new HumanMessage("热身2"),
      new AIMessage("热身回答2"),
      new HumanMessage("正式任务"),
    ]);
    // 仍应是第 0 步 list_files
    expect(r.tool_calls?.[0].name).toBe("list_files");
  });

  it("脚本工具名不在绑定集时回退到第一个绑定工具", async () => {
    const m = new MockModel({ script: [{ tool: { name: "nope", args: {} } }, { final: "done" }] });
    const bound = m.bindTools(tools);
    const r = await bound.invoke([new HumanMessage("t")]);
    expect(r.tool_calls?.[0].name).toBe("list_files");
  });

  it("invoke 直接调用（executor 的 recovery 路径，bindTools 已于同 run 内先调用）", async () => {
    const m = new MockModel();
    m.bindTools(tools); // executor 每轮都先 bindTools 再 invoke
    const r = await m.invoke([new HumanMessage("t")]);
    expect(r.tool_calls?.[0].name).toBe("list_files");
  });
});