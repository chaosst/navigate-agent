/**
 * mock-model.ts — ChatOpenAI 兼容假模型（perf A/B 隔离用）
 *
 * 用途：--mock 模式下替换真实 LLM，让整条 agent 链路（parse/图路由/工具真实执行/
 * DB 持久化/流式转发）跑起来但**没有 LLM 时间**，于是：
 *   mock 总耗时 ≈ 纯项目自身开销
 *   real − mock = DeepSeek 的净贡献
 *
 * 设计：脚本化决策。按已完成的 LLM 轮数（messages 里 AI 消息条数）推进脚本：
 *   第 0 轮 → list_files；第 1 轮 → read_file；第 2 轮 → 直接回复。
 * 工具名优先用脚本里写的，找不到则回退到调用方 bindTools 传入的第一个工具，
 * 避免 LangGraph ToolNode 报 unknown tool。
 *
 * 类型说明：ChatOpenAI 有海量方法，executor 实际只用了 bindTools().invoke / invoke。
 * 结构上无法静态满足 ChatOpenAI 类型，run.ts 注入时用 `as unknown as ChatOpenAI`。
 */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type MockStep = { tool: MockToolCall } | { final: string };

export interface MockModelOptions {
  /** 脚本化决策序列；缺省为「list_files → read_file → 回复」三段式 */
  script?: MockStep[];
  /** 每次 invoke 前模拟的本地处理延迟（ms），默认 0 */
  delayMs?: number;
}

const DEFAULT_SCRIPT: MockStep[] = [
  { tool: { name: "list_files", args: { path: "." } } },
  { tool: { name: "read_file", args: { path: "README.md" } } },
  { final: "MOCK — 本轮为纯项目自身开销（parse/路由/工具/DB），不含真实 LLM 时间。" },
];

export class MockModel {
  private script: MockStep[];
  private delayMs: number;
  /** bindTools(tools) 时记录的工具名（脚本名回退用） */
  private toolNames: string[] = [];
  private callSeq = 0;

  constructor(opts: MockModelOptions = {}) {
    this.script = opts.script ?? DEFAULT_SCRIPT;
    this.delayMs = opts.delayMs ?? 0;
  }

  /** 兼容 executor：llm.bindTools(activeTools) → { invoke(messages) } */
  bindTools(tools: unknown[]): {
    invoke: (messages: BaseMessage[], opts?: unknown) => Promise<AIMessage>;
  } {
    this.toolNames = (tools as Array<{ name: string } | undefined>)
      .map((t) => t?.name)
      .filter((n): n is string => !!n);
    const self = this;
    return {
      invoke: (messages: BaseMessage[], opts?: unknown) => self.respond(messages),
    };
  }

  /** 兼容 executor 降级路径：llm.invoke(messages, { signal }) */
  async invoke(messages: BaseMessage[], opts?: unknown): Promise<AIMessage> {
    return this.respond(messages);
  }

  private async respond(messages: BaseMessage[]): Promise<AIMessage> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));

    // 只数「带工具决策」的 AI 轮数（历史热身里的 assistant 回复不带 tool_calls，
    // 不计入），这样 --warmup 不会让 mock 脚本前进。
    const aiCount = messages.filter(
      (m) => m._getType() === "ai" && (m as { tool_calls?: unknown[] }).tool_calls?.length,
    ).length;
    const step = this.script[Math.min(aiCount, this.script.length - 1)];

    if (step && "tool" in step) {
      const tc = step.tool;
      const name = this.toolNames.includes(tc.name) ? tc.name : this.toolNames[0];
      if (!name) {
        return new AIMessage({
          content: "MOCK: 无绑定工具，直接结束。",
          usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        });
      }
      return new AIMessage({
        content: "",
        tool_calls: [
          { name, args: tc.args, id: `call_mock_${++this.callSeq}`, type: "tool_call" },
        ],
        usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      });
    }

    return new AIMessage({
      content: step && "final" in step ? step.final : "MOCK done",
      usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
  }
}