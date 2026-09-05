import { describe, it, expect, vi } from "vitest";
import type { ResumeData } from "../types.js";
import { parseResumeText } from "../parser.js";
import {
  MAX_JD_RESUME_CHARS,
  ResumeTooLongError,
  assertResumeBudget,
  serializeResumeForJd,
} from "../jd-analyzer.js";
import { loadResumeSource, RESUME_FILE_MD, RESUME_FILE_DOCX, RESUME_FILE_DOC } from "../loader.js";

const sampleResume: ResumeData = {
  name: "张三",
  title: "全栈工程师",
  summary: "5 年 TS/Node 经验",
  contact: { email: "a@b.com" },
  sections: [
    {
      type: "experience",
      title: "工作经历",
      items: [
        {
          title: "创新科技",
          dateRange: "2022-03 至今",
          subtitle: "高级工程师",
          description: "负责核心链路",
          highlights: ["QPS 提升 3x"],
        },
      ],
    },
    {
      type: "skills",
      title: "技能",
      items: [{ title: "技能", description: "", highlights: ["TypeScript", "Node.js"] }],
    },
  ],
};

describe("serializeResumeForJd", () => {
  it("keeps structured facts in LLM-friendly markdown", () => {
    const s = serializeResumeForJd(sampleResume);
    expect(s).toContain("张三 — 全栈工程师");
    expect(s).toContain("5 年 TS/Node 经验");
    expect(s).toContain("## 工作经历");
    expect(s).toContain("### 创新科技 (2022-03 至今)");
    expect(s).toContain("高级工程师");
    expect(s).toContain("QPS 提升 3x");
    expect(s).toContain("## 技能");
  });

  it("strips empty sections and noise fields", () => {
    const s = serializeResumeForJd({
      name: "",
      title: "",
      summary: "",
      contact: { email: "" },
      sections: [{ type: "skills", title: "技能", items: [] }],
    });
    expect(s).not.toContain("技能"); // 空 section 不输出
    expect(s).toBe("");
  });
});

describe("assertResumeBudget", () => {
  it("passes within budget", () => {
    expect(() => assertResumeBudget("短简历")).not.toThrow();
    expect(() => assertResumeBudget("x".repeat(MAX_JD_RESUME_CHARS))).not.toThrow();
  });

  it("throws ResumeTooLongError over budget with readable message", () => {
    const long = "x".repeat(MAX_JD_RESUME_CHARS + 1);
    expect(() => assertResumeBudget(long)).toThrow(ResumeTooLongError);
    try {
      assertResumeBudget(long);
    } catch (err) {
      expect((err as Error).message).toContain(String(MAX_JD_RESUME_CHARS));
      expect((err as Error).name).toBe("ResumeTooLongError");
    }
  });
});

describe("parseResumeText", () => {
  it("parses markdown text into structured sections", () => {
    const md = [
      "---",
      "name: 李四",
      "email: l@b.com",
      "---",
      "10 年后端",
      "",
      "## 工作经历",
      "### 某厂 (2020-01 至 2023-12)",
      "负责人",
      "- 订单系统",
    ].join("\n");
    const data = parseResumeText(md);
    expect(data.name).toBe("李四");
    expect(data.contact.email).toBe("l@b.com");
    expect(data.summary).toContain("10 年后端");
    expect(data.sections).toHaveLength(1);
    expect(data.sections[0].items[0].title).toBe("某厂");
    expect(data.sections[0].items[0].dateRange).toBe("2020-01 至 2023-12");
    expect(data.sections[0].items[0].highlights).toContain("订单系统");
  });
});

describe("loadResumeSource", () => {
  const mdText = "# 简历 md 源\n\n## 工作经历\n";

  it("prefers resume.md when both md and docx exist", async () => {
    const files = new Set([RESUME_FILE_MD, RESUME_FILE_DOCX]);
    const deps = {
      exists: (p: string) => files.has(p),
      readFile: (p: string) => Buffer.from(p === RESUME_FILE_MD ? mdText : ""),
      docxToMarkdown: vi.fn(async () => { throw new Error("should not convert"); }),
    };
    const src = await loadResumeSource(deps);
    expect(src).toEqual({ text: mdText, sourcePath: RESUME_FILE_MD, format: "md" });
    expect(deps.docxToMarkdown).not.toHaveBeenCalled();
  });

  it("converts docx via injected docxToMarkdown when only docx exists", async () => {
    const files = new Set([RESUME_FILE_DOCX]);
    const docxToMarkdown = vi.fn(async () => "# docx 转换结果");
    const src = await loadResumeSource({
      exists: (p: string) => files.has(p),
      readFile: (p: string) => Buffer.from("fake docx bytes"),
      docxToMarkdown,
    });
    expect(docxToMarkdown).toHaveBeenCalledTimes(1);
    expect(src).toEqual({ text: "# docx 转换结果", sourcePath: RESUME_FILE_DOCX, format: "docx" });
  });

  it("returns null when no resume file exists", async () => {
    const src = await loadResumeSource({
      exists: () => false,
      readFile: () => Buffer.from(""),
      docxToMarkdown: async () => "",
    });
    expect(src).toBeNull();
  });

  it("warns about unsupported .doc and returns null (docx absent)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = new Set([RESUME_FILE_DOC]);
    const src = await loadResumeSource({
      exists: (p: string) => files.has(p),
      readFile: () => Buffer.from(""),
      docxToMarkdown: async () => "",
    });
    expect(src).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("propagates docx conversion errors to caller", async () => {
    const files = new Set([RESUME_FILE_DOCX]);
    await expect(
      loadResumeSource({
        exists: (p: string) => files.has(p),
        readFile: () => Buffer.from("bad zip"),
        docxToMarkdown: async () => { throw new Error("invalid docx"); },
      }),
    ).rejects.toThrow("invalid docx");
  });
});
