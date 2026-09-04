/**
 * 循环保护器 replan 出口 + executor token 级遥测（benchmark §4 改进点 1/2）单测
 *
 * 覆盖场景（全部 mock 消息链，不联网）：
 *  1. 无进展循环命中且 replan 预算>0 → 注入「[重规划]」结构化反馈后仍走 LLM（不硬停）
 *  2. replan 后仍原样重复 → 预算耗尽 → 硬停（不再调 LLM，返回 [任务中断]）
 *  3. REPLAN_LIMIT=0 → 关闭 replan，直接硬停（旧行为回归）
 *  4. 无重复消息 → 正常 invoke，无 replan 提示注入
 *  5. 遥测：agentNode 累计记账 / run() 入口按 run 重置
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { GraphAgentExecutor } from "../graph-agent-executor.js";

/** 一次成功响应的 usage 值（input/output 固定，便于断言累计） */
const USAGE_IN = 100;
const USAGE_OUT = 20;

/** 构造 3 次「同 tool+args 且结果不变」的无进展消息链（触发 detectNoProgressLoop） */
function buildRepeatHistory(rounds: number, result = "same-result"): BaseMessage[] {
    const msgs: BaseMessage[] = [
        new SystemMessage("你是测试 agent"),
        new HumanMessage("请读取 /data/a.txt 并总结"),
    ];
    for (let i = 0; i < rounds; i++) {
        msgs.push(
            new AIMessage({
                content: "",
                tool_calls: [{ id: `call_${i}`, name: "read_file", args: { path: "/data/a.txt" } }],
            }),
        );
        msgs.push(new ToolMessage(result, `call_${i}`));
    }
    return msgs;
}

/** agentNode 的 state 形状（plain object 即可直接调方法，不必跑图） */
function stateOf(messages: BaseMessage[]): Record<string, unknown> {
    return {
        messages,
        userInput: "请读取 /data/a.txt 并总结",
        iteration: 0,
        intermediateSteps: [],
    };
}

/** 成功响应的 AI 消息（附带 usage_metadata，供遥测记账） */
function okResponse(content: string): AIMessage {
    const ai = new AIMessage({ content });
    (ai as unknown as { usage_metadata: unknown }).usage_metadata = {
        input_tokens: USAGE_IN,
        output_tokens: USAGE_OUT,
        total_tokens: USAGE_IN + USAGE_OUT,
    };
    return ai;
}

/** mock ChatOpenAI：bindTools → {invoke}，invoke 与裸 llm.invoke（recovery 分支）共用同一 mock */
function makeFakeLlm(respond: (messages: BaseMessage[]) => AIMessage) {
    const invokeMock = vi.fn(async (messages: BaseMessage[]) => respond(messages));
    const llm = {
        bindTools: vi.fn(() => ({ invoke: invokeMock })),
        invoke: invokeMock,
    };
    return { llm: llm as unknown as ChatOpenAI, invokeMock };
}

