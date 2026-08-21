import { BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "langchain";
import { ExecutionPlan, PlanStep, PlannerOutput } from "./types.js";
import { ChatOpenAI } from "@langchain/openai";
import { StructuredToolInterface } from "@langchain/core/tools";
import { Tracer } from "./tracer.js";
import { logAgent } from "./logger.js";
import { AgentStep } from "@langchain/core/agents";

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

export class HierarchicalAgent {
    private plannerLLM: ChatOpenAI
    private executorLLM: ChatOpenAI
    private tools: StructuredToolInterface[]
    private toolMap: Map<string, StructuredToolInterface>
    private tracer?: Tracer

    constructor(llm: ChatOpenAI, tools: StructuredToolInterface[], tracer?: Tracer) {
        this.plannerLLM = llm
        this.executorLLM = llm
        this.tools = tools
        this.toolMap = new Map(tools.map((t) => [t.name, t]))
        this.tracer = tracer
    }

    async *stream(params: { messages: BaseMessage[], maxPlanIterations?: number, maxStepIterations?: number }): AsyncGenerator<{ output?: string, intermediateSteps?: AgentStep[], plan?: ExecutionPlan }> {
        const { maxPlanIterations = 5, maxStepIterations = 10 } = params
        const messages = [...params.messages]

        let plan: ExecutionPlan = {
            goal: "",
            steps: [],
            currentStepIndex: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }

        this.tracer?.startSession(this.extractUserInput(messages))

        // 外层循环：规划
        for (let planIter = 0; planIter < maxPlanIterations; planIter++) {
            logAgent({
                type: "info", message: `Plan iteration ${planIter + 1}`
            })
            console.log(`Plan iteration ${planIter + 1}`)
            // 调用规划层
            const plannerOutput = await this.callPlanner(messages, plan)
            console.log(`plannerOutput ${JSON.stringify(plannerOutput)}`)
            // 产出计划更新
            if (plannerOutput.plan) {
                plan = plannerOutput.plan
                yield { plan }
            }

            // 根据动作执行
            switch(plannerOutput.action) {
                case "create_plan": {
                    // 创建计划后，自动执行第一个步骤
                    if (plan.steps.length > 0) {
                        const step = plan.steps[0]
                        step.status = "in_progress"
                        plan.updatedAt = Date.now()

                        logAgent({ type: "info", message: `Auto-executing step 1: ${step.description}` })
                        console.log(`Auto-executing step 1: ${step.description}`)

                        const stepResult = yield* this.executeStep(step, messages, maxStepIterations)

                        step.result = stepResult
                        step.status = stepResult.startsWith("Error:") ? "failed" : "completed"
                        plan.updatedAt = Date.now()

                        yield {
                            intermediateSteps: [{
                                action: { tool: "plan_step", toolInput: { step: step.description }, log: "" },
                                observation: stepResult
                            }]
                        }
                    }
                    break
                }

                case "execute_step": {
                    const stepIndex = plannerOutput.stepToExecute ?? 0
                    if (stepIndex >= plan.steps.length) {
                        logAgent({ type: "error", message: `Invalid step index: ${stepIndex}` })
                        break
                    }

                    const step = plan.steps[stepIndex]
                    // 跳过已完成的步骤
                    if (step.status === "completed" || step.status === "failed") {
                        const nextIndex = plan.steps.findIndex((s, i) => i > stepIndex && s.status === "pending")
                        if (nextIndex >= 0) {
                            plannerOutput.stepToExecute = nextIndex
                            // 继续执行下一步（不 break）
                        } else {
                            // 所有步骤完成，转为 finalize
                            plannerOutput.action = "finalize"
                            break
                        }
                    }

                    if (plannerOutput.action === "execute_step") {
                        const currentIndex = plannerOutput.stepToExecute ?? stepIndex
                        const currentStep = plan.steps[currentIndex]
                        currentStep.status = "in_progress"
                        plan.updatedAt = Date.now()

                        logAgent({ type: "info", message: `Executing step ${currentIndex + 1}: ${currentStep.description}` })
                        console.log(`Executing step ${currentIndex + 1}: ${currentStep.description}`)

                        const stepResult = yield* this.executeStep(currentStep, messages, maxStepIterations)

                        currentStep.result = stepResult
                        currentStep.status = stepResult.startsWith("Error:") ? "failed" : "completed"
                        plan.updatedAt = Date.now()

                        yield {
                            intermediateSteps: [{
                                action: { tool: "plan_step", toolInput: { step: currentStep.description }, log: "" },
                                observation: stepResult
                            }]
                        }
                    }
                    break
                }

                case "finalize": {
                    const finalAnswer = plannerOutput.finalAnswer || await this.generateFinalAnswer(plan, messages)
                    this.tracer?.finishSession()
                    yield {
                        output: finalAnswer
                    }
                    return
                }
            }
        }

        // 超出迭代限制
        const fallback = this.generateFallbackAnswer(plan)
        this.tracer?.finishSession()
        yield {
            output: fallback
        }
    }

    private async callPlanner(messages: BaseMessage[], currentPlan: ExecutionPlan): Promise<PlannerOutput> {
        // 1、构建消息
        const plannerMessages: BaseMessage[] = [
            new SystemMessage(PLANNER_PROMPT),
            ...messages
        ]

        // 2、如果有当前计划，注入上下文
        if (currentPlan.steps.length > 0) {
            const planSummary = this.formatPlanSummary(currentPlan)
            plannerMessages.push(new SystemMessage(`Current plan:\n${planSummary}`))
        }

        // 3、调用 LLM
        let response
        try {
            response = await this.plannerLLM.invoke(plannerMessages, {
                signal: AbortSignal.timeout(30000)
            })
        } catch (err) {
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

        // 4、解析 JSON
        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]) as PlannerOutput
                if(!parsed.action)
                    throw new Error("Missing action")

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
        return this.inferPlannerAction(content, currentPlan)
    }

    private async *executeStep(step: PlanStep, contextMessages: BaseMessage[], maxIterations: number = 10): AsyncGenerator<{ intermediateSteps?: AgentStep[] }, string> {
        // 1、构建消息
        const executorMessages: BaseMessage[] = [
            new SystemMessage(EXECUTOR_PROMPT),
            new HumanMessage(`Execute this step: ${step.description}`),
            ...contextMessages.slice(-4)
        ]

        // 2、绑定工具
        const llmWithTools = this.executorLLM.bindTools(this.tools)

        let finalResult = ""

        // 3、内存 ReAct 循环
        for (let iter = 0; iter < maxIterations; iter++) {
            logAgent({
                type: "info", message: `[Step ${step.id}] Iter ${iter + 1}`
            })

            let response
            try {
                response = await llmWithTools.invoke(executorMessages, {
                    signal: AbortSignal.timeout(30000)
                })
            } catch (err) {
                if (iter === 0) {
                    response = await this.executorLLM.invoke(executorMessages, {
                    signal: AbortSignal.timeout(30000),
                    });
                } else {
                    return `Error: LLM failed`;
                }
            }

            // 检查工具调用
            const toolCalls = response.tool_calls
            if (!toolCalls || toolCalls.length === 0) {
                finalResult = this.extractText(response.content)
                break
            }

            // 并发执行工具
            executorMessages.push(response)
            const toolResults = await Promise.all(
                toolCalls.map(async (tc) => {
                    const tool = this.toolMap.get(tc.name as string)
                    if (!tool) {
                        return {
                            tc, result: `Tool not found`, success: false
                        }
                    }

                    try {
                        const result = await tool.invoke(tc.args as Record<string, unknown>)
                        return {
                            tc, result, success: true
                        }
                    } catch (err) {
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
                yield {
                    intermediateSteps: [
                        {
                            action: {
                                tool: r.tc.name as string, toolInput: r.tc.args as Record<string, unknown>, log: ""
                            },
                            observation: r.result
                        }
                    ]
                }
            }
        }
        return finalResult || "Step completed"
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
        const lower = content.toLowerCase();
      
        if (lower.includes("final answer") || lower.includes("conclusion")) {
          return { action: "finalize", finalAnswer: content, reasoning: "Inferred finalize" };
        }
      
        if (currentPlan.steps.length === 0) {
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
        return {
          action: "execute_step",
          stepToExecute: nextStep >= 0 ? nextStep : 0,
          reasoning: "Inferred execute_step",
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
        ]);
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
}