/**
 * PTC 模式运行时类型定义
 *
 * 对应设计文档 docs/superpowers/specs/2026-08-16-ptc-mode-design.md §5.2
 * 词汇表对齐 deepseek-harness 的 Code Runtime seam（CodeRunRequest / CodeRunResult / CodeRunFailure）。
 */

/** 无损 JSON：跨运行时边界的合法值（可结构化克隆） */
export type CodeJsonValue =
  | null
  | boolean
  | number
  | string
  | CodeJsonValue[]
  | { [key: string]: CodeJsonValue };

/**
 * 一次程序运行请求。请求携带运行时作用的一切，无隐藏默认值
 * （默认与预算属于实现配置，不做运行时 ?? 兜底）。
 */
export interface CodeRunRequest {
  /** 程序源码（async 函数体；顶层 await/return 可用，return 值成为 CodeRunResult.value） */
  program: string;
  /** 暴露给程序的宿主函数命名空间（PTC 传一个：tools） */
  bindings: CodeBindingNamespace[];
  /** 中止信号：中止后以 failure.kind='abort' 结算 */
  signal?: AbortSignal;
}

/**
 * 程序运行结果。错误是结果上的字段，不是 run() 的异常路径 ——
 * 报告失败的程序是调用方的职责，run() 只对调用方/接缝误用拒绝。
 */
export interface CodeRunResult {
  /** 程序顶层 return 值（跨过无损 JSON 边界）；失败或无返回时缺省 */
  value?: CodeJsonValue;
  /** 程序按序输出的文本（console.log/warn/error 捕获） */
  logs: string[];
  /** 存在即失败，见 CodeRunFailure.kind 分类 */
  error?: CodeRunFailure;
}

/**
 * 为什么一次运行失败。各类别正交、独立报告：
 * 预算到期不是异常、中止不是超时、基质死亡两者都不是。
 */
export interface CodeRunFailure {
  kind:
    | "exception"      // 程序抛错 / 类型剥离失败 / 语法不可擦除
    | "timeout"        // maxWallMs 预算到期，worker 被强制终止
    | "abort"          // request.signal 触发
    | "worker-exit"    // 执行基质死亡且未结算（如 OOM）
    | "invalid-output" // 完成值/绑定值非无损 JSON（不可结构化克隆）
    | "output-limit";  // 序列化外层日志+完成值超 maxOutputBytes
  /** 人类可读详情，适合回喂模型自纠 */
  message: string;
}

/** 一个宿主侧异步函数；args 与 resolution 必须是无损 JSON */
export type CodeBindingFunction = (args: unknown) => Promise<CodeJsonValue>;

/** 暴露为程序全局对象的命名空间（如 tools） */
export interface CodeBindingNamespace {
  /** 程序可见的全局标识，必须满足 [A-Za-z_][A-Za-z0-9_]* 且非保留字 */
  global: string;
  /** 可调用成员，键为程序实际调用的名字（名字视作敌对方输入） */
  functions: Record<string, CodeBindingFunction>;
  /** 可选：程序可见的带类型拒绝错误类描述 */
  errorClass?: CodeBindingErrorClass;
}

/**
 * 程序可见的带类型拒绝错误（如 ToolCallError，成员属性 toolName）。
 * 运行时注入真实构造器，不向接缝传授消费者特定名称。
 */
export interface CodeBindingErrorClass {
  /** 构造器全局名 & Error.name */
  name: string;
  /** 承载成员名的自有属性名（如 "toolName"） */
  memberNameProperty: string;
}

/**
 * 代码运行时抽象接口（能力接缝）。
 * run() 只对调用方/接缝误用拒绝；程序失败一律作为 CodeRunResult.error 字段返回。
 */
export interface CodeRuntime {
  /** 程序必须用什么语言写（本实现为 typescript） */
  readonly language: "typescript" | "python";
  /**
   * 执行基质。诊断标签，**不是安全声明**：
   * worker-thread 提供遏制（containment）而非安全边界，信任态势与 bash 同级。
   */
  readonly isolation: "worker-thread" | "process" | "container";

  /** 执行一次程序并捕获它打印与返回的内容 */
  run(request: CodeRunRequest): Promise<CodeRunResult>;

  /** 终止所有在飞运行并等待退出；实现必须处置至静默（quiescence） */
  dispose(): Promise<void>;
}

/**
 * PTC 模式运行统计：驱动状态机路由（consecutiveErrors >= 3 → fallback）与
 * 可观测性（formatPtcStatsReport 注入 finalize，见设计文档 §5.2 / §5.7）。
 */
export interface PtcStats {
  /** run_code 外层调用次数 */
  runCodeCalls: number;
  /** 程序内工具子调用总数（跨所有 run_code 累积） */
  subCalls: number;
  /** 程序执行失败次数（六类 CodeRunFailure 任一） */
  programErrors: number;
  /** 连续失败次数；>= 3 时状态机路由至 fallback */
  consecutiveErrors: number;
}
