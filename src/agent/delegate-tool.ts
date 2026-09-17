import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentStep } from "@langchain/core/agents";
import { createAgentExecutor } from "./loop.js";

/** 子 agent 专长类别 */
export type DelegateAgent = "code" | "docs";

// ---------------------------------------------------------------------------
// 委托事件总线（模块级）
//
// 为什么是模块级而不是实例回调：bootstrap 里 delegate 经 wrapRead 包成
// PermissionWrapper 后才进工具集，TUI 拿到的不是 DelegateTool 原实例，
// 没法对实例挂回调。模块级总线与包装解耦，server 等无观察者路径零开销。
// ---------------------------------------------------------------------------

/** 子 agent 委托生命周期事件（runId 区分并行委托；同 runId 的事件按序到达） */
export type DelegateEvent =
  | { type: "start"; runId: string; agent: DelegateAgent; task: string }
  | { type: "childTool"; runId: string; agent: DelegateAgent; tool: string; input: unknown }
  | { type: "end"; runId: string; agent: DelegateAgent; ok: boolean; outputChars: number; error?: string };

type DelegateListener = (e: DelegateEvent) => void;

const delegateListeners = new Set<DelegateListener>();

/** 订阅委托事件；返回退订函数。监听器抛错被吞掉，绝不影响委托本身 */
export function onDelegateEvent(fn: DelegateListener): () => void {
  delegateListeners.add(fn);
  return () => {
    delegateListeners.delete(fn);
  };
}

/** 手动发事件（默认 runner 内部用；自定义 runSubAgent 想上报 childTool 也走这里） */
export function emitDelegateEvent(e: DelegateEvent): void {
  for (const fn of delegateListeners) {
    try {
      fn(e);
    } catch {
      // 观察者（如 TUI 渲染）异常不能拖垮子 agent 执行
    }
  }
}

let delegateRunSeq = 0;
function nextRunId(): string {
  delegateRunSeq += 1;
  return `delegate-${delegateRunSeq}`;
}

export interface DelegateProfile {
  key: DelegateAgent;
  label: string;
  /** 父工具名（按 name 匹配；缺失即跳过，绝不因缺工具崩） */
  tools: string[];
  /** child 系统提示模板 */
  prompt: string;
}

/** 各 profile 的系统提示：聚焦、可自主多步、用用户语言作答、给可核验来源 */
export const DELEGATE_PROFILES: Record<DelegateAgent, DelegateProfile> = {
  code: {
    key: "code",
    label: "代码/文件分析子 agent",
    tools: ["search_files", "list_files", "read_file"],
    prompt:
      "You are a focused code-analysis sub-agent. Investigate the subtask only through your tools " +
      "(search files, list directories, read files). Report concrete findings with file:line references. " +
      "Do not ask the caller questions; finish independently. Answer in the user's language.",
  },
  docs: {
    key: "docs",
    label: "文档检索子 agent",
    tools: ["search_documents", "list_files", "read_file"],
    prompt:
      "You are a document-research sub-agent. Answer the subtask using only content found via your tools " +
      "(search uploaded documents). Cite document names. Do not ask the caller questions; finish independently. " +
      "Answer in the user's language.",
  },
};

const schema = z.object({
  agent: z.enum(["code", "docs"]).describe("子 agent 专长：code=代码/文件分析；docs=上传文档检索"),
  task: z.string().describe("交给子 agent 的、可独立完成的自任务描述"),
});

export interface DelegateToolDeps {
  llm: ChatOpenAI;
  tools: StructuredToolInterface[];
  maxChildIterations?: number;
  llmTimeoutMs?: number;
  runSubAgent?: (ctx: {
    task: string;
    profile: DelegateProfile;
    childTools: StructuredToolInterface[];
    llm: ChatOpenAI;
    maxChildIterations: number;
    llmTimeoutMs: number;
    /** 本次委托的 runId：自定义 runner 可用它 emitDelegateEvent 上报 childTool */
    runId?: string;
  }) => Promise<string>;
}

/** 按 profile 从父工具集挑 child 工具子集（delegate 不在任何 profile 里 → 深度固定两层） */
export function pickChildTools(allTools: StructuredToolInterface[], agent: DelegateAgent): StructuredToolInterface[] {
  const wanted = new Set(DELEGATE_PROFILES[agent].tools);
  return allTools.filter((t) => t?.name && wanted.has(t.name));
}

