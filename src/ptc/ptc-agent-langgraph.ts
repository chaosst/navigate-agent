import { ChatOpenAI } from "@langchain/openai";
import { StructuredToolInterface } from "@langchain/core/tools";
import { CodeRuntime } from "./types.js";
import { END, START, StateGraph } from "@langchain/langgraph";
import { PtcState, PtcStateType } from "../agent/types.js";
import { AIMessage, BaseMessage, SystemMessage } from "langchain";
import { GraphAgentExecutorBase, truncateForLog } from "../agent/graph-agent-executor.js";
import { TrackingToolNode } from "../agent/tracking-tool-node.js";
import { buildIterationExhaustedSummary, extractFinalAnswer, extractUserText, formatPtcStatsReport } from "../agent/graph-utils.js";
import { DispatchBridge, PtcDispatchEvent } from "./dispatch-bridge.js";
import { DispatchOrderBuffer } from "./dispatch-order-buffer.js";
import { buildPtcSystemPrompt } from "./prompts.js";
import { AgentStep } from "@langchain/core/agents";
import type { ToolStatsRegistry } from "../tools/stats-registry.js";
import { logAgent } from "../agent/logger.js";


export class PtcAgentLangGraph extends GraphAgentExecutorBase {
    private visibleTools: StructuredToolInterface[]
    private runtime: CodeRuntime
    private dispatchBridge: DispatchBridge;
    private graph: any
    /** run_code 结算回调的待合并统计（agent 节点每轮合并进 state.ptcStats） */
    private pendingStats = { programErrors: 0, consecutiveErrors: 0, subCalls: 0 }

    constructor(
        llm: ChatOpenAI,
        visibleTools: StructuredToolInterface[],
        maxIterations: number,
        runtime: CodeRuntime,
        dispatchBridge: DispatchBridge,
        llmTimeoutMs?: number,
        toolStatsRegistry?: ToolStatsRegistry,
    ){
        super(llm, visibleTools, maxIterations, llmTimeoutMs, undefined, undefined, toolStatsRegistry)
        this.visibleTools = visibleTools
        this.runtime = runtime
        this.dispatchBridge = dispatchBridge;

        // 绑定 RunCodeTool 的结算回调 → 更新待合并统计
        const runCodeTool = visibleTools.find((t) => t.name === "run_code") as
            | (StructuredToolInterface & { setStatsReporter?: (cb: (r: { kind: string; subCalls: number }) => void) => void })
            | undefined
        runCodeTool?.setStatsReporter?.((r) => {
            this.pendingStats.subCalls += r.subCalls
            if (r.kind === "ok") {
                this.pendingStats.consecutiveErrors = 0
            } else {
                this.pendingStats.programErrors += 1
                this.pendingStats.consecutiveErrors += 1
            }
        })
    }

    /** 覆写 agent 节点：合并 run_code 结算统计；发起 run_code 时递增 runCodeCalls */
    async agentNode(state: PtcStateType) {
        const result = await super.agentNode(state)
        const last = result.messages?.[result.messages.length - 1] as AIMessage | undefined
        const callsRunCode =
            (last?.tool_calls as unknown[] | undefined)?.some(
                (tc) => (tc as { name?: string }).name === "run_code",
            ) ?? false

        const ptcStats = { ...state.ptcStats }
        if (callsRunCode) ptcStats.runCodeCalls += 1
        ptcStats.subCalls += this.pendingStats.subCalls
        ptcStats.programErrors += this.pendingStats.programErrors
        ptcStats.consecutiveErrors = this.pendingStats.consecutiveErrors
        this.pendingStats = { programErrors: 0, consecutiveErrors: 0, subCalls: 0 }

        return { ...result, ptcStats }
    }

    /** 覆写路由：连续失败 >= 3 直接降级 fallback（设计 §5.9） */
    conditionalRoute(state: PtcStateType): "tools" | "finalize" | "fallback" {
        if (state.ptcStats.consecutiveErrors >= 3) {
            return "fallback"
        }
        return super.conditionalRoute(state)
    }

    private createGraph() {
        const toolNode = new TrackingToolNode(this.tools)
        return new StateGraph(PtcState)
            .addNode("agent", (s) => this.agentNode(s))
            .addNode("tools", toolNode)
            .addNode("finalize", (s) => this.finalizeNode(s))
            .addNode("fallback", (s) => this.fallbackNode(s))
            .addEdge(START, "agent")
            .addConditionalEdges("agent", (s) => this.conditionalRoute(s))
            .addEdge("tools", "agent")
            .addEdge("finalize", END)
            .addEdge("fallback", END)
            .compile()
    }

    private finalizeNode(state: PtcStateType) {
        let output = extractFinalAnswer(state.messages) + "\n\n" + formatPtcStatsReport(state.ptcStats);
        // 追加工具统计 + token 消耗（与普通/plan 模式统一；须在 finishSession 前）
        output += this.buildStatsFooter();
        this.tracer?.finishSession();
        return { messages: [new AIMessage(output)], ptcStats: state.ptcStats };
    }

    private fallbackNode(state: PtcStateType) {
        let fallback = buildIterationExhaustedSummary(state.iteration, state.intermediateSteps) +
          "\n\nrun_code 调用 " + state.ptcStats.runCodeCalls +
          " 次，子调用 " + state.ptcStats.subCalls + " 次";
        fallback += this.buildStatsFooter();
        this.tracer?.finishSession();
        return { messages: [new AIMessage(fallback)], ptcStats: state.ptcStats };
      }
    
