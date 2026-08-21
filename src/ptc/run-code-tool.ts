import { StructuredTool } from "langchain";
import { z } from "zod";
import { CodeRuntime } from "./types.js";
import { DispatchBridge } from './dispatch-bridge.js';
import { Tracer } from "../agent/tracer.js";


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
    private tracer?: Tracer
    private statsReporter?: (r: { kind: string; subCalls: number }) => void

    constructor(config: {
        dispatch: DispatchBridge,
        runtime: CodeRuntime,
        maxProgramLength: number,
        tracer: Tracer
    }) {
        super()
        this.dispatch = config.dispatch
        this.runtime = config.runtime
        // 预算在构造函数内注入 schema（类字段初始化时 this 不可用）
        this.schema = z.object({
            code: z.string().describe("TypeScript 程序源码（async 函数体，顶层 await/return 可用）").max(config.maxProgramLength),
            description: z.string().describe("本次程序调用的意图说明，用于日志与界面展示")
        })
        this.tracer = config.tracer
    }

    /** 注入运行结算回调（PtcAgentLangGraph 用它更新 ptcStats：programErrors/consecutiveErrors/subCalls） */
    setStatsReporter(reporter: (r: { kind: string; subCalls: number }) => void): void {
        this.statsReporter = reporter
    }

    async _call(args: { code: string, description: string }): Promise<string> {
        this.tracer?.addPtcProgram(args.code, args.description, 0)
        const subCallsBefore = this.dispatch.subCallCount
        const result = await this.runtime.run({
            program: args.code,
            // userInput 为空串 → buildBindings 暴露全量工具（程序内安全靠 PermissionWrapper 审批）
            bindings: [this.dispatch.buildBindings("")]
        })

        this.tracer?.addPtcResult(
            result.error?.kind ?? "ok",
            result.logs.length,
            result.value === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.value)),
            0
        )
        // 统计上报：kind + 本次 run 新增的子调用数
        this.statsReporter?.({
            kind: result.error?.kind ?? "ok",
            subCalls: this.dispatch.subCallCount - subCallsBefore,
        })

        // 失败 → 回喂模型自纠（"[run_code kind] message" 前缀供 TUI 提取失败徽章）
        if (result.error) {
            return `[run_code ${result.error.kind}] ${result.error.message}`
        }

        // 成功 → logs 按序 + 完成值（仅回灌模型需要的摘要）
        const parts: string[] = [...result.logs]
        if (result.value !== undefined) {
            parts.push(JSON.stringify(result.value))
        }
        return parts.join("\n")
    }
}