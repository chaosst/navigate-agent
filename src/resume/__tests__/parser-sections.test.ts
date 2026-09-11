import { describe, it, expect } from "vitest";
import { parseResumeText } from "../parser.js";

/**
 * 回归背景（2026-09-11）：finalizeItem 只收尾、不把条目放进 section.items，
 * 而 finalizeSection 只会推入「该分节的最后一个条目」——
 * 结果是多条目分节里的 intermediate item 被静默丢弃。
 *
 * 实测后果：一份含两段工作经历的真实简历，解析后只剩最后一段
 * （华为 OD 那段经历整体消失），而简历问答会如实回答「只有一段工作经历」——
 * 错误被伪装成了「简历本来就没写」。
 */
describe("parseSections 多条目分节", () => {
  const md = [
    "## 工作经历",
    "### 甲公司 (2023-11 — 至今)",
    "鸿蒙开发工程师",
    "- 端侧交付",
    "- 性能优化",
    "### 乙公司 (2015-12 — 2023-08)",
    "前端架构师",
    "- 微前端框架",
    "### 丙公司 (2013-01 — 2015-11)",
    "前端工程师",
    "- 页面开发",
  ].join("\n");

  it("分节内所有条目全部保留，不只是最后一个", () => {
    const d = parseResumeText(md);
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0].items.map((i) => i.title)).toEqual(["甲公司", "乙公司", "丙公司"]);
  });

  it("各条目保留自己的日期、副标题与亮点，不与相邻条目串味", () => {
    const d = parseResumeText(md);
    const [a, b, c] = d.sections[0].items;
    expect(a.dateRange).toBe("2023-11 — 至今");
    expect(a.subtitle).toBe("鸿蒙开发工程师");
    expect(a.highlights).toEqual(["端侧交付", "性能优化"]);
    expect(b.dateRange).toBe("2015-12 — 2023-08");
    expect(b.subtitle).toBe("前端架构师");
    expect(b.highlights).toEqual(["微前端框架"]);
    expect(c.highlights).toEqual(["页面开发"]);
  });

  it("跨分节不串味：每个分节各自收好自己的条目", () => {
    const d = parseResumeText(
      ["## 工作经历", "### 甲公司", "- a", "## 项目", "### 项目甲", "- p", "### 项目乙", "- q"].join("\n"),
    );
    expect(d.sections.map((s) => s.items.map((i) => i.title))).toEqual([
      ["甲公司"],
      ["项目甲", "项目乙"],
    ]);
  });

  it("分节层级文本 + 条目混排时，两者都在（合成条目 + 真实条目）", () => {
    const d = parseResumeText(
      ["## 专业技能", "关键词：TypeScript / Node.js", "", "### 专项", "- MCP"].join("\n"),
    );
    const titles = d.sections[0].items.map((i) => i.title);
    expect(titles).toContain("专业技能"); // 条目之前的层级文本合成条目
    expect(titles).toContain("专项");
  });
});
