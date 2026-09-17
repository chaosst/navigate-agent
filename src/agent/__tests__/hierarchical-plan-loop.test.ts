/**
 * plan 模式（双层循环）回归锁 —— 2026-09-17 四项修复：
 *
 *  1. totalTokens 是**加法 reducer**，节点只能返回增量。
 *     旧实现返回 `state.totalTokens + tokensUsed` 会被二次累加（已用最小图实证），
 *     多步计划下预算翻倍消耗、过早 fallback。
 *  2. 内层 ReAct 每轮全量重发消息，单步实测烧到 163k tokens。
 *     改为「最近 N 组 + 单条截断」的受限视图，且必须保持 tool_call 配对完整。
 *  3. ReAct 迭代耗尽、一个字都没产出时，旧实现兜底成 "Step completed" 并标 completed ——
 *     什么都没做却显示 ✅。现在必须标 failed。
 *  4. 预算中断的 fallback 旧实现只吐 "Progress: 1/5"，
 *     看不出为什么停；现在要说清「因什么中断 / 停在第几步」。
 *  5. 规划器 steps 缺 description（或拿 "step_1" 冒充）时用占位描述并告警，
 *     不能让任务列表静默退化成只有编号。
 */
import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { HierarchicalAgentLangGraph } from "../hierarchical-agent-langgraph.js";
import type { ExecutionPlan, PlanStep } from "../types.js";

/** 每次成功的 LLM 调用记账（input 100 + output 20 = 120） */
const USAGE_IN = 100;
const USAGE_OUT = 20;
const USAGE_TOTAL = USAGE_IN + USAGE_OUT;

/** 带 usage 的 AI 消息 */
function ai(content: string, toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]): AIMessage {
    const msg = new AIMessage({ content, tool_calls: toolCalls ?? [] });
    (msg as unknown as { usage_metadata: unknown }).usage_metadata = {
        input_tokens: USAGE_IN,
        output_tokens: USAGE_OUT,
        total_tokens: USAGE_TOTAL,
    };
    return msg;
}

/** 按「第几次调用」返回脚本化响应的假 LLM */
class ScriptedLLM {
    calls = 0;
    /** 每次调用收到的消息（供断言「产出提醒」是否注入） */
    seen: BaseMessage[][] = [];
    constructor(private script: (call: number) => AIMessage) {}
    bindTools(): this { return this; }
    async invoke(messages: BaseMessage[] = []): Promise<AIMessage> {
        this.calls += 1;
        this.seen.push(messages);
        return this.script(this.calls);
    }
}

const dummyTool = {
    name: "dummy",
    invoke: async () => "tool-result",
} as unknown as never;

function makeAgent(
    llm: unknown,
    contextWindow?: Record<string, number>,
    tools: unknown[] = [dummyTool],
): HierarchicalAgentLangGraph {
    return new HierarchicalAgentLangGraph(
        llm as ChatOpenAI,
        tools as never,
        undefined,
        undefined,
        5_000,
        undefined,
        { maxTokens: 500_000, maxTimeMs: 900_000, maxSteps: 20 },
        contextWindow as never,
    );
}

function stepOf(overrides: Partial<PlanStep> = {}): PlanStep {
    return { id: "s1", description: "做一件事", status: "pending", ...overrides };
}

function planOf(steps: PlanStep[]): ExecutionPlan {
    return { goal: "目标", steps, currentStepIndex: 0, createdAt: Date.now(), updatedAt: Date.now() };
}

function dualState(overrides: Record<string, unknown> = {}): never {
    return {
        messages: [new HumanMessage("用户请求")],
        intermediateSteps: [],
        plan: planOf([stepOf()]),
        plannerOutput: null,
        currentStepIndex: 0,
        totalTokens: 0,
        startTime: Date.now(),
        maxTokens: 500_000,
        maxTimeMs: 900_000,
        maxSteps: 20,
        ...overrides,
    } as never;
}

