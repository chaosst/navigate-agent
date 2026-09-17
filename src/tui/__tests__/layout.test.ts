import { describe, it, expect } from "vitest";
import {
  CHROME_ROWS,
  computeDynamicBudget,
  charWidth,
  tailByRows,
  tailByWidth,
  textWidth,
  truncateToWidth,
  visualRows,
} from "../layout.js";

/**
 * 这批不变式对应的真实缺陷（2026-09-16 用户报的「输入框跑到顶部、下方一大块空隙」）：
 *
 * Ink 的动态帧每帧 `eraseLines(上一帧行数)` 原地重画，而光标最多只能上移到首行。
 * 一旦动态帧行数 ≥ 终端行数，擦除被夹在屏幕顶端 → 新帧画在屏幕上方，下面留一大片空白。
 *
 * 旧 `clipPreview` 按「逻辑行数 + 字符数」算预算：一行 1200 字符的中文在 80 列终端上
 * 实际是 15+ 行，预算却只算 1 行 —— 这是帧高失控的直接来源。
 * 所以本文件的核心断言是：**裁剪结果的终端行数不超过预算**。
 */
describe("textWidth / visualRows", () => {
  it("ASCII 每字符 1 列，中文/全角每字符 2 列", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("中文")).toBe(4);
    expect(textWidth("a中")).toBe(3);
    expect(charWidth(0x4e2d)).toBe(2);
    expect(charWidth(0x41)).toBe(1);
  });

  it("组合符 / 变体选择符零宽（emoji 的 VS16 不应把宽度算成 3）", () => {
    // ⚠️ = U+26A0 + U+FE0F
    expect(textWidth("\u26a0\ufe0f")).toBe(1);
    expect(textWidth("e\u0301")).toBe(1);
  });

  it("空白行算 1 行，空串算 0 行", () => {
    expect(visualRows("", 80)).toBe(0);
    expect(visualRows("\n", 80)).toBe(2);
    expect(visualRows(" ", 80)).toBe(1);
  });

  it("按显示宽度折行：40 个中文字符在 40 列终端上占 2 行", () => {
    expect(visualRows("中".repeat(40), 40)).toBe(2);
    expect(visualRows("中".repeat(40), 80)).toBe(1);
    expect(visualRows("中".repeat(41), 80)).toBe(2);
  });

  it("columns 非法（0 / 负数）时回落 80 列而非除零", () => {
    expect(visualRows("a".repeat(81), 0)).toBe(2);
    expect(visualRows("a".repeat(81), -5)).toBe(2);
  });
});

describe("tailByWidth", () => {  it("放得下就原样返回", () => {
    expect(tailByWidth("abc", 10)).toBe("abc");
  });

  it("超宽时留尾部并加省略号，且不切出半截宽字符", () => {
    const out = tailByWidth("中".repeat(10), 5);
    expect(out.startsWith("…")).toBe(true);
    expect(textWidth(out)).toBeLessThanOrEqual(5);
    // 全是完整汉字（无 U+FFFD 之类）
    expect(out.slice(1)).toMatch(/^中+$/);
  });

  it("宽度预算为 0 / 负数 → 空串（不返回半截内容）", () => {
    expect(tailByWidth("abc", 0)).toBe("");
    expect(tailByWidth("abc", -1)).toBe("");
  });
});

describe("truncateToWidth（保头部，表格单元格 / 省略标记用）", () => {
  it("放得下原样返回", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
  });

  it("超宽时保留行首并加省略号，宽度精确不超限", () => {
    const out = truncateToWidth("中文中文中文", 8);
    expect(out.endsWith("…")).toBe(true);
    expect(textWidth(out)).toBeLessThanOrEqual(8);
    expect(out.startsWith("中文")).toBe(true);
  });

  it("边界宽度 0 / 1 不产生超宽结果", () => {
    expect(textWidth(truncateToWidth("abc", 0))).toBeLessThanOrEqual(0);
    expect(textWidth(truncateToWidth("abc", 1))).toBeLessThanOrEqual(1);
  });
});

