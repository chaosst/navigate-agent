import { ChatOpenAI } from "@langchain/openai";
import { StructuredToolInterface } from "@langchain/core/tools";
import { CodeRuntime } from "./types.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { END, START, StateGraph } from "@langchain/langgraph";
import { PtcState, PtcStateType } from "../agent/types.js";
import { AIMessage, BaseMessage, SystemMessage } from "langchain";
import { GraphAgentExecutorBase } from "../agent/graph-agent-executor.js";
import { buildIterationExhaustedSummary, extractFinalAnswer, extractUserText, formatPtcStatsReport } from "../agent/graph-utils.js";
import { DispatchBridge, PtcDispatchEvent } from "./dispatch-bridge.js";
import { buildPtcSystemPrompt } from "./prompts.js";
import { AgentStep } from "@langchain/core/agents";


export class PtcAgentLangGraph extends GraphAgentExecutorBase {
    private visibleTools: StructuredToolInterface[]
    private runtime: CodeRuntime
    private dispatchBridge: DispatchBridge;
    private graph: any

    constructor(
        llm: ChatOpenAI,
        visibleTools: StructuredToolInterface[],
        maxIterations: number,
        runtime: CodeRuntime,
        dispatchBridge: DispatchBridge
    ){
        super(llm, visibleTools, maxIterations)
        this.visibleTools = visibleTools
        this.runtime = runtime
        this.dispatchBridge = dispatchBridge;
    }

    private createGraph() {
        const toolNode = new ToolNode(this.tools)
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
        this.tracer?.finishSession();
        return { messages: [new AIMessage(output)], ptcStats: state.ptcStats };
    }

    private fallbackNode(state: PtcStateType) {
        const fallback = buildIterationExhaustedSummary(state.iteration, state.intermediateSteps) +
          "\n\nrun_code 调用 " + state.ptcStats.runCodeCalls +
          " 次，子调用 " + state.ptcStats.subCalls + " 次";
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
        //    用队列缓冲：yield 只能发生在生成器体内，回调里先入队、循环里排空
        const pendingDispatches: PtcDispatchEvent[] = [];
        const unsubscribe = this.dispatchBridge.onDispatch((ev) => {
            pendingDispatches.push(ev);
        });

        try {
            // 3. 与普通模式相同的双 mode 流：["updates", "messages"]
            const streams = await graph.stream(input, {
                streamMode: ["updates", "messages"]
            })
            for await (const chunk of streams) {
                // 多 streamMode 时每个 chunk 是 [mode, value] 元组，先解构再按mode分流
                const [mode, value] = chunk
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
                        for (const step of (value.tools.intermediateSteps ?? []) as AgentStep[]) {
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
                        yield {
                            output: last?._getType() === "ai" ? String(last.content) : "", 
                            ptcStats: u?.ptcStats
                        }
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
        }                                // 统计
    }
    
    async dispose() { await this.runtime.dispose(); }
}