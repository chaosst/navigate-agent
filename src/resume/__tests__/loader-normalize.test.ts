import { describe, it, expect } from "vitest";
import { normalizeConvertedMarkdown, loadResumeSource, RESUME_FILE_MD, RESUME_FILE_DOCX } from "../loader.js";

/**
 * 回归背景：mammoth 的裸输出不是 parseResumeText 的契约形态。
 * 实测一份真实中文简历（含证件照、公式域转义、加粗编号标题）经转换后
 * 1.44M 字符、0 个章节、检索恒空。本组用例锁住三类归一化规则。
 */
describe("normalizeConvertedMarkdown", () => {
  it("剥离 base64 内嵌图片，并清掉残留的空强调行", () => {
    const md = [
      "谭泳超",
      `__![](data:image/jpeg;base64,${"A".repeat(5000)})`,
      "正文",
    ].join("\n");
    const out = normalizeConvertedMarkdown(md);
    expect(out).not.toContain("base64");
    expect(out).not.toContain("![]");
    expect(out.split("\n").some((l) => /^_+$/.test(l.trim()))).toBe(false);
    expect(out).toContain("谭泳超");
    expect(out).toContain("正文");
  });

  it("还原 mammoth 对公式域标点的转义", () => {
    const out = normalizeConvertedMarkdown("电话：【\\+86 135\\-9059\\-7722】 ｜ Node\\.js \\_下划线\\_ \\#1");
    expect(out).toContain("+86 135-9059-7722");
    expect(out).toContain("Node.js");
    expect(out).toContain("_下划线_");
    expect(out).toContain("#1");
    expect(out).not.toContain("\\+");
  });

  it("把中文编号小标题提升为 ## 二级标题（解析器的分节依据）", () => {
    const out = normalizeConvertedMarkdown(
      ["谭泳超", "一、教育背景", "深圳大学 本科", "二、专业技能", "TypeScript"].join("\n"),
    );
    expect(out).toContain("## 教育背景");
    expect(out).toContain("## 专业技能");
    // 原文的编号前缀不应残留
    expect(out).not.toContain("一、");
    expect(out).not.toContain("二、");
  });

  it("对已符合契约的 markdown 是幂等的", () => {
    const clean = ["# 简历 md 源", "", "## 工作经历", "", "### 某厂 (2020-01 — 2023-12)", "- 订单系统"].join("\n");
    expect(normalizeConvertedMarkdown(clean)).toBe(clean);
  });
});

describe("loadResumeSource 只归一化 docx 路径", () => {
  it("docx 输出经归一化后再返回", async () => {
    const src = await loadResumeSource({
      exists: (p) => p === RESUME_FILE_DOCX,
      readFile: () => Buffer.from("fake"),
      docxToMarkdown: async () => "一、教育背景\n__![](data:image/png;base64,AAAA)__",
    });
    expect(src?.format).toBe("docx");
    expect(src?.text).toContain("## 教育背景");
    expect(src?.text).not.toContain("base64");
  });

  it("resume.md 是手工维护的单一事实源，原样透传不做改写", async () => {
    // md 里刻意放 base64 与中文编号标题：都不应被改写
    const mdText = "一、教育背景\n![](data:image/png;base64,AAAA)\n\\+86 135\\-9059\\-7722";
    const src = await loadResumeSource({
      exists: (p) => p === RESUME_FILE_MD,
      readFile: () => Buffer.from(mdText),
      docxToMarkdown: async () => {
        throw new Error("should not convert");
      },
    });
    expect(src?.format).toBe("md");
    expect(src?.text).toBe(mdText);
  });
});
