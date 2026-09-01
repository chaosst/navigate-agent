#!/usr/bin/env node
/**
 * 推理模型验证脚本：打印当前 provider 解析结果 + 发一次最小对话。
 * TTFT计时支持命令行参数：
 *       --runs=<n>      测量次数，默认 3
 *       --warmup=<n>    预热次数，默认 1
 *       --prompt=<text> 自定义提示词（可选；想测长输出就换长 prompt）
 *       --no-timing     跳过计时，只跑原有的一次对话（保持脚本轻量可用）
 *
 * 用法：
 *   npx tsx scripts/check-provider.ts                   # 读 .env 的 PROVIDER
 *   PROVIDER=ollama npx tsx scripts/check-provider.ts   # 命令行覆盖（需 ollama 已启动）
*/

import "dotenv/config"
import { parseArgs } from 'node:util';
import { loadConfig } from "../src/config/index.js";
import { createChatModel } from "../src/agent/langchain.js";
import { HumanMessage } from "langchain"

/** 单次调用的计时快照 */
export interface ChatTiming {
    /**
     * 首 token 延迟（毫秒）。
     * 契约：null 表示**无法测量**而非"零延迟"——发生在后端不支持流式、
     *       或 stream 抛错降级到 invoke 时。下游打印时必须判 null，别当 0。
     */
    ttftMs: number | null
    /** 从发起请求到收到完整回复的总耗时（毫秒） */
    totalMs: number
     /**
     * 输出量，用于粗算吞吐。
     * 契约：优先取 res.usage_metadata?.output_tokens（LangChain AIMessage 提供，各后端支持度不一）；
     *       取不到时退回回复文本的**字符数**（此时吞吐单位是 chars/s，不是 tokens/s）。
     *       单位差异必须在输出里标注，否则数字会被误读。
     */
    outputUnits: number
    outputUnit: "tokens" | "chars"
    /** 本次调用是否成功；失败时 ttftMs/totalMs 仍记录到失败为止的耗时 */
    ok: boolean
    error?: string
}
/** 多次调用的聚合结果 */
export interface TimingSummary {
    runs: number
    /** 仅统计 ok === true 的样本；全失败时为 null */
    ttftAvgMs: number | null
    ttftMinMs: number | null
    ttftMaxMs: number | null
    totalAvgMs: number | null
    /** 吞吐：outputUnits / (totalMs - ttftMs) 的均值，单位见 outputUnit；样本不足时为 null */
    throughput: number | null
    outputUnit: "tokens" | "chars"
    failed: number
}

/**
 * 测一次对话的 TTFT 与总耗时。
 */
export async function measureChatOnce(
    llm: ReturnType<typeof createChatModel>,
    prompt: string
): Promise<ChatTiming> {
    const t0 = performance.now()
    let result: ChatTiming = {
        ttftMs: null,
        totalMs: 0,
        outputUnits: 0,
        outputUnit: "tokens",
        ok: false
    }
    let content = ""
    let units = 0
    try {
        for await (const chunk of await llm.stream([new HumanMessage(prompt)])) {
            const output = typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content)
            if (result.ttftMs == null && output.length > 0) {   // 加 output.length > 0
                result.ttftMs = performance.now() - t0
            }
            if (output.length) {
                content += `\n${output}`
            }
            if (chunk.usage_metadata?.output_tokens) {
                units += chunk.usage_metadata?.output_tokens
            }
        }
        if (units > 0) {
            result.outputUnits = units          // 单位保持 "tokens"
        } else {
            result.outputUnits = content.length // 退化为字符数
            result.outputUnit = "chars"
        }
        result.totalMs = performance.now() - t0
        result.ok = true
    } catch (err) {
        const error = typeof err === "string" ? err : JSON.stringify(err)
        console.error("[measureChatOnce] stream error with: ", error)
        try {
            const r = await llm.invoke([new HumanMessage(prompt)])
            const output = typeof r.content === "string" ? r.content : JSON.stringify(r.content)
            result.ok = true
            result.ttftMs = null
            result.totalMs = performance.now() - t0
            if (r.usage_metadata?.output_tokens) {
                result.outputUnits = r.usage_metadata?.output_tokens
                result.outputUnit = "tokens"
            } else {
                result.outputUnits = output.length
                result.outputUnit = "chars"
            }
            result.error = error
        } catch (e) {
            const error = typeof e === "string" ? e : JSON.stringify(e)
            result.ok = false
            result.error = error
            console.error("[measureChatOnce] invoke error with: ", error)
        }
    }

    return result
}

