import { StructuredTool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { ChatOpenAI } from "@langchain/openai";
import type { Tracer } from "../agent/tracer.js";
import { GraphAgentExecutor } from "../agent/graph-agent-executor.js";

/**
 * DelegateTaskTool — 子任务委派工具
 *
 * 让主 Agent 可以把子任务派给一个 Worker Agent 独立执行。
 * Worker 和主 Agent 共享同一个 LLM 和工具集，但有自己的系统提示词。
 *
 * 用途：
 *   - 并行执行多个独立任务
 *   - 让 Worker 专注于一个子任务，不被其他信息干扰
 *   - 通过限制 Worker 的迭代次数防止死循环
 */
export class DelegateTaskTool extends StructuredTool {
  name = "delegate_task";
  description = "Delegate a subtask to a dedicated worker agent. "
    + "Use this when the user's request involves multiple independent parts that can be done in parallel, "
    + "or when a subtask requires focused execution without distraction. "
    + "The worker runs with the same tools and abilities.";

  schema = z.object({
    task: z.string().describe("The specific task for the worker to execute. Be clear and self-contained."),
    context: z.string().nullable().optional().describe("Optional background information the worker needs to understand the task."),
  });

  private llm: ChatOpenAI;
  private allTools: StructuredToolInterface[];
  /** Worker 最大迭代次数（防止死循环） */
  private maxWorkerIterations: number;
  /** 主 agent 的 tracer，注入到 worker 中以便统一报告 */
  private tracer?: Tracer;

  constructor(
    llm: ChatOpenAI,
    tools: StructuredToolInterface[],
    maxWorkerIterations = 6,
  ) {
    super();
    this.llm = llm;
    // 排除自身，防止递归委派
    this.allTools = tools.filter((t) => t.name !== this.name);
    this.maxWorkerIterations = maxWorkerIterations;
  }

  /** 注入主 agent 的 tracer，使 worker 的调用归入同一份跟踪报告 */
  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  async _call(args: z.infer<typeof this.schema>): Promise<string> {
    const taskText = args.context
      ? `Context:\n${args.context}\n\nTask:\n${args.task}`
      : args.task;

    // 为 Worker 创建独立的系统提示词
    const workerPrompt = `You are a worker agent with a limit of ${this.maxWorkerIterations} thinking cycles.
Your job is to complete the assigned task using the available tools.
Plan your steps efficiently — each cycle is one LLM call + tool execution round.
When you have the final answer, output it directly WITHOUT any tool calls.

IMPORTANT:
- You have at most ${this.maxWorkerIterations} cycles. Use them wisely.
- Do NOT waste cycles on trivial lookups you can answer from context.
- If the task is complex, prioritize the most impactful subtasks first.
- If you exhaust your ${this.maxWorkerIterations} cycles without finishing, whatever you've gathered so far will be returned as partial result.
- Do not ask questions. Do not delegate to others.`;

    const worker = new GraphAgentExecutor(
      this.llm,
      this.allTools,
      workerPrompt,
      this.maxWorkerIterations,
      undefined,  // toolStatsRegistry — 共享 PermissionWrapper 已自行统计
      undefined,  // toolFilter — worker 不需要动态过滤
      this.tracer, // ← 注入主 agent 的 tracer，worker 调用记入同一 session
    );

    try {
      // Worker 直接返回文本结果
      const result = await worker.run(taskText, workerPrompt);

      if (!result || result.trim().length === 0) {
        return "[delegate] Worker returned empty result";
      }

      return `[Worker result]\n${result.trim()}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[delegate] Worker failed: ${msg}`;
    }
  }
}
