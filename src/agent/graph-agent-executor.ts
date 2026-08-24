import { HumanMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from "@langchain/core/tools";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, SystemMessage } from "langchain";
import { ToolStatsRegistry } from "../tools/stats-registry.js";
import { ToolFilter } from "../tools/tool-filter.js";
import { Tracer } from "./tracer.js";
import { PermissionWrapper } from "../tools/permission.js";
import { logAgent } from "./logger.js";
import { AgentState, PtcStateType } from './types.js';
import { buildIterationExhaustedSummary, buildStatsFooter, extractText, extractUserText } from './graph-utils.js';
import { TrackingToolNode } from './tracking-tool-node.js';

type AgentStateType = typeof AgentState.State

/** 截断对象/字符串为紧凑的日志摘要（避免长工具结果撑爆日志） */
export function truncateForLog(v: unknown, maxLen: number = 200): string {
    if (v === undefined || v === null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + `…(${s.length} chars)`;
}

export class GraphAgentExecutorBase {
    llm: ChatOpenAI
    tools: StructuredToolInterface[]
    maxIterations: number
    /** 单次 LLM 调用超时（ms）。PTC 场景模型常生成大段程序/文档，默认 120s */
    llmTimeoutMs: number
    toolFilter?: ToolFilter
    tracer?: Tracer
    /** 工具调用统计注册表（PermissionWrapper 在创建时注册；finalize 时追加报告） */
    protected toolStatsRegistry?: ToolStatsRegistry
    

    constructor(
        llm: ChatOpenAI,
        tools: StructuredToolInterface[],
        maxIterations: number,
        llmTimeoutMs = 120_000,
        toolFilter?: ToolFilter,
        tracer?: Tracer,
        toolStatsRegistry?: ToolStatsRegistry,
    ){
        this.llm = llm
        this.tools = tools
        this.maxIterations = maxIterations
        this.llmTimeoutMs = llmTimeoutMs
        this.toolFilter = toolFilter
        this.tracer = tracer
        this.toolStatsRegistry = toolStatsRegistry
    }

    /**
     * 生成最终输出统计脚注（工具统计 + token 消耗）。
     * 必须在 finishSession() 之前调用，否则取不到当前 session。
     */
    protected buildStatsFooter(): string {
        return buildStatsFooter(this.toolStatsRegistry, this.tracer)
    }

    /**
     * 检测「无进展循环」：同一 (tool, args) 组合被反复调用且返回结果**不变**。
     *
     * 与单纯计数不同，本方法以「结果是否变化」作为判定核心：
     *   - 死循环：read_file 同一文件、search_files 同一关键词 → 结果恒定 → streak 累积 → 触发
     *   - 合法迭代：read_file → edit_file → read_file（结果变化）→ streak 重置 → 不触发
     *   - 反复跑同一命令（如 npm test）：输出随修复变化 → 不触发；输出恒定 3 次 → 触发（确实卡住）
     *
     * 这样既能拦截日志中的死循环（轮换工具也能被同一 key 的 streak 捕获），
     * 又不会误伤「编辑-验证」这类合法的长任务。
     */
    private detectNoProgressLoop(messages: BaseMessage[], limit: number = 3): {
        count: number;
        lastResult?: string;
        toolName?: string;
        toolArgs?: string;
    } {
        const map = new Map<string, {
            toolName: string;
            args: string;
            lastResult: string;
            streak: number;
        }>();
        const NO_RESULT = "\u0000NO_RESULT";

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg._getType() !== "ai" || !("tool_calls" in msg)) continue;
            const toolCalls = (msg as any).tool_calls ?? [];
            for (const tc of toolCalls) {
                // 查找该 tool_call_id 对应的 ToolMessage 结果
                let result = NO_RESULT;
                for (let j = i + 1; j < messages.length; j++) {
                    const tm = messages[j];
                    if (tm._getType() === "tool" && (tm as any).tool_call_id === tc.id) {
                        result = typeof (tm as any).content === "string"
                            ? (tm as any).content
                            : JSON.stringify((tm as any).content);
                        break;
                    }
                }
                const argsObj = tc.args ?? {};
                const key = `${tc.name}|${JSON.stringify(argsObj, Object.keys(argsObj).sort())}`;
                const prev = map.get(key);
                if (prev && prev.lastResult === result) {
                    // 与上次相同 (tool, args) 且结果不变 → 无进展，streak 累积
                    prev.lastResult = result;
                    prev.streak += 1;
                } else {
                    map.set(key, {
                        toolName: tc.name,
                        args: JSON.stringify(argsObj),
                        lastResult: result,
                        streak: 1,
                    });
                }
            }
        }

        for (const entry of map.values()) {
            if (entry.streak >= limit) {
                return {
                    count: entry.streak,
                    toolName: entry.toolName,
                    toolArgs: entry.args,
                    lastResult: entry.lastResult === NO_RESULT ? "（无返回结果）" : entry.lastResult,
                };
            }
        }
        return { count: 0 };
    }

    async agentNode(state: AgentStateType | PtcStateType){
        const userInput = state.userInput || extractUserText(state.messages)

        let activeTools = this.tools
        // 动态工具权限过滤
        if (this.toolFilter && userInput) {
            const filtered = this.toolFilter.filter(
                this.tools as PermissionWrapper[],
                userInput,
            )
            if (filtered.length > 0) {
                activeTools = filtered
            }
        }

        // 迭代入口日志：排查循环轮数/上下文增长
        logAgent({
            type: "info",
            message: `[Loop] iter ${state.iteration + 1}/${this.maxIterations} start | messages=${state.messages.length} | tools=${activeTools.length}`,
        });

        // 检测「无进展循环」：同一 (tool, args) 结果不变达到 limit 次即强制终止。
        // 阈值可用 REPETITION_LIMIT 环境变量调整（默认 3），越保守可调大。
        const repetitionLimit = parseInt(process.env.REPETITION_LIMIT ?? "3", 10) || 3;
        const repetitiveInfo = this.detectNoProgressLoop(state.messages, repetitionLimit);

        if (repetitiveInfo.count >= repetitionLimit) {
            // 硬停止：不再调用 LLM（省 token），直接构造总结消息返回给用户。
            // 经验证：注入 SystemMessage 提示让 LLM 自行改策略对多数模型无效（日志中
            // 提示被注入 11 次仍继续循环），必须由引擎强制终止。
            logAgent({
                type: "error",
                message: `检测到重复工具调用 ${repetitiveInfo.count} 次 (${repetitiveInfo.toolName} ${repetitiveInfo.toolArgs})，强制中断以避免死循环`
            });
            this.tracer?.addError(`重复工具调用中断: ${repetitiveInfo.toolName} ${repetitiveInfo.toolArgs}`);

            const userRequest = (userInput || "（无用户输入）").substring(0, 200);
            const lastResult = repetitiveInfo.lastResult?.substring(0, 300) ?? "（无返回结果）";

            const stopMessage = new AIMessage(
                `[任务中断] 检测到重复的工具调用，为避免死循环已强制停止。\n\n` +
                `**原始请求**: ${userRequest}\n\n` +
                `**重复的工具调用**: ${repetitiveInfo.toolName}\n` +
                `**参数**: ${repetitiveInfo.toolArgs}\n` +
                `**累计调用次数**: ${repetitiveInfo.count}\n` +
                `**最后一次返回**: ${lastResult}${repetitiveInfo.lastResult && repetitiveInfo.lastResult.length > 300 ? "..." : ""}\n\n` +
                `**可能的原因**:\n` +
                `1. 工具持续返回相同结果，未取得预期进展\n` +
                `2. 工具参数可能不正确或目标已存在/不存在\n` +
                `3. 任务可能需要完全不同的方法\n\n` +
                `**建议**: 请换一种方式描述需求，或检查相关文件/配置后重试。`
            );
            return {
                messages: [stopMessage],
                iteration: state.iteration + 1,
            };
        }

        const modelWithTools = this.llm.bindTools(activeTools)

        // LLM 请求日志：当前轮绑定的工具集
        logAgent({
            type: "llm_request",
            message: `iter ${state.iteration + 1} LLM call`,
            details: { activeTools: activeTools.map((t) => t.name) },
        });

        let response;
        const llmStart = performance.now()
        try {
            response = await modelWithTools.invoke(state.messages, {
                signal: AbortSignal.timeout(this.llmTimeoutMs)
            })
        } catch (err) {
            // AbortSignal.timeout 触发：给出可读的超时信息（而非裸 "AbortError"）
            const errMsg = isAbortError(err)
                ? `LLM call timed out after ${this.llmTimeoutMs}ms`
                : err instanceof Error
                  ? err.message
                  : String(err);

            // 检测是否为重复工具调用错误（来自 LangGraph 的内部检测）
            if (errMsg.includes("Repetitive tool calls") || errMsg.includes("infinite loop")) {
                logAgent({
                    type: "warning",
                    message: `LangGraph 检测到重复工具调用循环，尝试恢复...`
                });

                // 构建恢复提示，包含之前的尝试历史
                const recentToolHistory = state.messages
                    .filter(m => m._getType() === "ai" && "tool_calls" in m)
                    .slice(-5)
                    .map(m => {
                        const calls = (m as any).tool_calls || [];
                        return calls.map((tc: any) => `- ${tc.name}: ${JSON.stringify(tc.args)}`).join("\n");
                    })
                    .join("\n");

                const recoveryHint = new SystemMessage(
                    `[紧急恢复] 系统检测到重复工具调用循环。之前的尝试历史：\n${recentToolHistory}\n\n` +
                    `你必须立即改变策略：\n` +
                    `1. 停止所有工具调用\n` +
                    `2. 总结你尝试过的方法和每次的结果\n` +
                    `3. 分析为什么这些方法失败了\n` +
                    `4. 向用户清晰地说明情况，包括：\n` +
                    `   - 原始任务是什么\n` +
                    `   - 你尝试了哪些具体步骤\n` +
                    `   - 每个步骤遇到了什么错误\n` +
                    `   - 你认为的根本原因\n` +
                    `   - 需要用户提供的具体帮助\n\n` +
                    `请直接输出这个总结报告作为你的最终答案，不要再调用任何工具。`
                );

                try {
                    // 不绑定工具，强制 LLM 直接回复
                    response = await this.llm.invoke([...state.messages, recoveryHint], {
                        signal: AbortSignal.timeout(this.llmTimeoutMs)
                    });
                } catch (retryErr) {
                    // 恢复也失败了，抛出原始错误
                    throw new Error(`Agent loop failed at iteration ${state.iteration + 1}: ${errMsg}`);
                }
            } else {
                logAgent({ type: "error", message: `LLM invoke failed: ${errMsg}` });
                this.tracer?.addError(errMsg);

                // 优雅降级：如果绑工具失败，去掉工具再试一次
                if (state.iteration === 0) {
                    logAgent({
                        type: "info",
                        message: "Retrying without tool binding...",
                    });
                    response = await this.llm.invoke(state.messages, {
                        signal: AbortSignal.timeout(this.llmTimeoutMs),
                    });
                } else {
                    throw new Error(`Agent loop failed at iteration ${state.iteration + 1}: ${errMsg}`);
                }
            }
        }
        const llmDuration = performance.now() - llmStart;

        // 记录 LLM 调用
        const toolCalls = response.tool_calls;
        const usage = (response as any).usage_metadata;
        this.tracer?.addLLMCall(
            state.iteration,
            `messages[${state.messages.length}]`,
            toolCalls?.length ? null : extractText(response.content),
            toolCalls?.map((tc: any) => tc.name as string) ?? null,
            llmDuration,
            usage?.input_tokens,
            usage?.output_tokens,
        )

        // LLM 响应日志：返回的工具调用或最终答案 + token 用量（排查上下文爆炸/死循环）
        if (toolCalls?.length) {
            const toolList = toolCalls
                .map((tc: any) => `${tc.name}(${truncateForLog(tc.args, 150)})`)
                .join(" | ");
            logAgent({
                type: "llm_response",
                message: `iter ${state.iteration + 1} → tools: ${toolList}`,
                details: {
                    inputTokens: usage?.input_tokens,
                    outputTokens: usage?.output_tokens,
                    durationMs: Math.round(llmDuration),
                    contextMsgs: state.messages.length,
                },
            });
        } else {
            logAgent({
                type: "llm_response",
                message: `iter ${state.iteration + 1} → final answer (${(extractText(response.content) ?? "").length} chars)`,
                details: {
                    inputTokens: usage?.input_tokens,
                    outputTokens: usage?.output_tokens,
                    durationMs: Math.round(llmDuration),
                    contextMsgs: state.messages.length,
                },
            });
        }

        return {
            messages: [response],
            iteration: state.iteration + 1
        }
    }

    conditionalRoute(state: AgentStateType): "tools" | "finalize" | "fallback" {
        const lastMessage = state.messages[state.messages.length - 1]
        // AIMessage 才有 tool_calls；没有工具请求时 LangChain 给的是 [] 或 undefined
        const hasToolCalls = !!(lastMessage && "tool_calls" in lastMessage && (lastMessage.tool_calls as unknown[]).length)

        let next: "tools" | "finalize" | "fallback";
        if (!hasToolCalls) {
            next = "finalize"
        } else if (state.iteration >= this.maxIterations) {
            next = "fallback"
        } else {
            next = "tools"
        }

        // 路由决策日志：快速定位循环如何结束（finalize=正常结束 / fallback=达上限 / tools=继续）
        logAgent({
            type: "info",
            message: `[Route] iter ${state.iteration} → ${next} | hasToolCalls=${hasToolCalls} | iteration>=maxIterations=${state.iteration >= this.maxIterations} (${state.iteration}/${this.maxIterations})`,
        });
        return next
    }
}

