import { describe, it, expect } from "vitest";
import { estimateBlockRows, keepTailBlocks } from "../markdown-view.js";
import type { MdBlock } from "../markdown.js";

const para = (text: string): MdBlock => ({ kind: "paragraph", text });
const paras = (n: number): MdBlock[] => Array.from({ length: n }, (_, i) => para(`第${i + 1}段`));

describe("estimateBlockRows", () => {
  it("代码块 = min(行数, cap) + 3（头/尾/margin）", () => {
    const block: MdBlock = { kind: "code", lang: "ts", lines: ["a", "b", "c", "d", "e"], closed: true };
    expect(estimateBlockRows(block, 80, 3)).toBe(6);
    expect(estimateBlockRows(block, 80, 10)).toBe(8);
  });

  it("段落按列宽折行估算", () => {
    expect(estimateBlockRows(para("短文本"), 80, 40)).toBe(1);
    // 160 个英文列宽字符在 80 列终端上占 2 行
    expect(estimateBlockRows(para("x".repeat(160)), 80, 40)).toBe(2);
  });

  it("blank / rule 各 1 行", () => {
    expect(estimateBlockRows({ kind: "blank" }, 80, 40)).toBe(1);
    expect(estimateBlockRows({ kind: "rule" }, 80, 40)).toBe(1);
  });
});

describe("keepTailBlocks", () => {
  it("全部放得下时原样返回", () => {
    const blocks = paras(3);
    const r = keepTailBlocks(blocks, 10, 80, 40);
    expect(r.blocks).toBe(blocks);
    expect(r.dropped).toBe(0);
  });

  it("放不下时保留尾部并给出被裁块数", () => {
    const blocks = paras(5);
    const r = keepTailBlocks(blocks, 4, 80, 40);
    expect(r.dropped).toBe(2);
    expect(r.blocks).toHaveLength(3);
    expect((r.blocks[0] as { text: string }).text).toBe("第3段");
    expect((r.blocks[2] as { text: string }).text).toBe("第5段");
  });

  it("代码块行数与 codeCap 联动，单块不超 maxRows", () => {
    const code: MdBlock = { kind: "code", lang: "ts", lines: Array.from({ length: 50 }, (_, i) => `l${i}`), closed: true };
    // app 层 MarkdownView 传 codeCap = min(maxCodeRows, maxRows-4) = min(40, 2) = 2
    // code est = 2+3 = 5；head 段落 est = 2（160 宽字符 / 80 列）
    const head: MdBlock = { kind: "paragraph", text: "x".repeat(160) };
    const r = keepTailBlocks([head, code], 6, 80, 2);
    // select(6): 5+2=7 > 6 → 留 code；select(5): code 5 ≤ 5 → 保留 code 裁 head，dropped=1
    expect(r.dropped).toBe(1);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].kind).toBe("code");
  });

  it("连单块都放不进 maxRows-1 时保底留末块且 dropped=-1（不渲染头标记）", () => {
    const huge: MdBlock = { kind: "paragraph", text: "很".repeat(400) }; // 400 列宽 / 80 列 = 5 行
    const r = keepTailBlocks([huge], 4, 80, 40);
    expect(r.dropped).toBe(-1);
    expect(r.blocks).toHaveLength(1);
  });
});
