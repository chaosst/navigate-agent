import { describe, it, expect } from "vitest";
import { END, START, StateGraph } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { AgentStep } from "@langchain/core/agents";
import { AgentState } from "../types.js";
import { pickFinalOutput, runAgentMessages } from "../loop.js";
import { GraphAgentExecutor } from "../graph-agent-executor.js";

/**
 * normal 模式的最终回答只有两个来源：
 *   1. finalize / fallback 节点写入 AgentState.finalOutput（权威值）
 *   2. agent 节点 token 的流式拼接（兜底）
 *
 * 2026-09-11 之前的缺陷：AgentState 里**没有** finalOutput 这个通道，
 * LangGraph 静默丢弃该字段 → agent.log 里 151/151 次 `finalize 完成 {"outputChars":0}`，
 * 最终回答只能靠「把所有 agent 节点 token 拼起来」，于是中间轮的叙述也混了进去。
 *
 * 下面第一条用例把「通道确实会被 updates 流带出」钉死；如果哪天 LangGraph 改了行为，
 * 这条测试必须先失败，而不是等线上回答凭空变空。
 */
describe("AgentState.finalOutput 通道", () => {
  it("节点返回的 finalOutput 会被 updates 流带出", async () => {
    const graph = new StateGraph(AgentState)
      .addNode("finalize", () => ({ finalOutput: "权威答案" }))
      .addEdge(START, "finalize")
      .addEdge("finalize", END)
      .compile();

    const chunks: unknown[] = [];
    for await (const chunk of await graph.stream({ messages: [] }, { streamMode: "updates" })) {
      chunks.push(chunk);
    }
    expect(JSON.stringify(chunks)).toContain("权威答案");
  });

  it("没有任何节点写入时，finalOutput 落到默认空串（不是 undefined）", async () => {
    const graph = new StateGraph(AgentState)
      .addNode("noop", () => ({ iteration: 1 }))
      .addEdge(START, "noop")
      .addEdge("noop", END)
      .compile();

    const out = await graph.invoke({ messages: [] });
    expect(out.finalOutput).toBe("");
  });
});

describe("pickFinalOutput", () => {
  it("权威值非空 → 采用权威值", () => {
    expect(pickFinalOutput("答案", "叙述答案")).toBe("答案");
  });
  it("权威值为空或纯空白 → 回退到流式拼接，绝不返回空", () => {
    expect(pickFinalOutput("", "叙述答案")).toBe("叙述答案");
    expect(pickFinalOutput("  \n ", "叙述答案")).toBe("叙述答案");
  });
  it("两边都空 → 空串（不是 undefined）", () => {
    expect(pickFinalOutput("", "")).toBe("");
  });
});

/**
 * 下面两条打穿 runAgentMessages → GraphAgentExecutor 的真实链路。
 * 这是「中间叙述被拼进最终回答」这个历史缺陷的直接回归护栏。
 */
describe("normal 模式：叙述与最终回答分流", () => {
  it("outputPreview 只进预览，output 只进最终回答（旧实现会把两者拼成一条）", async () => {
    const step: AgentStep = {
      action: { tool: "read_file", toolInput: { path: "a.txt" }, log: "" } as never,
      observation: "文件内容",
    };
    // 桩 stream：复现真实 graph 的 chunk 序列
    const stub = {
      stream: async function* () {
        yield { outputPreview: "我先看一下文件。" };
        yield { intermediateSteps: [step] };
        yield { outputPreview: "已看清结构。" };
        yield { output: "最终回答。" };
      },
    } as unknown as GraphAgentExecutor;

    const previews: string[] = [];
    const tokens: string[] = [];
    const tools: string[] = [];
    const out = await runAgentMessages(stub, [], {
      onPreview: (t) => previews.push(t),
      onToken: (t) => tokens.push(t),
      onToolStart: (name) => tools.push(name),
    });

    // 最终回答绝不含中间叙述（修复前这里是「我先看一下文件。已看清结构。最终回答。」）
    expect(out).toBe("最终回答。");
    expect(out).not.toContain("我先看一下文件");
    // 叙述走 onPreview，最终回答走 onToken，两条通道不串
    expect(previews.join("")).toBe("我先看一下文件。已看清结构。");
    expect(tokens.join("")).toBe("最终回答。");
    // 工具事件照常透传
    expect(tools).toEqual(["read_file"]);
  });

  it("真实 graph：最终回答由 finalize 节点送达（假 LLM，无 token 流）", async () => {
    const reply = new AIMessage("这是最终回答。");
    const fakeLlm = {
      bindTools: () => ({ invoke: async () => reply }),
      invoke: async () => reply,
    };
    // 无工具 → 首轮即 finalize；无 token 流 → 修复前 output 会是空串
    const exec = new GraphAgentExecutor(fakeLlm as never, [], "sys", 3, undefined, undefined, undefined, 5000);

    const out = await runAgentMessages(exec, [new HumanMessage("hi")], {}, 20_000);

    expect(out).toBe("这是最终回答。");
  });
});