/** 判断是否为 AbortSignal 触发的 AbortError（Node/浏览器 DOMException 或 Error 形式） */
function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError"
}

export class GraphAgentExecutor extends GraphAgentExecutorBase {
    private systemPrompt: string

    constructor(
        llm: ChatOpenAI,
        tools: StructuredToolInterface[],
        systemPrompt: string,
        maxIterations: number,
        toolStatsRegistry?: ToolStatsRegistry,
        toolFilter?: ToolFilter,
        tracer?: Tracer,
        llmTimeoutMs?: number,
    ){
        super(llm, tools, maxIterations, llmTimeoutMs, toolFilter, tracer, toolStatsRegistry)
        this.systemPrompt = systemPrompt
    }

    

    /**
     * finalize, 最终答案（含 stats)
     */
    private finalizeNode(state: AgentStateType){
        let output = extractText((state.messages.at(-1) as AIMessage).content)
        // 工具统计 + token 消耗（必须在 finishSession 前取当前 session）
        output += this.buildStatsFooter()
        this.tracer?.finishSession()
        return {
            finalOutput: output
        }
    }

    /**
     * fallback, 迭代用尽兜底（对应原maxIterations分支）
     * @param state 
     */
    private fallbackNode(state: AgentStateType){
        let fallback = buildIterationExhaustedSummary(this.maxIterations, state.intermediateSteps)
        // 即使失败，已发生的 LLM 调用也应计入统计
        fallback += this.buildStatsFooter()
        this.tracer?.finishSession()
        return {
            finalOutput: fallback
        }
    }

