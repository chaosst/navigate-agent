import { describe, it, expect } from "vitest";
import {
  clipCodeLines,
  parseBlocks,
  parseInline,
  renderTableBlock,
  splitTableRow,
} from "../markdown.js";
import { textWidth } from "../layout.js";

/**
 * 解析器有两条硬约束（对应真实缺陷）：
 *
 * 1. **容忍半截输入**：预览每 80ms 重解析一次，此刻文本可能停在 ` ```ts ` 之后、
 *    或 `**加粗` 只写了一半。旧实现直接把 markdown 源码糊在屏上，所以这条是新增的；
 *    一旦解析器把半截标记吞掉，流式过程中文字会「跳」。
 * 2. **不能膨胀行数**：动态区按终端行数发预算（layout.ts），一个源码行变成一个渲染行
 *    才不超预算。表格不额外插分隔行、围栏的收尾行被吃掉，都是为了这个。
 */
describe("parseInline", () => {
  it("普通文本原样返回", () => {
    expect(parseInline("就是一段话")).toEqual([{ kind: "text", text: "就是一段话" }]);
  });

  it("**加粗** / *斜体* / ~~删除线~~ / `行内代码`", () => {
    expect(parseInline("**加粗**")).toEqual([{ kind: "bold", text: "加粗" }]);
    expect(parseInline("*斜体*")).toEqual([{ kind: "italic", text: "斜体" }]);
    expect(parseInline("~~删除~~")).toEqual([{ kind: "strike", text: "删除" }]);
    expect(parseInline("`fetch failed`")).toEqual([{ kind: "code", text: "fetch failed" }]);
  });

  it("[文本](url) → link", () => {
    expect(parseInline("见 [部署文档](https://x.dev/dep)")).toEqual([
      { kind: "text", text: "见 " },
      { kind: "link", text: "部署文档", href: "https://x.dev/dep" },
    ]);
  });

  it("★ 未闭合标记当字面量，绝不吞字符（流式切换点）", () => {
    expect(parseInline("**未闭合")).toEqual([{ kind: "text", text: "**未闭合" }]);
    expect(parseInline("`未闭合")).toEqual([{ kind: "text", text: "`未闭合" }]);
    expect(parseInline("~~未闭合")).toEqual([{ kind: "text", text: "~~未闭合" }]);
    expect(parseInline("[未闭合(url")).toEqual([{ kind: "text", text: "[未闭合(url" }]);
  });

  it("反斜杠转义不被当成标记", () => {
    expect(parseInline("\\*不是斜体\\*")).toEqual([{ kind: "text", text: "*不是斜体*" }]);
  });

  it("纯空格 / 空串不产生空片段", () => {
    expect(parseInline("")).toEqual([]);
    expect(parseInline(" ")).toEqual([{ kind: "text", text: " " }]);
  });

  it("混排：文字 + 代码 + 加粗 顺序不乱、字符不丢", () => {
    const parts = parseInline("先 `a` 再 **b** 后");
    expect(parts.map((p) => p.text).join("")).toBe("先 a 再 b 后");
    expect(parts.map((p) => p.kind)).toEqual(["text", "code", "text", "bold", "text"]);
  });
});

