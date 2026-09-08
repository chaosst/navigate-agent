import { describe, it, expect } from "vitest";
import { DelegateTool, pickChildTools, DELEGATE_PROFILES } from "../delegate-tool.js";
import type { ChatOpenAI } from "@langchain/openai";

/** 父工具存根：只需 name（StructuredToolInterface 靠 as any） */
const stub = (name: string) => ({ name } as any);

describe("pickChildTools 按 profile 裁剪", () => {
  it("code 只挑 search/list/read 文件工具", () => {
    const all = [stub("search_files"), stub("execute_command"), stub("search_documents"), stub("read_file")];
    const picked = pickChildTools(all, "code").map((t) => t.name);
    expect(picked).toEqual(["search_files", "read_file"]);
  });
  it("profile 工具缺失时静默跳过（不抛）", () => {
    const picked = pickChildTools([stub("execute_command")], "docs");
    expect(picked).toEqual([]);
  });
});

describe("DelegateTool", () => {
  it("委派成功：child 输出被包上来源标记返回", async () => {
    const tool = new DelegateTool({
      llm: {} as unknown as ChatOpenAI,
      tools: [stub("search_files")],
      runSubAgent: async ({ profile }) => `这是 ${profile.key} 的分析`,
    });
    const out = await tool.invoke({ agent: "code", task: "分析 x.ts 的错误" });
    expect(out).toContain("[子 agent code 返回]");
    expect(out).toContain("这是 code 的分析");
  });

  it("child 抛错：吞成可读错误串返回，不向上抛", async () => {
    const tool = new DelegateTool({
      llm: {} as unknown as ChatOpenAI,
      tools: [stub("search_files")],
      runSubAgent: async () => { throw new Error("boom"); },
    });
    const out = await tool.invoke({ agent: "code", task: "t" });
    expect(out).toContain("失败");
    expect(out).toContain("boom");
  });

  it("profile 无可裁剪工具：返回明确错误而非开空 executor", async () => {
    const tool = new DelegateTool({
      llm: {} as unknown as ChatOpenAI,
      tools: [stub("execute_command")],
      runSubAgent: async () => "不该被调用",
    });
    const out = await tool.invoke({ agent: "code", task: "t" });
    expect(out).toContain("无可用的工具");
  });
});
