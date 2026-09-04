import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { foldOldToolResults } from "../graph-utils.js";

/** 造一轮：AI 决策(工具) + Tool 结果 */
function round(name: string, content: string, id: number): BaseMessage[] {
  return [
    new AIMessage({
      content: "",
      tool_calls: [{ id: `c${id}`, name, args: {}, type: "tool_call" }],
    }),
    new ToolMessage(content, `c${id}`, name),
  ];
}

const big = (ch: string) => ch.repeat(800); // > FOLD_SNIPPET(300)

function build(): BaseMessage[] {
  return [
    new SystemMessage("sys"),
    new HumanMessage("hi"),
    ...round("list_files", big("a"), 1), // round 0
    ...round("read_file", big("b"), 2),  // round 1
    ...round("echo", big("c"), 3),       // round 2
    ...round("echo", big("d"), 4),       // round 3
  ];
}

describe("foldOldToolResults", () => {
  it("超过 keepRounds 的旧轮 ToolMessage 折叠为开头+标记，近窗轮原样保留", () => {
    const folded = foldOldToolResults(build(), 2);
    // 结构不变：仍 2 + 4*2 条
    expect(folded.length).toBe(2 + 8);

    // round0/1 的 tool 结果（a/b）被折叠
    const toolContents = folded
      .filter((m) => m._getType() === "tool")
      .map((m) => String(m.content));
    expect(toolContents[0]).toContain("旧工具结果已折叠");
    expect(toolContents[0]).toContain("原始 800 字符");
    expect(toolContents[1]).toContain("旧工具结果已折叠");
    // round2/3 的 tool 结果（c/d）完整
    expect(toolContents[2]).toBe(big("c"));
    expect(toolContents[3]).toBe(big("d"));
  });

  it("keepRounds<=0 视为禁用，原样返回", () => {
    const folded = foldOldToolResults(build(), 0);
    expect(folded).toHaveLength(build().length);
    expect(folded.filter((m) => m._getType() === "tool").map((m) => String(m.content))[0]).toBe(big("a"));
  });

  it("工具轮数没超过窗口时完全不折叠", () => {
    const folded = foldOldToolResults(build(), 4);
    const toolContents = folded.filter((m) => m._getType() === "tool").map((m) => String(m.content));
    expect(toolContents.every((c) => c.length === 800)).toBe(true);
  });
});