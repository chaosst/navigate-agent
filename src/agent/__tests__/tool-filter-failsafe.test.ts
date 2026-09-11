/**
 * 工具过滤的 fail-closed 回归护栏（2026-09-11 新增）
 *
 * 旧实现（graph-agent-executor.ts 的 agentNode）：
 *   if (filtered.length > 0) activeTools = filtered
 * —— 过滤结果为空时**静默回退 this.tools（全量工具面）**。这意味着只要工具集里
 * 混进了未包装的裸工具（无 permission → 必被过滤掉），或工具数组被误扩大，
 * 过滤器就形同虚设，把危险工具重新交回 LLM。这是与 server-entry fallback 并列的
 * 第二个 fail-open，本文件直接把它钉死。
 *
 * 用「空集」而不是「回退全量」的语义还有一个好处：LLM 仍可凭自身知识作答，
 * 入口不会因为过滤器而变成完全不可用 —— 只是拿不到任何工具。
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ChatOpenAI } from "@langchain/openai";
import { GraphAgentExecutor } from "../graph-agent-executor.js";
import { ReadOnlyToolFilter } from "../../tools/tool-filter.js";
import { PermissionWrapper, type ToolPermission } from "../../tools/permission.js";

/** 轻量假工具：只用于被包装与绑定，不需要真正执行 */
function fakeTool(toolName: string, permission: ToolPermission): PermissionWrapper {
  const inner = {
    name: toolName,
    description: "test tool",
    schema: z.object({}),
  } as unknown as StructuredTool;
  return new PermissionWrapper(inner, permission);
}

/** mock ChatOpenAI：记录 bindTools 实际收到的工具面 */
function makeFakeLlm() {
  const invokeMock = vi.fn(async () => new AIMessage("done"));
  const bindTools = vi.fn(() => ({ invoke: invokeMock }));
  const llm = { bindTools, invoke: invokeMock };
  return { llm: llm as unknown as ChatOpenAI, bindTools };
}

/** agentNode 的 state 形状（plain object 即可直接调方法，不必跑图） */
function stateOf(userInput: string): Record<string, unknown> {
  return {
    messages: [new SystemMessage("你是测试 agent"), new HumanMessage(userInput)],
    userInput,
    iteration: 0,
    intermediateSteps: [],
  };
}

/** 取第 n 次 bindTools 实际绑定的工具名 */
function boundNames(bindTools: ReturnType<typeof vi.fn>, callIndex = 0): string[] {
  const tools = bindTools.mock.calls[callIndex]?.[0] as Array<{ name: string }> | undefined;
  return (tools ?? []).map((t) => t.name);
}

describe("工具过滤 fail-closed：空结果不回退全量", () => {
  it("只读过滤器剔除全部工具后，绑定给 LLM 的是空集（旧实现会回退到全量）", async () => {
    const { llm, bindTools } = makeFakeLlm();
    const tools = [
      fakeTool("write_file", "write"),
      fakeTool("execute_command", "dangerous"),
    ];
    const executor = new GraphAgentExecutor(
      llm,
      tools,
      "系统提示",
      5,
      undefined,
      new ReadOnlyToolFilter(),
    );

    await executor.agentNode(stateOf("帮我执行一个命令") as never);

    expect(bindTools).toHaveBeenCalled();
    expect(boundNames(bindTools)).toEqual([]);
  });

  it("只读过滤器保留 read 工具、剔除高危工具（正常只读场景）", async () => {
    const { llm, bindTools } = makeFakeLlm();
    const tools = [
      fakeTool("search_resume", "read"),
      fakeTool("write_file", "write"),
      fakeTool("execute_command", "dangerous"),
    ];
    const executor = new GraphAgentExecutor(
      llm,
      tools,
      "系统提示",
      5,
      undefined,
      new ReadOnlyToolFilter(),
    );

    await executor.agentNode(stateOf("介绍一下你的项目经历") as never);

    expect(boundNames(bindTools)).toEqual(["search_resume"]);
  });

  it("对照组：不传过滤器时全量工具照常绑定（过滤是显式开关，不是默认行为）", async () => {
    const { llm, bindTools } = makeFakeLlm();
    const tools = [
      fakeTool("search_resume", "read"),
      fakeTool("execute_command", "dangerous"),
    ];
    const executor = new GraphAgentExecutor(llm, tools, "系统提示", 5);

    await executor.agentNode(stateOf("介绍一下你的项目经历") as never);

    expect(boundNames(bindTools)).toEqual(["search_resume", "execute_command"]);
  });
});