    private createGraph(){
        const toolNode = new TrackingToolNode(this.tools)

        const workflow = new StateGraph(AgentState)
        // 注意：不能直接传 this.agentNode —— LangGraph 会把裸方法包装成 RunnableCallable
        // 再以对象方法形式调用，this 会变成那个 callable（没有 llm 属性）。
        // 必须包一层箭头函数保持 this 指向实例。
        .addNode("agent", (state) => this.agentNode(state))
        .addNode("tools", toolNode)
        .addNode("finalize", (state) => this.finalizeNode(state))
        .addNode("fallback", (state) => this.fallbackNode(state))
        .addEdge(START, "agent")
        .addConditionalEdges("agent", (state) => this.conditionalRoute(state), ["tools", "fallback", "finalize"])
        .addEdge("tools", "agent")
        .addEdge("finalize", END)
        .addEdge("fallback", END)

        const graph = workflow.compile()
        return graph
    }

    public async *stream({ messages }:{ messages: BaseMessage[]}) {
        const graph = this.createGraph()
        const input: AgentStateType = {
            messages: [new SystemMessage(this.systemPrompt), ...messages],
            userInput: extractUserText(messages),
            iteration: 0,
            intermediateSteps: []
        }
        // LangGraph recursionLimit 计的是「超步」（agent 节点 + tools 节点各算一步），
        // 而 maxIterations 计的是 LLM 调用轮数。每轮 = agent + tools ≈ 2 个超步，
        // 因此 recursionLimit = maxIterations*2 + 余量，保证 maxIterations 轮能完整跑完。
        // 真正的停止由 conditionalRoute 的 `iteration >= maxIterations` 控制，
        // recursionLimit 只是兜底（防止 conditionalRoute 有 bug 时无限循环）。
        // 注意：这是 1:1 映射，并不是把 25 次放宽成 50 次。
        const recursionLimit = Math.max(this.maxIterations * 2 + 2, 26);
        const streams = await graph.stream(input, {
            streamMode: ["updates", "messages"],
            recursionLimit: recursionLimit
        })
        for await (const chunk of streams) {
            // 多 streamMode 时每个 chunk 是 [mode, value] 元组，先解构再按mode分流
            const [mode, value] = chunk as [string, any]

            if (mode === 'messages') {
                // messages-mode 的 value 是 [messageChunk, metadata]
                const [msgChunk, metadata] = value
                if (metadata?.langgraph_node === 'agent') {
                    const token = msgChunk?.content ?? ""
                    if (token) yield { output: String(token) }
                }
                continue
            }

            if (mode === 'updates') {
                // updates-mode 的 value 是 { 节点名: partial update }
                if (value.tools) {
                    for (const step of value.tools.intermediateSteps ?? []) {
                        // 工具执行日志：统一在此记录（TUI/server 共用执行器，保证 agent.log 都有）
                        logAgent({
                            type: "tool_call",
                            message: `${step.action.tool}`,
                            details: truncateForLog(step.action.toolInput, 300),
                        });
                        logAgent({
                            type: "tool_result",
                            message: `${step.action.tool}`,
                            details: truncateForLog(step.observation, 300),
                        });
                        yield { intermediateSteps: [step] }
                    }
                } else if (value.finalize || value.fallback) {
                    const u = value.finalize ?? value.fallback
                    const kind = value.finalize ? "finalize" : "fallback"
                    logAgent({
                        type: "info",
                        message: `[Loop] ${kind} 完成`,
                        details: { outputChars: (u.finalOutput ?? "").length },
                    });
                    yield {
                        output: u.finalOutput,
                        intermediateSteps: u.intermediateSteps ?? []
                    }
                }
            }

        }
    }

    /**
     * worker子agent专用
     */
    public async run(input: string, workerPrompt: string): Promise<string>{
        this.tracer?.startSession(`[worker] ${input}`)

        const graph = this.createGraph()
        // recursionLimit = maxIterations*2 + 余量：与 conditionalRoute 的 maxIterations 1:1 对应
        const recursionLimit = Math.max(this.maxIterations * 2 + 2, 26);
        const result = await graph.invoke({
            messages: [new SystemMessage(workerPrompt), new HumanMessage(input)],
            userInput: input,
            iteration: 0,
            intermediateSteps: [],
        }, {
            recursionLimit: recursionLimit
        })
        const last = result.messages.at(-1);
        return extractText((last as AIMessage).content);
    }
}