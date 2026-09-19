import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ResumeData, SectionType } from "../../resume/types.js";
import { FakeEvent, mountResumePage } from "./resume-page-harness.js";

/**
 * 回归背景：`resume.html` 的 experience/education 渲染分支只输出 title / subtitle /
 * dateRange / highlights，**从不输出 item.description**。于是「教育背景」「求职意向与定位」
 * 「核心亮点」这类正文全在 description、highlights 为空的分节，卡片里只剩一个标题 ——
 * 页面上表现为「这一节是空的」。
 *
 * 这类缺陷单元测试抓不到（解析层数据是好的），只有真正跑一遍渲染函数才暴露。
 * 下面用假 DOM 执行 resume.html 里那段真实脚本，对渲染产物做断言
 * （shim 与 scripts/preview-resume-page.ts 共用一份，见 resume-page-harness.ts）。
 */

const HTML_PATH = path.resolve(process.cwd(), "src/server/public/resume.html");

/** 用假 DOM 跑一遍页面脚本，返回 #app 的渲染结果 */
async function renderPage(data: ResumeData): Promise<string> {
  const { app } = await mountResumePage(readFileSync(HTML_PATH, "utf-8"), data);
  return app.renderedHtml ?? "";
}

/** 每个分节只放「正文在 description、highlights 为空」的条目 —— 正是出问题的形态 */
const fixture: ResumeData = {
  name: "张三",
  title: "AI Agent 应用开发工程师",
  summary: "",
  contact: { email: "z@example.com" },
  sections: [
    {
      type: "experience",
      title: "工作经历",
      items: [
        {
          title: "某厂 (2020-01 — 2023-12)",
          dateRange: "2020-01 — 2023-12",
          description: "负责核心系统重构",
          highlights: ["性能提升 30%"],
        },
      ],
    },
    {
      type: "education",
      title: "教育背景",
      items: [{ title: "教育背景", description: "某大学 ｜ 计算机科学与技术 ｜ 本科", highlights: [] }],
    },
    {
      type: "summary",
      title: "求职意向与定位",
      items: [{ title: "求职意向与定位", description: "求职意向：Agent 开发工程师", highlights: [] }],
    },
    {
      type: "skills",
      title: "专业技能",
      items: [{ title: "专业技能", description: "TypeScript,Node.js", highlights: [] }],
    },
    {
      type: "projects",
      title: "项目经历",
      items: [{ title: "项目一：Navigate", description: "多模式 Agent 系统", highlights: ["自研编排"] }],
    },
    {
      type: "certifications",
      title: "证书",
      items: [{ title: "证书", description: "华为 HCIA 认证", highlights: [] }],
    },
    {
      type: "languages",
      title: "语言",
      items: [{ title: "语言", description: "英语 CET-6", highlights: [] }],
    },
  ],
};