/** 取某次 invoke 实际收到的消息数组（bindTools 的 invoke 第一个参数） */
function sentMessages(invokeMock: ReturnType<typeof vi.fn>): BaseMessage[] {
    return invokeMock.mock.calls[0]![0] as BaseMessage[];
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("循环保护器 replan 出口", () => {
    it("命中且预算>0：注入结构化 [重规划] 反馈后仍调 LLM（不硬停）", async () => {
        const { llm, invokeMock } = makeFakeLlm((msgs) => {
            // 模型收到 replan 提示后给出修正后的最终答复
            expect(msgs.at(-1)?.content).toContain("[重规划]");
            return okResponse("已用不同方式读取成功：/data/a.txt 内容为 same-result");
        });
        const executor = new GraphAgentExecutor(llm, [], "系统提示", 10);
        const messages = buildRepeatHistory(3);

        const out = await executor.agentNode(stateOf(messages) as never);

        // LLM 被调用一次，输入 = 历史 + 1 条 replan SystemMessage
        expect(invokeMock).toHaveBeenCalledTimes(1);
        const sent = sentMessages(invokeMock);
        expect(sent).toHaveLength(messages.length + 1);
        const hint = sent.at(-1) as SystemMessage;
        expect(hint._getType()).toBe("system");
        const text = String(hint.content);
        expect(text).toContain("[重规划]");
        expect(text).toContain("read_file");          // 被暂停的重复调用
        expect(text).toContain("same-result");        // 最后一次工具返回的事实
        expect(text).toContain("严禁再次发起与上面完全相同的调用");

        // 未硬停：返回的是 LLM 响应而非 [任务中断]
        const resp = out.messages[0] as AIMessage;
        expect(String(resp.content)).toContain("已用不同方式读取成功");
        expect(out.iteration).toBe(1);

        // 遥测同时记账
        expect(executor.getUsage()).toEqual({ llmCalls: 1, inputTokens: USAGE_IN, outputTokens: USAGE_OUT });
    });

    it("replan 后仍原样重复 → 预算耗尽 → 硬停（不再调 LLM）", async () => {
        const { llm, invokeMock } = makeFakeLlm((msgs) => {
            expect(msgs.at(-1)?.content).toContain("[重规划]");
            return okResponse("好的，我换个思路");
        });
        const executor = new GraphAgentExecutor(llm, [], "系统提示", 10);
        const messages = buildRepeatHistory(3);

        // 第一轮：replan 机会被使用（预算 1 → 0）
        await executor.agentNode(stateOf(messages) as never);
        expect(invokeMock).toHaveBeenCalledTimes(1);

        // 第二轮：模型仍原样重复（同参同结果）→ 预算耗尽 → 引擎硬停
        const out2 = await executor.agentNode(stateOf(messages) as never);
        expect(invokeMock).toHaveBeenCalledTimes(1); // 未再调用 LLM（省 token）
        const stop = out2.messages[0] as AIMessage;
        expect(String(stop.content)).toContain("[任务中断]");
        expect(String(stop.content)).toContain("已给过重规划机会");
        expect(out2.iteration).toBe(1);
    });

    it("REPLAN_LIMIT=0：关闭 replan，命中即硬停（旧行为回归）", async () => {
        vi.stubEnv("REPLAN_LIMIT", "0");
        const { llm, invokeMock } = makeFakeLlm((msgs) => okResponse("不应被调用"));
        const executor = new GraphAgentExecutor(llm, [], "系统提示", 10);

        const out = await executor.agentNode(stateOf(buildRepeatHistory(3)) as never);

        expect(invokeMock).not.toHaveBeenCalled();
        const stop = out.messages[0] as AIMessage;
        expect(String(stop.content)).toContain("[任务中断]");
    });

    it("无重复消息：正常 invoke，无 replan 提示注入", async () => {
        const { llm, invokeMock } = makeFakeLlm((msgs) => {
            // 正常路径不该收到 replan 提示
            expect(String(msgs.at(-1)?.content ?? "")).not.toContain("[重规划]");
            return okResponse("正常答复");
        });
        const executor = new GraphAgentExecutor(llm, [], "系统提示", 10);
        const messages = buildRepeatHistory(2); // streak 2 < 3，不触发

        const out = await executor.agentNode(stateOf(messages) as never);

        expect(invokeMock).toHaveBeenCalledTimes(1);
        const sent = sentMessages(invokeMock);
        expect(sent).toHaveLength(messages.length); // 未追加任何提示
        expect(String((out.messages[0] as AIMessage).content)).toContain("正常答复");
    });
});

describe("executor token 级遥测（改进点 1）", () => {
    it("agentNode 每次成功调用累计记账", async () => {
        const { llm, invokeMock } = makeFakeLlm(() => okResponse("答复"));
        const executor = new GraphAgentExecutor(llm, [], "系统提示", 10);
        expect(executor.getUsage()).toEqual({ llmCalls: 0, inputTokens: 0, outputTokens: 0 });

        await executor.agentNode(stateOf(buildRepeatHistory(2)) as never);
        await executor.agentNode(stateOf(buildRepeatHistory(2)) as never);

        expect(invokeMock).toHaveBeenCalledTimes(2);
        expect(executor.getUsage()).toEqual({
            llmCalls: 2,
            inputTokens: USAGE_IN * 2,
            outputTokens: USAGE_OUT * 2,
        });
    });

    it("run() 入口按 run 重置（worker 多轮不串账）", async () => {
        const { llm, invokeMock } = makeFakeLlm((msgs) => okResponse("worker 产物"));
        const executor = new GraphAgentExecutor(llm, [], "", 5);

        // 先人为制造一次历史记账（直调 agentNode）
        await executor.agentNode(stateOf(buildRepeatHistory(2)) as never);
        expect(executor.getUsage().llmCalls).toBe(1);

        // run() 内部 beginRun 重置后重新记账（每次 worker run 独立）
        const result = await executor.run("任务", "worker 提示");
        expect(result).toContain("worker 产物");
        expect(executor.getUsage()).toEqual({
            llmCalls: 1,
            inputTokens: USAGE_IN,
            outputTokens: USAGE_OUT,
        });

        // 第二次 run 再次重置（两次独立 worker run 各自记账，由 runner 层加总）
        const result2 = await executor.run("任务2", "worker 提示2");
        expect(result2).toContain("worker 产物");
        expect(executor.getUsage()).toEqual({
            llmCalls: 1,
            inputTokens: USAGE_IN,
            outputTokens: USAGE_OUT,
        });
    });
});
