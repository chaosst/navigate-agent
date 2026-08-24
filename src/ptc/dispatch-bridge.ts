import { StructuredToolInterface } from "@langchain/core/tools";
import { CodeBindingFunction, CodeBindingNamespace, CodeJsonValue } from "./types.js";
import { ToolFilter } from "../tools/tool-filter.js";
import { ToolStatsRegistry } from "../tools/stats-registry.js";
import { PermissionWrapper } from "../tools/permission.js";
import { Tracer } from "../agent/tracer.js";

/** 一次程序内子调用事件（对应 dsh 的 tool/code-dispatch） */
export interface PtcDispatchEvent {
    parentId: string;    // 所属 run_code 调用的确定性 id
    seq: number;         // 程序内提交序号（提交时分配，0 起）。并发执行时完成顺序 ≠ 提交顺序，
                         // 消费端按 (parentId, seq) 重排，保证展示与调用顺序一致
    tool: string;        // 子调用工具名
    input: unknown;      // 规范化参数（无损 JSON 快照）
    output: unknown;     // 规范化结果
    isError: boolean;    // 工具执行失败（程序收到 ToolCallError）
}

type DispatchListener = (ev: PtcDispatchEvent) => void;

/** 队列中的一个子调用 */
interface QueuedCall {
    tool: StructuredToolInterface
    args: unknown
    parentId: string
    seq: number          // 提交序号（入队时分配）
    resolve: (v: CodeJsonValue) => void
    reject: (e: unknown) => void
}

/**
 * DispatchBridge — 程序内 tools.x() 的并发有界分发层。
 *
 * 对标 dsh 的并发池模型（设计文档 §5.6）：
 * - 队列严格按提交顺序启动；
 * - 并行类工具最多重叠 maxParallelSubCalls 个（默认 10，1 恢复串行）；
 * - 排他工具（exclusiveTools，如 shell/写文件）排空池子后独占执行；
 * - 每个子调用产生一次 PtcDispatchEvent（onDispatch 订阅者消费，供 TUI/日志）。
 */
export class DispatchBridge {
    private queue: QueuedCall[] = []    // 待分发队列（严格按提交顺序启动）
    private inFlight = 0                // 当前在飞子调用数
    private maxParallelSubCalls: number
    private listeners = new Set<DispatchListener>();
    private tracer?: Tracer
    private runCounter = 0              // run_code 调用计数器 → parentId
    private submitSeq = 0               // 子调用提交计数器 → seq（提交顺序，与完成顺序解耦）
    private exclusiveTools: Set<string>
    private _subCallCount = 0           // 实际执行的子调用总数（统计上报用）
    private exclusiveInFlight = false   // 排他工具正在执行：所有其他调用必须等待

    constructor(
        private tools: StructuredToolInterface[],   // 全量工具
        private toolFilter?: ToolFilter,            // 动态权限过滤（复用系统当前现有）
        private stats?: ToolStatsRegistry,          // 调用统计（复用系统当前现有）
        tracer?: Tracer,
        maxParallelSubCalls = 10,                   // 默认 10；1 恢复串行
        exclusiveTools: Iterable<string> = [],      // 排他工具名（如 execute_command）
    ) {
        this.maxParallelSubCalls = maxParallelSubCalls
        this.tracer = tracer
        this.exclusiveTools = new Set(exclusiveTools)
    }

