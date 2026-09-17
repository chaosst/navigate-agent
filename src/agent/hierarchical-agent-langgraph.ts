import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, SystemMessage, HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Tracer } from "./tracer.js";
import { DualLoopState, type DualLoopStateType, type ExecutionPlan, type PlanStep, type PlannerOutput } from "./types.js";
import { logAgent } from "./logger.js";
import { AgentStep } from "@langchain/core/agents";
import { buildStatsFooter } from "./graph-utils.js";
import type { ToolStatsRegistry } from "../tools/stats-registry.js";
import type { ToolFilter } from "../tools/tool-filter.js";
import type { PermissionWrapper } from "../tools/permission.js";

const PLANNER_PROMPT = `你是一个任务规划器，采用双层循环架构：

执行流程（必须严格遵守）：
1. 第一次调用：输出 action="create_plan"，生成执行计划
2. 后续调用：输出 action="execute_step"，执行下一步骤（stepToExecute 从 0 开始）
3. 所有步骤完成后：输出 action="finalize"，生成最终答案

重要规则：
- 创建计划后，下一次调用必须输出 execute_step
- 不要重复创建计划
- execute_step 时必须指定 stepToExecute（步骤索引，从 0 开始）
- 必须输出有效 JSON
- **特殊路径**：如果用户输入是问候（你好/hi/hey）、闲聊、感谢、或无需任何工具即可直接回答的简单问题（例如"你是谁"、"1+1等于几"、"今天星期几"），**第一次调用就直接输出 action="finalize" + finalAnswer**，不要生成计划、不要调用任何工具。只有真正需要多步执行、文件读写、检索的任务才走 create_plan。

输出格式：
{
  "action": "create_plan" | "execute_step" | "finalize",
  "plan": {                                   // 仅 create_plan 时
    "goal": "整个任务的一句话目标",
    "steps": [
      { "id": "s1", "description": "第一步要做什么", "status": "pending" },
      { "id": "s2", "description": "第二步要做什么", "status": "pending" }
    ]
  },
  "stepToExecute": 0,                         // 仅 execute_step 时
  "finalAnswer": "...",                       // 仅 finalize 时
  "reasoning": "思考过程"
}

steps 字段约束（不遵守会导致任务列表只剩编号、无法展示）：
- 每条 step 必须带 id / description / status 三个字段，且 description 非空
- description 写清「这一步做什么」，例如「检索万绿湖游船班次与票价」
- **严禁**把 "step_1"、"步骤 1" 这类编号原样当作 description
- steps 至少 2 条，每条应当是能独立执行的动作`;

const EXECUTOR_PROMPT = `你是一个任务执行器。

规则：
- 专注于当前步骤，只做这一步该做的事
- 需要外部信息（检索、读文件、执行命令）时才调用工具
- 撰写 / 整理 / 归纳 / 规划类步骤若不缺外部信息，**直接输出结果**，
  不要为了「稳妥」反复调用工具
- 已能给出结果时立即输出，不要重复调用同一个工具`;

/**
 * 跑到一半仍未产出文本时注入的提醒。
 * 实测：纯汇总步骤会一直调工具（找根目录不存在的 README 找了 7 次），
 * 跑满 10 轮零产出 → 步骤被判失败。仅靠 system prompt 约束不住。
 */
const EXECUTOR_NUDGE = "提示：以上信息可能已经足够。若本步骤是撰写 / 归纳 / 汇总类，"
    + "请立即基于已有结果直接输出最终文本，不要再调用工具。";

/** 内层 ReAct 上下文窗口：控制每轮请求体量，避免单步 token 超线性膨胀 */
interface ExecutorContextWindow {
    /** 保留最近多少组「AIMessage(tool_calls) + 其全部 ToolMessage」 */
    recentGroups: number;
    /** 单条工具结果字符上限，超出做头尾截断 */
    maxToolResultChars: number;
    /** 窗口内历史部分的总字符上限（从最新往前收，收满即停） */
    maxContextChars: number;
}

const DEFAULT_CONTEXT_WINDOW: ExecutorContextWindow = {
    recentGroups: 4,
    maxToolResultChars: 1200,
    maxContextChars: 24_000,
};

/**
 * 双层循环（plan 模式）的运行预算。
 * 默认值偏保守地放宽：plan 是多步任务，100k 总预算常在第一、二步就被 ReAct 循环耗尽
 * （实测单步 163k tokens），导致 step_2..N 永远拿不到调度机会。
 * 可用 PLAN_MAX_TOKENS / PLAN_MAX_TIME_MS / PLAN_MAX_STEPS 覆盖。
 */
export interface HierarchicalBudget {
    maxTokens?: number;
    maxTimeMs?: number;
    maxSteps?: number;
}

const DEFAULT_BUDGET: Required<HierarchicalBudget> = {
    maxTokens: 500_000,
    maxTimeMs: 900_000,
    maxSteps: 20,
};

/**
 * 「不是描述的描述」：纯编号（step_1 / 步骤 2 / 3）。
 * LLM 偶尔会把它填进 description，界面就只剩编号（2026-09-17 实测）。
 */
const NUMBER_LIKE_DESCRIPTION = /^(?:step[\s_-]*\d+|步骤\s*\d+|\d+)$/i;

/** 资源耗尽的判定结果（供路由与 fallback 文案复用，避免只吐一句 Progress） */
interface ExhaustionInfo {
    reason: "tokens" | "time" | "steps";
    message: string;
}