/** 构造 N 组「AIMessage(tool_calls) + ToolMessage」历史 */
function buildHistory(rounds: number, resultLen = 200): BaseMessage[] {
    const msgs: BaseMessage[] = [new SystemMessage("EXECUTOR"), new HumanMessage("执行步骤")];
    for (let i = 0; i < rounds; i++) {
        msgs.push(ai("", [{ id: `c${i}`, name: "dummy", args: {} }]));
        msgs.push(new ToolMessage(`r${i}-` + "x".repeat(resultLen), `c${i}`));
    }
    return msgs;
}

describe("plan 模式：内层 ReAct 上下文窗口", () => {
    it("按组裁剪：头部固定、只留最近 N 组、tool_call 配对完整", () => {
        const agent = makeAgent(new ScriptedLLM(() => ai("x")), {
            recentGroups: 2,
            maxToolResultChars: 100_000,
            maxContextChars: 1_000_000,
        }) as unknown as { buildExecutorWindow(m: BaseMessage[]): BaseMessage[] };

        const win = agent.buildExecutorWindow(buildHistory(5));

        // 头部 2 条 + 最近 2 组（各 2 条）
        expect(win).toHaveLength(2 + 2 * 2);
        expect(win[0]._getType()).toBe("system");
        expect(win[1]._getType()).toBe("human");

        // 最新的第 5 组还在，最旧的第 1 组已被裁掉
        const ids = win.filter((m) => m._getType() === "tool").map((m) => (m as ToolMessage).tool_call_id);
        expect(ids).toContain("c4");
        expect(ids).not.toContain("c1");

        // 配对完整：每个带 tool_calls 的 AIMessage 都能在窗口内找到全部 ToolMessage
        for (const msg of win) {
            if (msg._getType() !== "ai") continue;
            for (const tc of (msg as AIMessage).tool_calls ?? []) {
                expect(win.some((m) => m._getType() === "tool" && (m as ToolMessage).tool_call_id === tc.id))
                    .toBe(true);
            }
        }
    });

    it("单条工具结果超限做头尾截断，且不改动原消息", () => {
        const agent = makeAgent(new ScriptedLLM(() => ai("x")), {
            recentGroups: 5,
            maxToolResultChars: 50,
            maxContextChars: 1_000_000,
        }) as unknown as { buildExecutorWindow(m: BaseMessage[]): BaseMessage[] };

        const history = buildHistory(1, 500);
        const original = history[3] as ToolMessage;
        const win = agent.buildExecutorWindow(history);
        const copy = win.find((m) => m._getType() === "tool") as ToolMessage;

        expect(copy.content.length).toBeLessThan(120);
        expect(String(copy.content)).toContain("已截断");
        expect(copy.tool_call_id).toBe(original.tool_call_id);
        // 原消息保留完整内容（intermediateSteps / 统计仍用它）
        expect(String(original.content).length).toBeGreaterThan(500);
    });

    it("字符上限触发时至少保留最新一组，不会裁成空窗口", () => {
        const agent = makeAgent(new ScriptedLLM(() => ai("x")), {
            recentGroups: 10,
            maxToolResultChars: 100_000,
            maxContextChars: 10,
        }) as unknown as { buildExecutorWindow(m: BaseMessage[]): BaseMessage[] };

        const win = agent.buildExecutorWindow(buildHistory(4, 500));
        const ids = win.filter((m) => m._getType() === "tool").map((m) => (m as ToolMessage).tool_call_id);
        expect(ids).toEqual(["c3"]);
    });
});

