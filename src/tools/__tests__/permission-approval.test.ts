import { describe, it, expect } from "vitest";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { PermissionWrapper, type ToolPermission } from "../permission.js";
import {
  HumanChannel,
  ThresholdApprovalPolicy,
  type HumanInteractor,
  type HumanRequest,
  type HumanResponse,
} from "../human-channel.js";

/** 按顺序发放 decision 的替身（用完后重复最后一个） */
class Scripted implements HumanInteractor {
  count = 0;
  seen: string[] = [];
  constructor(private decisions: Array<"allow" | "always" | "deny">) {}
  async ask(req: HumanRequest): Promise<HumanResponse> {
    this.count++;
    this.seen.push(req.kind === "approval" ? req.tool : req.question);
    const d = this.decisions[Math.min(this.count - 1, this.decisions.length - 1)] ?? "deny";
    return { kind: "approval", decision: d };
  }
}

/** 记下被问到的 id 与请求，带延迟，用于验证等待时长不被计入工具耗时 */
class SlowApprover implements HumanInteractor {
  constructor(private delayMs: number) {}
  async ask(_req: HumanRequest): Promise<HumanResponse> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return { kind: "approval", decision: "allow" };
  }
}

class EchoTool extends StructuredTool {
  name = "echo";
  description = "echo back";
  schema = z.object({ v: z.string() });
  calls = 0;
  async _call(input: { v: string }): Promise<string> {
    this.calls++;
    return `echo:${input.v}`;
  }
}

function makeWrapper(permission: ToolPermission, channel?: HumanChannel) {
  const inner = new EchoTool();
  const policy = new ThresholdApprovalPolicy("write");
  const wrapper = new PermissionWrapper(inner, permission, undefined, undefined, channel, policy);
  return { inner, wrapper };
}

describe("PermissionWrapper 审批门", () => {
  it("read 级不打扰用户，直接执行", async () => {
    const rec = new Scripted(["deny"]);
    const ch = new HumanChannel();
    ch.attach(rec);
    const { inner, wrapper } = makeWrapper("read", ch);
    const out = await wrapper.invoke({ v: "x" });
    expect(String(out)).toBe("echo:x");
    expect(rec.count).toBe(0);
    expect(inner.calls).toBe(1);
  });

  it("write 级先问；allow 后正常执行", async () => {
    const rec = new Scripted(["allow"]);
    const ch = new HumanChannel();
    ch.attach(rec);
    const { inner, wrapper } = makeWrapper("write", ch);
    const out = await wrapper.invoke({ v: "x" });
    expect(rec.count).toBe(1);
    expect(rec.seen).toEqual(["echo"]);
    expect(String(out)).toBe("echo:x");
    expect(inner.calls).toBe(1);
  });

  it("dangerous 级也要问", async () => {
    const rec = new Scripted(["deny"]);
    const ch = new HumanChannel();
    ch.attach(rec);
    const { wrapper } = makeWrapper("dangerous", ch);
    await wrapper.invoke({ v: "x" });
    expect(rec.count).toBe(1);
  });

  it("deny → 不执行、返回可读文案、denials+1、errors 不加", async () => {
    const rec = new Scripted(["deny"]);
    const ch = new HumanChannel();
    ch.attach(rec);
    const { inner, wrapper } = makeWrapper("write", ch);
    const out = String(await wrapper.invoke({ v: "x" }));
    expect(out).toContain("[approval_denied]");
    expect(out).toContain("echo");
    expect(inner.calls).toBe(0);
    expect(wrapper.stats.denials).toBe(1);
    expect(wrapper.stats.errors).toBe(0);
    expect(wrapper.stats.callCount).toBe(1);
  });

  it("连续 3 次 deny 不触发熔断，第 4 次 allow 仍能执行", async () => {
    const rec = new Scripted(["deny", "deny", "deny", "allow"]);
    const ch = new HumanChannel();
    ch.attach(rec);
    const { inner, wrapper } = makeWrapper("write", ch);
    for (let i = 0; i < 3; i++) await wrapper.invoke({ v: `d${i}` });
    expect(wrapper.stats.denials).toBe(3);
    const out = await wrapper.invoke({ v: "ok" });
    expect(String(out)).toBe("echo:ok");
    expect(inner.calls).toBe(1);
    expect(rec.count).toBe(4);
  });

  it("deny 的理由进入文案", async () => {
    const denier: HumanInteractor = {
      async ask() { return { kind: "approval", decision: "deny", reason: "别删那个文件" }; },
    };
    const ch = new HumanChannel();
    ch.attach(denier);
    const { wrapper } = makeWrapper("write", ch);
    const out = String(await wrapper.invoke({ v: "x" }));
    expect(out).toContain("别删那个文件");
  });

  it("always → 同一工具后续不再问，其它工具照问", async () => {
    const rec = new Scripted(["always", "deny"]);
    const ch = new HumanChannel();
    ch.attach(rec);
    const { inner, wrapper } = makeWrapper("write", ch);
    await wrapper.invoke({ v: "1" });
    await wrapper.invoke({ v: "2" });
    expect(rec.count).toBe(1);
    expect(inner.calls).toBe(2);
  });

  it("人工等待不计入工具耗时统计", async () => {
    const ch = new HumanChannel();
    ch.attach(new SlowApprover(40));
    const { wrapper } = makeWrapper("write", ch);
    await wrapper.invoke({ v: "x" });
    expect(wrapper.stats.totalDurationMs).toBeLessThan(25);
  });

  it("不传 channel → 不问、行为与今天一致（回归护栏）", async () => {
    const { inner, wrapper } = makeWrapper("write");
    const out = await wrapper.invoke({ v: "x" });
    expect(String(out)).toBe("echo:x");
    expect(inner.calls).toBe(1);
    expect(wrapper.stats.denials).toBe(0);
  });

  it("注入 channel 但漏配 policy → 仍然问（fail-closed），不静默放行", async () => {
    const rec = new Scripted(["deny"]);
    const ch = new HumanChannel();
    ch.attach(rec);
    const inner = new EchoTool();
    const wrapper = new PermissionWrapper(inner, "write", undefined, undefined, ch, undefined);
    const out = String(await wrapper.invoke({ v: "x" }));
    expect(rec.count).toBe(1);
    expect(inner.calls).toBe(0);
    expect(out).toContain("[approval_denied]");
  });
});