describe("tailByRows（旧 clipPreview 的回归不变式 + 新增行预算不变式）", () => {
  it("短文本原样返回（不加任何标记）", () => {
    const text = "第一行\n第二行";
    expect(tailByRows(text, { rows: 10 })).toBe(text);
  });

  it("恰好等于行上限时不加省略标记", () => {
    const text = "a\nb";
    expect(tailByRows(text, { rows: 2 })).toBe(text);
  });

  it("空串 → 空串", () => {
    expect(tailByRows("", { rows: 5 })).toBe("");
  });

  it("超行预算时只保留尾部整行，且省略标记自身占 1 行", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${String(i + 1).padStart(2, "0")}`);
    const out = tailByRows(lines.join("\n"), { rows: 10 });
    const body = out.split("\n").slice(1);
    expect(body).toHaveLength(9); // 10 - 1（标记行）
    expect(body[body.length - 1]).toBe("line30");
    expect(body[0]).toBe("line22");
    expect(out).toContain("已省略");
    expect(out.split("\n")[0]).not.toContain("line");
  });

  it("按列宽折行也绝不切在整行中间（每行宽度固定时保留整行）", () => {
    const LINE = "x".repeat(20);
    const text = Array.from({ length: 40 }, () => LINE).join("\n");
    const out = tailByRows(text, { rows: 5, columns: 20 });
    for (const line of out.split("\n").slice(1)) {
      expect(line).toBe(LINE);
    }
  });

  it("单行超长且无换行可退时，按列宽硬切尾部（仍带省略标记）", () => {
    const out = tailByRows("x".repeat(500), { rows: 2, columns: 40 });
    const [mark, body] = out.split("\n");
    expect(mark).toContain("已省略");
    expect(textWidth(body)).toBeLessThanOrEqual(40);
    expect(body.endsWith("x")).toBe(true);
  });

  it("★ 不变式：裁剪结果的终端行数永远不超过 rows（中文折行场景）", () => {
    const samples = [
      "中".repeat(500),
      Array.from({ length: 60 }, (_, i) => `第 ${i} 行：这是一段比较长的中文说明文字，用来撑出折行`).join("\n"),
      "短\n很短\n" + "x".repeat(300),
      Array.from({ length: 12 }, () => "a".repeat(37)).join("\n"),
      "标题\n\n" + "- 一\n- 二\n".repeat(20),
    ];
    for (const text of samples) {
      for (const columns of [20, 40, 80, 120]) {
        for (const rows of [2, 3, 5, 9, 16, 40]) {
          const clipped = tailByRows(text, { rows, columns });
          expect(visualRows(clipped, columns)).toBeLessThanOrEqual(rows);
        }
      }
    }
  });

  it("自定义省略标记（卡片正文用「已省略」而非「预览已省略」）", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const out = tailByRows(text, { rows: 3, marker: (d) => `⋯ 已省略前 ${d.lines} 行` });
    expect(out.split("\n")[0]).toBe("⋯ 已省略前 8 行");
  });

  it("★ 窄终端里省略标记自身也不折行（否则它会顶破行预算）", () => {
    for (const columns of [10, 12, 20, 30]) {
      const out = tailByRows("中".repeat(400), { rows: 2, columns });
      const [mark] = out.split("\n");
      expect(textWidth(mark)).toBeLessThanOrEqual(columns);
      expect(visualRows(out, columns)).toBeLessThanOrEqual(2);
    }
  });

  it("默认标记在「单行硬切」时报告字符数而不是行数", () => {
    const out = tailByRows("中".repeat(200), { rows: 2, columns: 60 });
    expect(out.split("\n")[0]).toContain("字符");
  });
});

describe("computeDynamicBudget", () => {
  it("动态区总预算 = 终端行数 - 固定外壳", () => {
    const b = computeDynamicBudget(30);
    expect(b.total).toBe(30 - CHROME_ROWS);
  });

  it("★ 不变式：卡片 + 预览的最坏情况不会超过总预算", () => {
    for (const rows of [10, 12, 20, 24, 30, 40, 60, 100]) {
      const b = computeDynamicBudget(rows);
      expect(b.cardsLimit * (b.cardBodyRows + 2) + b.previewRows).toBeLessThanOrEqual(b.total);
    }
  });

  it("终端越高，分到的卡片数与预览行数单调不减", () => {
    const small = computeDynamicBudget(20);
    const large = computeDynamicBudget(50);
    expect(large.cardsLimit).toBeGreaterThanOrEqual(small.cardsLimit);
    expect(large.previewRows).toBeGreaterThanOrEqual(small.previewRows);
  });

  it("审批卡片出现时从预算里先扣掉（预览变小，总预算仍受控）", () => {
    const idle = computeDynamicBudget(30);
    const waiting = computeDynamicBudget(30, { approvalRows: 6 });
    expect(waiting.total).toBe(idle.total - 6);
    expect(waiting.previewRows).toBeLessThanOrEqual(idle.previewRows);
  });

  it("退化输入（缺 rows / 极小终端）也给出可用预算，不返回 0 或负数", () => {
    for (const rows of [Number.NaN, 0, -1, 3, 5]) {
      const b = computeDynamicBudget(rows);
      expect(b.total).toBeGreaterThan(0);
      expect(b.cardsLimit).toBeGreaterThanOrEqual(1);
      expect(b.cardBodyRows).toBeGreaterThanOrEqual(2);
      expect(b.previewRows).toBeGreaterThanOrEqual(2);
    }
  });
});
