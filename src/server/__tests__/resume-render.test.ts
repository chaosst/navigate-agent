import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ResumeData, SectionType } from "../../resume/types.js";

/**
 * 回归背景：`resume.html` 的 experience/education 渲染分支只输出 title / subtitle /
 * dateRange / highlights，**从不输出 item.description**。于是「教育背景」「求职意向与定位」
 * 「核心亮点」这类正文全在 description、highlights 为空的分节，卡片里只剩一个标题 ——
 * 页面上表现为「这一节是空的」。
 *
 * 这类缺陷单元测试抓不到（解析层数据是好的），只有真正跑一遍渲染函数才暴露。
 * 下面用一个最小 DOM shim 执行 resume.html 里那段真实脚本，对渲染产物做断言。
 */

const HTML_PATH = path.resolve(process.cwd(), "src/server/public/resume.html");

/** 浏览器把文本节点的 innerHTML 序列化为转义后的字符串 */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class FakeEl {
  textContent = "";
  /** 被赋值 innerHTML 时捕获原始 HTML（用于读取 #app 的渲染结果） */
  renderedHtml: string | null = null;

  set innerHTML(v: string) {
    this.renderedHtml = v;
    this.textContent = "";
  }
  get innerHTML(): string {
    return escapeText(this.textContent);
  }
}

function extractScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("resume.html 中找不到 <script> 块");
  return m[1];
}

/** 用假 DOM 跑一遍页面脚本，返回 #app 的渲染结果 */
async function renderPage(data: ResumeData): Promise<string> {
  const script = extractScript(readFileSync(HTML_PATH, "utf-8"));

  const app = new FakeEl();
  const fakeDocument = {
    getElementById: (id: string) => (id === "app" ? app : new FakeEl()),
    createElement: () => new FakeEl(),
    querySelectorAll: () => [] as unknown[],
  };
  const session = new Map<string, string>([["navigate_token", "test-token"]]);
  const fakeSessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  };
  const fakeLocation = { search: "", pathname: "/resume", href: "" };
  const fakeFetch = async (url: string) => ({
    json: async () => (url.includes("/api/me") ? { isAdmin: true } : data),
  });

  const run = new Function(
    "document",
    "location",
    "sessionStorage",
    "fetch",
    "URLSearchParams",
    script,
  );
  run(fakeDocument, fakeLocation, fakeSessionStorage, fakeFetch, URLSearchParams);

  // loadResume() 是异步的（fetch → json → render），放行微任务后取渲染结果
  await new Promise((r) => setTimeout(r, 20));
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
