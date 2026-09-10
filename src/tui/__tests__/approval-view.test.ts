import { describe, it, expect } from "vitest";
import {
  resolveApprovalKey,
  optionIndexToValue,
  summarizeArgs,
  formatApproval,
  formatQuestion,
  approvalHint,
} from "../approval-view.js";

describe("resolveApprovalKey", () => {
  it("y/a/n 大小写映射到三种 decision", () => {
    expect(resolveApprovalKey({ ch: "y" })).toBe("allow");
    expect(resolveApprovalKey({ ch: "Y" })).toBe("allow");
    expect(resolveApprovalKey({ ch: "a" })).toBe("always");
    expect(resolveApprovalKey({ ch: "A" })).toBe("always");
    expect(resolveApprovalKey({ ch: "n" })).toBe("deny");
    expect(resolveApprovalKey({ ch: "N" })).toBe("deny");
  });
  it("Esc → deny", () => {
    expect(resolveApprovalKey({ escape: true })).toBe("deny");
  });
  it("其它字符 / 空输入 → null（交给理由输入缓冲）", () => {
    expect(resolveApprovalKey({ ch: "x" })).toBeNull();
    expect(resolveApprovalKey({ ch: "" })).toBeNull();
    expect(resolveApprovalKey({})).toBeNull();
  });
});

describe("optionIndexToValue", () => {
  it("数字 1..n 映射到选项", () => {
    expect(optionIndexToValue("1", ["火锅", "烧烤"])).toBe("火锅");
    expect(optionIndexToValue("2", ["火锅", "烧烤"])).toBe("烧烤");
  });
  it("越界 / 非数字 / 无选项 → null", () => {
    expect(optionIndexToValue("9", ["火锅"])).toBeNull();
    expect(optionIndexToValue("0", ["火锅"])).toBeNull();
    expect(optionIndexToValue("x", ["火锅"])).toBeNull();
    expect(optionIndexToValue("1", undefined)).toBeNull();
    expect(optionIndexToValue("1", [])).toBeNull();
  });
});

describe("summarizeArgs", () => {
  it("对象格式化并保留结构", () => {
    const out = summarizeArgs({ path: "a.txt", content: "hi" });
    expect(out).toContain("a.txt");
    expect(out).toContain("hi");
  });
  it("单行超长被截断", () => {
    const out = summarizeArgs({ content: "x".repeat(500) }, 50, 4000);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(200);
  });
  it("总长超限追加截断标记", () => {
    const out = summarizeArgs({ a: "y".repeat(300), b: "z".repeat(300) }, 400, 200);
    expect(out).toContain("参数过长已截断");
  });
  it("字符串输入原样处理，循环引用不抛", () => {
    expect(summarizeArgs("plain")).toBe("plain");
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => summarizeArgs(cyc)).not.toThrow();
  });
  it("无参数（undefined / null）不渲染成字面量 undefined", () => {
    expect(summarizeArgs(undefined)).toBe("（无参数）");
    expect(summarizeArgs(null)).toBe("（无参数）");
  });
});

describe("formatApproval / formatQuestion", () => {
  it("审批卡片含工具名、权限标签与参数摘要（三档提示由 approvalHint 单独渲染，不重复）", () => {
    const out = formatApproval("execute_command", { command: "rm -rf x" }, "dangerous");
    expect(out).toContain("execute_command");
    expect(out).toContain("rm -rf x");
    expect(out).toContain("高危");
    expect(out).not.toContain("[y]");
  });
  it("提问卡片列出编号选项", () => {
    const out = formatQuestion("今天吃什么？", ["火锅", "烧烤"]);
    expect(out).toContain("今天吃什么？");
    expect(out).toContain("1. 火锅");
    expect(out).toContain("2. 烧烤");
  });
  it("无选项的提问卡片不出现编号", () => {
    const out = formatQuestion("你的 API key 是？");
    expect(out).not.toContain("1.");
  });
  it("超过 9 个选项时只给前 9 项编号，并提示其余需直接输入", () => {
    const options = Array.from({ length: 11 }, (_, i) => `o${i + 1}`);
    const out = formatQuestion("选一个？", options);
    expect(out).toContain("9. o9");
    expect(out).not.toContain("10. o10");
    expect(out).toContain("仅前 9 项支持数字快选");
  });
  it("approvalHint 提到三种按键", () => {
    const hint = approvalHint();
    expect(hint).toContain("y");
    expect(hint).toContain("a");
    expect(hint).toContain("n");
  });
});
