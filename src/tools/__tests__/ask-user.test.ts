import { describe, it, expect } from "vitest";
import { AskUserTool } from "../ask-user.js";
import {
  HumanChannel,
  NonInteractiveInteractor,
  type HumanInteractor,
  type HumanRequest,
  type HumanResponse,
} from "../human-channel.js";

class Fixed implements HumanInteractor {
  lastRequest: HumanRequest | null = null;
  constructor(private answer: string) {}
  async ask(req: HumanRequest): Promise<HumanResponse> {
    this.lastRequest = req;
    return { kind: "question", answer: this.answer };
  }
}

describe("AskUserTool", () => {
  it("把问题交给通道并取回答案", async () => {
    const fixed = new Fixed("A：火锅");
    const ch = new HumanChannel();
    ch.attach(fixed);
    const tool = new AskUserTool(ch);
    const out = await tool.invoke({ question: "今天吃什么？" });
    expect(String(out)).toBe("A：火锅");
    expect(fixed.lastRequest?.kind).toBe("question");
  });

  it("options 透传给交互器", async () => {
    const fixed = new Fixed("2");
    const ch = new HumanChannel();
    ch.attach(fixed);
    const tool = new AskUserTool(ch);
    await tool.invoke({ question: "选哪个？", options: ["火锅", "烧烤"] });
    if (fixed.lastRequest?.kind !== "question") throw new Error("unreachable");
    expect(fixed.lastRequest.options).toEqual(["火锅", "烧烤"]);
  });

  it("无人值守 → 返回可读兜底文案，不抛", async () => {
    const ch = new HumanChannel();
    ch.attach(new NonInteractiveInteractor());
    const tool = new AskUserTool(ch);
    const out = String(await tool.invoke({ question: "q" }));
    expect(out).toContain("no user available");
  });

  it("交互器抛错 → 吞成可读文案", async () => {
    const boom: HumanInteractor = { async ask() { throw new Error("boom"); } };
    const ch = new HumanChannel();
    ch.attach(boom);
    const tool = new AskUserTool(ch);
    const out = String(await tool.invoke({ question: "q" }));
    expect(out).toContain("no user available");
    expect(out).toContain("boom");
  });

  it("空答案 → 明确标记，避免 LLM 误以为是有效回答", async () => {
    const ch = new HumanChannel();
    ch.attach(new Fixed("   "));
    const tool = new AskUserTool(ch);
    expect(String(await tool.invoke({ question: "q" }))).toBe("[empty answer]");
  });

  it("question 必填（schema 校验）", () => {
    const ch = new HumanChannel();
    const tool = new AskUserTool(ch);
    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.schema.safeParse({ question: "q" }).success).toBe(true);
  });
});
