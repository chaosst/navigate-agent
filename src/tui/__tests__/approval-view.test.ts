import { describe, it, expect } from "vitest";
import {
  resolveApprovalKey,
  optionIndexToValue,
  summarizeArgs,
  formatApproval,
  formatQuestion,
  approvalHint,
  compactArgs,
  describeIntent,
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

describe("compactArgs（紧凑单行，替代 pretty JSON）", () => {
  it("对象压成单行 key=value，多个键两空格分隔", () => {
    expect(compactArgs({ path: "a.txt", content: "hi" })).toBe("path=a.txt  content=hi");
  });
  it("嵌套对象 / 数组走紧凑 JSON", () => {
    expect(compactArgs({ list: [1, 2] })).toBe("list=[1,2]");
  });
  it("超长整体截断并带省略号", () => {
    const out = compactArgs({ content: "x".repeat(100) }, 30);
    expect(out.length).toBeLessThan(60);
    expect(out).toContain("…");
  });
  it("无参数 → （无参数）", () => {
    expect(compactArgs({})).toBe("（无参数）");
    expect(compactArgs(undefined)).toBe("（无参数）");
    expect(compactArgs(null)).toBe("（无参数）");
  });
  it("循环引用不抛", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => compactArgs(cyc)).not.toThrow();
  });
});

describe("describeIntent（审批卡片说人话）", () => {
  it("write_file → 文件路径 + 字符数，不 dump JSON", () => {
    const out = describeIntent("write_file", { path: "PROJECT_INTRO.txt", content: "abc" });
    expect(out).toBe("写入文件 PROJECT_INTRO.txt（3 字符）");
    expect(out).not.toContain("{");
  });
  it("edit_file / read_file / list_files 走各自句式", () => {
    expect(describeIntent("edit_file", { path: "src/a.ts" })).toBe("修改文件 src/a.ts");
    expect(describeIntent("read_file", { path: "src/a.ts" })).toBe("读取文件 src/a.ts");
    expect(describeIntent("list_files", { path: "src", maxDepth: 2 })).toBe("列出目录 src（深度 2）");
  });
  it("execute_command → 直接给命令原文", () => {
    expect(describeIntent("execute_command", { command: "rm -rf x" })).toBe("执行命令 rm -rf x");
  });
  it("检索类 → 带引号的查询词", () => {
    expect(describeIntent("search_documents", { query: "RAG 三级缓存" })).toBe("检索知识库“RAG 三级缓存”");
    expect(describeIntent("web_search", { query: "ink static" })).toBe("联网搜索“ink static”");
  });
  it("delegate → 委派目标 + 任务", () => {
    expect(describeIntent("delegate", { agent: "code", task: "分析 loop.ts" })).toBe("委派 code agent：分析 loop.ts");
  });
  it("未知工具 → 退回紧凑单行参数（不换行、不 pretty JSON）", () => {
    const out = describeIntent("mystery_tool", { a: 1, b: "two" });
    expect(out).toBe("a=1  b=two");
    expect(out).not.toContain("\n");
  });
  it("参数缺失 / 非对象都不抛", () => {
    expect(() => describeIntent("write_file", undefined)).not.toThrow();
    expect(() => describeIntent("execute_command", null)).not.toThrow();
    expect(() => describeIntent("execute_command", "raw")).not.toThrow();
    expect(() => describeIntent("read_file", {})).not.toThrow();
  });
  it("formatApproval 不再出现 JSON 花括号缩进", () => {
    const out = formatApproval("write_file", { path: "a.txt", content: "hi" }, "write");
    expect(out).toContain("写入文件 a.txt");
    expect(out).not.toContain('"path"');
  });
});
