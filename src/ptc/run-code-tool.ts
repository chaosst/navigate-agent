import { StructuredTool } from "langchain";
import { z } from "zod";
import { CodeRuntime } from "./types.js";
import { DispatchBridge } from './dispatch-bridge.js';


export class RunCodeTool extends StructuredTool {
    name = "run_code"
    description: string = "编写并执行一段 TypeScript 程序，在单次调用内组合多个工具操作（读取、搜索、循环、并行、汇总）。" +
    "适合多步骤、可并行、需要循环/分支处理中间结果的任务。程序体是 async 函数，用 await tools[\"工具名\"](args) 调用工具。" +
    "只 return 或 console.log 需要回灌上下文的摘要。"

    schema: z.ZodObject<{
        code: z.ZodString;
        description: z.ZodString
    }>;

    private dispatch: DispatchBridge
    private runtime: CodeRuntime

    constructor(config: {
        dispatch: DispatchBridge,
        runtime: CodeRuntime,
        maxProgramLength: number
    }) {
        super()
        this.dispatch = config.dispatch
        this.runtime = config.runtime
        // 预算在构造函数内注入 schema（类字段初始化时 this 不可用）
        this.schema = z.object({
            code: z.string().describe("TypeScript 程序源码（async 函数体，顶层 await/return 可用）").max(config.maxProgramLength),
            description: z.string().describe("本次程序调用的意图说明，用于日志与界面展示")
        })
    }

    async _call(args: { code: string, description: string }): Promise<string> {
        // 1. 构建绑定（见 5.6）：每个可见工具 → tools[name]，经 ToolFilter 过滤
        // 2. 构建运行信号：跟随外层取消；运行结束即中止
        // 3. runtime.run({ program, bindings, signal })
        // 4. 结算：中止未完成子调用、排空分发队列
        // 5. 成功 → `${logs.join("\n")}\n${JSON.stringify(value)}`
        //    失败 → `[run_code ${error.kind}] ${error.message}`（回喂模型自纠）
        throw new Error("Not implemented");
    }
}