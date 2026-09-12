import { describe, it, expect } from "vitest";
import { htmlToMarkdown, DOCX_STYLE_MAP } from "../docx-extract.js";

describe("htmlToMarkdown", () => {
  it("标题层级原样保留", () => {
    expect(htmlToMarkdown("<h1>一级</h1><h3>三级</h3><h6>六级</h6>")).toBe("# 一级\n\n### 三级\n\n###### 六级");
  });

  it("段落之间用空行分隔", () => {
    expect(htmlToMarkdown("<p>第一段</p><p>第二段</p>")).toBe("第一段\n\n第二段");
  });

  it("行内强调：strong → **，em → *", () => {
    expect(htmlToMarkdown("<p><strong>粗</strong></p>")).toBe("**粗**");
    expect(htmlToMarkdown("<p><em>斜</em></p>")).toBe("*斜*");
  });

  it("列表：ol → 有序，ul → 无序（styleMap 修好后 mammoth 才会产出）", () => {
    expect(htmlToMarkdown("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
    expect(htmlToMarkdown("<ul><li>x</li><li>y</li></ul>")).toBe("- x\n- y");
  });

  it("★ 表格 → GFM（含分隔行）—— convertToMarkdown 丢的就是它", () => {
    const html = "<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(htmlToMarkdown(html)).toBe(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
  });

  it("★ 单元格内的 <p> / <ul> 被压成单行（GFM 单元格不能含换行）", () => {
    const html =
      "<table><tr><td><p>段落一</p><p>段落二</p></td><td><ul><li>甲</li><li>乙</li></ul></td></tr>" +
      "<tr><td>次行</td><td>值</td></tr></table>";
    const out = htmlToMarkdown(html);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("段落一");
    expect(lines[0]).toContain("段落二");
    expect(lines[0]).toContain("甲");
    expect(lines[0]).not.toContain("次行");
    expect(lines[2]).toBe("| 次行 | 值 |");
  });

  it("★ <img>（base64 内嵌证件照）被完全丢弃", () => {
    const html = `<p>前</p><p><img src="data:image/png;base64,${"A".repeat(2000)}"/></p><p>后</p>`;
    const out = htmlToMarkdown(html);
    expect(out).toBe("前\n\n后");
    expect(out).not.toContain("base64");
    expect(out).not.toContain("data:image");
  });

  it("<a> 只保留文字，丢弃 URL（避开 md 路径的 [text](url\" \\t \"dkey) 噪声）", () => {
    expect(htmlToMarkdown('<p><a href="https://x.dev">文字</a></p>')).toBe("文字");
  });

  it("实体解码：&amp; &lt; &gt; &quot; &#39; &nbsp;", () => {
    const out = htmlToMarkdown("<p>a &amp; b &lt;c&gt; &quot;d&quot; e&#39;f&#39; g&nbsp;h</p>");
    expect(out).toContain("a & b <c> \"d\" e'f'");
    expect(out).not.toContain("&amp;");
    expect(out).not.toContain("&nbsp;");
  });

  it("<script> / <style> 内容被丢弃（保底）", () => {
    expect(htmlToMarkdown("<p>正文</p><script>var x=1;</script><style>p{color:red}</style>")).toBe("正文");
  });

  it("未知标签当透明容器处理（mammoth 可能加 span 之类）", () => {
    expect(htmlToMarkdown("<p><span>透明</span>容器</p>")).toBe("透明容器");
  });

  it("<br> 变成换行", () => {
    expect(htmlToMarkdown("<p>上<br>下</p>")).toBe("上\n下");
  });

  it("容忍未闭合标签（不抛错，内容不丢）", () => {
    expect(htmlToMarkdown("<p>未闭合<strong>粗")).toBe("未闭合**粗**");
  });
});

describe("DOCX_STYLE_MAP", () => {
  it("把 Word 列表样式映射回 ol/ul（不加会有 2 条 Unrecognised paragraph style 警告）", () => {
    expect(DOCX_STYLE_MAP).toEqual([
      "p[style-name='List Number'] => ol > li:fresh",
      "p[style-name='List Bullet'] => ul > li:fresh",
    ]);
  });
});
