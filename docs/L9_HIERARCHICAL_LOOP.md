# L9: 认知层级循环（双层循环）完整实现方案

> 双层循环架构：规划层（Outer Loop）+ 执行层（Inner Loop）

---

## 1. 设计理念

### 1.1 当前问题

单层 ReAct 循环：
- LLM 每次同时做"规划"和"执行"
- 复杂任务容易迷失方向
- 无法区分"战略思考"和"战术执行"

### 1.2 双层循环架构

```
┌─────────────────────────────────┐
│  Outer Loop: Planner (规划层)    │
│  - 分析任务，制定计划            │
│  - 监控执行进展                  │
│  - 动态调整计划                  │
│  - 不绑定工具，减少 token        │
└──────────────┬──────────────────┘
               │ 分配子任务
               ▼
┌─────────────────────────────────┐
│  Inner Loop: Executor (执行层)   │
│  - 执行具体工具调用              │
│  - 返回执行结果                  │
│  - 绑定完整工具集                │
└─────────────────────────────────┘
```

### 1.3 核心优势

| 特性 | 单层 ReAct | 双层循环 |
|------|-----------|---------|
| 职责分离 | ❌ 混合 | ✅ 明确分离 |
| 全局视角 | ❌ 只看当前 | ✅ 看到完整计划 |
| 动态调整 | ❌ 困难 | ✅ 可随时修改 |
| Token 消耗 | 中 | 低（规划层无工具） |

---

## 2. 核心类型定义

在 `src/agent/types.ts` 中新增：

```typescript
export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  result?: string;
  error?: string;
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  currentStepIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlannerOutput {
  action: "create_plan" | "update_plan" | "execute_step" | "finalize";
  plan?: ExecutionPlan;
  stepToExecute?: number;
  finalAnswer?: string;
  reasoning: string;
}
```

---

## 3. 类结构

```typescript
// src/agent/hierarchical-agent.ts

export class HierarchicalAgent {
  private plannerLLM: ChatOpenAI;
  private executorLLM: ChatOpenAI;
  private tools: StructuredToolInterface[];
  private toolMap: Map<string, StructuredToolInterface>;
  private tracer?: Tracer;

  constructor(llm: ChatOpenAI, tools: StructuredToolInterface[], tracer?: Tracer) {
    this.plannerLLM = llm;
    this.executorLLM = llm;
    this.tools = tools;
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
    this.tracer = tracer;
  }

  async *stream(params): AsyncGenerator<{ output?, intermediateSteps?, plan? }> {
    // 主循环，见第 4 节
  }

  private async callPlanner(messages, currentPlan): Promise<PlannerOutput> {
    // 规划层调用，见第 5 节
  }

  private async *executeStep(step, contextMessages, maxIterations): AsyncGenerator<AgentStep[], string> {
    // 执行层调用，见第 6 节
  }
}
```

---

## 4. 主循环 stream

```typescript
async *stream(params: {
  messages: BaseMessage[];
  maxPlanIterations?: number;
  maxStepIterations?: number;
}): AsyncGenerator<{
  output?: string;
  intermediateSteps?: AgentStep[];
  plan?: ExecutionPlan;
}> {
  const { maxPlanIterations = 5, maxStepIterations = 10 } = params;
  const messages = [...params.messages];

  let plan: ExecutionPlan = {
    goal: "",
    steps: [],
    currentStepIndex: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  this.tracer?.startSession(this.extractUserInput(messages));

  // Outer Loop: 规划层
  for (let planIter = 0; planIter < maxPlanIterations; planIter++) {
    logAgent({ type: "info", message: `Plan iteration ${planIter + 1}` });

    // 调用规划层
    const plannerOutput = await this.callPlanner(messages, plan);

    // 产出计划更新
    if (plannerOutput.plan) {
      plan = plannerOutput.plan;
      yield { plan };
    }

    // 根据动作执行
    switch (plannerOutput.action) {
      case "create_plan":
      case "update_plan":
        continue;

      case "execute_step": {
        const stepIndex = plannerOutput.stepToExecute ?? 0;
        if (stepIndex >= plan.steps.length) continue;

        const step = plan.steps[stepIndex];
        step.status = "in_progress";

        // 执行步骤（内层循环）
        const stepResult = yield* this.executeStep(step, messages, maxStepIterations);

        step.result = stepResult;
        step.status = stepResult.startsWith("Error:") ? "failed" : "completed";

        yield {
          intermediateSteps: [{
            action: { tool: "plan_step", toolInput: { step: step.description }, log: "" },
            observation: stepResult,
          }],
        };
        break;
      }

      case "finalize": {
        const finalAnswer = plannerOutput.finalAnswer ||
          await this.generateFinalAnswer(plan, messages);
        this.tracer?.finishSession();
        yield { output: finalAnswer };
        return;
      }
    }
  }

  // 超出迭代限制
  const fallback = this.generateFallbackAnswer(plan);
  this.tracer?.finishSession();
  yield { output: fallback };
}
```

