# L9 双层循环 LangGraph 改造方案

> 将手写双层循环改造为基于 LangGraph 的实现

---

## 1. 背景与目标

### 当前问题
- maxPlanIterations 限制过死，多步骤计划无法完整执行
- 手动维护 plan 对象，状态管理复杂
- 缺乏可视化调试工具

### 改造目标
- ✅ 基于任务完成度终止（而非固定迭代）
- ✅ 基于资源限制终止（token/时间预算）
- ✅ 利用 LangGraph 的状态管理和可视化
- ✅ 保持与现有系统的兼容性

---

## 2. 架构设计

### 状态图

```
START
  ↓
[Planner Node] ──→ 生成/更新计划
  ↓
[条件路由] ──→ 检查计划状态
  ├─ 有新计划 ──→ [Executor Node]
  ├─ 所有步骤完成 ──→ [Finalize Node] ──→ END
  └─ 资源耗尽 ──→ [Fallback Node] ──→ END
  ↓
[Executor Node] ──→ 执行单个步骤
  ↓
[条件路由] ──→ 检查步骤状态
  ├─ 步骤完成 ──→ [Planner Node]（继续下一步）
  └─ 步骤失败 ──→ [Planner Node]（调整计划）
```

### 核心改进

| 特性 | 手写版 | LangGraph 版 |
|------|-------|-------------|
| 迭代控制 | ❌ 固定次数 | ✅ 资源限制 |
| 状态管理 | ❌ 手动维护 | ✅ 自动管理 |
| 可视化 | ❌ 无 | ✅ LangGraph Studio |
| 调试 | ⚠️ console.log | ✅ 内置追踪 |
| 扩展性 | ⚠️ 困难 | ✅ 容易 |

---

## 3. 核心类型定义

在 `src/agent/types.ts` 中新增：

```typescript
import { Annotation } from "@langchain/langgraph";
import { MessagesAnnotation } from "@langchain/langgraph";

/**
 * 双层循环状态
 */
export const DualLoopState = Annotation.Root({
  // 继承消息链
  ...MessagesAnnotation.spec,
  
  // 执行计划
  plan: Annotation<ExecutionPlan>({
    reducer: (_, b) => b,  // 覆盖更新
    default: () => ({
      goal: "",
      steps: [],
      currentStepIndex: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  }),
  
  // 规划层输出
  plannerOutput: Annotation<PlannerOutput | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  
  // 当前执行的步骤索引
  currentStepIndex: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 0,
  }),
  
  // 资源跟踪
  totalTokens: Annotation<number>({
    reducer: (a, b) => a + b,
    default: () => 0,
  }),
  
  startTime: Annotation<number>({
    reducer: (_, b) => b,
    default: () => Date.now(),
  }),
  
  // 配置
  maxTokens: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 100000,  // 100k tokens
  }),
  
  maxTimeMs: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 300000,  // 5 minutes
  }),
  
  maxSteps: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 20,  // 安全上限
  }),
  
  // 中间步骤（兼容现有接口）
  intermediateSteps: Annotation<AgentStep[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

export type DualLoopStateType = typeof DualLoopState.State;
```

---

## 4. 核心实现

### 4.1 类结构

文件：`src/agent/hierarchical-agent-langgraph.ts`

```typescript
import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, SystemMessage, HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Tracer } from "./tracer.js";
import type { DualLoopStateType, ExecutionPlan, PlanStep, PlannerOutput } from "./types.js";
import { logAgent } from "./logger.js";

const PLANNER_PROMPT = `...`;  // 同原实现
const EXECUTOR_PROMPT = `...`; // 同原实现

export class HierarchicalAgentLangGraph {
  private plannerLLM: ChatOpenAI;
  private executorLLM: ChatOpenAI;
  private tools: StructuredToolInterface[];
  private toolMap: Map<string, StructuredToolInterface>;
  private tracer?: Tracer;
  private graph: any;

  constructor(
    llm: ChatOpenAI,
    tools: StructuredToolInterface[],
    tracer?: Tracer,
  ) {
    this.plannerLLM = llm;
    this.executorLLM = llm;
    this.tools = tools;
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
    this.tracer = tracer;
    this.graph = this.createGraph();
  }

  private createGraph() {
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

    return workflow.compile();
  }
}
```

