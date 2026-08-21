/**
 * Tracer — 结构化 Agent 执行轨迹记录器
 *
 * 记录每次 Agent 执行的完整轨迹：
 *   - 每次 LLM 调用的输入、输出、token 消耗、耗时
 *   - 每次工具调用的名称、参数、结果、耗时
 *   - 最终输出
 *
 * 用途：
 *   - 调试：追踪 Agent 为什么做出某个决策
 *   - 成本分析：统计 token 消耗
 *   - 性能分析：定位哪个工具最慢
 */

// ════════════════════════════════════════════
//  类型定义
// ════════════════════════════════════════════

export interface TraceEntry {
  /** 唯一标识 */
  id: string;
  /** 轨迹类型 */
  type:
    | "llm_call"
    | "tool_call"
    | "tool_result"
    | "final_answer"
    | "error"
    | "ptc_program"    // PTC：模型发起一次 run_code
    | "ptc_dispatch"   // PTC：程序内一次工具子调用
    | "ptc_result";    // PTC：一次 run_code 的结算结果
  /** 时间戳 */
  timestamp: number;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 迭代轮次 */
  iteration: number;
  /** 来源标识: "main" (主agent) | "worker" (子任务worker) */
  source?: "main" | "worker";

  // LLM 调用
  llmInput?: string;          // 发送给 LLM 的 messages 摘要
  llmOutput?: string;         // LLM 的文本回复
  llmToolCalls?: string[];    // LLM 决定调用的工具名列表
  inputTokens?: number;
  outputTokens?: number;

  // 工具调用
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolSuccess?: boolean;

  // PTC（程序化工具调用）
  ptcCode?: string;           // run_code 程序源码（截断存储）
  ptcDescription?: string;    // run_code 意图说明
  ptcParentId?: string;       // 子调用所属 run_code 调用 id
  ptcKind?: PtcResultKind;    // ptc_result：结算结果（ok 或失败类别）
  ptcLogCount?: number;       // 程序日志条数
  ptcValueBytes?: number;     // 完成值序列化字节数

  // 错误
  error?: string;
}

/** PTC 运行结算类别：ok 或六类失败（对齐 CodeRunFailure.kind） */
export type PtcResultKind =
  | "ok"
  | "exception"
  | "timeout"
  | "abort"
  | "worker-exit"
  | "invalid-output"
  | "output-limit";

export interface TraceSession {
  /** 用户输入 */
  userInput: string;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间 */
  finishedAt?: number;
  /** 执行步骤 */
  steps: TraceEntry[];
  /** 总 token 消耗 */
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ════════════════════════════════════════════
//  Tracer 类
// ════════════════════════════════════════════

let entryCounter = 0;

export class Tracer {
  private currentSession: TraceSession | null = null;
  private sessions: TraceSession[] = [];
  private readonly MAX_SESSIONS = 20;

