import { describe, expect, it } from "vitest";
import { applyModeRules, ModeRouter } from "../mode-router.js";
import type { ChatOpenAI } from "@langchain/openai";

/** 便宜假 llm：本测试全走注入 classifier，不走网络 */
const fakeLlm = {} as unknown as ChatOpenAI;

describe("mode-router 规则层", () => {
  it("硬 plan：多目标/多步中文信号", () => {
    const samples = [
      "把 src 下所有模块重构一遍，并按模块补单元测试",
      "帮我迁移 docs 到新目录并逐个更新引用",
      "整理 docs 目录并生成一份索引",
      "对整个项目做一次梳理，给出模块化建议",
    ];
    for (const s of samples) {
      const d = applyModeRules(s);
      expect(d?.mode, s).toBe("plan");
      expect(d?.source).toBe("rule");
    }
  });

  it("过短/寒暄 → normal（rule，不升档）", () => {
    for (const s of ["你好", "谢谢", "hi", "嗯", ""]) {
      const d = applyModeRules(s);
      expect(d?.mode, s).toBe("normal");
      expect(d?.source).toBe("rule");
    }
  });

  it("普通长指令 → 不确定（返回 null，交 LLM）", () => {
    const s = "今天天气怎么样？顺便帮我看看最近有哪些新的开源大模型发布";
    expect(applyModeRules(s)).toBeNull();
  });
});

describe("mode-router 编排", () => {
  it("硬规则命中时不调分类器（spy 应返回 0 次）", async () => {
    let calls = 0;
    const r = new ModeRouter({
      llm: fakeLlm,
      classifier: async () => { calls++; return { mode: "plan" as const, reason: "x" }; },
    });
    const d = await r.resolveMode("把 docs 迁移到新目录并更新引用", {});
    expect(d.mode).toBe("plan");
    expect(d.source).toBe("rule");
    expect(calls).toBe(0);
  });

  it("分类器判 plan → 升档（source=llm）", async () => {
    const r = new ModeRouter({
      llm: fakeLlm,
      classifier: async () => ({ mode: "plan" as const, reason: "语义多步" }),
    });
    const d = await r.resolveMode("这是一个需要多步才能完成的普通指令示例内容", {});
    expect(d.mode).toBe("plan");
    expect(d.reason).toBe("语义多步");
    expect(d.source).toBe("llm");
  });

  it("分类器判 normal → 保持 normal", async () => {
    const r = new ModeRouter({
      llm: fakeLlm,
      classifier: async () => ({ mode: "normal" as const, reason: "单步问答" }),
    });
    const d = await r.resolveMode("解释一下什么是 pgvector 的工作原理吧", {});
    expect(d.mode).toBe("normal");
  });

  it("分类器抛错 → fallback normal", async () => {
    const r = new ModeRouter({
      llm: fakeLlm,
      classifier: async () => { throw new Error("llm timeout"); },
    });
    const d = await r.resolveMode("帮我把这几篇文档的要点汇总成一份清单", {});
    expect(d.mode).toBe("normal");
    expect(d.source).toBe("fallback");
  });

  it("极短接续 + 上轮 plan + 接续词 → 保持 plan；否则回 normal", async () => {
    const r = new ModeRouter({ llm: fakeLlm });
    const keep = await r.resolveMode("继续", { lastMode: "plan" });
    expect(keep.mode).toBe("plan");
    const drop = await r.resolveMode("好的", { lastMode: "plan" });
    expect(drop.mode).toBe("normal");
  });

  it("坏 JSON 输出 → fallback normal", async () => {
    const r = new ModeRouter({
      llm: fakeLlm,
      classifier: async () => { throw new Error("bad json"); },
    });
    const d = await r.resolveMode("随便一句长一点的话看会不会被兜底保护", {});
    expect(d.mode).toBe("normal");
  });
});