### 4.2 节点实现

#### Planner Node

```typescript
private async plannerNode(state: DualLoopStateType) {
  // 1. 检查资源限制
  if (this.isResourceExhausted(state)) {
    return { plannerOutput: { action: "finalize", reasoning: "Resource exhausted" } };
  }

  // 2. 调用规划层 LLM
  const plannerOutput = await this.callPlanner(state.messages, state.plan);

  // 3. 更新计划
  const newPlan = plannerOutput.plan || state.plan;

  // 4. 如果是 create_plan，自动设置第一个步骤
  if (plannerOutput.action === "create_plan" && newPlan.steps.length > 0) {
    plannerOutput.action = "execute_step";
    plannerOutput.stepToExecute = 0;
  }

  return {
    plan: newPlan,
    plannerOutput,
    currentStepIndex: plannerOutput.stepToExecute ?? state.currentStepIndex,
  };
}
```

#### Executor Node

```typescript
private async executorNode(state: DualLoopStateType) {
  const stepIndex = state.currentStepIndex;
  if (stepIndex >= state.plan.steps.length) {
    return { plannerOutput: { action: "finalize", reasoning: "All steps completed" } };
  }

  const step = state.plan.steps[stepIndex];
  step.status = "in_progress";

  // 执行步骤
  const { result, intermediateSteps, tokensUsed } = await this.executeStep(
    step,
    state.messages,
  );

  step.result = result;
  step.status = result.startsWith("Error:") ? "failed" : "completed";

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
```

#### Finalize Node

```typescript
private async finalizeNode(state: DualLoopStateType) {
  const finalAnswer = await this.generateFinalAnswer(state.plan, state.messages);
  this.tracer?.finishSession();
  return {
    messages: [new AIMessage(finalAnswer)],
  };
}
```

#### Fallback Node

```typescript
private async fallbackNode(state: DualLoopStateType) {
  const fallback = this.generateFallbackAnswer(state.plan);
  this.tracer?.finishSession();
  return {
    messages: [new AIMessage(fallback)],
  };
}
```

### 4.3 条件路由

```typescript
// 规划层后的路由
private routeAfterPlanner(state: DualLoopStateType): string {
  const action = state.plannerOutput?.action;

  // 资源耗尽
  if (this.isResourceExhausted(state)) {
    return "fallback";
  }

  // 执行步骤
  if (action === "execute_step") {
    return "executor";
  }

  // 完成
  if (action === "finalize") {
    return "finalize";
  }

  // 继续规划
  return "planner";
}

// 执行层后的路由
private routeAfterExecutor(state: DualLoopStateType): string {
  // 所有步骤完成
  const allCompleted = state.plan.steps.every(
    s => s.status === "completed" || s.status === "failed"
  );
  if (allCompleted) {
    return "finalize";
  }

  // 资源耗尽
  if (this.isResourceExhausted(state)) {
    return "fallback";
  }

  // 继续下一步
  return "planner";
}
```

### 4.4 资源检查

```typescript
private isResourceExhausted(state: DualLoopStateType): boolean {
  const elapsed = Date.now() - state.startTime;
  return (
    state.totalTokens >= state.maxTokens ||
    elapsed >= state.maxTimeMs ||
    state.currentStepIndex >= state.maxSteps
  );
}
```

### 4.5 流式输出

```typescript
async *stream(params: {
  messages: BaseMessage[];
  config?: {
    maxTokens?: number;
    maxTimeMs?: number;
    maxSteps?: number;
  };
}) {
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

  this.tracer?.startSession(this.extractUserInput(params.messages));

  for await (const chunk of await this.graph.stream(initialState)) {
    // 产出计划更新
    if (chunk.plan) {
      yield { plan: chunk.plan };
    }
    // 产出中间步骤
    if (chunk.intermediateSteps && chunk.intermediateSteps.length > 0) {
      yield { intermediateSteps: chunk.intermediateSteps };
    }
    // 产出最终答案
    if (chunk.messages && chunk.messages.length > 0) {
      const lastMsg = chunk.messages[chunk.messages.length - 1];
      if (lastMsg._getType() === "ai") {
        yield { output: lastMsg.content as string };
      }
    }
  }
}
```

