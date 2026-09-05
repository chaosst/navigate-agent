import { describe, it, expect } from "vitest";
import { buildResumeSystemPrompt } from "../prompt.js";
import { buildJdPrompt, parseJdResult } from "../jd-analyzer.js";

describe("buildResumeSystemPrompt", () => {
  it("is resume-scoped: grants only search_resume, never names other tools", () => {
    const p = buildResumeSystemPrompt();
    expect(p).toContain("search_resume");
    expect(p).toContain("简历");
    // 最小权限面：prompt 不得授予/暗示任何其它真实工具（shell/文件/网络）
    for (const banned of ["execute_command", "read_file", "write_file", "search_documents", "[权限"]) {
      expect(p.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("contains explicit refusal rules for out-of-scope requests", () => {
    const p = buildResumeSystemPrompt();
    expect(p).toMatch(/无关|拒绝|不编造|未提及|无法回答/i);
    expect(p).toContain("简历");
  });

  it("embeds the resume summary when provided", () => {
    const p = buildResumeSystemPrompt("Name: 张三\nTitle: 全栈工程师\nSummary: 精通 TS/Node");
    expect(p).toContain("张三");
    expect(p).toContain("全栈工程师");
  });

  it("omits the About section when no summary given", () => {
    const withSummary = buildResumeSystemPrompt("Name: 张三");
    const without = buildResumeSystemPrompt(undefined);
    expect(withSummary.length).toBeGreaterThan(without.length);
    expect(without).not.toContain("About the User");
  });
});

describe("buildJdPrompt", () => {
  it("includes both the JD text and the full resume", () => {
    const p = buildJdPrompt("resume line 1\nresume line 2", "我们招聘一位 Node 后端工程师");
    expect(p).toContain("resume line 1");
    expect(p).toContain("我们招聘一位 Node 后端工程师");
  });

  it("asks for the exact JSON schema fields", () => {
    const p = buildJdPrompt("R", "J");
    expect(p).toMatch(/score/);
    expect(p).toMatch(/summary/);
    expect(p).toMatch(/strengths/);
    expect(p).toMatch(/gaps/);
    expect(p).toMatch(/suggestions/);
  });
});

describe("parseJdResult", () => {
  const valid = {
    score: 72,
    summary: "整体匹配",
    strengths: ["熟悉 TS"],
    gaps: ["缺 Docker"],
    suggestions: ["补充容器化经验"],
  };

  it("parses bare JSON", () => {
    expect(parseJdResult(JSON.stringify(valid))).toEqual(valid);
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const fenced = "```json\n" + JSON.stringify(valid, null, 2) + "\n```";
    expect(parseJdResult(fenced)).toEqual(valid);
  });

  it("tolerates surrounding prose noise", () => {
    const noisy = "好的，这是分析结果：\n" + JSON.stringify(valid) + "\n希望有帮助！";
    expect(parseJdResult(noisy)).toEqual(valid);
  });

  it("returns null on invalid JSON", () => {
    expect(parseJdResult("抱歉我无法分析")).toBeNull();
    expect(parseJdResult("")).toBeNull();
  });
});