export class HierarchicalAgentLangGraph {
    private plannerLLM: ChatOpenAI;
    private executorLLM: ChatOpenAI;
    private tools: StructuredToolInterface[];
    private tracer?: Tracer;
    private toolStatsRegistry?: ToolStatsRegistry;
    /** 单次 LLM 调用超时（ms），与 normal/ptc 模式统一（默认 120s） */
    private llmTimeoutMs: number;
    /** 内层步骤 executor 的动态工具过滤（normal/ptc 同款；仅作用于 executeStep，planner 不绑工具不受影响） */
    private toolFilter?: ToolFilter;
    /** 运行预算（未传则用 DEFAULT_BUDGET；stream 的 config 参数优先级更高） */
    private budget: Required<HierarchicalBudget>;
    /** 内层 ReAct 上下文窗口 */
    private contextWindow: ExecutorContextWindow;
    private graph: any;

    constructor(
        llm: ChatOpenAI,
        tools: StructuredToolInterface[],
        tracer?: Tracer,
        toolStatsRegistry?: ToolStatsRegistry,
        llmTimeoutMs = 120_000,
        toolFilter?: ToolFilter,
        budget?: HierarchicalBudget,
        contextWindow?: Partial<ExecutorContextWindow>,
    ) {
        this.plannerLLM = llm;
        this.executorLLM = llm;
        this.tools = tools;
        this.tracer = tracer;
        this.toolStatsRegistry = toolStatsRegistry;
        this.llmTimeoutMs = llmTimeoutMs;
        this.toolFilter = toolFilter;
        this.budget = { ...DEFAULT_BUDGET, ...budget };
        this.contextWindow = { ...DEFAULT_CONTEXT_WINDOW, ...contextWindow };
        this.graph = this.createGraph();
        logAgent({
            type: "info",
            message: `[LangGraph] 初始化完成，工具数量: ${tools.length}`,
            details: {
                toolNames: tools.map(t => t.name),
                budget: this.budget,
                contextWindow: this.contextWindow,
            }
        });
    }

    private createGraph() {
        logAgent({
            type: "info",
            message: `[LangGraph] 创建状态图...`
        });

        const workflow = new StateGraph(DualLoopState)
        .addNode("planner", async (state) => await this.plannerNode(state))
        .addNode("executor", async (state) => await this.executorNode(state))
        .addNode("finalize", async (state) => await this.finalizeNode(state))
        .addNode("fallback", async (state) => await this.fallbackNode(state))
        .addEdge(START, "planner")
        .addConditionalEdges("planner", (state) => this.routeAfterPlanner(state))
        .addConditionalEdges("executor", (state) => this.routeAfterExecutor(state))
        .addEdge("finalize", END)
        .addEdge("fallback", END);

        logAgent({
            type: "info",
            message: `[LangGraph] 状态图编译完成`
        });

        return workflow.compile();
    }

    private routeAfterPlanner(state: DualLoopStateType): string {
        const action = state.plannerOutput?.action;

        // 资源耗尽
        if (this.isResourceExhausted(state)) {
            logAgent({
                type: "error",
                message: `[LangGraph] 规划后路由: 资源耗尽，进入 fallback`,
                details: { tokens: state.totalTokens, step: state.currentStepIndex }
            });
            return "fallback";
        }
        if (action === "execute_step") {
            logAgent({
                type: "info",
                message: `[LangGraph] 规划后路由: 执行步骤 ${state.currentStepIndex}`,
            });
            return "executor"
        }
        if (action === 'finalize') {
            logAgent({
                type: "info",
                message: `[LangGraph] 规划后路由: 生成最终答案`,
            });
            return 'finalize'
        }

        // 继续规划
        logAgent({
            type: "info",
            message: `[LangGraph] 规划后路由: 继续规划`,
        });
        return "planner";
    }

    private routeAfterExecutor(state: DualLoopStateType): string {
        const allCompleted = state.plan.steps.every((value, index) => {
            return value.status === 'completed' || value.status === 'failed'
        })

        if (allCompleted) {
            logAgent({
                type: "info",
                message: `[LangGraph] 执行后路由: 所有步骤完成，进入 finalize`,
                details: { totalSteps: state.plan.steps.length }
            });
            return "finalize"
        }

        // 资源耗尽
        if (this.isResourceExhausted(state)) {
            logAgent({
                type: "error",
                message: `[LangGraph] 执行后路由: 资源耗尽，进入 fallback`,
                details: { tokens: state.totalTokens, step: state.currentStepIndex }
            });
            return "fallback";
        }

        logAgent({
            type: "info",
            message: `[LangGraph] 执行后路由: 继续下一步骤`,
            details: { nextStep: state.currentStepIndex }
        });
        return "planner"
    }