---

## 5. callPlanner 实现

```typescript
private async callPlanner(
  messages: BaseMessage[],
  currentPlan: ExecutionPlan,
): Promise<PlannerOutput> {
  // 1. 构建消息
  const plannerMessages: BaseMessage[] = [
    new SystemMessage(PLANNER_PROMPT),
    ...messages,
  ];

  // 2. 如果有当前计划，注入上下文
  if (currentPlan.steps.length > 0) {
    const planSummary = this.formatPlanSummary(currentPlan);
    plannerMessages.push(new SystemMessage(`Current plan:\n${planSummary}`));
  }

  // 3. 调用 LLM
  let response;
  try {
    response = await this.plannerLLM.invoke(plannerMessages, {
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    // 降级：创建单步骤计划
    return {
      action: "create_plan",
      plan: {
        goal: this.extractUserInput(messages),
        steps: [{ id: "step_1", description: this.extractUserInput(messages), status: "pending" }],
        currentStepIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      reasoning: `Fallback: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const content = this.extractText(response.content);

  // 4. 解析 JSON
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as PlannerOutput;
      if (!parsed.action) throw new Error("Missing action");

      // 标准化 plan
      if (parsed.plan) {
        parsed.plan.steps = parsed.plan.steps.map((s, i) => ({
          id: s.id || `step_${i + 1}`,
          description: s.description || `Step ${i + 1}`,
          status: s.status || "pending",
        }));
      }
      return parsed;
    }
  } catch (err) {
    logAgent({ type: "warning", message: `JSON parse failed` });
  }

  // 5. 降级：从文本推断
  return this.inferPlannerAction(content, currentPlan);
}
```

### 5.1 PLANNER_PROMPT

```typescript
const PLANNER_PROMPT = `你是一个任务规划器。

输出 JSON 格式：
{
  "action": "create_plan" | "update_plan" | "execute_step" | "finalize",
  "plan": {
    "goal": "总体目标",
    "steps": [{ "id": "step_1", "description": "步骤描述", "status": "pending" }]
  },
  "stepToExecute": 0,
  "finalAnswer": "...",
  "reasoning": "思考过程"
}

动作说明：
- create_plan: 生成执行计划
- update_plan: 调整计划
- execute_step: 执行指定步骤
- finalize: 生成最终答案

规则：
- 计划 3-10 个步骤
- 每步应该是原子操作
- 必须输出有效 JSON`;
```

---

## 6. executeStep 实现

```typescript
private async *executeStep(
  step: PlanStep,
  contextMessages: BaseMessage[],
  maxIterations: number = 10,
): AsyncGenerator<AgentStep[], string> {
  // 1. 构建消息
  const executorMessages: BaseMessage[] = [
    new SystemMessage(EXECUTOR_PROMPT),
    new HumanMessage(`Execute this step: ${step.description}`),
    ...contextMessages.slice(-4),
  ];

  // 2. 绑定工具
  const llmWithTools = this.executorLLM.bindTools(this.tools);

  let finalResult = "";

  // 3. 内层 ReAct 循环
  for (let iter = 0; iter < maxIterations; iter++) {
    logAgent({ type: "info", message: `[Step ${step.id}] Iter ${iter + 1}` });

    let response;
    try {
      response = await llmWithTools.invoke(executorMessages, {
        signal: AbortSignal.timeout(30000),
      });
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
    const toolCalls = response.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      finalResult = this.extractText(response.content);
      break;
    }

    // 并发执行工具
    executorMessages.push(response);
    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        const tool = this.toolMap.get(tc.name as string);
        if (!tool) {
          return { tc, result: `Tool not found`, success: false };
        }

        try {
          const result = await tool.invoke(tc.args as Record<string, unknown>);
          return { tc, result, success: true };
        } catch (err) {
          return { tc, result: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false };
        }
      })
    );

    // 收集结果
    for (const r of toolResults) {
      executorMessages.push(new ToolMessage({ content: r.result, tool_call_id: r.tc.id as string }));
      yield [{
        action: { tool: r.tc.name as string, toolInput: r.tc.args as Record<string, unknown>, log: "" },
        observation: r.result,
      }];
    }
  }

  return finalResult || "Step completed";
}
```

### 6.1 EXECUTOR_PROMPT

```typescript
const EXECUTOR_PROMPT = `你是一个任务执行器。

规则：
- 专注于当前步骤
- 使用工具完成任务
- 有最终答案时直接输出，不调用工具`;
```

---

## 7. 辅助方法

```typescript
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
```

---

## 8. 集成到系统

### 8.1 添加工厂函数

```typescript
// src/agent/loop.ts