/**
 * 跑一组测量并聚合。
 * 为什么默认 3 次：单次抖动大（尤其云端），3 次足以看出量级差；跑满 10 次性价比低。
 */
export async function runTimingSuite(
    llm: ReturnType<typeof createChatModel>,
    prompt: string,
    opts?: { runs?: number; warmup?: number }
  ): Promise<{ samples: ChatTiming[]; summary: TimingSummary }> {
    const warmup = opts?.warmup ?? 1
    const runs = opts?.runs ?? 3
    const samples: ChatTiming[] = [] 
    const summary: TimingSummary = {
        runs, 
        ttftAvgMs: null,
        ttftMinMs: null,
        ttftMaxMs: null,
        totalAvgMs: null,
        throughput: null,
        outputUnit: "tokens",
        failed: 0
    }
    let ttftTotal = 0
    let total = 0
    let throughput = 0
    let rateCount = 0
    let ttftCount = 0
    try {
        for (let index = 0; index < warmup; index++) {
            await measureChatOnce(llm, prompt)
        }
        for (let index = 0; index < runs; index++) {
            const r = await measureChatOnce(llm, prompt)
            samples.push(r)
            if (r.ok) {
                if (r.ttftMs != null) { ttftTotal += r.ttftMs; ttftCount++ }
                total += (r.totalMs ?? 0)
                const decodeMs = r.ttftMs == null ? null : r.totalMs - r.ttftMs
                if (decodeMs != null && decodeMs > 0) { throughput += r.outputUnits / decodeMs * 1000; rateCount++ }
                summary.ttftMaxMs = r.ttftMs ? Math.max(summary.ttftMaxMs ?? r.ttftMs, r.ttftMs) : summary.ttftMaxMs
                summary.ttftMinMs = r.ttftMs ? Math.min(summary.ttftMinMs ?? r.ttftMs, r.ttftMs) : summary.ttftMinMs
                summary.outputUnit = r.outputUnit
            } else {
                summary.failed++
            }
        }
        const successCount = runs - summary.failed
        summary.ttftAvgMs = ttftCount > 0 ? ttftTotal / ttftCount : null
        summary.totalAvgMs = successCount > 0 ? total / successCount : null
        summary.throughput = rateCount > 0 ? throughput / rateCount : null
    } catch (err) {
        const error = typeof err === "string" ? err : JSON.stringify(err)
        console.error("[runTimingSuite] error with: ", error)
    }
    return {
        samples, summary
    }
}

/**
 * 打印人类可读的结果（表格或逐行，格式自定）。
 *
 * 逻辑契约：
 *  - 必须逐行打印每次样本（便于发现抖动），再打印一行汇总
 *  - ttftMs 为 null 的样本显示 "n/a"，**不要**显示 0（0 会被误读成"零延迟"）
 *  - 吞吐单位必须随数字一起打印（"tokens/s" 或 "chars/s"），
 *    并在首行标注数据来源（"usage_metadata 可用" / "退化为字符数估算"）
 *  - 汇总行末尾打印 provider + model，说明这份数据是哪个后端产出的
 */
/** 吞吐单位标签：必须随数字一起打印，否则 chars/s 会被误读成 tokens/s */
const RATE_LABEL: Record<ChatTiming["outputUnit"], string> = {
    tokens: "tokens/s",
    chars: "chars/s",
}

/** 固定列宽左对齐；超宽时不截断（错误信息可能较长，截断会丢线索），只补一个空格分隔 */
function padCell(text: string, width: number): string {
    return text.length >= width ? text + " " : text.padEnd(width)
}

/** 毫秒格式化：null 必须是 "n/a" 而不是 0 —— 0 会被读成"零延迟" */
function fmtMs(value: number | null): string {
    return value === null ? "n/a" : value.toFixed(1)
}