describe("parseBlocks", () => {
  it("标题：# 的个数即层级，收尾 # 被吃掉", () => {
    expect(parseBlocks("## 小标题 ##")).toEqual([{ kind: "heading", level: 2, text: "小标题" }]);
    expect(parseBlocks("# 一级").at(0)).toEqual({ kind: "heading", level: 1, text: "一级" });
  });

  it("段落保留源码换行（不 join 成一行，避免中文被插空格）", () => {
    expect(parseBlocks("第一行\n第二行")).toEqual([
      { kind: "paragraph", text: "第一行\n第二行" },
    ]);
  });

  it("空行产出 blank 块（间距跟随作者意图）", () => {
    expect(parseBlocks("A\n\nB").map((b) => b.kind)).toEqual(["paragraph", "blank", "paragraph"]);
  });

  it("无序 / 有序列表（有序列表保留起始序号），缩进转 depth", () => {
    expect(parseBlocks("- 一\n- 二").at(0)).toEqual({
      kind: "list",
      ordered: false,
      start: 1,
      items: [
        { text: "一", depth: 0 },
        { text: "二", depth: 0 },
      ],
    });
    const ordered = parseBlocks("3. 三\n4. 四").at(0) as { start: number; items: unknown[] };
    expect(ordered.start).toBe(3);
    expect(ordered.items).toHaveLength(2);
    const nested = parseBlocks("  - 缩进一层").at(0) as { items: { depth: number }[] };
    expect(nested.items[0].depth).toBe(1);
  });

  it("★ 有序/无序混排拆成两个 list 块：嵌套的 `- 子项` 不该被续编成 `3.`", () => {
    const blocks = parseBlocks("1. 一\n2. 二\n  - 甲\n  - 乙");
    expect(blocks.map((b) => b.kind)).toEqual(["list", "list"]);
    const first = blocks[0] as { ordered: boolean; items: unknown[] };
    const second = blocks[1] as { ordered: boolean; items: { text: string; depth: number }[] };
    expect(first.ordered).toBe(true);
    expect(first.items).toHaveLength(2);
    expect(second.ordered).toBe(false);
    expect(second.items.map((it) => it.text)).toEqual(["甲", "乙"]);
    expect(second.items[0].depth).toBe(1);
  });

  it("引用 / 分隔线", () => {    expect(parseBlocks("> 引用一\n> 引用二").at(0)).toEqual({
      kind: "quote",
      text: "引用一\n引用二",
    });
    expect(parseBlocks("---").at(0)).toEqual({ kind: "rule" });
    expect(parseBlocks("***").at(0)).toEqual({ kind: "rule" });
  });

  it("围栏代码块：吃掉收尾行、内容不再被解析", () => {
    expect(parseBlocks("```ts\n# 不是标题\nconst a = 1;\n```")).toEqual([
      { kind: "code", lang: "ts", lines: ["# 不是标题", "const a = 1;"], closed: true },
    ]);
  });

  it("★ 未闭合围栏 → 当「正在流式的代码块」，不能把 ``` 漏成正文", () => {
    expect(parseBlocks("```ts\nconst a = 1;")).toEqual([
      { kind: "code", lang: "ts", lines: ["const a = 1;"], closed: false },
    ]);
  });

  it("表格：表头 + 分隔行 + 数据行（分隔行不出现在结果里）", () => {
    const blocks = parseBlocks("| 工具 | 调用 |\n|---|---|\n| read_file | 3 |");
    expect(blocks).toEqual([
      { kind: "table", header: ["工具", "调用"], rows: [["read_file", "3"]] },
    ]);
  });

  it("只有 | 而没有分隔行 → 仍然按段落处理（不是表格）", () => {
    expect(parseBlocks("a | b").at(0)?.kind).toBe("paragraph");
  });

  it("splitTableRow：两侧竖线剥掉、`\\|` 不当分隔", () => {
    expect(splitTableRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitTableRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("列表里夹代码块不会无限循环（块边界判定自洽）", () => {
    const blocks = parseBlocks("- 一\n```\ncode\n```\n- 二");
    expect(blocks.map((b) => b.kind)).toEqual(["list", "code", "list"]);
  });
});

describe("renderTableBlock", () => {
  it("宽度够时每列按最宽内容对齐，行宽一致", () => {
    const lines = renderTableBlock(["工具", "调用"], [["read_file", "3"]], 80);
    expect(lines).toHaveLength(2);
    expect(textWidth(lines[0])).toBe(textWidth(lines[1]));
    expect(lines[0]).toContain("工具");
    expect(lines[0]).toContain("│");
    expect(lines[1]).toContain("read_file");
  });

  it("★ 宽度不够时逐列削减，保证一行都不折行（折行会多占终端行、撑爆行预算）", () => {
    const lines = renderTableBlock(
      ["工具", "调用次数"],
      [["some_really_long_tool_name", "1234567890"]],
      20,
    );
    for (const line of lines) {
      expect(textWidth(line)).toBeLessThanOrEqual(20);
    }
    // 超宽单元格被截断（保留行首 + 省略号），不是整行丢弃
    expect(lines[1]).toContain("…");
    expect(lines[1]).toContain("some");
  });

  it("中文按显示宽度补齐（不是按字符数），列不会错位", () => {
    const lines = renderTableBlock(["名", "值"], [["中文中文", "1"]], 80);
    expect(textWidth(lines[0].split("│")[0])).toBe(textWidth(lines[1].split("│")[0]));
  });

  it("列数多到放不下时（每列已到下限）整行硬截，绝不折行", () => {
    const header = ["工具", "调用", "平均耗时", "错误", "权限"];
    const rows = [["execute_command", "1", "850ms", "0", "高危"]];
    for (const maxWidth of [10, 14, 20]) {
      const lines = renderTableBlock(header, rows, maxWidth);
      for (const line of lines) {
        expect(textWidth(line)).toBeLessThanOrEqual(maxWidth);
      }
    }
  });

  it("空表格 / 无列 → 空数组（不渲染空行）", () => {
    expect(renderTableBlock([], [], 80)).toEqual([]);
  });
});

describe("clipCodeLines", () => {
  it("不超上限时原样返回", () => {
    expect(clipCodeLines(["a", "b"], 5)).toEqual({ lines: ["a", "b"], dropped: 0 });
  });

  it("超上限时保留头部 + 计数省略行数（标记行占 1 行）", () => {
    const { lines, dropped } = clipCodeLines(["1", "2", "3", "4", "5"], 3);
    expect(lines).toEqual(["1", "2"]);
    expect(dropped).toBe(3);
  });

  it("上限为 1 时至少留 1 行内容", () => {
    const { lines } = clipCodeLines(["1", "2"], 1);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