import { HierarchicalAgent } from "./hierarchical-agent.js";

export async function createHierarchicalAgent(
  llm: ChatOpenAI,
  tools: StructuredToolInterface[],
  tracer?: Tracer,
): Promise<HierarchicalAgent> {
  return new HierarchicalAgent(llm, tools, tracer);
}
```

### 8.2 使用示例

```typescript
const agent = await createHierarchicalAgent(llm, tools, tracer);

for await (const chunk of agent.stream({
  messages: [new HumanMessage("分析项目代码结构")],
  maxPlanIterations: 5,
  maxStepIterations: 10,
})) {
  if (chunk.plan) {
    console.log("Plan updated:", chunk.plan.steps);
  }
  if (chunk.intermediateSteps) {
    for (const step of chunk.intermediateSteps) {
      console.log(`Tool: ${step.action.tool}`);
    }
  }
  if (chunk.output) {
    console.log("Final:", chunk.output);
  }
}
```

---

## 9. 测试要点

1. **正常流程**: 创建计划 → 执行步骤 → 最终答案
2. **JSON 解析失败**: 降级推断动作
3. **LLM 调用失败**: 返回默认计划
4. **步骤失败**: 标记 failed，继续执行
5. **迭代超限**: 生成降级答案
6. **计划调整**: 根据执行结果更新计划

---

## 10. 性能优化建议

1. **规划层不绑定工具**: 减少 token 消耗
2. **执行层只保留最近 4 条上下文**: 避免 token 爆炸
3. **并发执行工具**: 使用 Promise.all
4. **缓存工具映射**: toolMap 避免重复查找
5. **限制迭代次数**: maxPlanIterations=5, maxStepIterations=10

---

## 11. 与 LangGraph 的对比

| 特性 | 手写双层循环 | LangGraph |
|------|-------------|-----------|
| 控制流 | 显式 for 循环 | StateGraph 节点 |
| 状态管理 | 手动维护 | Annotation |
| 可视化 | 无 | LangGraph Studio |
| 调试 | console.log | 内置追踪 |
| 学习曲线 | 低 | 中 |

**推荐**: 学习用此方案（手写），生产环境考虑 LangGraph

---

> 文档版本: 1.0
> 生成时间: 2026-08-13
> 相关文件: ADVANCED_LOOP_IMPLEMENTATION.md
