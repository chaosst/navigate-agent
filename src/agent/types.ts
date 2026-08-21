import { AgentStep } from "@langchain/core/agents";
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { PtcStats } from "../ptc/types.js";

export interface AgentConfig {
  modelName: string;
  maxIterations: number;
  systemPrompt: string;
  verbose?: boolean;
}

export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolResult {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  success: boolean;
  durationMs: number;
}

export interface AgentEvents {
  onToolStart?: (tool: string, input: Record<string, unknown>) => void;
  onToolEnd?: (result: ToolResult) => void;
  onToken?: (token: string) => void;
  onFinish?: (output: string) => void;
  onError?: (error: Error) => void;
}


/** 计划步骤 */
export interface PlanStep {
  id: string
  description: string
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped"
  result?: string
  error?: string
}

/** 执行计划 */
export interface ExecutionPlan {
  goal: string
  steps: PlanStep[]
  currentStepIndex: number
  createdAt: number
  updatedAt: number
}

/** 规划层输出 */
export interface PlannerOutput {
  action: "create_plan" | "update_plan" | "execute_step" | "finalize"
  plan?: ExecutionPlan
  stepToExecute?: number
  finalAnswer?: string
  reasoning: string
}

const AgentStateValue = {
  // 消息链： 用 addMessages reducer自动追加，等价于LangChain addMessages
  // 比手写 concat 更正确 —— concat 跨节点会把整个数组重复一遍。
  // 也可只取单字段: messages: MessagesAnnotation.spec.messages
  ...MessagesAnnotation.spec,
  
  // 累积中间步骤（供流式适配器拼 intermediateSteps 块）
  intermediateSteps: Annotation<AgentStep[]>({
      reducer: (left, right) => left.concat(right),
      default: () => []
  })
}

const NormalStateValue = {
  // 当前迭代轮次（取代for循环的iteration计算）
  iteration: Annotation<number>({
    reducer: (a:number, b:number) => b,
    default: () => 0
  }),
  // 原始用户输入（供 ToolFilter 使用；tools/toolFilter 等用闭包捕获，不进 state）
  userInput: Annotation<string>({
      reducer: (a:string, b:string) => b,
      default: () => ""
  }),
}

export const AgentState = Annotation.Root({
  ...AgentStateValue,
  ...NormalStateValue
})

export const DualLoopState = Annotation.Root({
  ...AgentStateValue,
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
})

export type DualLoopStateType = typeof DualLoopState.State;


export const PtcState = Annotation.Root({
  ...AgentStateValue,
  ...NormalStateValue,
  // PTC 统计：run_code 调用次数 / 子调用总数 / 程序错误次数
  ptcStats: Annotation<PtcStats>({
    reducer: (_, b) => b,
    default: () => ({ runCodeCalls: 0, subCalls: 0, programErrors: 0, consecutiveErrors: 0 }),
  }),
})

export type PtcStateType = typeof PtcState.State;