    private async plannerNode(state: DualLoopStateType) {
        logAgent({
            type: "info",
            message: `[LangGraph] 进入规划节点`,
            details: { stepIndex: state.currentStepIndex, tokens: state.totalTokens }
        });

        // 1. 检查资源限制
        if (this.isResourceExhausted(state)) {
            logAgent({
                type: "error",
                message: `[LangGraph] 规划节点: 资源耗尽，直接 finalize`,
                details: { tokens: state.totalTokens, step: state.currentStepIndex }
            });
            return { plannerOutput: { action: "finalize", reasoning: "Resource exhausted" } };
        }

        // 2. 调用规划层 LLM
        logAgent({
            type: "info",
            message: `[LangGraph] 规划节点: 调用规划 LLM`,
            details: { messageCount: state.messages.length, planSteps: state.plan.steps.length }
        });

        const { output: plannerOutput, tokensUsed: plannerTokens } = await this.callPlanner(state.messages, state.plan);

        logAgent({
            type: "info",
            message: `[LangGraph] 规划节点: 规划完成`,
            details: { action: plannerOutput.action, reasoning: plannerOutput.reasoning, tokensUsed: plannerTokens }
        });

        // 3. 更新计划
        const newPlan = plannerOutput.plan || state.plan;

        // 4. 如果是 create_plan，自动设置第一个步骤
        if (plannerOutput.action === "create_plan" && newPlan.steps.length > 0) {
            logAgent({
                type: "info",
                message: `[LangGraph] 规划节点: 创建计划后自动执行第一步`,
                details: { planSteps: newPlan.steps.length, planGoal: newPlan.goal }
            });
            plannerOutput.action = "execute_step";
            plannerOutput.stepToExecute = 0;
        }

        return {
            plan: newPlan,
            plannerOutput,
            currentStepIndex: plannerOutput.stepToExecute ?? state.currentStepIndex,
            // planner 的 token 此前完全没计入预算（只算 executor），
            // 属「统计偏低」的假信号；加法 reducer 下只能返回增量。
            totalTokens: plannerTokens,
        };
    }

    /** 预算耗尽的判定与原因（供路由与 fallback 文案共用；未耗尽返回 null） */
    private getExhaustion(state: DualLoopStateType): ExhaustionInfo | null {
        const elapsed = Date.now() - state.startTime;
        let info: ExhaustionInfo | null = null;

        if (state.totalTokens >= state.maxTokens) {
            info = {
                reason: "tokens",
                message: `token 预算耗尽（${state.totalTokens}/${state.maxTokens}）`,
            };
        } else if (elapsed >= state.maxTimeMs) {
            info = {
                reason: "time",
                message: `时间预算耗尽（${(elapsed / 1000).toFixed(1)}s/${(state.maxTimeMs / 1000).toFixed(0)}s）`,
            };
        } else if (state.currentStepIndex >= state.maxSteps) {
            info = {
                reason: "steps",
                message: `已达步骤数上限（${state.currentStepIndex}/${state.maxSteps}）`,
            };
        }

        if (info) {
            logAgent({
                type: "error",
                message: `[LangGraph] 资源检查: 已耗尽（${info.reason}）`,
                details: {
                    tokens: `${state.totalTokens}/${state.maxTokens}`,
                    elapsed: `${elapsed}ms/${state.maxTimeMs}ms`,
                    steps: `${state.currentStepIndex}/${state.maxSteps}`,
                    planSteps: state.plan.steps.length,
                }
            });
        }

        return info;
    }

    private isResourceExhausted(state: DualLoopStateType): boolean {
        return this.getExhaustion(state) !== null;
    }

    private async executorNode(state: DualLoopStateType) {
        const stepIndex = state.currentStepIndex;

        logAgent({
            type: "info",
            message: `[LangGraph] 进入执行节点`,
            details: { stepIndex, totalSteps: state.plan.steps.length }
        });

        if (stepIndex >= state.plan.steps.length) {
            logAgent({
                type: "error",
                message: `[LangGraph] 执行节点: 步骤索引超出范围`,
                details: { stepIndex, totalSteps: state.plan.steps.length }
            });
            return { plannerOutput: { action: "finalize", reasoning: "All steps completed" } };
        }

        const step = state.plan.steps[stepIndex];
        logAgent({
            type: "info",
            message: `[LangGraph] 执行节点: 开始执行步骤 ${step.id}`,
            details: { stepId: step.id, description: step.description }
        });

        step.status = "in_progress";

        // 执行步骤
        const { result, intermediateSteps, tokensUsed, completed, iterations } = await this.executeStep(
            step,
            state.messages,
        );

        logAgent({
            type: "info",
            message: `[LangGraph] 执行节点: 步骤执行完成`,
            details: {
                stepId: step.id,
                resultLength: result.length,
                toolCalls: intermediateSteps.length,
                tokensUsed,
                completed,
                iterations,
            }
        });

        step.result = result;
        // 「没产出结果」不能算完成：ReAct 迭代耗尽仍全是工具调用时 result 为空，
        // 旧实现兜底成 "Step completed" 并标 completed —— 一个字都没产出却被计为成功。
        if (!completed) {
            step.status = "failed";
            step.error = `未产出结果：ReAct 迭代 ${iterations} 轮仍全是工具调用（工具调用 ${intermediateSteps.length} 次）`;
        } else {
            step.status = result.startsWith("Error:") ? "failed" : "completed";
            if (step.status === "failed") step.error = result;
        }

        logAgent({
            type: "info",
            message: `[LangGraph] 执行节点: 步骤状态更新为 ${step.status}`,
            details: { stepId: step.id, status: step.status, error: step.error }
        });

        // 更新计划
        const newPlan = { ...state.plan };
        newPlan.steps[stepIndex] = step;
        newPlan.updatedAt = Date.now();

        return {
            plan: newPlan,
            intermediateSteps,
            // totalTokens 是加法 reducer（reducer: (a,b) => a+b），节点只能返回**增量**。
            // 旧实现返回 state.totalTokens + tokensUsed 会被二次累加（langgraph 语义已实测），
            // 多步计划下 token 预算会翻倍消耗、过早触发 fallback。
            totalTokens: tokensUsed,
            currentStepIndex: stepIndex + 1,
        };
    }