describe("plan 模式：步骤产出与状态", () => {
    it("ReAct 迭代耗尽仍全是工具调用 → completed=false 且 result 不冒充完成", async () => {
        const llm = new ScriptedLLM(() => ai("", [{ id: "c", name: "dummy", args: {} }]));
        const agent = makeAgent(llm) as unknown as {
            executeStep(s: PlanStep, m: BaseMessage[], n: number): Promise<{
                result: string; tokensUsed: number; completed: boolean; iterations: number;
            }>;
        };

        const out = await agent.executeStep(stepOf(), [], 3);

        expect(out.completed).toBe(false);
        expect(out.iterations).toBe(3);
        expect(out.tokensUsed).toBe(3 * USAGE_TOTAL);
        expect(out.result).not.toContain("Step completed");
        expect(out.result).toContain("未产出内容");
    });

    it("正常产出 → completed=true，result 是模型原文", async () => {
        const llm = new ScriptedLLM((call) =>
            call === 1 ? ai("", [{ id: "c", name: "dummy", args: {} }]) : ai("最终结果"));
        const agent = makeAgent(llm) as unknown as {
            executeStep(s: PlanStep, m: BaseMessage[], n: number): Promise<{
                result: string; tokensUsed: number; completed: boolean; iterations: number;
            }>;
        };

        const out = await agent.executeStep(stepOf(), [], 5);

        expect(out.completed).toBe(true);
        expect(out.iterations).toBe(2);
        expect(out.result).toBe("最终结果");
        expect(out.tokensUsed).toBe(2 * USAGE_TOTAL);
    });

    it("executorNode 只返回 token 增量（加法 reducer 下不能被二次累加）", async () => {
        const llm = new ScriptedLLM((call) =>
            call === 1 ? ai("", [{ id: "c", name: "dummy", args: {} }]) : ai("done"));
        const agent = makeAgent(llm) as unknown as {
            executorNode(s: unknown): Promise<{ totalTokens: number; plan: ExecutionPlan }>;
        };

        const out = await agent.executorNode(dualState({ totalTokens: 1_000 }));

        // 本步真实消耗 2 轮 × 120；若返回全量会变成 1000 + 240
        expect(out.totalTokens).toBe(2 * USAGE_TOTAL);
        expect(out.plan.steps[0].status).toBe("completed");
    });

    it("零产出步骤标 failed 并写明原因", async () => {
        const llm = new ScriptedLLM(() => ai("", [{ id: "c", name: "dummy", args: {} }]));
        const agent = makeAgent(llm) as unknown as {
            executorNode(s: unknown): Promise<{ totalTokens: number; plan: ExecutionPlan }>;
        };

        const out = await agent.executorNode(dualState());

        expect(out.plan.steps[0].status).toBe("failed");
        expect(out.plan.steps[0].error).toContain("未产出结果");
    });

    it("跑到一半仍全是工具调用 → 注入产出提醒后可收口", async () => {
        const llm = new ScriptedLLM((call) =>
            call <= 2 ? ai("", [{ id: `c${call}`, name: "dummy", args: {} }]) : ai("汇总结果"));
        const agent = makeAgent(llm) as unknown as {
            executeStep(s: PlanStep, m: BaseMessage[], n: number): Promise<{
                result: string; completed: boolean; iterations: number;
            }>;
        };

        const out = await agent.executeStep(stepOf(), [], 6);

        expect(out.completed).toBe(true);
        expect(out.result).toBe("汇总结果");
        // maxIterations=6 → 提醒在第 ceil(6/2)=3 轮注入
        const thirdRequest = llm.seen[2];
        expect(
            thirdRequest.some((m) =>
                m._getType() === "human" && String(m.content).includes("不要再调用工具")),
        ).toBe(true);
    });

    it("最后一轮强制不绑工具，保证至少一次文本收口", async () => {
        const llm = new ToolAwareLLM("兜底结论");
        const agent = makeAgent(llm as never) as unknown as {
            executeStep(s: PlanStep, m: BaseMessage[], n: number): Promise<{
                result: string; completed: boolean; iterations: number;
            }>;
        };

        const out = await agent.executeStep(stepOf(), [], 4);

        expect(llm.boundCalls).toBe(3);   // 前 3 轮带工具
        expect(llm.plainCalls).toBe(1);   // 最后一轮裸调用收口
        expect(out.completed).toBe(true);
        expect(out.result).toBe("兜底结论");
    });
});

