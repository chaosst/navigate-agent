import { describe, it, expect } from "vitest";
import { splitByHeadings, chunkMdSections, chunkMarkdownText } from "../md-chunker.js";

const OPTS = { chunkSize: 1000, chunkOverlap: 200, filename: "方案.md" };

/** 生成 n 个中文字符（无标点，便于精确控制长度） */
const fill = (n: number): string => "字".repeat(n);

const countFences = (s: string): number => (s.match(/^```/gm) || []).length;

describe("splitByHeadings", () => {
  it("嵌套标题 → headingPath 是含自身的面包屑", () => {
    const md = ["## 四、专业技能", "### 后端能力", "TypeScript / Node.js", "", "### 前端能力", "React"].join("\n");
    const sections = splitByHeadings(md);

    expect(sections).toHaveLength(2);
    expect(sections[0].headingPath).toEqual(["四、专业技能", "后端能力"]);
    expect(sections[0].body).toBe("TypeScript / Node.js");
    expect(sections[1].headingPath).toEqual(["四、专业技能", "前端能力"]);
    expect(sections[1].body).toBe("React");
  });

  it("标题之前的正文 → 一个 headingPath 为 [] 的前言节", () => {
    const md = ["一段没有归属的引言。", "", "## 第一节", "正文"].join("\n");
    const sections = splitByHeadings(md);

    expect(sections[0].headingPath).toEqual([]);
    expect(sections[0].body).toBe("一段没有归属的引言。");
    expect(sections[1].headingPath).toEqual(["第一节"]);
  });

  it("只有标题没有正文的节被丢弃（避免'有标题没内容'的空 chunk）", () => {
    const md = ["## 空节", "## 有内容", "正文"].join("\n");
    const sections = splitByHeadings(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].headingPath).toEqual(["有内容"]);
  });

  it("无标题文档 → 单个 headingPath 为 [] 的节（整篇即前言）", () => {
    const md = "纯文本一篇。\n没有标题结构。";
    const sections = splitByHeadings(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].headingPath).toEqual([]);
    expect(sections[0].body).toBe(md);
  });

  it("★ 已闭合的代码围栏内的 '# 注释' 不算标题", () => {
    const md = ["## 用法", "```bash", "# 这是注释不是标题", "npm run dev", "```", "结束"].join("\n");
    const sections = splitByHeadings(md);

    expect(sections).toHaveLength(1);
    expect(sections[0].headingPath).toEqual(["用法"]);
    expect(sections[0].body).toContain("# 这是注释不是标题");
    expect(sections[0].body).toContain("结束");
  });

  it("★ 未闭合的代码围栏之后的 '# 行' 同样不算标题", () => {
    const md = ["## 用法", "```bash", "# 注释", "npm run dev"].join("\n");
    const sections = splitByHeadings(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].headingPath).toEqual(["用法"]);
  });

  it("层级跳跃（h1 → h4）不产生 undefined 面包屑", () => {
    const md = ["# 顶层", "#### 深潜", "正文"].join("\n");
    const sections = splitByHeadings(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].headingPath).toEqual(["顶层", "深潜"]);
  });
});

describe("chunkMdSections", () => {
  it("3 个小节 → 3 个 chunk，各自 headingPath 正确，不跨标题边界", async () => {
    const md = [
      "## 一、背景",
      fill(200),
      "## 二、方案",
      fill(200),
      "## 三、结论",
      fill(200),
    ].join("\n");
    const out = await chunkMdSections(splitByHeadings(md), OPTS);

    expect(out).toHaveLength(3);
    expect(out.map((c) => c.metadata.headingPath)).toEqual([["一、背景"], ["二、方案"], ["三、结论"]]);
    expect(out[0].content).not.toContain(fill(201)); // 没把别节内容拉进来
    for (const c of out) expect(c.metadata.strategy).toBe("md-heading");
  });

  it("content 以叶标题开头（正文里往往不出现章节名，靠前缀做语义定位）", async () => {
    const md = ["## 四、专业技能", "TypeScript / Node.js"].join("\n");
    const out = await chunkMdSections(splitByHeadings(md), OPTS);
    expect(out[0].content).toBe(`四、专业技能\n\nTypeScript / Node.js`);
  });

  it("headingPath 为 [] 的前言节 → content 不加前缀", async () => {
    const md = ["开篇引言。", "## 第一节", "正文"].join("\n");
    const out = await chunkMdSections(splitByHeadings(md), OPTS);
    expect(out[0].metadata.headingPath).toEqual([]);
    expect(out[0].content).toBe("开篇引言。");
  });

  it("超长节内切：每片同一 headingPath，partIndex 递增、partTotal 一致", async () => {
    const md = ["## 长节", fill(5000)].join("\n");
    const out = await chunkMdSections(splitByHeadings(md), OPTS);

    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.metadata.headingPath).toEqual(["长节"]);
      expect(c.metadata.partTotal).toBe(out.length);
    }
    expect(out.map((c) => c.metadata.partIndex)).toEqual(out.map((_, i) => i));
    for (const c of out) expect(c.content.startsWith("长节\n\n")).toBe(true);
  });

  it("★ 代码块整体落在同一个 chunk 内（围栏成对，不被拦腰切断）", async () => {
    const code = ["```ts", "export function a() {", "  return 1;", "}", "```"].join("\n");
    const md = ["## 示例", "代码如下：", "", code, "", "以上。"].join("\n");
    const out = await chunkMdSections(splitByHeadings(md), OPTS);

    expect(out).toHaveLength(1);
    expect(countFences(out[0].content)).toBe(2);
  });

  it("metadata：filename / source 正确，source 可被覆盖", async () => {
    const md = ["## 标题", "正文"].join("\n");
    const out = await chunkMdSections(splitByHeadings(md), { ...OPTS, source: "wiki/x" });
    expect(out[0].metadata.filename).toBe("方案.md");
    expect(out[0].metadata.source).toBe("wiki/x");
  });
});

describe("chunkMarkdownText", () => {
  it("有标题 → 走结构化切块（strategy=md-heading）", async () => {
    const md = ["## 一、背景", fill(200), "## 二、方案", fill(200)].join("\n");
    const out = await chunkMarkdownText(md, OPTS);
    expect(out.map((c) => c.metadata.strategy)).toEqual(["md-heading", "md-heading"]);
    expect(out[0].metadata.headingPath).toEqual(["一、背景"]);
  });

  it("无标题（如纯表格 markdown）→ fail-safe 退回字符切块（strategy=text-char）", async () => {
    const md = ["| 姓名 | 部门 |", "| --- | --- |", "| 张三 | 工程 |"].join("\n");
    const out = await chunkMarkdownText(md, OPTS);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.metadata.strategy).toBe("text-char");
      expect(c.metadata.headingPath).toBeUndefined();
    }
  });

  it("空文本 → []，不抛错", async () => {
    expect(await chunkMarkdownText("", OPTS)).toEqual([]);
    expect(await chunkMarkdownText("   \n\n  ", OPTS)).toEqual([]);
  });
});
