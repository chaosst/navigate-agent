import type { CodeRunRequest, CodeRunResult } from "./types.js";

/**
 * 代码运行时抽象接口（能力接缝）。
 *
 * 对应设计文档 §5.2：run() 只对调用方/接缝误用拒绝；
 * 程序失败一律作为 CodeRunResult.error 字段返回，绝不以 rejection 传播。
 */
export interface CodeRuntime {
  /** 程序必须用什么语言写（本实现为 typescript） */
  readonly language: "typescript" | "python";
  /**
   * 执行基质。诊断标签，**不是安全声明**：
   * worker-thread 提供遏制（containment）而非安全边界，信任态势与 bash 同级。
   */
  readonly isolation: "worker-thread" | "process" | "container";

  /**
   * 执行一次程序并捕获它打印与返回的内容。
   * @param request 程序、其绑定与中止信号；请求携带运行时作用的一切
   * @returns 运行结果：完成值（可跨边界时）、有序日志捕获、失败（如有）
   */
  run(request: CodeRunRequest): Promise<CodeRunResult>;

  /** 终止所有在飞运行并等待退出；实现必须处置至静默（quiescence） */
  dispose(): Promise<void>;
}
