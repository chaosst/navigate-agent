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

        const modelWithTools = this.llm.bindTools(activeTools)

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

        return {
            messages: [response],
            iteration: state.iteration + 1
        }
    }

    conditionalRoute(state: AgentStateType): "tools" | "finalize" | "fallback" {
        const lastMessage = state.messages[state.messages.length - 1]
        // AIMessage 才有 tool_calls；没有工具请求时 LangChain 给的是 [] 或 undefined
        const hasToolCalls = !!(lastMessage && "tool_calls" in lastMessage && (lastMessage.tool_calls as unknown[]).length)

        if (!hasToolCalls) {
            return 'finalize'
        }
        if (state.iteration >= this.maxIterations) {
            return 'fallback'
        }
        return "tools"
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
        const streams = await graph.stream(input, {
            streamMode: ["updates", "messages"]
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
                        yield { intermediateSteps: [step] }
                    }
                } else if (value.finalize || value.fallback) {
                    const u = value.finalize ?? value.fallback
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

        const result = await graph.invoke({
            messages: [new SystemMessage(workerPrompt), new HumanMessage(input)],
            userInput: input,
            iteration: 0,
            intermediateSteps: [],
        })
        const last = result.messages.at(-1);
        return extractText((last as AIMessage).content);
    }
}