  /** 开始追踪一次 Agent 执行 */
  startSession(userInput: string): void {
    if (this.currentSession) {
      this.finishSession(); // 自动关闭未结束的 session
    }
    this.currentSession = {
      userInput,
      startedAt: Date.now(),
      steps: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }

  /** 结束当前追踪 */
  finishSession(): TraceSession | null {
    if (!this.currentSession) return null;
    this.currentSession.finishedAt = Date.now();
    this.sessions.push(this.currentSession);
    if (this.sessions.length > this.MAX_SESSIONS) {
      this.sessions.shift();
    }
    const session = this.currentSession;
    this.currentSession = null;
    return session;
  }

  /** 获取当前 session */
  getCurrentSession(): TraceSession | null {
    return this.currentSession;
  }

  /** 获取历史 sessions */
  getSessions(): TraceSession[] {
    return [...this.sessions];
  }

  /** 添加一条 LLM 调用记录 */
  addLLMCall(
    iteration: number,
    inputSummary: string,
    outputText: string | null,
    toolCalls: string[] | null,
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    source?: "main" | "worker",
  ): void {
    if (!this.currentSession) return;
    const entry: TraceEntry = {
      id: `llm_${++entryCounter}`,
      type: "llm_call",
      timestamp: Date.now(),
      durationMs,
      iteration,
      source: source ?? "main",
      llmInput: inputSummary.slice(0, 500),
      llmOutput: outputText?.slice(0, 1000) ?? undefined,
      llmToolCalls: toolCalls ?? undefined,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    };
    this.currentSession.steps.push(entry);
    if (inputTokens) this.currentSession.totalInputTokens += inputTokens;
    if (outputTokens) this.currentSession.totalOutputTokens += outputTokens;
  }

  /** 添加一条工具调用记录 */
  addToolCall(
    iteration: number,
    toolName: string,
    input: Record<string, unknown>,
    source?: "main" | "worker",
  ): void {
    if (!this.currentSession) return;
    this.currentSession.steps.push({
      id: `tool_${++entryCounter}`,
      type: "tool_call",
      timestamp: Date.now(),
      durationMs: 0,
      iteration,
      source: source ?? "main",
      toolName,
      toolInput: input,
    });
  }

  /** 更新最近一条 tool_call 为完成状态 */
  completeToolCall(
    result: string,
    success: boolean,
    durationMs: number,
    source?: "main" | "worker",
  ): void {
    if (!this.currentSession) return;
    // 找到最近一条未完成的 tool_call
    for (let i = this.currentSession.steps.length - 1; i >= 0; i--) {
      const step = this.currentSession.steps[i];
      if (step.type === "tool_call" && step.toolResult === undefined && (source === undefined || step.source === source)) {
        step.type = "tool_result";
        step.toolResult = result.slice(0, 1000);
        step.toolSuccess = success;
        step.durationMs = durationMs;
        break;
      }
    }
  }

  /** 添加一条错误记录 */
  addError(error: string, source?: "main" | "worker"): void {
    if (!this.currentSession) return;
    this.currentSession.steps.push({
      id: `err_${++entryCounter}`,
      type: "error",
      timestamp: Date.now(),
      durationMs: 0,
      iteration: this.currentSession.steps.length > 0
        ? this.currentSession.steps[this.currentSession.steps.length - 1].iteration
        : 0,
      source: source ?? "main",
      error,
    });
  }

  /** 添加一条 PTC run_code 程序记录（模型发起的程序，源码截断存储） */
  addPtcProgram(
    code: string,
    description: string,
    iteration: number,
    source?: "main" | "worker",
  ): void {
    if (!this.currentSession) return;
    this.currentSession.steps.push({
      id: `ptc_prog_${++entryCounter}`,
      type: "ptc_program",
      timestamp: Date.now(),
      durationMs: 0,
      iteration,
      source: source ?? "main",
      ptcCode: code.slice(0, 500),
      ptcDescription: description.slice(0, 200),
    });
  }

  /** 添加一条 PTC 程序内子调用事件（程序内 tools.x() 的一次执行） */
  addPtcDispatch(
    parentId: string,
    tool: string,
    input: unknown,
    output: unknown,
    isError: boolean,
    iteration: number,
    source?: "main" | "worker",
  ): void {
    if (!this.currentSession) return;
    this.currentSession.steps.push({
      id: `ptc_disp_${++entryCounter}`,
      type: "ptc_dispatch",
      timestamp: Date.now(),
      durationMs: 0,
      iteration,
      source: source ?? "main",
      ptcParentId: parentId,
      toolName: tool,
      toolInput: isPlainObject(input)
        ? (input as Record<string, unknown>)
        : { args: input },
      toolResult: stringifyPreview(output, 500),
      toolSuccess: !isError,
    });
  }

  /** 添加一条 PTC 运行结算记录（ok 或失败类别，供成本/失败分析） */
  addPtcResult(
    kind: PtcResultKind,
    logCount: number,
    valueBytes: number,
    iteration: number,
    source?: "main" | "worker",
  ): void {
    if (!this.currentSession) return;
    this.currentSession.steps.push({
      id: `ptc_res_${++entryCounter}`,
      type: "ptc_result",
      timestamp: Date.now(),
      durationMs: 0,
      iteration,
      source: source ?? "main",
      ptcKind: kind,
      ptcLogCount: logCount,
      ptcValueBytes: valueBytes,
    });
  }

  /** 获取当前 session 的格式化报告 */
  getReport(): string {
    const session = this.currentSession ?? this.sessions[this.sessions.length - 1];
    if (!session) return "(no trace data)";

    const lines: string[] = [];
    const totalMs = session.finishedAt
      ? session.finishedAt - session.startedAt
      : 0;
    const llmCalls = session.steps.filter((s) => s.type === "llm_call").length;
    const toolCalls = session.steps.filter((s) => s.type === "tool_call" || s.type === "tool_result").length;

    lines.push("═══════════════════════════════");
    lines.push("📋 Agent Trace");

    // 统计主agent vs worker
    const workerSteps = session.steps.filter((s) => s.source === "worker");
    const mainSteps = session.steps.filter((s) => s.source !== "worker");
    const workerTokensIn = session.steps
      .filter((s) => s.source === "worker" && s.inputTokens)
      .reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
    const workerTokensOut = session.steps
      .filter((s) => s.source === "worker" && s.outputTokens)
      .reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);

    lines.push(`Query: ${session.userInput}`);
    lines.push(`Duration: ${totalMs}ms`);
    lines.push(`LLM calls: ${llmCalls} (main: ${mainSteps.filter(s => s.type === "llm_call").length}, worker: ${workerSteps.filter(s => s.type === "llm_call").length})`);
    lines.push(`Tool calls: ${toolCalls}`);
    lines.push(`Tokens: ${session.totalInputTokens} in / ${session.totalOutputTokens} out`);
    if (workerTokensIn > 0 || workerTokensOut > 0) {
      lines.push(`  ├ main: ${session.totalInputTokens - workerTokensIn} in / ${session.totalOutputTokens - workerTokensOut} out`);
      lines.push(`  └ worker: ${workerTokensIn} in / ${workerTokensOut} out`);
    }

    // 按迭代轮次分组
    let currentIter = -1;
    let inWorkerBlock = false;
    for (const step of session.steps) {
      // Worker 块：用 ─ worker ─ 分隔，不显示迭代编号
      if (step.source === "worker" && !inWorkerBlock) {
        inWorkerBlock = true;
        lines.push(`\n  ── Worker ──`);
      } else if (step.source !== "worker" && inWorkerBlock) {
        inWorkerBlock = false;
      }

      if (step.source !== "worker" && step.iteration !== currentIter) {
        currentIter = step.iteration;
        inWorkerBlock = false;
        lines.push(`\n── Iteration ${currentIter + 1} ──`);
      }

      const indent = step.source === "worker" ? "    " : "  ";
      const tag = step.source === "worker" ? "👷 " : "";

      switch (step.type) {
        case "llm_call":
          lines.push(`${indent}${tag}🤖 LLM (${step.durationMs}ms, in:${step.inputTokens ?? "?"} out:${step.outputTokens ?? "?"})`);
          if (step.llmToolCalls?.length) {
            for (const t of step.llmToolCalls) lines.push(`${indent}  → ${t}`);
          }
          break;
        case "tool_call":
          lines.push(`${indent}${tag}🔧 ${step.toolName}(${JSON.stringify(step.toolInput)})`);
          break;
        case "tool_result":
          lines.push(`${indent}${tag}✅ ${step.toolName} (${step.durationMs}ms)`);
          if (step.toolResult && step.toolResult.length > 200) {
            lines.push(`${indent}  ${step.toolResult.slice(0, 200)}...`);
          } else if (step.toolResult) {
            lines.push(`${indent}  ${step.toolResult}`);
          }
          break;
        case "final_answer":
          lines.push(`${indent}${tag}💬 Final (${step.durationMs}ms)`);
          break;
        case "error":
          lines.push(`${indent}${tag}❌ Error: ${step.error}`);
          break;
        case "ptc_program":
          lines.push(`${indent}${tag}📦 run_code${step.ptcDescription ? `: ${step.ptcDescription}` : ""}`);
          if (step.ptcCode && step.ptcCode.length > 0) {
            lines.push(`${indent}  ${step.ptcCode.length > 200 ? step.ptcCode.slice(0, 200) + "..." : step.ptcCode}`);
          }
          break;
        case "ptc_dispatch":
          lines.push(
            `${indent}${tag}${step.toolSuccess ? "⚡" : "❌"} tools["${step.toolName ?? "?"}"](${JSON.stringify(step.toolInput)})`,
          );
          if (step.toolResult) {
            lines.push(`${indent}  → ${step.toolResult.length > 200 ? step.toolResult.slice(0, 200) + "..." : step.toolResult}`);
          }
          break;
        case "ptc_result":
          lines.push(
            `${indent}${tag}📊 PTC ${step.ptcKind} (logs: ${step.ptcLogCount ?? 0}, value: ${step.ptcValueBytes ?? 0} B)`,
          );
          break;
      }
    }

    lines.push("═══════════════════════════════");
    return lines.join("\n");
  }
}

/** 判断是否为普通对象（非 null、非数组） */
function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 将任意值转为预览字符串（截断到 max 字符） */
function stringifyPreview(v: unknown, max: number): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "..." : v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > max ? s.slice(0, max) + "..." : s;
  } catch {
    return String(v);
  }
}
