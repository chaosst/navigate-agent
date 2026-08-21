
# Agent Loop 高级优化实现方案

> L9-L12 高级优化的具体实现方案  
> 基于当前 `custom-loop.ts` 和 `graph-agent-executor.ts` 的代码结构

---

## 目录

1. [L9: 认知层级循环（双层循环）](#l9-认知层级循环双层循环)
2. [L10: 自我反思与纠错](#l10-自我反思与纠错)
3. [L11: 多 Agent 协作](#l11-多-agent-协作)
4. [L12: Plan-and-Execute 模式](#l12-plan-and-execute-模式)
5. [实现顺序建议](#实现顺序建议)

---

## L9: 认知层级循环（双层循环）

### 1. 设计理念

当前单层 ReAct 循环的问题：
- LLM 每次都要同时做"规划"和"执行"两件事
- 复杂任务时容易迷失方向，缺乏全局视角
- 无法区分"战略思考"和"战术执行"

双层循环架构：
```
┌─────────────────────────────────────────┐
│  Outer Loop: Planner (规划层)            │
│  - 分析任务，制定计划                     │
│  - 监控执行进展                          │
│  - 动态调整计划                          │
│  - 生成最终总结                          │
└──────────────────┬──────────────────────┘
                   │ 分配子任务
                   ▼
┌─────────────────────────────────────────┐
│  Inner Loop: Executor (执行层)           │
│  - 执行具体工具调用                      │
│  - 返回执行结果                          │
│  - 报告进度和障碍                        │
└─────────────────────────────────────────┘
```

### 2. 核心类型定义

```typescript
// src/agent/types.ts 新增

/** 计划步骤 */
export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  result?: string;
  error?: string;
  iterations_used?: number;
}

/** 执行计划 */
export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  currentStepIndex: number;
  createdAt: number;
  updatedAt: number;
}

/** 规划层输出 */
export interface PlannerOutput {
  action: "create_plan" | "update_plan" | "execute_step" | "finalize";
  plan?: ExecutionPlan;
  stepToExecute?: number;
  finalAnswer?: string;
  reasoning: string;
}
```

### 3. 实现方案

#### 3.1 创建 HierarchicalAgent 类

文件：`src/agent/hierarchical-agent.ts`

核心逻辑：
1. **规划层（Outer Loop）**：分析任务、制定计划、监控进展
2. **执行层（Inner Loop）**：执行具体步骤、调用工具
3. **流式输出**：产出计划更新、中间步骤、最终答案

关键方法：
- `stream()` - 主循环，协调规划层和执行层
- `callPlanner()` - 调用规划层 LLM，获取计划决策
- `executeStep()` - 内层循环，执行单个计划步骤
- `generateFinalAnswer()` - 综合所有步骤结果生成最终答案
- `formatPlanSummary()` - 格式化计划状态用于 LLM 上下文

#### 3.2 关键设计决策

**规划层 Prompt 设计要点：**
- 明确要求输出 JSON 格式
- 定义 4 种动作：create_plan, update_plan, execute_step, finalize
- 提供计划状态模板，让 LLM 更新而非重建

**执行层工具绑定：**
- 可以根据步骤描述动态选择工具子集
- 或者使用完整工具集，让 LLM 自行决定

**降级策略：**
- JSON 解析失败时，从文本推断动作类型
- 超出迭代限制时，生成当前进展的总结

#### 3.3 核心实现步骤

**Step 1: 定义类型**
- 在 `src/agent/types.ts` 中新增 `PlanStep`, `ExecutionPlan`, `PlannerOutput`

**Step 2: 实现类骨架**
```typescript
export class HierarchicalAgent {
  private plannerLLM: ChatOpenAI;
  private executorLLM: ChatOpenAI;
  private tools: StructuredToolInterface[];
  private toolMap: Map<string, StructuredToolInterface>;
  private tracer?: Tracer;

  async *stream(params): AsyncGenerator<{ output?, intermediateSteps?, plan? }> {
    // 外层循环：规划
    for (let planIter = 0; planIter < maxPlanIterations; planIter++) {
      const plannerOutput = await this.callPlanner(messages, plan);
      switch (plannerOutput.action) {
        case "execute_step":
          const result = yield* this.executeStep(step, messages, maxStepIterations);
          break;
        case "finalize":
          yield { output: plannerOutput.finalAnswer };
          return;
      }
    }
  }
}
```

**Step 3: 实现规划层调用**
- 构建 planner prompt
- 解析 JSON 输出
- 处理解析失败的降级逻辑

**Step 4: 实现执行层**
- 复用 custom-loop.ts 的工具执行逻辑
- 限制步骤内的迭代次数
- 收集工具调用结果

**Step 5: 集成到系统**
- 在 `src/agent/loop.ts` 中添加工厂函数
- 在 TUI 中添加模式选择

---

## L10: 自我反思与纠错

### 1. 设计理念

在标准 ReAct 循环的每 N 轮迭代后，插入一个反思环节：

```
Main Loop:
  1. Think (LLM 推理)
  2. Act (工具调用)
  3. Observe (观察结果)
  4. Reflect (自我反思) ← 新增，每 N 轮执行一次
     - 评估进展评分 (0-1)
     - 检测死循环
     - 建议策略调整
```

### 2. 核心类型定义

```typescript
export interface ReflectionResult {
  progressScore: number;          // 0-1
  inLoop: boolean;                // 是否检测到死循环
  strategyAdjustment?: 
    "continue" | "change_approach" | "simplify" | "abort";
  reasoning: string;
  newSubgoal?: string;
}
```

### 3. 实现方案

#### 3.1 LoopDetector 类（规则检测）

文件：`src/agent/loop-detection.ts`

用滑动窗口检测重复调用模式：
- 记录最近 N 次工具调用（工具名 + 参数哈希）
- 如果相同调用重复 3+ 次，判定死循环
- 返回 `{ inLoop: boolean, confidence: number }`

#### 3.2 ReflectiveAgent 类

文件：`src/agent/reflective-agent.ts`

核心逻辑：
1. 标准 ReAct 循环（Think → Act → Observe）
2. 每 N 轮调用 `reflect()` 方法
3. `reflect()` 构建执行轨迹摘要，调用 LLM 评估
4. 根据反思结果注入 SystemMessage 调整策略

**关键设计：**
- 反思间隔可配置（默认 3 轮）
- 反思使用独立 prompt，不与主循环混淆
- 降级：LLM 反思失败时，用 LoopDetector 规则兜底

---

## L11: 多 Agent 协作

### 1. 设计理念

基于已有的 `delegate_task` 工具扩展，增加角色分工：

```
Coordinator Agent (主协调者)
  │
  ├─ Researcher Worker (信息收集)
  ├─ Executor Worker (执行操作)
  ├─ Validator Worker (验证结果)
  └─ Specialist Worker (领域专家)
```

### 2. 核心类型定义

```typescript
export type WorkerRole = 
  "researcher" | "executor" | "validator" | "specialist";

export interface WorkerConfig {
  role: WorkerRole;
  systemPrompt: string;
  maxIterations: number;
  tools?: string[];  // 按角色限制可用工具
}

export interface WorkerResult {
  workerId: string;
  role: WorkerRole;
  status: "success" | "failed" | "timeout";
  result: string;
  durationMs: number;
}

export interface CoordinationPlan {
  workers: Array<{
    workerId: string;
    role: WorkerRole;
    task: string;
  }>;
  aggregationStrategy: "sequential" | "parallel" | "map_reduce";
}
```

### 3. 实现方案

#### 3.1 MultiAgentCoordinator 类

文件：`src/agent/multi-agent.ts`

核心流程：
1. **Plan**：调用 LLM 分析任务，决定需要哪些 Worker
2. **Dispatch**：根据策略（并行/顺序）启动 Worker
3. **Collect**：收集所有 Worker 的结果
4. **Aggregate**：调用 LLM 综合所有结果生成最终答案

**角色工具过滤策略：**
| 角色 | 可用工具 |
|------|---------|
| researcher | 只读：search, list, read |
| executor | 全部工具 |
| validator | 只读：read, search, list |
| specialist | 全部工具 |

**与现有 delegate_task 的关系：**
- `delegate_task` 是简化版（单一 Worker 类型）
- `MultiAgentCoordinator` 是全功能版（多角色、多策略）
- 两者可以共存，TUI 中让用户选择

---

## L12: Plan-and-Execute 模式

### 1. 设计理念

与 L9 双层循环的区别：
- L9：规划和执行交替进行，动态调整
- L12：先完整规划，再顺序执行，支持重规划

```
Phase 1: Planning
  LLM 一次性生成完整计划（3-10 步）

Phase 2: Execution
  for step in plan:
    1. 执行当前步骤
    2. 检查结果
    3. 如果失败 → 触发重规划（最多 N 次）
    4. 更新计划状态

Phase 3: Final Answer
  综合所有步骤结果生成最终答案
```

### 2. 核心类型定义

```typescript
export interface PlanStep {
  id: string;
  description: string;
  expectedTool?: string;
  expectedOutput?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  actualOutput?: string;
  retryCount?: number;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
  version: number;  // 每次重规划 +1
}
```

### 3. 实现方案

#### 3.1 PlanExecuteAgent 类

文件：`src/agent/plan-execute-agent.ts`

核心方法：
- `generatePlan()` - 一次性生成完整计划
- `executeStep()` - 执行单个步骤
- `replan()` - 步骤失败时调整剩余计划
- `generateFinalAnswer()` - 综合结果

**重规划策略：**
- 步骤失败时，将已完成/失败的步骤作为上下文
- 调用 LLM 生成新的剩余步骤
- 最多重规划 N 次（默认 3）
- 重规划失败则继续执行原计划

---

## 实现顺序建议

### 阶段 1: 基础设施（1-2 天）

1. 在 `src/agent/types.ts` 中新增所有类型定义
2. 实现 `LoopDetector` 类（L10 的组件）
3. 编写单元测试

### 阶段 2: L10 自我反思（2-3 天）

最简单，只修改现有循环，不新增 Agent 类型

1. 实现 `ReflectiveAgent`
2. 集成 `LoopDetector`
3. TUI 中添加反思结果显示
4. 测试反思频率和效果

### 阶段 3: L12 Plan-and-Execute（2-3 天）

1. 实现 `PlanExecuteAgent`
2. TUI 中添加计划进度显示
3. 测试重规划逻辑
4. 调优 planner prompt

### 阶段 4: L9 双层循环（3-4 天）

1. 实现 `HierarchicalAgent`
2. 测试规划层和执行层的协调
3. 优化层间通信
4. 端到端测试

### 阶段 5: L11 多 Agent 协作（3-4 天）

1. 实现 `MultiAgentCoordinator`
2. 定义各角色的 prompt
3. 测试并行/顺序执行
4. 测试结果汇总

### 阶段 6: 集成和重构（2-3 天）

1. 在 `src/agent/loop.ts` 中添加工厂函数
2. TUI 中添加模式选择（4 种 Agent 类型）
3. 更新 `CLAUDE.md` 文档
4. 全量端到端测试

---

## 关键注意事项

1. **向后兼容**：新 Agent 类型必须实现与 `CustomAgent` 相同的 `stream()` 接口
2. **Tracer 集成**：所有新 Agent 都要支持 Tracer 记录
3. **错误处理**：每个组件都要有降级策略，避免 JSON 解析失败导致崩溃
4. **性能权衡**：反思和重规划会增加 LLM 调用次数，需要在质量和成本间平衡
5. **可测试性**：每个组件应该可以独立测试，不依赖完整的 Agent 循环

---

> 文档版本: 1.0
> 生成时间: 2026-08-13
> 建议: 按阶段逐步实现，每阶段完成后进行代码 review
