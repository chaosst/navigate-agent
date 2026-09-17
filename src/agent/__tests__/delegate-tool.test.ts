import { describe, it, expect, vi } from "vitest";
import { DelegateTool, pickChildTools, DELEGATE_PROFILES, onDelegateEvent, type DelegateEvent } from "../delegate-tool.js";
import type { ChatOpenAI } from "@langchain/openai";

// defaultRunSubAgent 走 createAgentExecutor：mock 掉 loop.js，让 child executor
// 产出一次工具调用 + 一次终稿，用于验证 childTool 事件上报
vi.mock("../loop.js", () => ({
  createAgentExecutor: vi.fn(() => ({
    async *stream() {
      yield {
        intermediateSteps: [
          { action: { tool: "read_file", toolInput: { path: "src/a.ts" } }, observation: "ok" },
        ],
      };
      yield { output: "子 agent 结论" };
    },
  })),
}));

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

describe("DelegateTool 事件总线", () => {
  it("默认 runner：start → childTool → end 依次发出且 runId 一致", async () => {
    const events: DelegateEvent[] = [];
    const off = onDelegateEvent((e) => events.push(e));
    try {
      const tool = new DelegateTool({ llm: {} as unknown as ChatOpenAI, tools: [stub("read_file")] });
      const out = await tool.invoke({ agent: "code", task: "分析 a.ts" });
      expect(out).toContain("[子 agent code 返回]");
      expect(events.map((e) => e.type)).toEqual(["start", "childTool", "end"]);
      const start = events[0] as Extract<DelegateEvent, { type: "start" }>;
      const child = events[1] as Extract<DelegateEvent, { type: "childTool" }>;
      const end = events[2] as Extract<DelegateEvent, { type: "end" }>;
      expect(start.agent).toBe("code");
      expect(start.task).toBe("分析 a.ts");
      expect(child.tool).toBe("read_file");
      expect(child.input).toEqual({ path: "src/a.ts" });
      expect(end.ok).toBe(true);
      expect(end.outputChars).toBe("子 agent 结论".length);
      expect(new Set(events.map((e) => (e as { runId: string }).runId)).size).toBe(1);
    } finally {
      off();
    }
  });

  it("child 抛错：end.ok=false 且带 error，工具仍返回可读错误串", async () => {
    const events: DelegateEvent[] = [];
    const off = onDelegateEvent((e) => events.push(e));
    try {
      const tool = new DelegateTool({
        llm: {} as unknown as ChatOpenAI,
        tools: [stub("read_file")],
        runSubAgent: async () => { throw new Error("boom"); },
      });
      const out = await tool.invoke({ agent: "code", task: "t" });
      expect(out).toContain("失败");
      const end = events.at(-1) as Extract<DelegateEvent, { type: "end" }>;
      expect(end.type).toBe("end");
      expect(end.ok).toBe(false);
      expect(end.error).toContain("boom");
    } finally {
      off();
    }
  });

  it("无可裁剪工具：提前返回，不发任何事件", async () => {
    const events: DelegateEvent[] = [];
    const off = onDelegateEvent((e) => events.push(e));
    try {
      const tool = new DelegateTool({
        llm: {} as unknown as ChatOpenAI,
        tools: [stub("execute_command")],
        runSubAgent: async () => "不该被调用",
      });
      await tool.invoke({ agent: "code", task: "t" });
      expect(events).toEqual([]);
    } finally {
      off();
    }
  });

  it("监听器抛错不影响委托；退订后不再收事件", async () => {
    const offBad = onDelegateEvent(() => { throw new Error("observer boom"); });
    const events: DelegateEvent[] = [];
    const off = onDelegateEvent((e) => events.push(e));
    try {
      const tool = new DelegateTool({
        llm: {} as unknown as ChatOpenAI,
        tools: [stub("read_file")],
        runSubAgent: async () => "ok",
      });
      await tool.invoke({ agent: "code", task: "t" });
      expect(events.map((e) => e.type)).toEqual(["start", "end"]);
      off();
      offBad();
      await tool.invoke({ agent: "code", task: "t2" });
      expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    } finally {
      off();
      offBad();
    }
  });
});