    /** 订阅子调用事件；返回取消函数 */
    onDispatch(listener: DispatchListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(ev: PtcDispatchEvent): void {
        for (const l of this.listeners) l(ev);
    }

    /** 只读暴露全量工具，供 buildPtcSystemPrompt() 生成 SDK 类型声明（见 5.3 / 5.7） */
    get sdkTools(): StructuredToolInterface[] {
        return this.tools;   // 即构造参数注入的全量工具
    }

    /** 已实际执行的子调用总数（供 PtcStats.subCalls 统计上报） */
    get subCallCount(): number {
        return this._subCallCount
    }

    /**
     * 构建程序可见的 bindings（工具名 → async 函数）。
     * 每次调用生成一个新的 parentId（一次 run_code = 一个 run id）。
     *
     * userInput 非空且配置了 toolFilter 时按关键词过滤（与外层一致）；
     * 为空时暴露全量工具 —— PTC 程序内工具的安全靠 PermissionWrapper 审批，
     * 关键词过滤是外层决策空间的优化，不适合在程序内二次截断。
     */
    buildBindings(userInput: string): CodeBindingNamespace {
        const parentId = `run_${++this.runCounter}`
        const functions: Record<string, CodeBindingFunction> = {}
        const activeTools = userInput && this.toolFilter ?
            this.toolFilter.filter(this.tools as PermissionWrapper[], userInput)
            : this.tools

        for (const tool of activeTools) {
            functions[tool.name] = (args: unknown): Promise<CodeJsonValue> => {
                // 进入分发队列（严格按提交顺序启动）
                return this.enqueue(tool, args, parentId);
            }
        }
        return {
            global: "tools",
            functions,
            errorClass: {
                name: "ToolCallError",
                memberNameProperty: "toolName"
            }
        }
    }

    /** 并发有界调度：入队后尝试泵出 */
    private async enqueue(tool: StructuredToolInterface, args: unknown, parentId: string): Promise<CodeJsonValue> {
        // seq 在提交（入队）时分配：程序内并发执行的完成顺序可能与提交顺序不同，
        // 消费端依赖 seq 把事件重排回调用顺序展示。
        const seq = ++this.submitSeq;
        return new Promise((resolve, reject) => {
            this.queue.push({ tool, args, parentId, seq, resolve, reject });
            this.pump(); // 满足条件即出队
        });
    }

    /**
     * 泵出队列：严格按提交顺序，但受并发槽与排他约束。
     * - 队首为排他工具 → 必须无任何在飞调用才执行（独占）；
     * - 其余工具 → 在飞数 < maxParallelSubCalls 即出队；
     * - 每个出队调用结束后递归 pump，直到队列空或条件不满足。
     */
    private async pump() {
        while (this.queue.length > 0) {
            const head = this.queue[0];
            const isExclusive = this.exclusiveTools.has(head.tool.name);

            // 排他工具正在执行：所有调用（含并行类）一律等待
            if (this.exclusiveInFlight) break;
            if (isExclusive) {
                if (this.inFlight > 0) break; // 排他工具还需无任何在飞调用
            } else if (this.inFlight >= this.maxParallelSubCalls) {
                break; // 并发槽满
            }

            const call = this.queue.shift()!;
            this.inFlight++;
            if (isExclusive) this.exclusiveInFlight = true;
            void this.runCall(call).finally(() => {
                this.inFlight--;
                if (isExclusive) this.exclusiveInFlight = false;
                this.pump(); // 继续泵
            });
        }
    }

    /** 执行单个出队调用，结算后 resolve/reject 对应 promise */
    private async runCall(call: QueuedCall): Promise<void> {
        try {
            const value = await this.invokeTool(call.tool, call.args, call.parentId, call.seq);
            call.resolve(value);
        } catch (err) {
            call.reject(err);
        }
    }

    /**
     * 结算：中止尚未启动的排队调用（reject），并等待在飞调用全部结束。
     * 在 run_code 执行完成后由宿主调用 —— 此时不会有新调用入队。
     */
    async drain(abort: AbortSignal): Promise<void> {
        // 中止未启动的排队调用
        while (this.queue.length > 0) {
            const call = this.queue.shift()!;
            call.reject(new Error(abort.aborted ? "Run aborted" : "Dispatch settled"));
        }
        // 等待在飞调用完成
        while (this.inFlight > 0) {
            await new Promise<void>((r) => setTimeout(r, 5));
        }
    }

    /**
     * 执行一次程序内工具调用：
     * 归一化参数 → 无损 JSON 校验 → tool.invoke → 结果无损化 →
     * 派发事件（onDispatch + tracer）→ 成功返回 JSON / 失败抛错（程序内变 ToolCallError）。
     */
    private async invokeTool(tool: StructuredToolInterface, args: unknown, parentId: string, seq: number): Promise<CodeJsonValue> {
        // 1. 归一化输入（对标 loop.ts normalizeToolInput：string → JSON.parse）
        const normalized = normalizeToolInput(args)
        // 2. 参数无损 JSON 校验（非 JSON 值 → 报 invalid 错误）
        toLosslessJson(normalized)

        try {
            // 3. 调用工具（PermissionWrapper 的审批/统计在其内部完成）
            const result = await tool.invoke(normalized)
            // 4. 结果无损化（undefined → null；BigInt/函数/循环引用 → 抛错）
            const json = toLosslessJson(result)
            this._subCallCount++
            // 5. 事件：onDispatch 订阅者（TUI）+ tracer
            this.emit({ parentId, seq, tool: tool.name, input: normalized, output: json, isError: false })
            this.tracer?.addPtcDispatch(parentId, tool.name, normalized, json, false, 0)
            return json
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            this._subCallCount++
            this.emit({ parentId, seq, tool: tool.name, input: normalized, output: message, isError: true })
            this.tracer?.addPtcDispatch(parentId, tool.name, normalized, message, true, 0)
            throw new Error(message) // 程序内被捕获为 ToolCallError
        }
    }
}

/** 归一化工具入参：字符串先尝试 JSON.parse，失败则包成 { input } */
function normalizeToolInput(input: unknown): unknown {
    if (typeof input === "string") {
        try {
            return JSON.parse(input) as unknown
        } catch {
            return { input }
        }
    }
    return input
}

/**
 * 无损 JSON 化：递归校验并转换任意值为 CodeJsonValue。
 * - undefined/null → null；非有限数字 / BigInt / 函数 / symbol / 循环引用 → 抛错
 */
function toLosslessJson(v: unknown, seen: Set<object> = new Set()): CodeJsonValue {
    if (v === null || v === undefined) return null
    if (typeof v === "boolean") return v
    if (typeof v === "string") return v
    if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new Error("Non-finite number is not lossless JSON")
        return v
    }
    if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") {
        throw new Error("Value is not lossless JSON")
    }
    if (typeof v === "object") {
        if (seen.has(v)) throw new Error("Circular reference is not lossless JSON")
        seen.add(v)
        try {
            if (Array.isArray(v)) {
                return v.map((x) => toLosslessJson(x, seen))
            }
            const out: Record<string, CodeJsonValue> = {}
            for (const [k, val] of Object.entries(v)) {
                out[k] = toLosslessJson(val, seen)
            }
            return out
        } finally {
            seen.delete(v)
        }
    }
    throw new Error("Value is not lossless JSON")
}
