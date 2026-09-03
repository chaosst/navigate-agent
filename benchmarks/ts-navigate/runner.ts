/**
 * benchmarks/ts-navigate/runner.ts —— navigate
 * 用法：
 *   cd benchmarks/ts-navigate
 *   node --import tsx runner.ts task-1-rag-qa     # 或短 id：task-1（Node>=20.6 用 --import，--loader 已废弃）
 *   node --import tsx runner.ts task-4            # 输出 ../results/navigate.task-4.json
 *
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { HumanMessage } from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import { StructuredTool } from "@langchain/core/tools"
import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod"
import { GraphAgentExecutor } from "../../src/agent/graph-agent-executor.js"
import { calculator, weather_now } from "../tools/tools.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = resolve(HERE, "../tasks")
const RESULTS_DIR = resolve(HERE, "../results")

class CalculatorTool extends StructuredTool {
    name = "calculator"
    description =
        "四则运算求值器。传入 expression（如 '3+4*2'、'(50+80+60)*3'），返回 JSON：{ok:true,value} 或 {ok:false,error}。"
    schema = z.object({
        expression: z.string().min(1).describe("四则运算表达式，只允许数字、+ - * /、括号与空格"),
    })

    async _call({ expression }: z.infer<typeof this.schema>): Promise<string> {
        return JSON.stringify(calculator(expression))
    }
}

class WeatherNowTool extends StructuredTool {
    name = "weather_now"
    description =
        "查询指定城市的实时天气。传入 city 城市名，返回 JSON：{ok:true,value:{city,temperature,condition,source}}；source 固定为 mock。"
    schema = z.object({
        city: z.string().min(1).describe("城市名，如：北京"),
    })

    async _call({ city }: z.infer<typeof this.schema>): Promise<string> {
        return JSON.stringify(weather_now(city))
    }
}


function buildChatModel(): ChatOpenAI {
    const apiKey = process.env.OPENAI_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
        throw new Error("缺少 OPENAI_API_KEY（或 DEEPSEEK_API_KEY），请先 export（见 benchmarks/README.md）")
    }
    const baseURL = process.env.OPENAI_BASE_URL?.trim() || "https://api.deepseek.com"
    const model = process.env.OPENAI_MODEL?.trim() || "deepseek-chat"
    return new ChatOpenAI({
        model,
        apiKey,
        temperature: 0,
        maxRetries: 1,
        timeout: 60_000,
        configuration: { baseURL },
    })
}

interface TaskJson {
    id: string
    description?: string
    context?: string
    question?: string
    topic?: string
    goal?: string
    budget?: number
    people?: number
    expected_keywords?: string[]
    [key: string]: unknown
}

/** 短 id："task-1-rag-qa" → "task-1" */
function shortIdOf(taskId: string): string {
    const m = /^(task-\d+)/.exec(taskId)
    return m ? m[1] : taskId
}

/** 解析命令行参数为任务定义；支持全名/短 id */
function loadTask(arg: string): { shortId: string; task: TaskJson } {
    const direct = resolve(TASKS_DIR, `${arg}.json`)
    if (existsSync(direct)) {
        const task = JSON.parse(readFileSync(direct, "utf8")) as TaskJson
        return { shortId: shortIdOf(task.id), task }
    }
    const short = shortIdOf(arg)
    const match = readdirSync(TASKS_DIR).find((f) => f.startsWith(`${short}-`) && f.endsWith(".json"))
    if (match) {
        const task = JSON.parse(readFileSync(resolve(TASKS_DIR, match), "utf8")) as TaskJson
        return { shortId: short, task }
    }
    throw new Error(
        `找不到任务 '${arg}'（期望 ${TASKS_DIR} 下的文件名，如 task-1-rag-qa 或短 id task-1）`,
    )
}

interface RunStats {
    output: string
    wallTimeMs: number
    toolCalls: number
    trace: { step: number; kind: "llm" | "tool" | "handoff" | "checkpoint"; name: string; ms: number }[]
}

/**
 * 跑一次 GraphAgentExecutor（stream），聚合最终输出与工具轨迹。
 *  - output 取最后一次 finalize/fallback 的完整输出（token 级流式 chunk 会被覆盖丢弃）
 *  - tool_calls 以 intermediateSteps 增量精确统计
 *  - llm_calls 返回 null：GraphAgentExecutor 不暴露该计数（metrics 层写 null，不编造）
 */
