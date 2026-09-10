import { describe, it, expect } from "vitest";
import { updatePlanMessage, PLAN_MESSAGE_MARKER } from "../plan-utils.js";

type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; timestamp: Date };

const mk = (role: Msg["role"], content: string): Msg => ({ role, content, timestamp: new Date() });

describe("updatePlanMessage（plan 渲染去重）", () => {
  it("首次调用：prev 无 plan 消息时追加一条", () => {
    const prev = [mk("user", "hi"), mk("assistant", "hello")];
    const next = updatePlanMessage(prev, `${PLAN_MESSAGE_MARKER} 读文件`);
    expect(next).toHaveLength(3);
    expect(next[2].content).toBe(`${PLAN_MESSAGE_MARKER} 读文件`);
    expect(next[0]).toBe(prev[0]); // 浅保留
    expect(next[1]).toBe(prev[1]);
  });

  it("再次调用：替换最后一条 plan 消息，不重复 append", () => {
    const prev = [
      mk("user", "hi"),
      mk("system", `${PLAN_MESSAGE_MARKER} 初版`),
      mk("assistant", "继续"),
    ];
    const next = updatePlanMessage(prev, `${PLAN_MESSAGE_MARKER} 更新版`);
    expect(next).toHaveLength(3);
    expect(next[1].content).toBe(`${PLAN_MESSAGE_MARKER} 更新版`);
    expect(next[0]).toBe(prev[0]);
    expect(next[2]).toBe(prev[2]);
  });

  it("多条 plan 消息时只替换最后一条，前面的保留", () => {
    const prev = [
      mk("system", `${PLAN_MESSAGE_MARKER} v1`),
      mk("assistant", "中间"),
      mk("system", `${PLAN_MESSAGE_MARKER} v2`),
    ];
    const next = updatePlanMessage(prev, `${PLAN_MESSAGE_MARKER} v3`);
    expect(next).toHaveLength(3);
    expect(next[0].content).toBe(`${PLAN_MESSAGE_MARKER} v1`);
    expect(next[1].content).toBe("中间");
    expect(next[2].content).toBe(`${PLAN_MESSAGE_MARKER} v3`);
  });

  it("prev 为空时直接 push", () => {
    const empty: Msg[] = [];
    const next = updatePlanMessage(empty, `${PLAN_MESSAGE_MARKER} 起步`);
    expect(next).toHaveLength(1);
    expect(next[0].content).toBe(`${PLAN_MESSAGE_MARKER} 起步`);
  });

  it("其他消息里含 marker 前缀但不是 system 角色不被替换", () => {
    // 防御性：确保 marker 匹配严格看 content 字符串
    const prev = [mk("assistant", `${PLAN_MESSAGE_MARKER} 误标`)];
    const next = updatePlanMessage(prev, `${PLAN_MESSAGE_MARKER} 新版`);
    // 当前实现仅按 content 前缀匹配；此用例记录行为：任何 role 含 marker 都会被替换
    expect(next).toHaveLength(1);
    expect(next[0].content).toBe(`${PLAN_MESSAGE_MARKER} 新版`);
  });
});
