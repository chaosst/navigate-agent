import { describe, it, expect } from "vitest";
import { parseResumeText } from "../parser.js";

/**
 * 回归背景：docx 路径不可能带 frontmatter（那是 resume.md 手工维护的元数据块），
 * 旧实现只从 meta 取 name/title/contact，导致 docx 简历解析出「无名、无联系方式」；
 * 且 SECTION_MAP 用精确查表，「专业技能」「AI 项目经历」这类长标题全部落到 experience 兜底。
 */
describe("parseResumeText 无 frontmatter 时的头部推断", () => {
  const docxLike = [
    "谭泳超",
    "",
    "AI Agent 应用开发工程师",
    "",
    "电话：【+86 135-9059-7722】 ｜ 邮箱：【tan5168203@163.com】 ｜ GitHub：【https://github.com/chaosst】",
    "工作年限：12 年+ ｜ 期望城市：【深圳】 ｜ 技术博客：【https://blog.csdn.net/weixin_42688444】",
    "",
    "## 工作经历",
    "### 某厂 (2020-01 — 2023-12)",
    "- 订单系统",
  ].join("\n");

  it("从首两行推断姓名与职位", () => {
    const d = parseResumeText(docxLike);
    expect(d.name).toBe("谭泳超");
    expect(d.title).toBe("AI Agent 应用开发工程师");
  });

  it("从头部块正则提取联系方式", () => {
    const d = parseResumeText(docxLike);
    expect(d.contact.email).toBe("tan5168203@163.com");
    expect(d.contact.phone).toBe("+86 135-9059-7722");
    expect(d.contact.github).toBe("github.com/chaosst");
    // 首个非 github 链接作个人站点
    expect(d.contact.website).toBe("https://blog.csdn.net/weixin_42688444");
  });

  it("含分隔符的信息行不会被误当作姓名/职位", () => {
    const d = parseResumeText(["张三", "前端工程师", "邮箱：a@b.com"].join("\n"));
    expect(d.name).toBe("张三");
    expect(d.title).toBe("前端工程师");
  });

  it("无 frontmatter 时不用头部噪声充当 summary", () => {
    const d = parseResumeText(docxLike);
    expect(d.summary).toBe("");
  });

  it("frontmatter 存在时优先于头部推断", () => {
    const md = [
      "---",
      "name: 李四",
      "title: 后端工程师",
      "email: l@b.com",
      "---",
      "10 年后端经验",
      "",
      "## 工作经历",
      "### 某厂 (2020-01 — 2023-12)",
      "负责人",
      "- 订单系统",
    ].join("\n");
    const d = parseResumeText(md);
    expect(d.name).toBe("李四");
    expect(d.title).toBe("后端工程师");
    expect(d.contact.email).toBe("l@b.com");
    expect(d.summary).toContain("10 年后端经验");
  });
});

describe("parseResumeText 分节类型的关键词归类", () => {
  const md = [
    "## 教育背景",
    "深圳大学",
    "## 求职意向与定位",
    "求职意向：AI 应用开发",
    "## 专业技能",
    "TypeScript",
    "## AI 项目经历（重点）",
    "### 项目一：Navigate",
    "## 工作经历",
    "### 某厂 (2020-01 — 2023-12)",
    "- 订单系统",
  ].join("\n");

  it("长标题也能命中对应类型，而不是全部落到兜底", () => {
    const d = parseResumeText(md);
    expect(d.sections.map((s) => [s.title, s.type])).toEqual([
      ["教育背景", "education"],
      // 无关键词 → 兜底为 summary（旧值是 experience，会把求职意向渲染成工作经历时间线）
      ["求职意向与定位", "summary"],
      ["专业技能", "skills"],
      ["AI 项目经历（重点）", "projects"],
      ["工作经历", "experience"],
    ]);
  });

  it("「项目」规则优先于「经历」——含项目经历的标题归为 projects", () => {
    const d = parseResumeText("## AI 项目经历\n### 项目一：X\n- 内容");
    expect(d.sections[0].type).toBe("projects");
  });

  it("分节能被解析出条目（条目数决定入索引的 chunk 数）", () => {
    const d = parseResumeText(md);
    expect(d.sections.length).toBeGreaterThan(0);
    const work = d.sections.find((s) => s.title === "工作经历");
    expect(work?.items[0].title).toBe("某厂");
    expect(work?.items[0].dateRange).toBe("2020-01 — 2023-12");
    expect(work?.items[0].highlights).toContain("订单系统");
  });
});