async function runExecutor(
    executor: GraphAgentExecutor,
    messages: BaseMessage[],
): Promise<RunStats> {
    const t0 = Date.now()
    let output = ""
    let lastMark = t0
    let toolCalls = 0
    let prevSteps = 0
    const trace: RunStats["trace"] = []
    let step = 0
    const mark = (kind: RunStats["trace"][number]["kind"], name: string) => {
        const now = Date.now()
        trace.push({ step: ++step, kind, name, ms: now - lastMark })
        lastMark = now
    }

    for await (const chunk of executor.stream({ messages })) {
        // 工具调用：按中间步骤增量计数（与 src/agent/loop.ts runAgent 同款做法）
        const steps = (chunk.intermediateSteps ?? []) as { action: { tool: string } }[]
        if (steps.length > prevSteps) {
            for (let i = prevSteps; i < steps.length; i++) {
                mark("tool", steps[i]!.action.tool)
            }
            toolCalls += steps.length - prevSteps
            prevSteps = steps.length
        }
        // 最终输出：与生产路径 src/agent/loop.ts runAgent 同款「累加」语义 ——
        // executor.stream() 以 token 级 chunk（output=单token）逐字吐最终答案，
        // 叠加 finalize/fallback 的完整 output；两者都要拼进结果，且 undefined 必须跳过。
        // （曾误用「最后一次覆盖」，导致 output 被单 token"。"/空值顶掉 —— task-1/2 全空即此 bug）
        if (chunk.output !== undefined && chunk.output !== null) {
            output += String(chunk.output)
        }
    }

    return { output, wallTimeMs: Date.now() - t0, toolCalls, trace }
}

/** task-1：RAG 问答（context 内指令跟随，无工具） */
async function runTask1(llm: ChatOpenAI, task: TaskJson): Promise<RunStats> {
    const system = [
        "你是 navigate 技术问答助手。只依据下面给定的上下文回答用户问题，禁止编造上下文之外的事实。",
        "",
        "上下文：",
        task.context ?? "",
        "",
        "回答要求：直接给出结论，一句话到三句话，包含关键术语依据上下文的结论，一句话到三句话，包含关键术语（如技术栈：JavaScript、C++、MAF等）。",
    ].join("\n")
    const executor = new GraphAgentExecutor(llm, [], system, 5)
    return runExecutor(executor, [new HumanMessage(task.question ?? "")])
}

/** task-2：工具编排（calculator + weather_now 自主调用） */
async function runTask2(llm: ChatOpenAI, task: TaskJson): Promise<RunStats> {
    const system = [
        "你是工具调度员。自主调用可用工具完成任务，并给出最终答案。",
        "规则：答案必须来自工具返回的真实结果；工具报错就修正参数重试；最后用一句中文总结。",
    ].join("\n")
    const executor = new GraphAgentExecutor(llm, [new CalculatorTool(), new WeatherNowTool()], system, 10)
    return runExecutor(executor, [new HumanMessage(task.question ?? "")])
}

/**
 * task-3：多 Agent 协作（researcher → writer）
 * navigate 的表达：两次受控 worker 执行 + 显式交接（对应 src/tools/delegate.ts 的子 agent 分发形态）。
 * handoff 发生在 runner 层：researcher 产出 → trace 记 handoff → writer 消费。
 */
async function runTask3(llm: ChatOpenAI, task: TaskJson): Promise<RunStats> {
    const wallStart = Date.now()
    const material = task.context ?? ""
    const topic = task.topic ?? ""
    const executor = new GraphAgentExecutor(llm, [], "", 5) // worker 场景 systemPrompt 由 run 的 workerPrompt 取代

    // ① researcher：只读材料产出要点
    const researchPrompt = [
        "你是研究员（researcher）。基于给定材料提炼要点，禁止编造材料之外的内容。",
        "输出格式：编号列表，至少 3 条要点，每条一句话。",
    ].join("\n")
    const researchInput = `材料：\n${material}\n\n请围绕「${topic}」提炼至少 3 条要点。`
    const researchStart = Date.now()
    const points = await executor.run(researchInput, researchPrompt)
    const researchMs = Date.now() - researchStart

    // ② handoff → writer
    const writerPrompt = [
        "你是撰稿人（writer）。依据研究员给出的要点写成短文。",
        "规则：必须覆盖全部要点，不得新增材料之外的结论；输出 3-5 句连贯中文。",
    ].join("\n")
    const writerInput = `研究员的要点：\n${points}`
    const writerStart = Date.now()
    const article = await executor.run(writerInput, writerPrompt)
    const writerMs = Date.now() - writerStart

    // 手动拼 trace（两次独立 worker run，粗粒度只记角色与交接）
    const trace: RunStats["trace"] = [
        { step: 1, kind: "llm", name: "researcher", ms: researchMs },
        { step: 2, kind: "handoff", name: "researcher→writer", ms: 0 },
        { step: 3, kind: "llm", name: "writer", ms: writerMs },
    ]
    return {
        output: article,
        wallTimeMs: Date.now() - wallStart,
        toolCalls: 0,
        trace,
    }
}

/**
 * task-4：双模式 plan/execute（★ 控制流回环）
 * navigate 的 plan 模式 = systemPrompt 强约束"先计划→执行→校验→回退重规划" +
 * GraphAgentExecutor 的 agent↔tools 条件边环（迭代上限兜底）。
 * replan 由 calculator 返回的超预算事实驱动模型重算，不是结构层硬编码——这一点写进 notes 如实说明。
 */