describe("resume.html 渲染：分节正文不得为空", () => {
  it("每一节的 description 都必须出现在渲染结果里", async () => {
    const html = await renderPage(fixture);
    expect(html.length).toBeGreaterThan(0);

    // 逐个分节核对正文，任一节丢失都会失败
    for (const fragment of [
      "负责核心系统重构", // experience
      "某大学 ｜ 计算机科学与技术 ｜ 本科", // education ← 曾整节空白
      "求职意向：Agent 开发工程师", // summary ← 曾整节空白
      "TypeScript", // skills
      "多模式 Agent 系统", // projects
      "华为 HCIA 认证", // certifications ← 旧渲染器完全没有该分支
      "英语 CET-6", // languages ← 旧渲染器完全没有该分支
    ]) {
      expect(html, `渲染结果缺少「${fragment}」`).toContain(fragment);
    }
  });

  it("每个 SectionType 都有可见内容（新增类型不会静默渲染成空白）", async () => {
    const html = await renderPage(fixture);
    const types: SectionType[] = [
      "experience",
      "education",
      "skills",
      "projects",
      "certifications",
      "languages",
      "summary",
    ];
    // fixture 覆盖了全部 SectionType —— 新增类型时这里会失败，提醒同步 fixture
    expect(fixture.sections.map((s) => s.type).sort()).toEqual([...types].sort());

    for (const section of fixture.sections) {
      const cardStart = html.indexOf(section.title);
      expect(cardStart, `分节「${section.title}」的标题未渲染`).toBeGreaterThanOrEqual(0);
      // 该节标题之后必须还有它的正文/标签，否则就是「有标题没内容」的空卡片
      const item = section.items[0];
      const needle = section.type === "skills" ? "TypeScript" : item.description;
      expect(html.slice(cardStart), `分节「${section.title}」渲染为空`).toContain(needle);
    }
  });

  it("合成分节的条目标题不与分节标题重复", async () => {
    const html = await renderPage(fixture);
    // 解析器为「无 ### 条目的分节」合成的 item.title === section.title，
    // 渲染时若不去重，页面会出现上下两个同名标题
    for (const title of ["教育背景", "求职意向与定位", "证书", "语言"]) {
      const count = html.split(title).length - 1;
      expect(count, `「${title}」在渲染结果里出现了 ${count} 次`).toBe(1);
    }
  });

  it("技能内容落在 highlights 时同样能渲染（resume.md 的 bullet 写法）", async () => {
    // `- **前端**: React, TypeScript` 这类 bullet 会进 item.highlights 而非 description，
    // 渲染器只读 tags/description 的话，整节技能就是一张空卡片
    const data: ResumeData = {
      ...fixture,
      sections: [
        {
          type: "skills",
          title: "技能",
          items: [{ title: "技能", description: "", highlights: ["React, TypeScript"] }],
        },
      ],
    };
    const html = await renderPage(data);
    expect(html).toContain("React");
    expect(html).toContain("TypeScript");
  });

  it("description 中的换行被转成 <br>，不会被浏览器折叠成空格", async () => {
    const data: ResumeData = {
      ...fixture,
      sections: [
        {
          type: "summary",
          title: "核心亮点",
          items: [{ title: "核心亮点", description: "第一行\n第二行", highlights: [] }],
        },
      ],
    };
    const html = await renderPage(data);
    expect(html).toContain("第一行<br>第二行");
  });
});

/**
 * 回归背景：`#downloadPdf` 从写完那天起就只有 `id`、**没有任何监听器** ——
 * 它是 `href="javascript:void(0)"` 的 `<a>`，点了既不下载也不报错，是个死按钮。
 *
 * 修复走「浏览器打印 → 目标选另存为 PDF」：不引 PDF 生成库（中文要嵌字体，体积与排版
 * 成本都高），也不用 CDN 脚本（面试官网络受限时会白屏）。所以这里锁两件事：
 * ① 点击真的走到 `window.print()`；② 打印样式存在（否则打出来是暗色稿 + 带导航栏）。
 */
describe("resume.html 下载 PDF 按钮", () => {
  it("点击 #downloadPdf 会调用 window.print()", async () => {
    // 注意：不要解构 printCalls —— 解构会立刻求值 getter，拿到的是挂载时的 0
    const page = await mountResumePage(readFileSync(HTML_PATH, "utf-8"), fixture);
    expect(page.pdfBtn.clickHandlers.length, "#downloadPdf 没有绑定任何 click 监听器").toBeGreaterThan(0);

    const e = new FakeEvent();
    for (const h of page.pdfBtn.clickHandlers) h(e);
    expect(page.printCalls, "点击后没有调用 window.print()").toBe(1);
    expect(e.defaultPrevented, "未阻止 <a href=\"javascript:void(0)\"> 的默认行为").toBe(true);
  });

  it("打印稿带上 @media print：覆盖回浅色 + 隐藏交互 chrome", () => {
    const html = readFileSync(HTML_PATH, "utf-8");
    expect(html, "缺少 @media print 打印样式").toContain("@media print");
    const print = html.slice(html.indexOf("@media print"));

    // prefers-color-scheme: dark 的变量会被带进打印稿 → 必须显式覆盖回浅色
    expect(print, "--bg 没有在打印稿里覆盖回浅色").toMatch(/--bg:\s*#fff/);
    // 导航栏 / 下载按钮是交互元素，不该进纸
    expect(print, "导航栏没有在打印稿里隐藏").toMatch(/\.nav-bar[\s\S]{0,80}display:\s*none/);
    expect(print, "下载按钮没有在打印稿里隐藏").toMatch(/#downloadPdf[\s\S]{0,40}display:\s*none/);
    // 浏览器默认丢弃背景色 → 技能标签会变成白字白底，必须保住底色
    expect(print, "技能标签没有保住底色（白字白底看不见）").toMatch(/print-color-adjust:\s*exact/);
  });
});