export function printTimingReport(
    samples: ChatTiming[],
    summary: TimingSummary,
    meta: { provider: string; model: string; baseURL: string }
  ): void {
    // 1. 先判断输出量口径：只有"全部成功样本都拿到 usage_metadata"才算真实 token 数。
    //    只要有一个样本退化成字符数，就必须在表头声明，否则整张表的吞吐单位不可信。
    const okSamples = samples.filter((s) => s.ok);
    const usageMetadataAvailable =
        okSamples.length > 0 && okSamples.every((s) => s.outputUnit === "tokens");
    const unitLabel = RATE_LABEL[summary.outputUnit];

    const lines: string[] = [];
    const sep = "-".repeat(72);

    lines.push(sep);
    lines.push("timing report");
    lines.push(
        `  output unit : ${summary.outputUnit} (${
            usageMetadataAvailable
                ? "usage_metadata 可用，真实 token 数"
                : "退化为字符数估算，后端未返回 usage_metadata"
        })`
    );
    lines.push(`  endpoint    : ${meta.baseURL || "(default)"}`);
    lines.push(sep);

    // 2. 空样本：直接早退，别打印空表头误导人以为"测了但都是 0"
    if (samples.length === 0) {
        lines.push("  (no samples)");
        lines.push(sep);
        console.log(lines.join("\n"));
        return;
    }

    // 3. 逐行打印每次样本：留着是为了看抖动，只看均值会掩盖首次请求/偶发网络抖动
    lines.push(
        padCell("#", 4) +
            padCell("TTFT(ms)", 12) +
            padCell("Total(ms)", 12) +
            padCell(`Output(${summary.outputUnit})`, 20) +
            "Status"
    );
    lines.push(sep);
    samples.forEach((s, i) => {
        const status = s.ok ? "ok" : `failed: ${s.error ?? "unknown error"}`;
        lines.push(
            padCell(String(i + 1), 4) +
                padCell(fmtMs(s.ttftMs), 12) +
                padCell(fmtMs(s.totalMs), 12) +
                padCell(String(s.outputUnits), 20) +
                status
        );
    });
    lines.push(sep);

    // 4. 汇总行：吞吐的单位跟着数字走；末尾带 provider + model 说明数据出自哪个后端
    lines.push(
        `avg  TTFT ${fmtMs(summary.ttftAvgMs)} ms ` +
            `(min ${fmtMs(summary.ttftMinMs)} / max ${fmtMs(summary.ttftMaxMs)}) | ` +
            `Total ${fmtMs(summary.totalAvgMs)} ms | ` +
            `throughput ${
                summary.throughput === null ? "n/a" : `${summary.throughput.toFixed(2)} ${unitLabel}`
            } | ` +
            `failed ${summary.failed}/${summary.runs}`
    );
    lines.push(`provider=${meta.provider}  model=${meta.model}`);
    lines.push(sep);

    console.log(lines.join("\n"));
}


async function main(): Promise<void> {
    try {
        const args = parseArgs({
            args: process.argv.slice(2),
            options: {
              runs: { type: 'string' },
              warmup: { type: 'string' },
              prompt: { type: 'string' },
              "no-timing": {type: 'boolean'}
            }
        });
        const config = loadConfig()
        console.log(`profile info:\n
            provider -> ${config.provider}\n
            baseURL -> ${config.baseURL}\n
            model -> ${config.modelName}\n
            apiKey -> ${mask(config.openAIApiKey)}\n
            embedding -> ${config.embeddingModel}\n
        `)
        
        const llm = createChatModel(config)
        const res = await llm.invoke([
            new HumanMessage("用一句话介绍你自己")
        ])

        const str = typeof res.content === 'string' ? res.content : JSON.stringify(res.content)

        console.info(`llm result: ${str}`)

        if (args.values['no-timing']) {
            return ;
        }

        let warmup = Number(args.values.warmup)
        let runs = Number(args.values.runs)
        warmup = isNaN(warmup) || warmup <= 0 ? 1 : warmup
        runs = isNaN(runs) || runs <= 0 ? 3 : runs
        try {
            const { samples, summary } = await runTimingSuite(llm, args.values.prompt ?? "用一句话介绍你自己", {
                runs, warmup
            })
            printTimingReport(samples, summary, {
                provider: config.provider,
                baseURL: config.baseURL,
                model: config.modelName
            })
        } catch {
            // 计时失败不应该exit(1)
            console.warn("[timing] skipped: ...")
        }
    } catch (err) {
        console.error("Fatal:", err instanceof Error ? err.message : err);
        process.exit(1);
    }
}

/**
 * apiKey 打码：只保留前 4 位与后 2 位，中间一律遮掉。
 * 注意：脚本输出常被引进日志/文档，这里必须彻底遮掩，不能只遮中间几位。
 */
function mask(key: string): string {
    if (!key) {
        return "(empty)"
    }
    if (key.length <= 4) {
        return "****"
    }
    return key.slice(0, 4) + "****" + key.slice(-2)
}

main()