async function runTask4(llm: ChatOpenAI, task: TaskJson): Promise<RunStats> {
    const budget = task.budget ?? 300
    const people = task.people ?? 3
    const system = [
        "你是预算规划执行员。任务必须按以下节奏完成：",
        "1. 计划：先输出计划——用编号列出至少 3 个具体步骤，明确每项花费与计算式。",
        "2. 执行：逐项用 calculator 工具计算，把每步结果与总花费算出来。",
        `3. 校验：若总花费超过 ${budget} 元，必须回退修改计划（删减/降价项目）后重新用 calculator 计算，直到不超过 ${budget} 元。`,
        "4. 输出最终预算方案：列出保留项目与总花费，并说明已满足预算约束。",
        "规则：花费数字必须来自 calculator 的真实返回值，禁止心算编造。",
    ].join("\n")
    const goal = `${task.goal ?? ""} 预算上限 ${budget} 元，共 ${people} 人。`
    const executor = new GraphAgentExecutor(llm, [new CalculatorTool()], system, 15)
    return runExecutor(executor, [new HumanMessage(goal)])
}

/** code_lines 口径：runner.ts 净行数（去注释与空行；三方共享适配层，所有任务同值，notes 注明） */
function countCodeLines(file: string): number {
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => {
            const t = l.trim()
            return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*")
        }).length
}

/**
 * success 机械校验：与 py 侧 bench_common.check_success 同口径（三方可比）。
 * - 有 expected_keywords：全部（大小写不敏感）命中才 success
 * - 无 expected_keywords（如 task-4）：恒 true，detail 提示人工核（预算约束无法从文本可靠断言）
 */
function checkSuccess(task: TaskJson, output: string): { ok: boolean; detail: string } {
    const kws = task.expected_keywords ?? []
    if (kws.length === 0) {
        return {
            ok: true,
            detail: "无 expected_keywords 约束（人工核：task-4 需确认最终预算 ≤ budget）",
        }
    }
    const low = output.toLowerCase()
    const missing = kws.filter((k) => !low.includes(k.toLowerCase()))
    if (missing.length > 0) {
        return { ok: false, detail: `缺少关键词: ${missing.join(", ")}` }
    }
    return { ok: true, detail: `关键词命中: ${kws.join(", ")}` }
}

/** 从根 package.json 读 navigate 版本（结果契约 framework_version 用真实版本） */
function frameworkVersion(): string {
    try {
        const pkg = JSON.parse(
            readFileSync(resolve(HERE, "../../package.json"), "utf8"),
        ) as { version?: string }
        return pkg.version ?? "0.0.0"
    } catch {
        return "0.0.0"
    }
}

async function main() {
    const arg = process.argv[2]
    if (!arg || arg === "--help" || arg === "-h") {
        console.log("用法: node --import tsx runner.ts <task-id>   (如 task-1-rag-qa 或 task-1)")
        return
    }
    const { shortId, task } = loadTask(arg)
    const llm = buildChatModel()
    const start = Date.now()

    let stats: RunStats
    switch (shortId) {
        case "task-1":
            stats = await runTask1(llm, task)
            break
        case "task-2":
            stats = await runTask2(llm, task)
            break
        case "task-3":
            stats = await runTask3(llm, task)
            break
        case "task-4":
            stats = await runTask4(llm, task)
            break
        default:
            throw new Error(`runner 未实现任务分派: ${shortId}（当前支持 task-1..4）`)
    }

    const { ok, detail } = checkSuccess(task, stats.output) // 与 py 侧同口径机械校验
    const contract = {
        framework: "navigate",
        framework_version: frameworkVersion(),
        task_id: task.id,
        run_at: new Date().toISOString(),
        success: ok,
        output: stats.output,
        metrics: {
            wall_time_ms: stats.wallTimeMs,
            llm_calls: null, // GraphAgentExecutor 不暴露 LLM 调用计数（拿不到写 null，不编造）
            tool_calls: stats.toolCalls,
            input_tokens: null,
            output_tokens: null,
            code_lines: countCodeLines(fileURLToPath(import.meta.url)),
        },
        trace: stats.trace,
        notes: [
            `校验: ${detail}`,
            `执行器: GraphAgentExecutor（src/server-entry 同款生产路径）`,
            `total_wall_ms(含装载)≈${Date.now() - start}`,
            shortId === "task-4"
                ? "replan 由 systemPrompt 约束 + calculator 返回事实驱动模型重算（agent↔tools 条件边环），非结构层硬编码"
                : undefined,
        ].filter(Boolean).join(" | "),
    }

    mkdirSync(RESULTS_DIR, { recursive: true })
    const outFile = resolve(RESULTS_DIR, `navigate.${task.id}.json`) // 全名（与 py 侧 write_result 同名口径）
    writeFileSync(outFile, JSON.stringify(contract, null, 2), "utf8")
    console.log(`[navigate] ${shortId} 完成 -> ${outFile}`)
    console.log(`  wall=${contract.metrics.wall_time_ms}ms tool_calls=${contract.metrics.tool_calls} code_lines=${contract.metrics.code_lines}`)
    console.log(`  输出前 300 字: ${stats.output.slice(0, 300).replace(/\n+/g, " ")}`)
}

main().catch((err) => {
    console.error(`[navigate runner] 失败: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
})
