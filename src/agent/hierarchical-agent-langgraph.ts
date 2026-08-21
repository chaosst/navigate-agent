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

输出格式：
{
  "action": "create_plan" | "execute_step" | "finalize",
  "plan": { "goal": "...", "steps": [...] },  // 仅 create_plan 时
  "stepToExecute": 0,                         // 仅 execute_step 时
  "finalAnswer": "...",                       // 仅 finalize 时
  "reasoning": "思考过程"
}`;

const EXECUTOR_PROMPT = `你是一个任务执行器。

规则：
- 专注于当前步骤
- 使用工具完成任务
- 有最终答案时直接输出，不调用工具`;

export class HierarchicalAgentLangGraph {
    private plannerLLM: ChatOpenAI;
    private executorLLM: ChatOpenAI;
    private tools: StructuredToolInterface[];
    private toolMap: Map<string, StructuredToolInterface>;
    private tracer?: Tracer;
    private toolStatsRegistry?: ToolStatsRegistry;
    /** 单次 LLM 调用超时（ms），与 normal/ptc 模式统一（默认 120s） */
    private llmTimeoutMs: number;
    private graph: any;

    constructor(
        llm: ChatOpenAI,
        tools: StructuredToolInterface[],
        tracer?: Tracer,
        toolStatsRegistry?: ToolStatsRegistry,
        llmTimeoutMs = 120_000,
    ) {
        this.plannerLLM = llm;
        this.executorLLM = llm;
        this.tools = tools;
        this.toolMap = new Map(tools.map((t) => [t.name, t]));
        this.tracer = tracer;
        this.toolStatsRegistry = toolStatsRegistry;
        this.llmTimeoutMs = llmTimeoutMs;
        this.graph = this.createGraph();
        logAgent({
            type: "info",
            message: `[LangGraph] 初始化完成，工具数量: ${tools.length}`,
            details: { toolNames: tools.map(t => t.name) }
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

        const plannerOutput = await this.callPlanner(state.messages, state.plan);

        logAgent({
            type: "info",
            message: `[LangGraph] 规划节点: 规划完成`,
            details: { action: plannerOutput.action, reasoning: plannerOutput.reasoning }
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
        };
    }

    private isResourceExhausted(state: DualLoopStateType): boolean {
        const elapsed = Date.now() - state.startTime;
        const exhausted = (
            state.totalTokens >= state.maxTokens ||
            elapsed >= state.maxTimeMs ||
            state.currentStepIndex >= state.maxSteps
        );

        if (exhausted) {
            logAgent({
                type: "error",
                message: `[LangGraph] 资源检查: 已耗尽`,
                details: {
                    tokens: `${state.totalTokens}/${state.maxTokens}`,
                    elapsed: `${elapsed}ms/${state.maxTimeMs}ms`,
                    steps: `${state.currentStepIndex}/${state.maxSteps}`
                }
            });
        }

        return exhausted;
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
        const { result, intermediateSteps, tokensUsed } = await this.executeStep(
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
                tokensUsed
            }
        });

        step.result = result;
        step.status = result.startsWith("Error:") ? "failed" : "completed";

        logAgent({
            type: "info",
            message: `[LangGraph] 执行节点: 步骤状态更新为 ${step.status}`,
            details: { stepId: step.id, status: step.status }
        });

        // 更新计划
        const newPlan = { ...state.plan };
        newPlan.steps[stepIndex] = step;
        newPlan.updatedAt = Date.now();

        return {
            plan: newPlan,
            intermediateSteps,
            totalTokens: state.totalTokens + tokensUsed,
            currentStepIndex: stepIndex + 1,
        };
    }

    private async callPlanner(messages: BaseMessage[], currentPlan: ExecutionPlan): Promise<PlannerOutput> {
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
                    parsed.plan.steps = parsed.plan.steps.map((s, i) => ({
                        id: s.id || `step_${i + 1}`,
                        description: s.description || `step_${i + 1}`,
                        status: s.status || "pending"
                    }))
                }

                return parsed
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
        return this.inferPlannerAction(content, currentPlan)
    }

    private async executeStep(step: PlanStep, contextMessages: BaseMessage[], maxIterations: number = 10): Promise<{ result: string, intermediateSteps: AgentStep[], tokensUsed: number }> {
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

        // 2、绑定工具
        const llmWithTools = this.executorLLM.bindTools(this.tools)

        let finalResult = ""
        const intermediateSteps: AgentStep[] = []
        // 本步骤累计 token 消耗（从 usage_metadata 读取，供 totalTokens 与统计展示）
        let tokensUsed = 0

        logAgent({
            type: "info",
            message: `[LangGraph] 步骤执行: 开始 ReAct 循环`,
            details: { stepId: step.id, maxIterations, contextMessages: contextMessages.length }
        });

        // 3、内存 ReAct 循环
        for (let iter = 0; iter < maxIterations; iter++) {
            logAgent({
                type: "info",
                message: `[Step ${step.id}] Iter ${iter + 1}`
            })

            let response
            try {
                response = await llmWithTools.invoke(executorMessages, {
                    signal: AbortSignal.timeout(this.llmTimeoutMs)
                })
                const usage = (response as any).usage_metadata;
                tokensUsed += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
                this.tracer?.addLLMCall(
                    iter,
                    `step ${step.id} messages[${executorMessages.length}]`,
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
                        response = await this.executorLLM.invoke(executorMessages, {
                            signal: AbortSignal.timeout(this.llmTimeoutMs),
                        });
                        const usage = (response as any).usage_metadata;
                        tokensUsed += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
                        this.tracer?.addLLMCall(
                            iter,
                            `step ${step.id} (retry) messages[${executorMessages.length}]`,
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
                            tokensUsed: 0
                        };
                    }
                } else {
                    return {
                        result: `Error: LLM failed`,
                        intermediateSteps,
                        tokensUsed: 0
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
                    const tool = this.toolMap.get(tc.name as string)
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

        logAgent({
            type: "info",
            message: `[LangGraph] 步骤 ${step.id} 执行完毕`,
            details: {
                resultLength: finalResult.length,
                totalToolCalls: intermediateSteps.length
            }
        });

        return {
            result: finalResult || "Step completed",
            intermediateSteps,
            tokensUsed,
        }
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

        const fallback = this.generateFallbackAnswer(state.plan);

        logAgent({
            type: "error",
            message: `[LangGraph] fallback 完成`,
            details: { answerLength: fallback.length }
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

    private generateFallbackAnswer(plan: ExecutionPlan): string {
        const completed = plan.steps.filter(s => s.status === "completed");
        return `Progress: ${completed.length}/${plan.steps.length} steps completed.\n\n` +
            completed.map(s => `- ✅ ${s.description}`).join("\n");
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
          maxTokens: config?.maxTokens ?? 100000,
          maxTimeMs: config?.maxTimeMs ?? 300000,
          maxSteps: config?.maxSteps ?? 20,
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

                // 产出最终答案
                if (updates.messages && updates.messages.length > 0) {
                    const lastMsg = updates.messages[updates.messages.length - 1];
                    if (lastMsg._getType() === "ai") {
                        const output = lastMsg.content as string;
                        yield { output };
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