    private async callPlanner(
        messages: BaseMessage[],
        currentPlan: ExecutionPlan,
    ): Promise<{ output: PlannerOutput; tokensUsed: number }> {
        /** planner 自身的 token 消耗（此前完全未计入预算，预算统计偏低） */
        let tokensUsed = 0;

        logAgent({
            type: "info",
            message: `[LangGraph] 调用规划器`,
            details: { messageCount: messages.length, currentPlanSteps: currentPlan.steps.length }
        });

        // 1、构建消息
        const plannerMessages: BaseMessage[] = [
            new SystemMessage(PLANNER_PROMPT),
            ...messages
        ]

        // 2、如果有当前计划，注入上下文
        if (currentPlan.steps.length > 0) {
            const planSummary = this.formatPlanSummary(currentPlan)
            plannerMessages.push(new SystemMessage(`Current plan:\n${planSummary}`))
            logAgent({
                type: "info",
                message: `[LangGraph] 规划器: 注入当前计划上下文`,
                details: { planSteps: currentPlan.steps.length }
            });
        }

        // 3、调用 LLM
        logAgent({
            type: "info",
            message: `[LangGraph] 规划器: 调用 LLM 中...`,
            details: { messageCount: plannerMessages.length }
        });

        let response
        try {
            response = await this.plannerLLM.invoke(plannerMessages, {
                signal: AbortSignal.timeout(this.llmTimeoutMs)
            })
            const usage = (response as any).usage_metadata;
            tokensUsed += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
            this.tracer?.addLLMCall(
                0,
                `planner messages[${plannerMessages.length}]`,
                this.extractText(response.content),
                null,
                0,
                usage?.input_tokens,
                usage?.output_tokens,
            );
            logAgent({
                type: "info",
                message: `[LangGraph] 规划器: LLM 调用成功`,
            });
        } catch (err) {
            logAgent({
                type: "error",
                message: `[LangGraph] 规划器: LLM 调用失败`,
                details: { error: err instanceof Error ? err.message : String(err) }
            });
            // 降级：创建单步骤计划
            return {
                output: {
                    action: "create_plan",
                    plan: {
                        goal: this.extractUserInput(messages),
                        steps: [{
                            id: "step_1", description: this.extractUserInput(messages), status: "pending"
                        }],
                        currentStepIndex: 0,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    reasoning: `Fallback： ${err instanceof Error ? err.message : String(err)}`
                },
                tokensUsed,
            }
        }

        const content = this.extractText(response.content)
        logAgent({
            type: "info",
            message: `[LangGraph] 规划器: 解析响应`,
            details: { contentLength: content.length, contentPreview: content.slice(0, 100) }
        });

        // 4、解析 JSON
        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]) as PlannerOutput
                if(!parsed.action)
                    throw new Error("Missing action")

                logAgent({
                    type: "info",
                    message: `[LangGraph] 规划器: JSON 解析成功`,
                    details: { action: parsed.action, planSteps: parsed.plan?.steps.length || 0 }
                });

                // 标准化 plan
                if (parsed.plan) {
                    const missing: number[] = []
                    parsed.plan.steps = parsed.plan.steps.map((s, i) => {
                        const description = s.description?.trim()
                        // 空描述与「纯编号冒充描述」都算缺失
                        const usable = !!description && !NUMBER_LIKE_DESCRIPTION.test(description)
                        if (!usable) missing.push(i + 1)
                        return {
                            id: s.id || `step_${i + 1}`,
                            // 兜底只是「不让界面崩」，它不是描述。缺失必须告警：
                            // 旧实现兜底成 `step_${i+1}`，任务列表静默退化成只有编号
                            // （2026-09-17 实测 LLM 返回 {"stepId":"step_1","description":"step_1"}）。
                            description: usable ? description : `（第 ${i + 1} 步：规划器未给出描述）`,
                            status: s.status || "pending",
                        }
                    })
                    if (missing.length > 0) {
                        logAgent({
                            type: "error",
                            message: `[LangGraph] 规划器: ${missing.length}/${parsed.plan.steps.length} 条步骤缺少可用 description，已用占位描述`,
                            details: { missingIndexes: missing }
                        })
                    }
                }