describe("plan 模式：预算判定与中断文案", () => {
    const agent = makeAgent(new ScriptedLLM(() => ai("x"))) as unknown as {
        getExhaustion(s: unknown): { reason: string; message: string } | null;
        generateFallbackAnswer(s: unknown, e: unknown): string;
    };

    it("token 超限判为 tokens 耗尽，未超限返回 null", () => {
        expect(agent.getExhaustion(dualState({ totalTokens: 600_000, maxTokens: 500_000 }))?.reason)
            .toBe("tokens");
        expect(agent.getExhaustion(dualState({ totalTokens: 10 }))).toBeNull();
    });

    it("时间超限判为 time 耗尽", () => {
        const info = agent.getExhaustion(dualState({ startTime: Date.now() - 999_999, maxTimeMs: 1_000 }));
        expect(info?.reason).toBe("time");
    });

    it("fallback 文案说清中断原因、进度与未完成步骤", () => {
        const state = dualState({
            totalTokens: 612_345,
            maxTokens: 500_000,
            currentStepIndex: 1,
            plan: planOf([
                stepOf({ id: "s1", description: "检索游船班次", status: "completed" }),
                stepOf({ id: "s2", description: "写露营清单", status: "failed", error: "未产出结果" }),
                stepOf({ id: "s3", description: "汇总攻略", status: "pending" }),
            ]),
        });

        const answer = agent.generateFallbackAnswer(state, agent.getExhaustion(state));

        expect(answer).toContain("token 预算耗尽");
        expect(answer).toContain("612345/500000");
        expect(answer).toContain("检索游船班次");
        expect(answer).toContain("写露营清单");
        expect(answer).toContain("汇总攻略");
        expect(answer).toContain("PLAN_MAX_TOKENS");
    });
});

describe("plan 模式：规划器输出归一化", () => {
    const plannerResponse = (steps: unknown[]) => {
        const msg = new AIMessage({
            content: JSON.stringify({ action: "create_plan", plan: { goal: "目标", steps } }),
        });
        (msg as unknown as { usage_metadata: unknown }).usage_metadata = {
            input_tokens: 10, output_tokens: 5, total_tokens: 15,
        };
        return msg;
    };

    it("description 缺失或用编号冒充 → 占位描述 + 计入 tokens", async () => {
        const llm = new ScriptedLLM(() => plannerResponse([
            { stepId: "step_1", description: "step_1" },
            { id: "s2", description: "读文件" },
        ]));
        const agent = makeAgent(llm) as unknown as {
            callPlanner(m: BaseMessage[], p: ExecutionPlan): Promise<{
                output: { plan?: ExecutionPlan }; tokensUsed: number;
            }>;
        };

        const { output, tokensUsed } = await agent.callPlanner(
            [new HumanMessage("hi")],
            planOf([]),
        );

        expect(tokensUsed).toBe(15);
        expect(output.plan!.steps[0].description).not.toBe("step_1");
        expect(output.plan!.steps[0].description).toContain("未给出描述");
        expect(output.plan!.steps[1].description).toBe("读文件");
    });

    it("正常 description 原样保留", async () => {
        const llm = new ScriptedLLM(() => plannerResponse([
            { id: "s1", description: "检索万绿湖游船班次" },
        ]));
        const agent = makeAgent(llm) as unknown as {
            callPlanner(m: BaseMessage[], p: ExecutionPlan): Promise<{
                output: { plan?: ExecutionPlan };
            }>;
        };

        const { output } = await agent.callPlanner([new HumanMessage("hi")], planOf([]));
        expect(output.plan!.steps[0].description).toBe("检索万绿湖游船班次");
    });
});

/** 能区分「已绑定工具」与「裸调用」的假 LLM（验证最后一轮强制收口） */
class ToolAwareLLM {
    boundCalls = 0;
    plainCalls = 0;
    constructor(private finalContent: string) {}
    bindTools(): { invoke(): Promise<AIMessage> } {
        return {
            invoke: async () => {
                this.boundCalls += 1;
                return ai("", [{ id: `b${this.boundCalls}`, name: "dummy", args: {} }]);
            },
        };
    }
    async invoke(): Promise<AIMessage> {
        this.plainCalls += 1;
        return ai(this.finalContent);
    }
}