    async *stream(params: { messages: BaseMessage[]; config?: {} }) {
        const graph = this.createGraph()
        // 1. 初始化状态：PTC_SYSTEM_PROMPT + SDK 声明注入；ptcStats 从零开始
        const input: PtcStateType = {
            messages: [new SystemMessage(buildPtcSystemPrompt(this.dispatchBridge.sdkTools)), ...params.messages],
            userInput: extractUserText(params.messages),
            iteration: 0,
            intermediateSteps: [],
            ptcStats: {
                runCodeCalls: 0,        // run_code 外层调用次数
                subCalls: 0,            // 程序内工具子调用总数（跨所有 run_code 累积）
                programErrors: 0,       // 程序执行失败次数（六类 CodeRunFailure 任一）
                consecutiveErrors: 0   // 连续失败次数；>= 3 时路由至 fallback
            } 
        }

        // 2. 订阅分发桥子调用事件（程序内 tools.x() → ptcDispatch 块）
        //    用 DispatchOrderBuffer 重排：并发子调用完成顺序 ≠ 提交顺序，
        //    缓冲器按 (parentId, seq) 还原成调用顺序，避免「最早调用显示在最下方」。
        const orderBuffer = new DispatchOrderBuffer();
        const unsubscribe = this.dispatchBridge.onDispatch((ev) => {
            orderBuffer.push(ev);
        });

        try {
            // 3. 与普通模式相同的双 mode 流：["updates", "messages"]
            // recursionLimit = maxIterations*2 + 余量：每轮 = agent + tools ≈ 2 超步，
            // 与 conditionalRoute 的 maxIterations 1:1 对应（不是放宽成 2 倍次数）。
            const recursionLimit = Math.max(this.maxIterations * 2 + 2, 26);
            const streams = await graph.stream(input, {
                streamMode: ["updates", "messages"],
                recursionLimit: recursionLimit
            })
            for await (const chunk of streams) {
                // 多 streamMode 时每个 chunk 是 [mode, value] 元组，先解构再按mode分流
                const [mode, value] = chunk
                if (mode === 'messages') {
                    // messages-mode 的 value 是 [messageChunk, metadata]
                    const [msgChunk, metadata] = value
                    if (metadata?.langgraph_node === 'agent') {
                        const token = msgChunk?.content ?? ""
                        // 中间轮次的叙述文字只做动态预览（outputPreview），不进入最终回答。
                        // 若与 finalize 的 output 混用，会污染最终 assistant 消息（拼接重复/乱序）。
                        if (token) yield { outputPreview: String(token) }
                    }
                    continue
                }

                if (mode === 'updates') {
                    // updates-mode 的 value 是 { 节点名: partial update }
                    if (value.tools) {
                        for (const step of (value.tools.intermediateSteps ?? []) as AgentStep[]) {
                            // 工具执行日志：与普通模式统一（run_code 外层调用 + 内部子调用由 ptcDispatch 事件日志覆盖）
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
                            if (step.action.tool === "run_code") {
                                const input = step.action.toolInput as { code?: string, description?: string }
                                yield {
                                    ptcProgram: { code: input.code ?? "", description: input.description ?? "" }
                                }
                            }
                            yield { intermediateSteps: [step] } // 与普通模式共用同一块结构
                        }
                    }
                    // finalize / fallback：产出最终答案 + 统计（节点返回值带 ptcStats，见下）
                    else if (value.finalize || value.fallback) {
                        const u = value.finalize ?? value.fallback
                        const last = u?.messages?.[u.messages.length -1]
                        logAgent({
                            type: "info",
                            message: `[PTC-Loop] ${value.finalize ? "finalize" : "fallback"} 完成`,
                            details: { runCodeCalls: u?.ptcStats?.runCodeCalls, subCalls: u?.ptcStats?.subCalls },
                        });
                        yield {
                            output: last?._getType() === "ai" ? String(last.content) : "",
                            ptcStats: u?.ptcStats
                        }
                    }
                }

                // 4. 每个 chunk 后排空已就绪的子调用事件（run_code 执行期间产生的事件在此被转发）
                for (const ev of orderBuffer.drain()) {
                    yield { ptcDispatch: ev };
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);

            // 检测是否为递归限制错误
            if (errMsg.includes("Recursion limit") || errMsg.includes("recursion")) {
                // 提取最后几条消息，构建任务总结
                const lastMessages = params.messages.slice(-5);
                const summary = lastMessages
                    .map(m => {
                        const type = m._getType();
                        const content = typeof m.content === 'string' ? m.content.substring(0, 100) : '';
                        return `${type}: ${content}...`;
                    })
                    .join("\n");

                yield {
                    output: `[PTC 任务中断] 达到递归限制（${this.maxIterations * 2} 次迭代）。\n\n` +
                        `这通常是因为：\n` +
                        `1. 任务过于复杂，需要分解为更小的步骤\n` +
                        `2. 遇到了重复工具调用的循环\n` +
                        `3. 工具持续返回错误，无法找到正确的解决方案\n\n` +
                        `最近的对话上下文：\n${summary}\n\n` +
                        `建议：\n` +
                        `- 将任务拆分为多个小任务分别完成\n` +
                        `- 检查是否有重复的工具调用模式\n` +
                        `- 提供更具体的指令或参数\n` +
                        `- 如果需要更高的迭代次数，可以调整 MAX_ITERATIONS 配置`
                };
            } else {
                yield { output: `[PTC Error] ${errMsg}` };
            }
        } finally {
            // 5. 无论成功失败都取消订阅，避免泄漏
            unsubscribe();
        }                                // 统计
    }
    
    async dispose() { await this.runtime.dispose(); }
}