/** 默认 child runner：用同一 llm + 裁剪工具 new 一个 GraphAgentExecutor 自主跑，收终稿 */
async function defaultRunSubAgent(ctx: {
  task: string; profile: DelegateProfile; childTools: StructuredToolInterface[];
  llm: ChatOpenAI; maxChildIterations: number; llmTimeoutMs: number; runId?: string;
}): Promise<string> {
  const exec = createAgentExecutor(
    ctx.llm,
    ctx.childTools,
    ctx.profile.prompt,
    ctx.maxChildIterations,
    undefined, // toolStatsRegistry：child 不注册，避免父统计被 child 污染
    undefined, // toolFilter：子集已显式裁剪，无需再过滤
    undefined, // tracer
    ctx.llmTimeoutMs,
  );
  let output = "";
  for await (const chunk of exec.stream({ messages: [new HumanMessage(ctx.task)] })) {
    // child 的每次工具调用经 intermediateSteps 上报（TUI 据此实时显示子 agent 在干什么）。
    // step 在工具执行完后才到达（LangGraph updates 语义），但比全程静默好得多。
    const steps = ((chunk as { intermediateSteps?: AgentStep[] }).intermediateSteps) ?? [];
    if (ctx.runId) {
      for (const step of steps) {
        emitDelegateEvent({
          type: "childTool",
          runId: ctx.runId,
          agent: ctx.profile.key,
          tool: step.action.tool,
          input: step.action.toolInput,
        });
      }
    }
    const out = (chunk as { output?: unknown }).output;
    if (out !== undefined && out !== null) output += String(out);
  }
  return output;
}

/** 委派工具：父 agent 把自任务交给聚焦子 agent；结果（或可读错误）以字符串回传 */
export class DelegateTool extends StructuredTool {
  name = "delegate";
  description =
    "把一段可独立完成的子任务委派给一个聚焦的子 agent 去自主完成（它会用专业工具多步调研后给结论）。" +
    "适合：需要深挖代码/文件(code)、或需要查上传文档(docs)的独立子任务。参数 agent 选专长、task 写清楚要子 agent 独立完成什么。" +
    "返回该子 agent 的结论文本。注意：这是把上下文隔离给子 agent，用于『专注深挖』，不要用它替代简单直查。";

  schema = schema;

  private deps: Required<Pick<DelegateToolDeps, "llm" | "tools" | "maxChildIterations" | "llmTimeoutMs">> &
    Pick<DelegateToolDeps, "runSubAgent">;

  constructor(deps: DelegateToolDeps) {
    super();
    this.deps = {
      llm: deps.llm,
      tools: deps.tools,
      maxChildIterations: deps.maxChildIterations ?? 8,
      llmTimeoutMs: deps.llmTimeoutMs ?? 120_000,
      runSubAgent: deps.runSubAgent,
    };
  }

  async _call({ agent, task }: z.infer<typeof schema>): Promise<string> {
    const profile = DELEGATE_PROFILES[agent];
    const childTools = pickChildTools(this.deps.tools, agent);
    if (childTools.length === 0) {
      return `[delegate] 子 agent「${profile.key}」无可用的工具（需要：${profile.tools.join(" / ")}）`;
    }
    const run = this.deps.runSubAgent ?? defaultRunSubAgent;
    const runId = nextRunId();
    const trimmedTask = task.trim();
    emitDelegateEvent({ type: "start", runId, agent: profile.key, task: trimmedTask });
    try {
      const text = await run({
        task: trimmedTask,
        profile,
        childTools,
        llm: this.deps.llm,
        maxChildIterations: this.deps.maxChildIterations,
        llmTimeoutMs: this.deps.llmTimeoutMs,
        runId,
      });
      const out = (text ?? "").trim();
      if (!out) {
        emitDelegateEvent({ type: "end", runId, agent: profile.key, ok: false, outputChars: 0, error: "无输出" });
        return `[delegate] 子 agent「${profile.key}」无输出`;
      }
      emitDelegateEvent({ type: "end", runId, agent: profile.key, ok: true, outputChars: out.length });
      return `[子 agent ${profile.key} 返回]\n${out}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emitDelegateEvent({ type: "end", runId, agent: profile.key, ok: false, outputChars: 0, error: msg });
      return `[delegate] 子 agent「${profile.key}」失败：${msg}`;
    }
  }
}
