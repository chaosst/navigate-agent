# PTC 模式（程序化工具调用）详细设计文档

> 版本：v1.0 ｜ 日期：2026-08-16 ｜ 状态：Draft
>
> 参考实现：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 PTC 模式（Programmatic Tool Calling / Code Mode）
>
> 适用范围：`src/agent/` 与 `src/tools/` 周边新增一套独立运行模式，与既有「普通模式」「plan 模式」共存

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [deepseek-harness PTC 模式调研](#2-deepseek-harness-ptc-模式调研)
3. [当前项目现状与差距分析](#3-当前项目现状与差距分析)
4. [总体架构设计](#4-总体架构设计)
5. [详细设计](#5-详细设计)
6. [集成方案](#6-集成方案)
7. [安全模型](#7-安全模型)
8. [边界情况与风险](#8-边界情况与风险)
9. [测试计划](#9-测试计划)
10. [实施里程碑](#10-实施里程碑)
11. [附录](#附录)

---

## 1. 背景与目标

### 1.1 当前问题

当前项目的「普通模式」（`GraphAgentExecutor`，LangGraph ReAct 循环）中，模型与工具的交互是**逐轮往返**的：

```
模型 ──(调用 tool_A)──▶ 系统 ──(返回结果_A)──▶ 模型 ──(调用 tool_B)──▶ ...
```

这种模式存在四个固有痛点（与 deepseek-harness Code Mode 设计动机一致）：

| 痛点 | 说明 |
|------|------|
| **Token 开销巨大** | 每一次工具调用产生的 `tool-result` 都完整回灌进模型上下文，无论模型是否需要 |
| **串行、无组合能力** | 每个工具调用需要一次完整模型往返；模型无法对结果集做循环、分支、扇出（fan-out）、后处理 |
| **模型能力错配** | 模型在训练中见过海量真实代码，但相对少见人工构造的工具调用轨迹——**写代码比逐个发工具调用更可靠** |
| **延迟高** | 步骤多、重复多、数据量大的任务（如遍历 8 个地区各采样 10 次）需要几十次往返 |

### 1.2 设计目标

借鉴 deepseek-harness 的 PTC（Programmatic Tool Calling，程序化工具调用）模式，让模型在需要时**编写一段 TypeScript 程序**，程序在受控运行时中**连续调用多个工具并处理中间结果**，最终只把选定的输出回灌上下文。

具体目标：

1. **减少模型↔工具往返**：多步、可并行的工具操作压缩进一次程序执行；
2. **降低 Token 消耗**：中间结果不进上下文，只有模型选择打印/返回的内容回灌；
3. **获得组合能力**：程序内可循环、分支、`Promise.all` 并行、后处理；
4. **与现有模式共存**：通过配置切换 `normal / plan / ptc` 三种模式，互不影响；
5. **可观测、可降级**：程序执行过程可被 TUI/日志/轨迹完整记录；运行时失败能反馈给模型自纠。

### 1.3 术语表

| 术语 | 含义 |
|------|------|
| PTC | Programmatic Tool Calling，程序化工具调用（deepseek-harness 中即 Code Mode） |
| `run_code` | PTC 模式中模型可见的**唯一传输工具**：`{ code: string; description: string }` |
| Code Mode SDK | 暴露给程序的工具编程接口（一个 `tools` 全局对象 + 类型声明） |
| 绑定（Binding） | 把每个原生工具包装为程序中可 `await` 的异步函数 |
| 分发桥（Dispatch Bridge） | 程序内工具调用 → 原生工具执行的调度层（并发控制、上下文注入） |
| 运行时（Code Runtime） | 执行模型程序的隔离运行时（本设计采用 Node `worker_threads`） |
| 子调用（Sub-call） | 程序内部的一次 `tools.x(...)` 调用 |

---

## 2. deepseek-harness PTC 模式调研

> 调研来源：GitHub 仓库 `deepseek-ai/deepseek-harness`（master 分支，v0.1.0-rc.5 阶段，MIT 协议），
> 核心文档：`packages/preset/agent-presets/README.zh.md`、`docs/subsystems/code-runtime.md`、
> `.agents/notes/implemented/feature/2026-06-15-code-mode.md`。

### 2.1 模式定位

deepseek-harness 提供四种 Agent 预设：**标准（standard）｜ PTC ｜ 极简（minimal）｜ 创造（creative）**。
它们不是四套独立 Agent，而是基于同一宿主、为会话装配**不同工具集 + 提示词 + 运行时能力**的预设组合。

PTC 模式的定位：**保留标准模式的全部能力，但把工具的呈现方式从「逐个 JSON-schema 工具」改为「一套 Code Mode SDK + 一个 `run_code` 传输工具」**。

官方对 PTC 的解释（摘自 README 相关报道）：

> PTC 会给模型一套 Code Mode SDK，让模型写一段 TypeScript 程序，在一次 `run_code` 里组合多个工具操作。
> 原来可能需要五次模型往返的读取、搜索、筛选、并行调用和结果整理，有机会被压进一次程序执行，
> 这会减少模型与工具之间来回对话的次数，更适合结构化、多步骤、可并行的操作，同时也更省 Token。

### 2.2 核心机制拆解

#### 2.2.1 展示模式开关（ToolRuntime 一等模式）

工具注册表通过 `mode` 配置选择工具的**呈现方式**：

```text
mode: 'native'  // 默认：原生逐个工具调用
mode: 'code'    // 仅暴露 run_code + SDK
mode: 'both'    // 两者共存（模型自行选择）
```

PTC preset 即 `standard` 的完整副本 + `mode: 'code'`（或 `both`）的运行时装配。

#### 2.2.2 `run_code` 传输工具

模型可见的唯一入口，参数仅两个，**不进入可过滤的能力层**（防止权限策略误删 PTC 唯一入口）：

```typescript
interface RunCodeArgs {
  code: string;         // TypeScript 程序源码（async 函数体）
  description: string;  // 供 UI/日志标注这次调用的意图（bash 先例）
}
```

#### 2.2.3 Code Mode SDK 与提示段（`tools:sdk`）

在 `code` / `both` 模式下，系统提示词中惰性注入一段 SDK 说明（`tools:sdk`），其契约（TypeScript 风格）：

```text
写一个 async 主体；通过 await tools.name(args) 调用工具；按需捕获被拒绝的工具调用；
只返回或记录应回灌上下文的输出。
- 只读、独立的调用可在 Promise.all 下重叠
- 变更类调用串行执行，按提交顺序
- 依赖工作用 await 序列化
- 仅可擦除 TypeScript（禁 enum / namespace）
```

同时用 `jsonSchemaToTs()` 把每个工具的 JSON-Schema 映射为 TypeScript 类型（描述进入 JSDoc），
工具暴露为**引号对象键** `tools["my-tool"](…)` —— 支持任意工具名，零别名/碰撞逻辑。类型是咨询性的，运行时执行前剥离。

#### 2.2.4 绑定与分发桥（Dispatch Bridge）

`run_code` 执行时：

1. 为每个可见工具构建绑定：参数做**无损 JSON 快照** → 进入**并发分发池**；
2. 以确定性调用 ID 执行，外层 token 作为 parent；记录 `tool/code-dispatch-start` / `tool/code-dispatch` 事件对；
3. 成功返回工具的最终规范化 JSON 值；失败成为程序可见的 `ToolCallError`（带 `toolName` 成员属性）；
4. 并发有界：严格按提交顺序启动，连续并行类调用最多重叠 `maxParallelSubCalls` 个（默认 10，`1` 恢复串行）；排他调用（如 bash）排空池子单独运行；结算时放弃未启动的排队调用。

#### 2.2.5 代码运行时（code-runtime seam）

- **能力接缝**：`CodeRuntime` 服务只定义 `run(request)`，对工具一无所知；`language`（`typescript`/`python`）与 `isolation`（`worker-thread`/`process`/`container`）为只读描述符；
- **参考实现**：每次运行一个**全新 Node Worker 线程**（`env: {}` 真空环境、`resourceLimits` 来自配置、`stdout`/`stderr` 捕获进 logs、**无池化无跨运行状态**）；
- **类型剥离**：用 Node 内置 `stripTypeScriptTypes`（`node:module`）位置保留剥离，运行时错误行号与模型源码一致；仅剥离模式拒绝不可擦除语法（`enum`/`namespace`）→ 以 `exception` 失败返回；
- **端口协议假设敌对对端**：worker 内每个绑定函数 post `{ id, global, name, args }` 并等待回复；主机校验名称、调用、回复；`__proto__`/`constructor` 均为普通自有属性（空原型构造）；
- **失败分类（正交）**：`exception`（程序抛错/解析失败）｜ `timeout`（预算到期）｜ `abort`（信号中止）｜ `worker-exit`（执行基质死亡，如 OOM）｜ `invalid-output`（返回值非无损 JSON）｜ `output-limit`（输出超上限）；
- **独立预算**：`computeMs`（计量 worker 忙时，允许慢 await 但不纵容热循环）｜ `maxWallMs`（总墙钟上限）｜ `maxOutputBytes`（仅组合序列化的外层日志+返回值；中间绑定值无字节上限）；
- **信任态势**：worker 提供**遏制（containment）而非安全边界**——模型代码可达 Node API，权威度与 bash 相当；需要硬多租户时上容器级后端。

#### 2.2.6 上下文延迟注入（deferContext）

子调用产生的上下文不直接注入模型（会破坏父调用/结果相邻性），而是按分发顺序收集每个子结果的
`additionalContexts` 条目，在 `run_code` 结果之后、循环内每个兄弟结果之后才追加——
程序执行中产生的中间文件、工作区发现等，以**延迟且有序**的方式进入历史。

### 2.3 对我们项目的可借鉴点与裁剪点

| dsh 机制 | 本项目借鉴 | 裁剪/简化 |
|----------|-----------|-----------|
| 插件化 preset 装配 | ❌ 不引入 Cordis 插件体系 | 用配置开关 `AGENT_MODE` 选择，工厂函数创建 |
| Code Mode SDK + `tools:sdk` | ✅ 完整采用 | 提示词静态模板 + 运行时生成类型声明 |
| `run_code` 传输工具 | ✅ 完整采用 | 增加代码长度/时长预算校验 |
| worker 线程运行时 | ✅ 采用 `worker_threads` | 简化：`maxWallMs` + 输出上限为主，computeMs 可选 |
| 分发桥 + 并发池 | ✅ 采用 | 复用项目现有 `ToolFilter`/`PermissionWrapper`/`ToolStatsRegistry` |
| `deferContext` 延迟注入 | ✅ 采用 | 简化为「run_code 结果后统一按序追加」 |
| 失败分类 | ✅ 采用六类 | 增加「连续失败 → 降级提示」策略 |
| 能力接缝抽象 | ⚠️ 部分 | 定义 `CodeRuntime` 接口，先实现 worker 后端 |

---

## 3. 当前项目现状与差距分析

### 3.1 现有架构快照

```
src/
├── index.ts                 # TUI 入口：createAgentExecutor(...) → render(<App/>)
├── server-entry.ts          # Web server 入口（同构装配）
├── config/index.ts          # 环境变量配置（无模式开关）
├── agent/
│   ├── types.ts             # AgentConfig / AgentMessage / AgentState / DualLoopState
│   ├── loop.ts              # 工厂层：createAgentExecutor() / createHierarchicalAgent() / runAgent()
│   ├── graph-agent-executor.ts   # 普通模式：LangGraph ReAct（agent→tools→finalize/fallback）
│   ├── hierarchical-agent-langgraph.ts  # plan 模式：LangGraph 双层循环（planner→executor）
│   ├── langchain.ts         # createChatModel()
│   ├── prompt.ts            # buildSystemPrompt()
│   ├── tracer.ts            # 结构化轨迹（LLM/工具/token/耗时）
│   └── logger.ts            # logAgent() 文件日志
├── tools/
│   ├── registry.ts          # createTools(): 6 个内置工具
│   ├── shell.ts / filesystem.ts / search.ts
│   ├── permission.ts        # PermissionWrapper
│   ├── tool-filter.ts       # ToolFilter（动态权限过滤）
│   └── stats-registry.ts    # ToolStatsRegistry（调用统计）
├── memory/ rag/ resume/ skills/ storage/ tui/ server/
```

三种模式对比：

| 维度 | 普通模式 | plan 模式 | PTC 模式（新增） |
|------|---------|-----------|------------------|
| 图结构 | `agent→tools→agent...→finalize` | `planner→executor→planner...→finalize` | `agent→run_code→agent...→finalize` |
| 工具呈现 | 原生逐个调用 | 执行层原生逐个调用 | `run_code` 程序内批量调用 |
| 状态类型 | `AgentState` | `DualLoopState` | `PtcState`（新增） |
| 生产入口 | ✅ `index.ts`/`server-entry.ts` | ❌ 仅 `src/test.ts` 实验调用 | 待接入 |
| TUI 支持 | ✅ | ❌（`{plan}` 块未处理） | 待开发 |

### 3.2 差距清单（PTC 落地需要补的）

| # | 差距 | 说明 |
|---|------|------|
| G1 | **无模式开关配置** | `src/config/index.ts` 需新增 `AGENT_MODE` 与 `PTC_*` 系列配置 |
| G2 | **无 Code Mode SDK 生成器** | 需将 `StructuredTool` 的 JSON-Schema 转 TS 类型声明 + 提示段 |
| G3 | **无 `run_code` 工具** | 新增 `RunCodeTool`（继承 `StructuredTool`） |
| G4 | **无代码运行时** | 需实现 worker 线程沙箱（`CodeRuntime` 接口 + worker 后端） |
| G5 | **无分发桥** | 程序内 `tools.x()` → 原生工具执行的调度层 |
| G6 | **无 PTC 状态机** | 新增 `PtcAgentLangGraph`（或复用 `GraphAgentExecutor` 扩展） |
| G7 | **TUI 不识别新事件** | `app.tsx` 需处理 `run_code` 程序展示与子调用事件 |
| G8 | **无失败降级策略** | `run_code` 连续失败时如何反馈/降级 |

---

## 4. 总体架构设计

### 4.1 架构定位

PTC 模式作为**第三种执行模式**接入现有工厂层，与普通模式、plan 模式并列：

```
                     ┌─────────────────────────────────────────────┐
                     │            src/agent/loop.ts（工厂层）       │
                     │  createAgentExecutor()    normal → GraphAgentExecutor
                     │  createHierarchicalAgent() plan   → HierarchicalAgentLangGraph
                     │  createPtcAgent()         ptc    → PtcAgentLangGraph   ★ 新增
                     └─────────────────────────────────────────────┘
                                       │ AGENT_MODE
              ┌────────────────────────┼───────────────────────────┐
              ▼                        ▼                           ▼
   GraphAgentExecutor      HierarchicalAgentLangGraph    PtcAgentLangGraph ★
   （ReAct，原生工具）        （双层循环，原生工具）         （外层 ReAct + 内层程序执行）
```

### 4.2 新增模块划分

```
src/ptc/                          # PTC 模式独立目录（与 agent/ 平级，便于整体开关）
├── types.ts                      # PtcState / CodeRunRequest / CodeRunResult / CodeRunFailure / CodeBinding* 
├── prompts.ts                    # PTC_SYSTEM_PROMPT + 动态 SDK 提示段生成
├── sdk-generator.ts              # jsonSchemaToTs()：工具 JSON-Schema → TS 类型声明
├── run-code-tool.ts              # RunCodeTool（StructuredTool，name="run_code"）
├── code-runtime.ts               # CodeRuntime 抽象接口（能力接缝）
├── code-runtime-worker.ts        # WorkerThreadCodeRuntime（worker_threads 后端实现）
├── dispatch-bridge.ts            # DispatchBridge：绑定构建 + 并发池 + 事件 + deferContext
└── ptc-agent-langgraph.ts        # PtcAgentLangGraph：LangGraph 状态机
```

复用现有模块：`ToolNode`（或 `executeStep` 的 `toolMap` 并发模式）、`ToolFilter`、`PermissionWrapper`、
`ToolStatsRegistry`、`Tracer`、`logAgent`、`createChatModel`。

### 4.3 运行时数据流（一次完整 PTC 回合）

```
模型 ──(run_code {code, description})──▶ RunCodeTool
                                             │
                                  DispatchBridge.buildBindings()
                                  ├─ 每个工具 → tools[name] = async (args) => ToolCallError|json
                                  ├─ 空 env、资源限制、AbortSignal
                                  ▼
                              WorkerThreadCodeRuntime.run({
                                  program, bindings, signal
                              })
                                  │  worker 线程：类型剥离 → AsyncFunction → 执行
                                  │  program: const files = await tools.list_files(...)
                                  │           const r = await tools.read_file(...)
                                  │           return { summary }
                                  ├─ stdout/stderr → logs[]
                                  ├─ 子调用 → postMessage → 主线程分发池 → 原生工具
                                  │             ← postMessage ← ToolCallError|value
                                  ▼
                              CodeRunResult { value?, logs[], error? }
                                  │
                              run_code 工具输出（日志+完成值 或 失败信息）
                                  │
                              └─▶ 回灌模型上下文（+ 延迟注入的子调用上下文）
```

---

## 5. 详细设计

### 5.1 配置层（G1）

在 `src/config/index.ts` 的 `AppConfig` 中新增：

```typescript
export type AgentMode = "normal" | "plan" | "ptc";

// 新增字段
agentMode: AgentMode;                 // AGENT_MODE，默认 "normal"
ptcMaxProgramLength: number;          // PTC_MAX_PROGRAM_LENGTH，默认 16_384（字符）
ptcMaxWallMs: number;                 // PTC_MAX_WALL_MS，默认 60_000
ptcMaxComputeMs: number;              // PTC_MAX_COMPUTE_MS，默认 30_000（可选）
ptcMaxOutputBytes: number;            // PTC_MAX_OUTPUT_BYTES，默认 64_1024（64KB）
ptcMaxParallelSubCalls: number;       // PTC_MAX_PARALLEL_SUBCALLS，默认 10；1 恢复串行
ptcMode: "code" | "both";             // PTC_TOOL_MODE，默认 "code"（PTC 内是否同时保留原生工具）
```

其中 PTC 相关字段聚合为独立的 `PtcConfig` 接口（供 `createPtcAgent()` 消费，见 6.1）：

```typescript
/** PTC 运行时配置：从 AppConfig 的 PTC_* 字段聚合，由工厂函数注入 */
export interface PtcConfig {
  maxProgramLength: number;        // 代码长度上限（字符）
  maxWallMs: number;               // 单次 run_code 墙钟上限（ms）
  maxComputeMs: number;            // 计算时间上限（ms，可选计量）
  maxOutputBytes: number;          // 外层日志+返回值序列化上限（字节）
  maxParallelSubCalls: number;     // 程序内并发子调用上限；1 恢复串行
  mode: "code" | "both";           // 工具呈现模式
}
```

`.env.example` 示例：

```bash
# 执行模式：normal | plan | ptc
AGENT_MODE=normal

# PTC 模式预算
PTC_MAX_PROGRAM_LENGTH=16384
PTC_MAX_WALL_MS=60000
PTC_MAX_COMPUTE_MS=30000
PTC_MAX_OUTPUT_BYTES=65536
PTC_MAX_PARALLEL_SUBCALLS=10
PTC_TOOL_MODE=code
```

### 5.2 类型定义（G6）

新增 `src/ptc/types.ts`（与 `src/agent/types.ts` 风格一致）：

```typescript
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { AgentStep } from "@langchain/core/agents";

/** 无损 JSON（跨运行时边界的合法值） */
export type CodeJsonValue =
  | null | boolean | number | string
  | CodeJsonValue[]
  | { [key: string]: CodeJsonValue };

/** 一次程序运行请求 —— 请求携带运行时作用的一切，无隐藏默认值 */
export interface CodeRunRequest {
  /** 程序源码（async 函数体，顶层 await/return 可用，return 值成为 value） */
  program: string;
  /** 暴露给程序的宿主函数命名空间（PTC 传一个：tools） */
  bindings: CodeBindingNamespace[];
  /** 中止信号：中止后以 failure.kind='abort' 结算 */
  signal?: AbortSignal;
}

/** 程序运行结果 —— 错误是结果上的字段，不是 run() 的异常路径 */
export interface CodeRunResult {
  /** 程序顶层 return 值（跨过无损 JSON 边界）；失败或无返回时缺省 */
  value?: CodeJsonValue;
  /** 程序按序输出的文本 */
  logs: string[];
  /** 存在即失败，见 CodeRunFailure 分类 */
  error?: CodeRunFailure;
}

/** 失败分类（正交：超时≠异常≠中止≠基质死亡） */
export interface CodeRunFailure {
  kind:
    | "exception"      // 程序抛错 / 类型剥离失败 / 语法不可擦除
    | "timeout"        // 预算到期（computeMs / maxWallMs）
    | "abort"          // signal 触发
    | "worker-exit"    // worker 线程死亡（如 OOM）
    | "invalid-output" // 返回值非无损 JSON
    | "output-limit";  // 序列化外层日志/值/诊断超上限
  message: string;     // 人类可读，适合回喂模型自纠
}

/** 暴露为程序全局对象的命名空间（如 tools） */
export interface CodeBindingNamespace {
  /** 程序可见的全局标识，必须满足 [A-Za-z_][A-Za-z0-9_]* 且非保留字 */
  global: string;
  /** 可调用成员，键为程序实际调用的名字 */
  functions: Record<string, CodeBindingFunction>;
  /** 可选：程序可见的带类型拒绝错误类 */
  errorClass?: CodeBindingErrorClass;
}

export type CodeBindingFunction = (args: unknown) => Promise<CodeJsonValue>;

/** 程序可见的带类型拒绝错误（如 ToolCallError，成员属性 toolName） */
export interface CodeBindingErrorClass {
  name: string;              // 构造器全局名 & Error.name
  memberNameProperty: string; // 承载成员名的自有属性名（如 "toolName"）
}

/** 运行时抽象接口（能力接缝）：run() 只对调用方误用拒绝，失败一律是结果字段 */
export interface CodeRuntime {
  readonly language: "typescript" | "python";   // 本设计实现 typescript
  readonly isolation: "worker-thread" | "process" | "container";
  run(request: CodeRunRequest): Promise<CodeRunResult>;
  dispose(): Promise<void>;
}
```

新增 `PtcState`（`src/ptc/types.ts` 或 `src/agent/types.ts`）：

```typescript
/** PTC 模式运行统计：驱动状态机路由与可观测性 */
export interface PtcStats {
  /** run_code 外层调用次数 */
  runCodeCalls: number;
  /** 程序内工具子调用总数（跨所有 run_code 累积） */
  subCalls: number;
  /** 程序执行失败次数（六类 CodeRunFailure 任一） */
  programErrors: number;
  /** 连续失败次数；>= 3 时状态机路由至 fallback（见 5.9） */
  consecutiveErrors: number;
}

export const PtcState = Annotation.Root({
  ...MessagesAnnotation.spec,
  iteration: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  userInput: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  // 外层累积中间步骤（与普通模式一致的流式适配）
  intermediateSteps: Annotation<AgentStep[]>({
    reducer: (l, r) => l.concat(r), default: () => [],
  }),
  // PTC 统计：run_code 调用次数 / 子调用总数 / 程序错误次数
  ptcStats: Annotation<PtcStats>({
    reducer: (_, b) => b,
    default: () => ({ runCodeCalls: 0, subCalls: 0, programErrors: 0, consecutiveErrors: 0 }),
  }),
});
```

**统一流式块契约**（三种模式共用 `stream()` 返回类型，供 TUI/`runAgent` 解构）：

```typescript
/** stream() 产出的统一流式块（三模式并集；各模式只产出与自己相关的字段） */
export interface AgentStreamChunk {
  output?: string;                    // token 流 / 最终答案（三种模式）
  intermediateSteps?: AgentStep[];    // 外层工具调用步骤（普通 / PTC）
  plan?: ExecutionPlan;               // 计划更新（仅 plan 模式）
  ptcProgram?: { code: string; description: string };   // 模型发起 run_code（仅 PTC）
  ptcDispatch?: PtcDispatchEvent;     // 程序内子调用事件（仅 PTC）
  ptcStats?: PtcStats;                // 执行统计（仅 PTC）
}
```

### 5.3 Code Mode SDK 生成器（G2）

新增 `src/ptc/sdk-generator.ts`。将 `StructuredToolInterface[]` 渲染为一段 TypeScript 类型声明，
供 `PTC_SYSTEM_PROMPT` 注入（对标 dsh 的 `jsonSchemaToTs()`）。

```typescript
/**
 * 工具 → TS 类型声明
 * - JSON Schema 的 type/description/enum/required 映射为 TS 类型 + JSDoc
 * - 工具暴露为引号对象键 tools["my-tool"](…)：支持任意工具名，零别名/碰撞逻辑
 * - 不支持的 schema 构造退化为 unknown
 * - 输出是咨询性的：运行时执行前剥离类型
 */
export function jsonSchemaToTs(tools: StructuredToolInterface[]): string {
  return tools
    .map((t) => {
      const schema = t.schema; // zod 或 JSON Schema
      const params = zodToTs(schema); // 递归映射
      return `/**
 * ${t.description ?? ""}
 */
type ${t.name}_args = ${params};

// @ts-ignore 未定义工具引用
declare const tools: {
  [key: string]: (args: never) => Promise<unknown>;
} & {
  ${tools.map((t2) => `"${t2.name}"(args: ${t2.name}_args): Promise<unknown>`).join(";\n  ")}
};`;
    })
    .join("\n\n");
}
```

`zodToTs()` 是上面的递归辅助函数——把 zod schema（或普通 JSON Schema）映射为 TS 类型字符串。
项目工具 schema 均来自 zod（`StructuredTool.schema`），故以 zod 判定为主，未识别构造退化为 `unknown`（与 dsh 一致）：

```typescript
import { z } from "zod";

/**
 * 将 zod schema 递归映射为 TS 类型字符串。
 * - 覆盖常见构造：string / number / boolean / enum / literal / array / object / record / tuple / union
 * - 对 optional / nullable / default / effects 等 wrapper 递归取其 innerType
 * - 不支持的构造退化为 unknown
 */
function zodToTs(schema: unknown): string {
  if (!schema) return "unknown";

  // wrapper 类型：剥壳后递归
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodEffects ||
    schema instanceof z.ZodBranded ||
    schema instanceof z.ZodCatch
  ) {
    const inner = (schema as z.ZodTypeAny)._def?.innerType;
    return inner ? zodToTs(inner) : "unknown";
  }

  // 基础标量
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodBigInt) return "bigint";

  // 字面量与枚举
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  if (schema instanceof z.ZodEnum) {
    return schema.options.map((o) => JSON.stringify(o)).join(" | ");
  }
  if (schema instanceof z.ZodNativeEnum) {
    return Object.values(schema.enum as Record<string, unknown>)
      .map((v) => JSON.stringify(v))
      .join(" | ");
  }

  // 容器
  if (schema instanceof z.ZodArray) return `${zodToTs(schema.element)}[]`;
  if (schema instanceof z.ZodTuple) {
    return `[${schema.items.map((i) => zodToTs(i)).join(", ")}]`;
  }
  if (schema instanceof z.ZodRecord) {
    return `Record<string, ${zodToTs(schema.valueType)}>`;
  }
  if (schema instanceof z.ZodObject) {
    const entries = Object.entries(schema.shape).map(([k, v]) => {
      const isOptional =
        v instanceof z.ZodOptional || v instanceof z.ZodNullable;
      return `${k}${isOptional ? "?" : ""}: ${zodToTs(v)}`;
    });
    return `{ ${entries.join("; ")} }`;
  }
  if (schema instanceof z.ZodUnion) {
    return schema.options.map((o) => zodToTs(o)).join(" | ");
  }
  if (schema instanceof z.ZodIntersection) {
    return `(${zodToTs(schema._def.left)} & ${zodToTs(schema._def.right)})`;
  }

  return "unknown";
}
```

**SDK 使用契约**（写入 `PTC_SYSTEM_PROMPT`，对标 dsh `tools:sdk`）：

```text
你处于 PTC（程序化工具调用）模式。你可以编写 TypeScript 程序，通过 run_code 工具一次执行多步工具操作。

编写规则：
1. 程序体是 async 函数体：支持顶层 await 与 return；return 值会成为工具结果的一部分。
2. 通过 await tools["工具名"](args) 调用工具；args 必须与工具 schema 匹配（见下方类型声明）。
3. 只读、相互独立的调用可以用 Promise.all([...]) 重叠执行；
4. 变更类调用（写文件、执行命令）必须串行，按提交顺序；
5. 有依赖关系的调用用 await 序列化；
6. 工具调用失败会抛出 ToolCallError（含 toolName 与 message 属性），请 try/catch 捕获并自行处理；
7. 只把需要回灌上下文的摘要、结果 return 出来，不要在程序里打印大段内容；
8. 仅使用可擦除 TypeScript：禁止 enum、namespace、类型断言以外的非擦除语法；
9. 程序运行有墙钟与输出大小上限，超出会以 error 返回，请根据 error.kind 自纠。
```

`buildPtcSystemPrompt()` 把上述契约与生成的类型声明拼成最终系统提示（5.7 构造函数调用一次，
前缀稳定利于 KV 缓存）：

```typescript
// src/ptc/prompts.ts
import { jsonSchemaToTs } from "./sdk-generator.js";

/** PTC_SYSTEM_PROMPT + SDK 类型声明 → 完整系统提示 */
export function buildPtcSystemPrompt(sdkTools: StructuredToolInterface[]): string {
  return `${PTC_SYSTEM_PROMPT}

以下为程序内可用工具的类型声明（ts-ignore 仅为提示用，运行时执行前剥离类型）：
\`\`\`typescript
${jsonSchemaToTs(sdkTools)}
\`\`\``;
}
```

### 5.4 `run_code` 传输工具（G3）

新增 `src/ptc/run-code-tool.ts`：

```typescript
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { DispatchBridge } from "./dispatch-bridge.js";
import type { CodeRuntime } from "./code-runtime.js";

export class RunCodeTool extends StructuredTool {
  name = "run_code";
  description =
    "编写并执行一段 TypeScript 程序，在单次调用内组合多个工具操作（读取、搜索、循环、并行、汇总）。" +
    "适合多步骤、可并行、需要循环/分支处理中间结果的任务。程序体是 async 函数，用 await tools[\"工具名\"](args) 调用工具。" +
    "只 return 或 console.log 需要回灌上下文的摘要。";

  schema: z.ZodObject<{
    code: z.ZodString;
    description: z.ZodString;
  }>;

  private dispatch: DispatchBridge;
  private runtime: CodeRuntime;

  constructor(config: {
    dispatch: DispatchBridge;
    runtime: CodeRuntime;
    maxProgramLength: number;
  }) {
    super();
    this.dispatch = config.dispatch;
    this.runtime = config.runtime;
    // 预算在构造函数内注入 schema（类字段初始化时 this 不可用）
    this.schema = z.object({
      code: z
        .string()
        .describe("TypeScript 程序源码（async 函数体，顶层 await/return 可用）")
        .max(config.maxProgramLength),
      description: z
        .string()
        .describe("本次程序调用的意图说明，用于日志与界面展示"),
    });
  }

  async _call(args: { code: string; description: string }): Promise<string> {
    // 1. 构建绑定（见 5.6）：每个可见工具 → tools[name]，经 ToolFilter 过滤
    // 2. 构建运行信号：跟随外层取消；运行结束即中止
    // 3. runtime.run({ program, bindings, signal })
    // 4. 结算：中止未完成子调用、排空分发队列
    // 5. 成功 → `${logs.join("\n")}\n${JSON.stringify(value)}`
    //    失败 → `[run_code ${error.kind}] ${error.message}`（回喂模型自纠）
    throw new Error("Not implemented");
  }
}
```

### 5.5 沙箱运行时：`WorkerThreadCodeRuntime`（G4）

> ✅ 已实现：`src/ptc/code-runtime-worker.ts` + `code-runtime-worker-bootstrap.ts`，
> 配套测试 `src/ptc/code-runtime-worker.test.ts`（12 用例，vitest 全绿；`tsc --noEmit` 通过）。

新增 `src/ptc/code-runtime-worker.ts`，对标 dsh `@deepseek-ai/dsh-code-runtime-worker-thread`。

**主线程侧（`run()`）**：

```typescript
export class WorkerThreadCodeRuntime implements CodeRuntime {
  readonly language = "typescript" as const;
  readonly isolation = "worker-thread" as const;

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    // 1. 类型剥离（主线程预检）：stripTypeScriptTypes(wrapped, { mode: "strip" })
    //    - wrapped = `async () => {\n${program}\n}`：程序体是 async 函数体（顶层 return 合法），
    //      但剥离器按模块级解析顶层 return 会报错，须先包一层箭头函数、剥离后再
    //      unwrapFunctionBody() 解包出函数体（行号保持，函数体从 program 第 1 行开始）
    //    - 仅剥离模式；enum/namespace 等不可擦除语法 → 直接返回
    //      { error: { kind: "exception", message } }（不创建 worker）
    //    - 语法级失败从不生成 worker（对标 dsh）
    // 2. 启动全新 Worker(workerBootstrap.js)：
    //    env: {}（真空环境）, resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb }
    // 3. 建立 MessageChannel，worker 内绑定调用走端口协议（见下）
    // 4. 预算控制：
    //    - maxWallMs → setTimeout 强制 worker.terminate() → { kind: "timeout" }
    //    - 输出字节计数：累积 logs + 完成值序列化，超限 → { kind: "output-limit" }
    //    - computeMs（可选增强）：主线程定时器采样 worker 忙状态
    // 5. 结算：终止 worker（await 其 exit），返回 CodeRunResult
  }

  async dispose(): Promise<void> {
    // 终止所有在飞 worker，等待退出
  }
}
```

**Worker 侧（`worker-bootstrap.js`）**：

```typescript
import { parentPort, workerData } from "node:worker_threads";

// 1. 接收 { program }：主线程剥离后的 async 函数体（worker 不再二次剥离）
// 2. 构造 AsyncFunction("tools", "ToolCallError", "console", program)
//    - tools：空原型对象（Object.create(null)），defineProperty 挂载每个绑定函数
//      → __proto__/constructor/toString 均为普通自有属性
//    - ToolCallError：运行时注入真实构造函数（不硬编码工具名）
//    - console：shim 捕获 log/warn/error → 数组（跨边界传回）
// 4. 绑定函数实现：
//    parentPort.postMessage({ id, global, name, args });  // 等待主线程回复
//    const reply = await waitReply(id);                    // 按 id 匹配
//    if (!reply.ok) throw new ToolCallError(name, reply.message);
//    return reply.value;                                   // 无损 JSON
// 5. 执行 program，顶层 return 值 → postMessage({ type: "done", value })
//    顶层抛错 → postMessage({ type: "error", message })
```

**端口协议（假设对端敌对）**：

```text
worker → host:  { type: "call",  id, global, name, args }   // args 为无损 JSON
host  → worker: { type: "reply", id, ok: true,  value }
                 { type: "reply", id, ok: false, message }
worker → host:  { type: "done",  value? } | { type: "error", message }
```

主线程校验：`name` 必须在请求的绑定内；未知 `id`、重复 `id`、结算后消息一律拒绝/忽略。

### 5.6 分发桥 `DispatchBridge`（G5）

新增 `src/ptc/dispatch-bridge.ts`，负责「绑定构建 + 并发调度 + 事件 + 延迟上下文」。

```typescript
/** 队列中的一个子调用 */
interface QueuedCall {
  tool: StructuredToolInterface;
  args: unknown;
  resolve: (v: CodeJsonValue) => void;
  reject: (e: unknown) => void;
}

export class DispatchBridge {
  private queue: QueuedCall[] = [];   // 待分发队列（严格按提交顺序启动）
  private inFlight = 0;               // 当前在飞子调用数
  private maxParallelSubCalls: number;

  constructor(
    private tools: StructuredToolInterface[],   // 全量工具
    private toolFilter?: ToolFilter,            // 动态权限过滤（复用现有）
    private stats?: ToolStatsRegistry,          // 调用统计（复用现有）
    maxParallelSubCalls = 10,                  // 默认 10；1 恢复串行
  ) {
    this.maxParallelSubCalls = maxParallelSubCalls;
  }

  /** 只读暴露全量工具，供 buildPtcSystemPrompt() 生成 SDK 类型声明（见 5.3 / 5.7） */
  get sdkTools(): StructuredToolInterface[] {
    return this.tools;   // 即构造参数注入的全量工具
  }

  /** 构建程序可见的 bindings（工具名 → async 函数） */
  buildBindings(userInput: string): CodeBindingNamespace {
    const functions: Record<string, CodeBindingFunction> = {};
    const activeTools = this.toolFilter
      ? this.toolFilter.filter(this.tools as PermissionWrapper[], userInput)
      : this.tools;

    for (const tool of activeTools) {
      functions[tool.name] = async (args: unknown): Promise<CodeJsonValue> => {
        // 进入分发队列（严格按提交顺序启动）
        return this.enqueue(tool, args);
      };
    }
    return {
      global: "tools",
      functions,
      errorClass: { name: "ToolCallError", memberNameProperty: "toolName" },
    };
  }

  /** 并发有界调度 */
  private async enqueue(tool, args): Promise<CodeJsonValue> {
    return new Promise((resolve, reject) => {
      this.queue.push({ tool, args, resolve, reject });
      this.pump(); // 满足条件即出队
    });
  }

  private async pump() {
    // 并发池模型（对标 dsh）：
    // - 并发槽：maxParallelSubCalls（默认 10）
    // - 排他工具（isConcurrencySafe=false，如 shell）→ 排空池子，单独执行
    // - 并行类工具 → 最多重叠 maxParallelSubCalls 个
    // - 每个子调用：确定性 id、记录 tool/code-dispatch-start → 执行 → tool/code-dispatch
  }

  /** 结算：中止未启动的排队调用，等待在飞调用 */
  async drain(abort: AbortSignal): Promise<void> { ... }
}
```

**子调用执行的要点**（复用现有工具基础设施）：

```typescript
private async invokeTool(tool, args): Promise<CodeJsonValue> {
  // 1. 无损 JSON 快照参数（非 JSON 值 → 报 invalid 错误）
  // 2. 归一化输入（对标 loop.ts normalizeToolInput：string → JSON.parse）
  // 3. 调用工具：tool.invoke(normalizedArgs)
  //    包装 PermissionWrapper 提示（若工具需要权限确认）
  // 4. 结果 → JSON.stringify 无损化（undefined → null；BigInt/函数 → 报错）
  // 5. 事件：stats?.record(...)、tracer、logAgent
  // 6. 成功 → 规范化 JSON；失败 → 构造 ToolCallError 让程序可捕获
}
```

**延迟上下文注入（deferContext 简化版）**：

```typescript
/** 收集每个子调用的额外上下文（如执行后的文件路径），
 *  在 run_code 外层结果之后、按分发顺序统一追加进会话消息 */
export interface DeferredContext {
  order: number;          // 分发顺序
  content: string;        // 文本块
}
```

**子调用事件订阅**（`stream()` 消费，见 5.7）：每次 `run_code` 期间，分发桥把每个子调用
作为一条事件广播出去；`PtcAgentLangGraph.stream()` 订阅后转发为 `{ ptcDispatch }` 流式块。

```typescript
/** 一次程序内子调用事件（对应 dsh 的 tool/code-dispatch） */
export interface PtcDispatchEvent {
  parentId: string;    // 所属 run_code 调用的确定性 id
  tool: string;        // 子调用工具名
  input: unknown;      // 规范化参数（无损 JSON 快照）
  output: unknown;     // 规范化结果
  isError: boolean;    // 工具执行失败（程序收到 ToolCallError）
}

type DispatchListener = (ev: PtcDispatchEvent) => void;

// 在 DispatchBridge 类中新增（成员片段，类声明见上）：
  private listeners = new Set<DispatchListener>();

  /** 订阅子调用事件；返回取消函数 */
  onDispatch(listener: DispatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: PtcDispatchEvent): void {
    for (const l of this.listeners) l(ev);
  }
  // ...enqueue/pump/drain 中在子调用 start/settle 时调用 this.emit(...)
```

对外层 `stream()` 的契约：`run_code` 结算后，其子调用产生的 `DeferredContext[]`
按 `order` 追加为 `SystemMessage`，再进入下一次外层模型调用（保持父子相邻性）；
`PtcDispatchEvent[]` 则作为流式块实时转发给 TUI，**不进模型历史**。

### 5.7 PTC 状态机 `PtcAgentLangGraph`（G6）

新增 `src/ptc/ptc-agent-langgraph.ts`。**外层循环与普通模式完全一致**（ReAct：
模型产出 `run_code` 调用 → 执行 → 回灌 → 模型继续），只是模型可见工具集里只有 `run_code`（`mode: "code"`）
或 `run_code + 原生工具`（`mode: "both"`）。

> **两套工具集，务必区分**：
> - **模型可见工具集**（`visibleTools`，下图 `bindTools`/`ToolNode` 消费）：`mode="code"` 时只有
>   `[runCodeTool]`——模型只能调 `run_code`，**不会直接调原生工具**；
> - **分发桥工具集**（`DispatchBridge` 持有，见 5.6）：全量原生工具，供**程序内** `tools["x"](args)` 调用。
>   全量工具由工厂注入 `DispatchBridge`（6.1），**不进图**。
> 一句话：模型 ↔ 图的边界只有 `run_code`；工具真正执行发生在 `run_code` 内部的程序里。

```typescript
export class PtcAgentLangGraph {
  private llm: ChatOpenAI;
  /** 模型可见工具集：mode=code → [runCodeTool]；mode=both → [runCodeTool, ...nativeTools]。
   *  由工厂按 mode 组装后注入；全量原生工具不属于本类，它们只存在于 DispatchBridge 中。 */
  private visibleTools: StructuredToolInterface[];
  /** 与 RunCodeTool 内部共享的同一 runtime 实例，仅用于生命周期管理（dispose on teardown） */
  private runtime: CodeRuntime;
  /** 订阅程序内子调用事件（→ { ptcDispatch } 流式块），与 RunCodeTool 内部共享同一实例 */
  private dispatchBridge: DispatchBridge;
  /** 构造时生成一次（PTC_SYSTEM_PROMPT + SDK 类型声明），前缀稳定、利于 KV 缓存 */
  private systemPrompt: string;
  private graph: any;

  constructor(
    llm: ChatOpenAI,
    visibleTools: StructuredToolInterface[],
    runtime: CodeRuntime,
    dispatchBridge: DispatchBridge,
  ) {
    this.llm = llm;
    this.visibleTools = visibleTools;
    this.runtime = runtime;
    this.dispatchBridge = dispatchBridge;
    // SDK 类型声明基于分发桥可见的全量工具（ToolFilter 运行时再过滤绑定，见 5.6）
    this.systemPrompt = buildPtcSystemPrompt(this.dispatchBridge.sdkTools);
    this.graph = this.createGraph();
  }

  private createGraph() {
    const toolNode = new ToolNode(this.visibleTools); // 只处理模型会调用的工具（code 模式下仅 run_code）
    return new StateGraph(PtcState)
      .addNode("agent", (s) => this.agentNode(s))
      .addNode("tools", toolNode)
      .addNode("finalize", (s) => this.finalizeNode(s))
      .addNode("fallback", (s) => this.fallbackNode(s))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", (s) => this.route(s))  // tools | finalize | fallback
      .addEdge("tools", "agent")
      .addEdge("finalize", END)
      .addEdge("fallback", END)
      .compile();
  }

  private async agentNode(state) {
    // 与 GraphAgentExecutor.agentNode 相同：
    // llm.bindTools(this.visibleTools) → invoke   （code 模式下仅绑 run_code）
    // 失败降级：迭代 0 去掉工具重试一次
  }

  private route(state): "tools" | "finalize" | "fallback" {
    // 复用 GraphAgentExecutor.conditionalRoute 逻辑
    // fallback 条件：iteration >= maxIterations 或 ptcStats.consecutiveErrors >= 3
  }

  async *stream(params: {
    messages: BaseMessage[];
    config?: { maxIterations?: number };
  }): AsyncGenerator<AgentStreamChunk> {
    // 1. 初始化状态：PTC_SYSTEM_PROMPT + SDK 声明注入；ptcStats 从零开始
    const initialState: PtcStateType = {
      messages: [new SystemMessage(this.systemPrompt), ...params.messages],
      userInput: extractUserText(params.messages),
      iteration: 0,
      intermediateSteps: [],
      ptcStats: { runCodeCalls: 0, subCalls: 0, programErrors: 0, consecutiveErrors: 0 },
    };

    // 2. 订阅分发桥子调用事件（程序内 tools.x() → ptcDispatch 块）
    //    用队列缓冲：yield 只能发生在生成器体内，回调里先入队、循环里排空
    const pendingDispatches: PtcDispatchEvent[] = [];
    const unsubscribe = this.dispatchBridge.onDispatch((ev) => {
      pendingDispatches.push(ev);
    });

    try {
      // 3. 与普通模式相同的双 mode 流：["updates", "messages"]
      const streams = await this.graph.stream(initialState, {
        streamMode: ["updates", "messages"],
      });

      for await (const chunk of streams) {
        const [mode, value] = chunk as [string, any];

        if (mode === "messages") {
          // token 流：只转发 agent 节点产生的文本（与 GraphAgentExecutor 一致）
          const [msgChunk, metadata] = value;
          if (metadata?.langgraph_node === "agent") {
            const token = msgChunk?.content ?? "";
            if (token) yield { output: String(token) };
          }
          continue;
        }

        if (mode === "updates") {
          // tools 节点：run_code 执行完毕 → 从 intermediateSteps 识别并产出程序块
          if (value.tools) {
            for (const step of value.tools.intermediateSteps ?? []) {
              if (step.action.tool === "run_code") {
                const input = step.action.toolInput as { code?: string; description?: string };
                yield {
                  ptcProgram: { code: input.code ?? "", description: input.description ?? "" },
                };
              }
              yield { intermediateSteps: [step] };   // 与普通模式共用同一块结构
            }
          }
          // finalize / fallback：产出最终答案 + 统计（节点返回值带 ptcStats，见下）
          else if (value.finalize || value.fallback) {
            const u = value.finalize ?? value.fallback;
            const last = u.messages?.[u.messages.length - 1];
            yield {
              output: last?._getType() === "ai" ? String(last.content) : "",
              ptcStats: u.ptcStats,
            };
          }
        }

        // 4. 每个 chunk 后排空子调用事件队列（run_code 执行期间产生的事件在此被转发）
        while (pendingDispatches.length > 0) {
          yield { ptcDispatch: pendingDispatches.shift()! };
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      yield { output: `[PTC Error] ${errMsg}` };
    } finally {
      // 5. 无论成功失败都取消订阅，避免泄漏
      unsubscribe();
    }
  }

  async dispose() { await this.runtime.dispose(); }
}
```

**finalize / fallback 复用策略：结构复用，实现不复用**。

`GraphAgentExecutor`（普通模式）与 `PtcAgentLangGraph` 的这两个节点**语义与数据源都不同**，不能直接调用类方法：

| 节点 | GraphAgentExecutor（普通） | PtcAgentLangGraph（PTC） |
|------|---------------------------|--------------------------|
| `finalizeNode` | 取最后一条 AIMessage 文本 + `ToolStatsRegistry` 报告 → `{ finalOutput }` | 取最后一条 AIMessage 文本 + **`ptcStats`** 报告（runCodeCalls/subCalls/programErrors）→ `{ messages }` |
| `fallbackNode` | 触发：仅迭代耗尽；内容：`maxIterations` + `intermediateSteps` 摘要 | 触发：迭代耗尽 **或** `consecutiveErrors >= 3`；内容：`maxIterations` + run_code/子调用摘要 |
| 状态类型 | `AgentState` | `PtcState`（无 `finalOutput` 字段，输出走 `messages`，与 plan 模式一致） |

复用方式：提取**共享纯函数**（`src/agent/graph-utils.ts`），三个 executor 各自做状态适配与统计注入；
PTC 专属的统计格式化（依赖 `PtcStats` 类型）放 `src/ptc/stats.ts`：

```typescript
// src/agent/graph-utils.ts —— 三模式共享
/** 从消息链提取最终回答文本（最后一条 AI 消息） */
export function extractFinalAnswer(messages: BaseMessage[]): string { ... }

/** 从消息链提取用户输入文本（普通模式已内联实现；PTC 的 stream 初始化复用） */
export function extractUserText(messages: BaseMessage[]): string { ... }

/** 构造「迭代耗尽」兜底摘要（普通模式 / PTC 共用） */
export function buildIterationExhaustedSummary(
  iterations: number,
  steps: AgentStep[],
): string { ... }
```

#### `formatPtcStatsReport()` 详细设计（`src/ptc/stats.ts`）

```typescript
import type { PtcStats } from "./types.js";

/**
 * 格式化 PTC 执行统计报告，追加到最终答案末尾（finalize 节点使用）。
 *
 * 规则：
 * 1. 从未执行过 run_code（纯对话，或 both 模式未走程序）→ 返回空串，
 *    避免给无 PTC 活动的回答追加无意义报告；
 * 2. 派生指标由原始计数算出：成功/失败程序数、失败率、平均每次程序的子调用数；
 * 3. 连续失败 ≥ 3 时追加降级提示（对应 5.9 降级策略），供用户感知发生了什么；
 * 4. 防御性截断：programErrors 不可能大于 runCodeCalls（每个失败都源自一次调用）。
 */
export function formatPtcStatsReport(stats: PtcStats): string {
  const { runCodeCalls, subCalls, programErrors, consecutiveErrors } = stats;

  // 无 PTC 活动：不输出报告
  if (runCodeCalls === 0) return "";

  const failedRuns = Math.min(programErrors, runCodeCalls);        // 防御：失败数 ≤ 调用数
  const successRuns = runCodeCalls - failedRuns;                   // 成功执行的程序数
  const failureRate = Math.round((failedRuns / runCodeCalls) * 100); // 失败率 %
  const avgSubCalls = (subCalls / runCodeCalls).toFixed(1);        // 每次程序平均子调用数

  const lines = [
    "📦 PTC 执行统计",
    `- run_code 调用：${runCodeCalls} 次（成功 ${successRuns} / 失败 ${failedRuns}，失败率 ${failureRate}%）`,
    `- 工具子调用：${subCalls} 次（平均每次程序 ${avgSubCalls} 次）`,
  ];

  if (consecutiveErrors >= 3) {
    lines.push(`- ⚠️ 连续 ${consecutiveErrors} 次程序失败，已触发降级（可要求我改用更小的程序或逐步调用）`);
  } else if (consecutiveErrors > 0) {
    lines.push(`- 当前连续失败 ${consecutiveErrors} 次`);
  }

  return lines.join("\n");
}
```

**示例输出**（一次典型会话后）：

```text
📦 PTC 执行统计
- run_code 调用：4 次（成功 3 / 失败 1，失败率 25%）
- 工具子调用：22 次（平均每次程序 5.5 次）
- 当前连续失败 1 次
```

**边界行为**：

| 输入（runCodeCalls, subCalls, programErrors, consecutiveErrors） | 输出 |
|------|------|
| `(0, 0, 0, 0)` | `""`（无 PTC 活动，不追加） |
| `(1, 6, 0, 0)` | 两行基础统计，`成功 1 / 失败 0，失败率 0%`，无失败提示行 |
| `(4, 22, 1, 1)` | 两行基础统计 + `当前连续失败 1 次` |
| `(5, 40, 3, 3)` | 两行基础统计 + `⚠️ 连续 3 次…已触发降级` |
| `(2, 0, 2, 2)` | 防御截断生效：`成功 0 / 失败 2，失败率 100%`（而非失败 2/2 溢出） |

PTC 侧节点实现示意：

```typescript
private finalizeNode(state: PtcStateType) {
  const output = extractFinalAnswer(state.messages) +
    "\n\n" + formatPtcStatsReport(state.ptcStats);
  this.tracer?.finishSession();
  // ptcStats 随节点返回值带出，供 stream() 的 updates 分支读取（见上）
  return { messages: [new AIMessage(output)], ptcStats: state.ptcStats };
}

private fallbackNode(state: PtcStateType) {
  const fallback = buildIterationExhaustedSummary(state.iteration, state.intermediateSteps) +
    "\n\nrun_code 调用 " + state.ptcStats.runCodeCalls +
    " 次，子调用 " + state.ptcStats.subCalls + " 次";
  this.tracer?.finishSession();
  return { messages: [new AIMessage(fallback)], ptcStats: state.ptcStats };
}
```

**为何不直接改 `GraphAgentExecutor`**：PTC 的工具绑定（`run_code`）、统计状态（`ptcStats`）、
流式事件（`ptcProgram`/`ptcDispatch`）、生命周期（runtime dispose）与普通模式差异较大，
独立成类更清晰；核心图结构与路由逻辑复用同一套 LangGraph 模式（可提取共享基类或复制少量代码）。

### 5.8 上下文与预算管理

**上下文（对标 dsh deferContext）**：
- `run_code` 的**程序日志 + 完成值**作为该工具调用的 `ToolMessage` 内容进入历史；
- 子调用的延迟上下文在 `run_code` 结果之后按序追加，保证「父调用/结果相邻」；
- 中间结果**不进历史**——这是 PTC 省 Token 的关键，必须用 `ContextManager` 之外的独立通道承载（仅 TUI/日志可见）。

**预算（三层）**：
| 预算 | 默认 | 触发行为 |
|------|------|---------|
| `PTC_MAX_PROGRAM_LENGTH` | 16 KB | 超限拒绝调用（模型自纠） |
| `PTC_MAX_WALL_MS` | 60 s | `timeout` 失败 + 强制 terminate |
| `PTC_MAX_OUTPUT_BYTES` | 64 KB | `output-limit` 失败（仅外层日志+值计数，中间绑定值不计） |

**资源耗尽兜底**：外层迭代达到 `maxIterations`（沿用 `MAX_ITERATIONS`）→ `fallback` 节点汇总已完成子调用。

### 5.9 失败处理与降级策略（G8）

| 场景 | 处理 |
|------|------|
| 程序编译失败（不可擦除语法/类型错误） | `error.kind="exception"`，消息回喂模型自纠（与修普通 bug 相同） |
| 程序超时/输出超限 | `timeout`/`output-limit`，提示模型拆分程序、缩小输出 |
| 工具调用失败（程序内） | `ToolCallError` 抛给程序，程序 try/catch 自行处理 |
| **连续失败**（`consecutiveErrors >= 3`） | 状态机路由至 fallback；系统提示词提醒模型「改用更小的程序或逐步调用」 |
| 运行时后端崩溃 | `worker-exit`，外层报错并由 `fallbackNode` 汇总已产生的结果 |
| 模型反复不用 `run_code`（`both` 模式） | 不干预——`both` 模式下模型自行选择，符合设计 |

### 5.10 可观测性（G7）

**Tracer 扩展**（`src/agent/tracer.ts` 增加事件类型，保持向后兼容）：
```typescript
type TracerEvent =
  | { type: "ptc_program"; code: string; description: string }
  | { type: "ptc_dispatch"; parentId: string; tool: string; input: unknown; output: unknown }
  | { type: "ptc_result"; kind: "ok" | CodeRunFailure["kind"]; logs: number; valueBytes: number };
```

**TUI 扩展**（`src/tui/app.tsx`）：
- 收到 `{ ptcProgram }` 块 → 静态区展示「📦 run_code」卡片（description + 可展开源码）；
- 收到 `{ ptcDispatch }` 块 → 动态区展示子调用 `⚡ tools.xxx(...)`；
- 收到 `{ output }` 块 → 现有 token 流逻辑不变；
- `run_code` 失败时展示错误类别徽章（exception/timeout/output-limit…）。

**日志**：沿用 `logAgent()`，新增 `ptc_program` / `ptc_dispatch` / `ptc_result` 三类。

---

## 6. 集成方案

### 6.1 工厂层与入口

`src/agent/loop.ts` 新增。注意：**`tools`（全量）在这里只进 `DispatchBridge`，绝不进图**；
进图的只有按 `mode` 组装好的模型可见工具集：

```typescript
export async function createPtcAgent(
  llm: ChatOpenAI,
  tools: StructuredToolInterface[],   // 全量工具：仅分发桥消费（程序内 tools.x() 可见）
  config: {
    maxIterations: number;
    ptc: Required<Pick<PtcConfig, "maxProgramLength" | "maxWallMs" | "maxOutputBytes" | "maxParallelSubCalls" | "mode">>;
    toolFilter?: ToolFilter;
  },
  tracer?: Tracer,
): Promise<PtcAgentLangGraph> {
  // 1. 构建 CodeRuntime（WorkerThreadCodeRuntime）—— 持有预算，执行模型程序
  const runtime = new WorkerThreadCodeRuntime(config.ptc);

  // 2. 构建 DispatchBridge —— 持有全量 tools，把程序内 tools.x() 转发到原生工具
  const bridge = new DispatchBridge(tools, config.toolFilter, undefined, config.ptc.maxParallelSubCalls);

  // 3. 构建 RunCodeTool —— 注入 bridge + runtime（run_code 内部执行时使用）
  const runCodeTool = new RunCodeTool({ dispatch: bridge, runtime, maxProgramLength: config.ptc.maxProgramLength });

  // 4. 组装模型可见工具集（决定模型能调什么）：
  //      mode=code → [runCodeTool]            —— 模型只能调 run_code
  //      mode=both → [runCodeTool, ...tools]  —— 模型也可直接调原生工具
  const visibleTools = config.ptc.mode === "code"
    ? [runCodeTool]
    : [runCodeTool, ...tools];

  // 5. 返回 PtcAgentLangGraph（visibleTools 进图；runtime 仅用于 dispose）
  return new PtcAgentLangGraph(llm, visibleTools, runtime, bridge);
}
```

`src/index.ts`（TUI 入口）与 `src/server-entry.ts`（server 入口）统一改造：

```typescript
const executor = config.agentMode === "plan"
  ? await createHierarchicalAgent(llm, allTools)
  : config.agentMode === "ptc"
    ? await createPtcAgent(llm, allTools, { maxIterations: config.maxIterations, ptc: {...} })
    : await createAgentExecutor(llm, allTools, systemPrompt, config.maxIterations);
```

> 注意：plan 模式当前仅测试调用。若本次一并接入，`runAgent()` 的入参类型需泛化为
> `GraphAgentExecutor | HierarchicalAgentLangGraph | PtcAgentLangGraph`（三者都有 `stream()`）。

### 6.2 TUI 集成

- `src/tui/app.tsx` 的 `props.executor` 类型放宽为共用接口
  `{ stream(params): AsyncGenerator<AgentStreamChunk> }`（`AgentStreamChunk` 定义见 5.2）；
- 新增 `PtcProgramCard` / `PtcDispatchItem` 组件（`src/tui/output.tsx` 或独立文件）；
- 斜杠命令（可选）：`/mode ptc` 切换运行时模式（会话开始前才允许，对标 dsh「产生内容后不可切换」）。

### 6.3 配置样例（`.env`）

```bash
AGENT_MODE=ptc
PTC_TOOL_MODE=code          # 或 both（保留原生工具）
PTC_MAX_PROGRAM_LENGTH=16384
PTC_MAX_WALL_MS=60000
PTC_MAX_OUTPUT_BYTES=65536
PTC_MAX_PARALLEL_SUBCALLS=10
```

---

## 7. 安全模型

**信任定位**：PTC 模式允许模型编写并执行任意 TypeScript 程序，信任等级与 `execute_command`
（bash 工具）**同级**——worker 线程提供遏制（containment），**不是安全边界**。

| 措施 | 说明 |
|------|------|
| 真空环境 | `Worker` 构造 `env: {}`，程序看不到宿主环境变量 |
| 进程内隔离 | 每次运行全新 worker；无池化、无跨运行状态；`worker.terminate()` 可硬停 |
| 端口协议敌对假设 | 未知/重复/结算后消息一律拒绝；绑定名空原型构造（防 `__proto__` 污染） |
| 绑定白名单 | 程序只能经 `tools` 命名空间调工具，无 `require`/`import`/`fs` 直连能力（除非工具本身暴露） |
| 输出/时长上限 | `maxWallMs` 强制 terminate；`maxOutputBytes` 防日志洪泛 |
| 复用既有门控 | `ToolFilter` 动态权限过滤 + `PermissionWrapper` 审批（高风险工具执行前确认） |
| 明确警告 | TUI 启动提示：PTC 模式可执行模型代码，勿在不信任环境中使用 |

> 未来增强：接入容器级后端（项目已有 `docker-compose.yml` 基础），`isolation` 描述符切换为 `container`。

---

## 8. 边界情况与风险

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | worker 非硬安全边界 | 恶意/错误代码可达 Node API | 明示信任定位；空 env + 绑定白名单；容器后端为既定扩展 |
| R2 | 模型代码能力不稳定（规划能力不足） | 程序反复编译失败，体验下降 | 失败信息回喂自纠；连续失败 ≥3 次降级提示；`both` 模式可退回原生 |
| R3 | `stripTypeScriptTypes` 为 Node 实验性 API | 版本差异/行为变化 | Node ≥22.6 可用；`ts.transpileModule`（仅剥离）为直接替代 |
| R4 | 大 JSON 值耗尽内存 | 运行时崩溃 | 中间绑定值无上限但完成值走 `output-limit`；必要时加单值上限 |
| R5 | 子调用并发受工具安全声明约束 | 并发写文件/命令竞态 | 排他工具（shell/写文件）强制串行；工具元数据标注 `isConcurrencySafe` |
| R6 | 上下文膨胀（子调用上下文累积） | Token 增长 | 延迟注入仅追加程序显式返回/路径类上下文；`ContextManager` 截断仍生效 |
| R7 | 与 plan 模式组合语义未定义 | 混乱 | v1 明确：PTC 与 plan 互斥；未来可设计 plan→ptc 混合（规划层计划，执行层程序化） |
| R8 | `run_code` 被权限策略误删 | 模式失效 | `run_code` 不进入可过滤能力层（对标 dsh：不进入 Filter 层） |
| R9 | 运行时长超出用户预期 | 卡顿感 | TUI 展示运行中状态与预算；`maxWallMs` 可配 |

---

## 9. 测试计划

遵循项目无独立测试框架的现状，以 `npx tsc --noEmit` 为编译门禁；新增 `vitest` 用例放 `tests/`（镜像 `src/ptc/`）。

### 9.1 单元测试（`tests/ptc/`）

| 模块 | 用例 |
|------|------|
| `sdk-generator` | JSON-Schema → TS 类型正确性；工具名含连字符/中文的引号键；`unknown` 退化 |
| `run-code-tool` | 代码超长拒绝；description 必填；正常程序返回 `logs + value` |
| `code-runtime-worker` | 类型剥离位置保留（错误行号一致）；不可擦除语法拒绝且**不创建 worker**；顶层 return 值跨边界；日志顺序；超时→terminate；输出超限；`__proto__` 键安全 |
| `dispatch-bridge` | 串行/并行调度顺序；`maxParallelSubCalls=1` 恢复串行；排他工具排空池；结算放弃排队调用；ToolCallError 带 toolName；参数无损 JSON 快照 |
| `stats`（`formatPtcStatsReport`） | 零调用返回空串；派生指标（成功率/失败率/平均子调用数）正确；`consecutiveErrors >= 3` 降级提示、`1-2` 普通提示、`0` 无提示；`programErrors > runCodeCalls` 防御截断（对照 5.7 边界表） |
| 失败分类 | 六类 `CodeRunFailure.kind` 各覆盖一条路径 |

### 9.2 集成测试

- **带 key e2e**（对标 dsh）：真实模型在一个 `run_code` 中组合两次只读调用（list_files + read_file）并汇总；
- **both 模式**：模型在原生调用与 `run_code` 之间自由选择；
- **失败自纠**：给模型一个含 `enum` 的程序，验证其收到 `exception` 后改写为可擦除语法并成功执行；
- **连续失败降级**：mock 运行时连续抛错，验证 3 次后进入 fallback；
- **流式契约**：`{ ptcProgram }`/`{ ptcDispatch }`/`{ output }` 块顺序与内容正确。

### 9.3 回归

- 普通模式、plan 模式行为不回归（`tsc --noEmit` + 现有手动用例）；
- `AGENT_MODE` 缺省时行为与现状完全一致。

---

## 10. 实施里程碑

| 阶段 | 内容 | 产出 |
|------|------|------|
| **M1 基础层** | 配置项（G1）、`src/ptc/types.ts`、`CodeRuntime` 接口、`WorkerThreadCodeRuntime`（类型剥离 + worker 执行 + 预算） | 单元测试通过（worker 运行时） |
| **M2 SDK 与工具** | `sdk-generator`、`run-code-tool`、`dispatch-bridge`（并发池 + ToolCallError + 事件） | 单元测试通过；TUI 可见 dispatch 事件 |
| **M3 状态机** | `PtcAgentLangGraph`、`createPtcAgent()`、入口改造（TUI/server）、`AGENT_MODE` 接线 | `AGENT_MODE=ptc` 可跑通端到端 |
| **M4 体验与稳健** | TUI 程序卡片/错误徽章、连续失败降级、`both` 模式、日志与 tracer 事件 | 集成测试 + e2e 通过 |
| **M5 可选增强** | `computeMs` 计量、容器后端（`isolation: container`）、plan×PTC 混合 | 视需求 |

---

## 附录

### A. `PTC_SYSTEM_PROMPT` 完整模板（初稿）

```text
你是一个编程式工具调用 Agent（PTC 模式）。

当前可用的工具由下方 TypeScript 类型声明描述：
{SDK_TYPE_DECLARATIONS}

使用方式：
1. 通过 run_code 编写 TypeScript 程序批量操作；
2. 程序体是 async 函数：await tools["工具名"](args)；
3. 只读独立调用用 Promise.all 并行；变更类调用串行；有依赖用 await；
4. 工具失败抛 ToolCallError（.toolName / .message），程序内 try/catch；
5. 只 return/console.log 需要回灌上下文的摘要；
6. 禁止 enum/namespace 等不可擦除语法；
7. 程序超时/超限会返回 error，请据 error.kind 拆分程序或精简输出。
```

### B. 示例：PTC 程序（遍历目录并汇总）

```typescript
// 任务：扫描 src/agent 下所有 .ts 文件，统计各文件行数，返回 TOP5
const files = await tools["list_files"]({ path: "src/agent" });   // 只读，可并行
const tsFiles = files.filter((f) => f.endsWith(".ts")).slice(0, 10);

// 并行读取（只读、独立）
const contents = await Promise.all(
  tsFiles.map((f) => tools["read_file"]({ file_path: f }))
);

const stats = tsFiles
  .map((f, i) => ({ file: f, lines: contents[i].split("\n").length }))
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 5);

return { total: tsFiles.length, top: stats };  // 仅此摘要回灌上下文
```

### C. 与 plan 模式的组合展望（非本次范围）

plan 模式提供「步骤编排」，PTC 提供「单步内程序化批处理」。未来可设计：
`planner（计划）→ ptcExecutor（每步用 run_code 执行）→ 校验 → 汇总`，
即「规划层保持 LLM 决策，执行层程序化」——届时 `HierarchicalAgentLangGraph` 的
`executeStep` 内部可复用 `DispatchBridge`，而外层新增 `verify` 节点（对标 deepseek-harness 的评审节点）。

### D. 参考链接

- deepseek-harness：https://github.com/deepseek-ai/deepseek-harness
- `docs/subsystems/code-runtime.md`（Code Runtime 子系统）
- `packages/code-runtime/code-runtime-worker-thread`（worker 后端参考实现）
- `packages/preset/agent-presets`（四种模式 preset 装配）
- 本项目：`docs/L9_HIERARCHICAL_LOOP.md`、`docs/L9_LANGGRAPH_MIGRATION.md`（plan 模式既有设计）