                return { output: parsed, tokensUsed }
            }
        } catch (err) {
            logAgent({ type: "error", message: `JSON parse failed` });
        }

        // 5、降级：从文本推断
        logAgent({
            type: "error",
            message: `[LangGraph] 规划器: 使用降级推理`,
            details: { contentLength: content.length }
        });
        return { output: this.inferPlannerAction(content, currentPlan), tokensUsed }
    }

    private async executeStep(
        step: PlanStep,
        contextMessages: BaseMessage[],
        maxIterations: number = 10,
    ): Promise<{
        result: string;
        intermediateSteps: AgentStep[];
        tokensUsed: number;
        /** 是否走到「无工具调用 → 产出文本」的正常出口。false = 迭代耗尽仍全是工具调用 */
        completed: boolean;
        /** 实际执行的 ReAct 轮数 */
        iterations: number;
    }> {
        logAgent({
            type: "info",
            message: `[LangGraph] 执行步骤 ${step.id}`,
            details: { stepId: step.id, description: step.description, maxIterations }
        });

        // 1、构建消息
        const executorMessages: BaseMessage[] = [
            new SystemMessage(EXECUTOR_PROMPT),
            new HumanMessage(`Execute this step: ${step.description}`),
            ...contextMessages.slice(-4)
        ]

        // 2、动态工具过滤：仅暴露与「用户意图 + 本步骤描述」匹配权限的工具（同 normal 模式 agentNode）
        let activeTools: StructuredToolInterface[] = this.tools;
        const filterInput = (this.extractUserInput(contextMessages) + "\n" + step.description).trim();
        if (this.toolFilter && filterInput) {
            const filtered = this.toolFilter.filter(this.tools as PermissionWrapper[], filterInput);
            if (filtered.length > 0) {
                activeTools = filtered;
            }
        }
        const activeToolMap = new Map(activeTools.map((t) => [t.name, t]));

        // 3、绑定工具（只绑过滤后的可见集）
        const llmWithTools = this.executorLLM.bindTools(activeTools)

        let finalResult = ""
        const intermediateSteps: AgentStep[] = []
        // 本步骤累计 token 消耗（从 usage_metadata 读取，供 totalTokens 与统计展示）
        let tokensUsed = 0
        /** 实际跑过的 ReAct 轮数（供零产出时说明原因） */
        let iterationsRun = 0

        logAgent({
            type: "info",
            message: `[LangGraph] 步骤执行: 开始 ReAct 循环`,
            details: { stepId: step.id, maxIterations, contextMessages: contextMessages.length }
        });

        // 3、内存 ReAct 循环
        const nudgeAt = Math.max(1, Math.ceil(maxIterations / 2))
        for (let iter = 0; iter < maxIterations; iter++) {
            iterationsRun = iter + 1
            logAgent({
                type: "info",
                message: `[Step ${step.id}] Iter ${iter + 1}`
            })

            // 跑到一半仍没产出文本 → 注入一次「别再调工具了」的提醒。
            // 纯汇总步骤实测会一直检索（找不存在的 README 找了 7 次），跑满轮数零产出。
            if (iterationsRun === nudgeAt) {
                executorMessages.push(new HumanMessage(EXECUTOR_NUDGE))
                logAgent({
                    type: "info",
                    message: `[LangGraph] 步骤 ${step.id}: 注入产出提醒（第 ${iterationsRun} 轮）`
                })
            }

            // 每轮只发「受限窗口」，避免历史工具结果把请求体越滚越大
            const llmMessages = this.buildExecutorWindow(executorMessages)
            const isLastIteration = iter === maxIterations - 1

            let response
            try {
                // 最后一轮不再绑工具：强制模型给出文本结论。
                // 实测汇总类步骤会一直检索（找根目录不存在的 README 找了 10 次），
                // 跑满轮数却一个字都没产出 —— 留一轮裸调用作保底收口。
                response = isLastIteration
                    ? await this.executorLLM.invoke(llmMessages, {
                        signal: AbortSignal.timeout(this.llmTimeoutMs)
                    })
                    : await llmWithTools.invoke(llmMessages, {
                        signal: AbortSignal.timeout(this.llmTimeoutMs)
                    })
                const usage = (response as any).usage_metadata;
                tokensUsed += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
                this.tracer?.addLLMCall(
                    iter,
                    `step ${step.id} messages[${llmMessages.length}]`,
                    null,
                    response.tool_calls?.map((tc: any) => tc.name as string) ?? null,
                    0,
                    usage?.input_tokens,
                    usage?.output_tokens,
                );
                logAgent({
                    type: "info",
                    message: `[LangGraph] 步骤 ${step.id} 迭代 ${iter + 1}: LLM 调用成功`,
                    details: { toolCalls: response.tool_calls?.length || 0 }
                });
            } catch (err) {
                logAgent({
                    type: "error",
                    message: `[LangGraph] 步骤 ${step.id} 迭代 ${iter + 1}: LLM 调用失败`,
                    details: { error: err instanceof Error ? err.message : String(err) }
                });
                if (iter === 0) {
                    logAgent({
                        type: "info",
                        message: `[LangGraph] 步骤 ${step.id}: 降级重试（不绑定工具）`
                    });
                    try {
                        response = await this.executorLLM.invoke(llmMessages, {
                            signal: AbortSignal.timeout(this.llmTimeoutMs),
                        });
                        const usage = (response as any).usage_metadata;
                        tokensUsed += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
                        this.tracer?.addLLMCall(
                            iter,
                            `step ${step.id} (retry) messages[${llmMessages.length}]`,
                            this.extractText(response.content),
                            null,
                            0,
                            usage?.input_tokens,
                            usage?.output_tokens,
                        );
                    } catch (retryErr) {
                        logAgent({
                            type: "error",
                            message: `[LangGraph] 步骤 ${step.id}: 降级重试也失败`,
                            details: { error: retryErr instanceof Error ? retryErr.message : String(retryErr) }
                        });
                        return {
                            result: `Error: LLM failed - ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
                            intermediateSteps,
                            // 已发生的调用要计入预算，旧实现固定返回 0 会让统计偏低
                            tokensUsed,
                            completed: false,
                            iterations: iterationsRun,
                        };
                    }
                } else {
                    return {
                        result: `Error: LLM failed`,
                        intermediateSteps,
                        tokensUsed,
                        completed: false,
                        iterations: iterationsRun,
                    }
                }
            }

            // 检查工具调用
            const toolCalls = response.tool_calls
            if (!toolCalls || toolCalls.length === 0) {
                logAgent({
                    type: "info",
                    message: `[LangGraph] 步骤 ${step.id}: 无工具调用，生成最终结果`,
                    details: { resultLength: finalResult.length }
                });
                finalResult = this.extractText(response.content)
                break
            }

            logAgent({
                type: "info",
                message: `[LangGraph] 步骤 ${step.id} 迭代 ${iter + 1}: 执行 ${toolCalls.length} 个工具`,
                details: { tools: toolCalls.map(tc => tc.name) }
            });

            // 并发执行工具
            executorMessages.push(response)
            const toolResults = await Promise.all(
                toolCalls.map(async (tc) => {
                    const tool = activeToolMap.get(tc.name as string)
                    if (!tool) {
                        logAgent({
                            type: "error",
                            message: `[LangGraph] 步骤 ${step.id}: 工具 ${tc.name} 未找到`,
                        });
                        return {
                            tc, result: `Tool not found`, success: false
                        }
                    }

                    try {
                        const result = await tool.invoke(tc.args as Record<string, unknown>)
                        logAgent({
                            type: "info",
                            message: `[LangGraph] 步骤 ${step.id}: 工具 ${tc.name} 执行成功`,
                            details: { resultLength: String(result).length }
                        });
                        return {
                            tc, result, success: true
                        }
                    } catch (err) {
                        logAgent({
                            type: "error",
                            message: `[LangGraph] 步骤 ${step.id}: 工具 ${tc.name} 执行失败`,
                            details: { error: err instanceof Error ? err.message : String(err) }
                        });
                        return {
                            tc, result: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false
                        }
                    }
                })
            )

            // 收集结果
            for (const r of toolResults) {
                executorMessages.push(new ToolMessage({
                    content: r.result, tool_call_id: r.tc.id as string
                }))
                intermediateSteps.push({
                    action: {
                        tool: r.tc.name as string, toolInput: r.tc.args as Record<string, unknown>, log: ""
                    },
                    observation: r.result
                })
            }

            logAgent({
                type: "info",
                message: `[LangGraph] 步骤 ${step.id}: 迭代 ${iter + 1} 完成`,
                details: { totalToolCalls: intermediateSteps.length }
            });
        }

        const completed = finalResult.trim().length > 0;

        logAgent({
            type: completed ? "info" : "error",
            message: `[LangGraph] 步骤 ${step.id} 执行完毕`,
            details: {
                resultLength: finalResult.length,
                totalToolCalls: intermediateSteps.length,
                iterations: iterationsRun,
                completed,
            }
        });

        return {
            // 不用 "Step completed" 兜底 —— 那会把「一个字都没产出」伪装成正常完成：
            // 卡片显示 ✅、状态标 completed，但这一步实际什么都没做。
            result: completed
                ? finalResult
                : `（未产出内容：ReAct 迭代 ${iterationsRun} 轮全部产生了工具调用，未生成结果文本）`,
            intermediateSteps,
            tokensUsed,
            completed,
            iterations: iterationsRun,
        }
    }

    /**
     * 构造内层 ReAct 的受限上下文视图。
     *
     * 背景：`executorMessages` 每轮全量重发，工具结果持续累积，单步 token 超线性膨胀
     * （实测 31 次工具调用 = 163k tokens，单步即打爆 100k 预算）。
     * 这里不改动 `executorMessages` 本身，只在每次调用 LLM 前生成
     * 「最近若干组工具往返 + 单条结果截断」的视图。
     *
     * 硬约束：带 tool_calls 的 AIMessage 必须与其全部 ToolMessage 同现，
     * 因此按「组」裁剪，绝不在组内切断（否则 OpenAI 直接 400）。
     */
    private buildExecutorWindow(messages: BaseMessage[]): BaseMessage[] {
        const { recentGroups, maxToolResultChars, maxContextChars } = this.contextWindow;

        // 头部固定：executorMessages 前缀是 [System(EXECUTOR_PROMPT), Human(本步骤指令)]
        const head = messages.slice(0, 2);
        const rest = messages.slice(2);
        if (rest.length === 0) return head;

        // 分组：带 tool_calls 的 AIMessage 起新组，其后所有消息（ToolMessage）归入该组
        const groups: BaseMessage[][] = [];
        for (const msg of rest) {
            const toolCalls = msg._getType() === "ai" ? (msg as AIMessage).tool_calls : undefined;
            const isToolCallRoot = Array.isArray(toolCalls) && toolCalls.length > 0;
            if (isToolCallRoot || groups.length === 0) {
                groups.push([msg]);
            } else {
                groups[groups.length - 1].push(msg);
            }
        }

        // 从最新往前收，受「组数」与「字符数」双约束
        const kept: BaseMessage[][] = [];
        let windowChars = 0;
        for (let i = groups.length - 1; i >= 0 && kept.length < recentGroups; i--) {
            const group = groups[i];
            const size = group.reduce((n, m) => n + this.messageChars(m), 0);
            // 至少保留最新一组，避免超大结果导致窗口为空
            if (kept.length > 0 && windowChars + size > maxContextChars) break;
            kept.unshift(group);
            windowChars += size;
        }

        const dropped = groups.length - kept.length;
        if (dropped > 0) {
            logAgent({
                type: "info",
                message: `[LangGraph] 执行步骤: 上下文窗口裁剪 ${dropped}/${groups.length} 组`,
                details: {
                    keptGroups: kept.length,
                    droppedGroups: dropped,
                    windowChars,
                }
            });
        }

        return [
            ...head,
            ...kept.flat().map((m) => this.truncateToolMessage(m, maxToolResultChars)),
        ];
    }

    /** 估算单条消息的字符量（工具结果是大头，tool_calls 忽略不计） */
    private messageChars(msg: BaseMessage): number {
        const content = (msg as any).content;
        if (typeof content === "string") return content.length;
        if (Array.isArray(content)) return JSON.stringify(content).length;
        return 0;
    }

    /** 单条工具结果超限时做头尾截断，保留开头（关键结论）与结尾（下一步线索） */
    private truncateToolMessage(msg: BaseMessage, maxChars: number): BaseMessage {
        if (msg._getType() !== "tool") return msg;

        const text = this.extractText((msg as any).content);
        if (text.length <= maxChars) return msg;

        const headLen = Math.floor(maxChars * 0.7);
        const tailLen = Math.max(0, maxChars - headLen);
        const truncated = text.slice(0, headLen)
            + `\n…[已截断 ${text.length - maxChars} 字符]…\n`
            + text.slice(-tailLen);

        // 生成视图专用副本：原消息继续用于 intermediateSteps 与统计，不受影响
        return new ToolMessage({
            content: truncated,
            tool_call_id: (msg as any).tool_call_id,
        });
    }

    private formatPlanSummary(plan: ExecutionPlan): string {
        const lines = [`Goal: ${plan.goal}`, `Progress: ${plan.steps.filter(s => s.status === "completed").length}/${plan.steps.length}`, ""];
        for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            const icon = { pending: "⏳", in_progress: "🔄", completed: "✅", failed: "❌", skipped: "⏭️" }[step.status] || "?";
            lines.push(`${i + 1}. ${icon} ${step.description} [${step.status}]`);
        }
        return lines.join("\n");
    }

    private inferPlannerAction(content: string, currentPlan: ExecutionPlan): PlannerOutput {
        logAgent({
            type: "error",
            message: `[LangGraph] 降级推理: 开始分析文本`,
            details: { contentLength: content.length, contentPreview: content.slice(0, 50) }
        });

        const lower = content.toLowerCase();

        if (lower.includes("final answer") || lower.includes("conclusion")) {
            logAgent({
                type: "info",
                message: `[LangGraph] 降级推理: 推断为 finalize`
            });
            return { action: "finalize", finalAnswer: content, reasoning: "Inferred finalize" };
        }

        if (currentPlan.steps.length === 0) {
            logAgent({
                type: "info",
                message: `[LangGraph] 降级推理: 推断为 create_plan`
            });
            return {
                action: "create_plan",
                plan: {
                    goal: content.slice(0, 100),
                    steps: [{ id: "step_1", description: content.slice(0, 200), status: "pending" }],
                    currentStepIndex: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                },
                reasoning: "Inferred create_plan",
            };
        }

        const nextStep = currentPlan.steps.findIndex(s => s.status === "pending");
        logAgent({
            type: "info",
            message: `[LangGraph] 降级推理: 推断为 execute_step`,
            details: { nextStep }
        });
        return {
            action: "execute_step",
            stepToExecute: nextStep >= 0 ? nextStep : 0,
            reasoning: "Inferred execute_step",
        };
    }

    private async finalizeNode(state: DualLoopStateType) {
        logAgent({
            type: "info",
            message: `[LangGraph] 进入 finalize 节点`,
            details: { planSteps: state.plan.steps.length, planGoal: state.plan.goal }
        });

        const finalAnswer = await this.generateFinalAnswer(state.plan, state.messages);

        logAgent({
            type: "info",
            message: `[LangGraph] finalize 完成`,
            details: { answerLength: finalAnswer.length }
        });

        // 统计脚注：工具统计 + token 消耗（须在 finishSession 前取当前 session）
        const footer = buildStatsFooter(this.toolStatsRegistry, this.tracer);
        this.tracer?.finishSession();
        return {
            messages: [new AIMessage(finalAnswer + footer)],
        };
    }

    private async fallbackNode(state: DualLoopStateType) {
        logAgent({
            type: "error",
            message: `[LangGraph] 进入 fallback 节点`,
            details: {
                planSteps: state.plan.steps.length,
                completedSteps: state.plan.steps.filter(s => s.status === "completed").length,
                tokens: state.totalTokens
            }
        });

        const exhaustion = this.getExhaustion(state);
        const fallback = this.generateFallbackAnswer(state, exhaustion);

        logAgent({
            type: "error",
            message: `[LangGraph] fallback 完成`,
            details: { answerLength: fallback.length, reason: exhaustion?.reason }
        });

        // 统计脚注：即使失败，已发生的 LLM/工具调用也应计入
        const footer = buildStatsFooter(this.toolStatsRegistry, this.tracer);
        this.tracer?.finishSession();
        return {
            messages: [new AIMessage(fallback + footer)],
        };
    }

    private async generateFinalAnswer(plan: ExecutionPlan, messages: BaseMessage[]): Promise<string> {
        const prompt = `Based on the plan and results, generate a final answer.
    
        Goal: ${plan.goal}
        
        Steps:
        ${plan.steps.map((s, i) => `${i + 1}. ${s.description}\n   Status: ${s.status}\n   Result: ${s.result || "N/A"}`).join("\n\n")}`;
    
        const response = await this.plannerLLM.invoke([
            new SystemMessage("Synthesize results into a final answer."),
            ...messages,
            new HumanMessage(prompt),
        ], {
            signal: AbortSignal.timeout(this.llmTimeoutMs),
        });
        return this.extractText(response.content);
    }

    /**
     * 中断时的产出说明。
     * 旧实现只吐 "Progress: 1/5" —— 用户看不出为什么停、停在哪、还能不能继续。
     */
    private generateFallbackAnswer(state: DualLoopStateType, exhaustion: ExhaustionInfo | null): string {
        const plan = state.plan;
        const completed = plan.steps.filter(s => s.status === "completed");
        const failed = plan.steps.filter(s => s.status === "failed");
        const pending = plan.steps.filter(s => s.status === "pending" || s.status === "in_progress");
        const elapsedSec = ((Date.now() - state.startTime) / 1000).toFixed(1);

        const lines = [
            `⚠️ 任务未完成：${exhaustion ? `因${exhaustion.message}中断` : "因执行异常中断"}`,
            `进度 ${completed.length}/${plan.steps.length} 步 · 已消耗 ${state.totalTokens} tokens · 耗时 ${elapsedSec}s`,
        ];

        if (completed.length > 0) {
            lines.push("", "已完成：", ...completed.map(s => `- ✅ ${s.description}`));
        }
        if (failed.length > 0) {
            lines.push("", "未成功：", ...failed.map(s => `- ❌ ${s.description}${s.error ? `（${s.error}）` : ""}`));
        }
        if (pending.length > 0) {
            lines.push("", "未开始：", ...pending.map(s => `- ⏳ ${s.description}`));
        }

        lines.push(
            "",
            "可提高 PLAN_MAX_TOKENS / PLAN_MAX_TIME_MS 后重试，或把任务拆成更小的几轮。",
        );

        return lines.join("\n");
    }

    private extractUserInput(messages: BaseMessage[]): string {
        return messages.filter(m => m._getType() === "human").map(m => this.extractText(m.content)).join(" ");
    }

    private extractText(content: string | Record<string, unknown>[]): string {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content.map(c => typeof c === "string" ? c : "text" in c ? String(c.text) : "").join("");
        }
        return String(content);
    }

    async *stream(params: {
        messages: BaseMessage[];
        config?: {
          maxTokens?: number;
          maxTimeMs?: number;
          maxSteps?: number;
        };
      }) {
        logAgent({
            type: "info",
            message: `[LangGraph] 开始流式执行`,
            details: { messageCount: params.messages.length }
        });

        const { config } = params;
        const initialState: DualLoopStateType = {
          messages: params.messages,
          plan: {
            goal: "",
            steps: [],
            currentStepIndex: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          plannerOutput: null,
          currentStepIndex: 0,
          totalTokens: 0,
          startTime: Date.now(),
          maxTokens: config?.maxTokens ?? this.budget.maxTokens,
          maxTimeMs: config?.maxTimeMs ?? this.budget.maxTimeMs,
          maxSteps: config?.maxSteps ?? this.budget.maxSteps,
          intermediateSteps: [],
        };

        logAgent({
            type: "info",
            message: `[LangGraph] 初始化状态`,
            details: {
                maxTokens: initialState.maxTokens,
                maxTimeMs: initialState.maxTimeMs,
                maxSteps: initialState.maxSteps
            }
        });

        this.tracer?.startSession(this.extractUserInput(params.messages));

        let chunkCount = 0;
        try {
            const graphStream = await this.graph.stream(initialState, {
                streamMode: "updates"
            });

            for await (const chunk of graphStream) {
                chunkCount++;
                logAgent({
                    type: "info",
                    message: `[LangGraph] 产出 chunk #${chunkCount}`,
                    details: { chunkKeys: Object.keys(chunk) }
                });

            // updates 模式: chunk 是 { nodeName: { ...updates } }
            for (const [nodeName, nodeUpdates] of Object.entries(chunk)) {
                const updates = nodeUpdates as any;

                logAgent({
                    type: "info",
                    message: `[LangGraph] 节点 ${nodeName} 更新`,
                    details: {
                        hasPlan: !!updates.plan,
                        hasIntermediateSteps: !!(updates.intermediateSteps && updates.intermediateSteps.length > 0),
                        hasMessages: !!(updates.messages && updates.messages.length > 0),
                        action: updates.plannerOutput?.action
                    }
                });

                // 产出计划更新
                if (updates.plan) {
                    yield { plan: updates.plan };
                }

                // 产出中间步骤
                if (updates.intermediateSteps && updates.intermediateSteps.length > 0) {
                    for (const step of updates.intermediateSteps) {
                    }
                    yield { intermediateSteps: updates.intermediateSteps };
                }

                // 产出最终答案 / 中间叙述：
                // finalize / fallback 节点 → output（进入最终 assistant 消息）
                // 其他节点（planner/executor 若有文字）→ outputPreview（仅动态预览）
                if (updates.messages && updates.messages.length > 0) {
                    const lastMsg = updates.messages[updates.messages.length - 1];
                    if (lastMsg._getType() === "ai") {
                        const output = lastMsg.content as string;
                        if (nodeName === "finalize" || nodeName === "fallback") {
                            yield { output };
                        } else {
                            yield { outputPreview: output };
                        }
                    }
                }
            }
        }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logAgent({ type: "error", message: `[LangGraph] 流式执行异常: ${errMsg}` });
            yield { output: `[LangGraph Error] ${errMsg}` };
        }

        logAgent({
            type: "info",
            message: `[LangGraph] 流式执行完成`,
            details: { totalChunks: chunkCount }
        });
      }
}