describe("plan 模式：预算默认值可配置", () => {
    it("未传 budget → 默认 500k / 900s / 20 步", () => {
        const agent = new HierarchicalAgentLangGraph(
            new ScriptedLLM(() => ai("x")) as unknown as ChatOpenAI,
            [] as never,
        ) as unknown as { budget: { maxTokens: number; maxTimeMs: number; maxSteps: number } };

        expect(agent.budget).toEqual({ maxTokens: 500_000, maxTimeMs: 900_000, maxSteps: 20 });
    });

    it("传入 budget 只覆盖给定项（PLAN_MAX_TOKENS 等 env 由此生效）", () => {
        const agent = new HierarchicalAgentLangGraph(
            new ScriptedLLM(() => ai("x")) as unknown as ChatOpenAI,
            [] as never,
            undefined,
            undefined,
            5_000,
            undefined,
            { maxTokens: 42 },
        ) as unknown as { budget: { maxTokens: number; maxTimeMs: number; maxSteps: number } };

        expect(agent.budget).toEqual({ maxTokens: 42, maxTimeMs: 900_000, maxSteps: 20 });
    });
});

/** 图级假 LLM：按 system prompt 区分规划器 / 执行器，脚本化推进两步计划 */
class GraphLLM {
    plannerCalls = 0;
    executorCalls = 0;
    bindTools(): this { return this; }
    async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        const sys = String(messages[0]?.content ?? "");
        if (sys.includes("任务执行器")) {
            this.executorCalls += 1;
            return ai(`步骤结果 ${this.executorCalls}`);
        }
        this.plannerCalls += 1;
        // 1: 建计划（2 步）  2: 推进到第 2 步  3: finalize 里的「生成最终答案」
        if (this.plannerCalls === 1) {
            return ai(JSON.stringify({
                action: "create_plan",
                plan: {
                    goal: "写攻略",
                    steps: [
                        { id: "s1", description: "第一步" },
                        { id: "s2", description: "第二步" },
                    ],
                },
            }));
        }
        if (this.plannerCalls === 2) {
            return ai(JSON.stringify({ action: "execute_step", stepToExecute: 1 }));
        }
        return ai("最终答案");
    }
}

async function runStream(maxTokens: number): Promise<{ chunks: any[]; llm: GraphLLM }> {
    const llm = new GraphLLM();
    const agent = new HierarchicalAgentLangGraph(
        llm as unknown as ChatOpenAI,
        [] as never,
        undefined,
        undefined,
        5_000,
        undefined,
        { maxTokens, maxTimeMs: 900_000, maxSteps: 20 },
    );
    const chunks: any[] = [];
    for await (const c of (agent as any).stream({ messages: [new HumanMessage("做个攻略")] })) {
        chunks.push(c);
    }
    return { chunks, llm };
}

describe("plan 模式：图级推进（回归「第一步之后不继续」）", () => {
    it("预算充足：两步都被调度，最终 finalize", async () => {
        const { chunks, llm } = await runStream(500_000);
        const output = chunks.filter((c) => c.output).map((c) => c.output).join("");
        const lastPlan = chunks.filter((c) => c.plan).pop()?.plan as ExecutionPlan;

        expect(llm.executorCalls).toBe(2);
        expect(lastPlan.steps.every((s) => s.status === "completed")).toBe(true);
        expect(output).toContain("最终答案");
        expect(output).not.toContain("任务未完成");
    });

    it("预算不足：停在第一步并说明因 token 预算中断", async () => {
        const { chunks, llm } = await runStream(200);
        const output = chunks.filter((c) => c.output).map((c) => c.output).join("");

        // 第一步执行后累计即超预算 → 第二步拿不到调度
        expect(llm.executorCalls).toBe(1);
        expect(output).toContain("token 预算耗尽");
        expect(output).toContain("1/2");
    });
});