---

## 5. 辅助方法

从原 `hierarchical-agent.ts` 复制以下方法：

```typescript
// 规划层调用
private async callPlanner(
  messages: BaseMessage[],
  currentPlan: ExecutionPlan,
): Promise<PlannerOutput> {
  // 实现同原 hierarchical-agent.ts
}

// 执行层调用
private async executeStep(
  step: PlanStep,
  contextMessages: BaseMessage[],
): Promise<{ result: string; intermediateSteps: AgentStep[]; tokensUsed: number }> {
  // 实现同原 hierarchical-agent.ts
  // 额外返回 tokensUsed
}

// 生成最终答案
private async generateFinalAnswer(
  plan: ExecutionPlan,
  messages: BaseMessage[],
): Promise<string> {
  // 实现同原 hierarchical-agent.ts
}

// 生成降级答案
private generateFallbackAnswer(plan: ExecutionPlan): string {
  // 实现同原 hierarchical-agent.ts
}

// 格式化计划摘要
private formatPlanSummary(plan: ExecutionPlan): string {
  // 实现同原 hierarchical-agent.ts
}

// 从文本推断动作
private inferPlannerAction(content: string, currentPlan: ExecutionPlan): PlannerOutput {
  // 实现同原 hierarchical-agent.ts
}

// 提取用户输入
private extractUserInput(messages: BaseMessage[]): string {
  // 实现同原 hierarchical-agent.ts
}

// 提取文本
private extractText(content: string | Record<string, unknown>[]): string {
  // 实现同原 hierarchical-agent.ts
}
```

---

## 6. 集成方案

### 6.1 更新 loop.ts

```typescript
// src/agent/loop.ts

import { HierarchicalAgentLangGraph } from "./hierarchical-agent-langgraph.js";

export async function createHierarchicalAgent(
  llm: ChatOpenAI,
  tools: StructuredToolInterface[],
  tracer?: Tracer,
): Promise<HierarchicalAgentLangGraph> {
  return new HierarchicalAgentLangGraph(llm, tools, tracer);
}
```

### 6.2 更新 test.ts

```typescript
// src/test.ts

import { createHierarchicalAgent } from "./agent/loop.js";
import { HumanMessage } from "@langchain/core/messages";

const agent = await createHierarchicalAgent(llm, createTools());

for await (const chunk of agent.stream({
  messages: [new HumanMessage("分析项目代码结构")],
  config: {
    maxTokens: 100000,
    maxTimeMs: 300000,
    maxSteps: 20,
  },
})) {
  if (chunk.plan) {
    console.log("Plan updated:", chunk.plan);
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

## 7. 文件清单

### 新增
- `src/agent/hierarchical-agent-langgraph.ts` - LangGraph 版双层循环

### 修改
- `src/agent/types.ts` - 新增 DualLoopState 类型定义
- `src/agent/loop.ts` - 更新工厂函数
- `src/test.ts` - 更新测试代码

### 保留（可选）
- `src/agent/hierarchical-agent.ts` - 手写版作为学习参考

---

## 8. 测试要点

1. **正常流程**: 创建计划 → 执行所有步骤 → 生成最终答案
2. **资源限制**: Token/时间/步骤超限时正确降级
3. **步骤失败**: 标记失败，继续执行其他步骤
4. **计划调整**: 根据执行结果动态调整计划
5. **流式输出**: 正确产出 plan/intermediateSteps/output

---

## 9. 实施步骤

1. 在 `types.ts` 中定义 DualLoopState
2. 创建 `hierarchical-agent-langgraph.ts`
3. 实现 plannerNode, executorNode, finalizeNode, fallbackNode
4. 实现条件路由逻辑
5. 实现资源检查
6. 更新 loop.ts 工厂函数
7. 更新 test.ts 测试代码
8. 测试验证

---

## 10. 后续优化

1. **添加检查点**: 支持中断和恢复
2. **添加人类介入**: 在关键步骤暂停等待确认
3. **添加子图**: 复杂步骤可以用子图实现
4. **添加持久化**: 将状态保存到数据库

---

> 文档版本: 1.0
> 生成时间: 2026-08-13
> 相关文件: L9_HIERARCHICAL_LOOP.md, graph-agent-executor.ts
