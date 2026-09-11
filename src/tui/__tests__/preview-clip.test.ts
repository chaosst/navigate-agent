import { describe, it, expect } from "vitest";
import { clipPreview } from "../ptc.js";

/**
 * 旧的动态区裁剪是 `"…" + text.slice(-800)`，会切在词/行中间，
 * 画面里出现 `…ckage.json` 这种半截词 —— 看起来像输出被撕裂。
 * 新策略：只留尾部，但按整行切。
 */
describe("clipPreview", () => {
  it("短文本原样返回（不加任何标记）", () => {
    const text = "第一行\n第二行";
    expect(clipPreview(text)).toBe(text);
  });

  it("超过行数上限时只保留尾部整行，并标注省略量", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
    const out = clipPreview(text, 2000, 10);
    expect(out).toContain("line30");
    expect(out).toContain("line21");
    expect(out).not.toContain("line20\n");
    expect(out).toContain("已省略");
  });

  it("超过字符上限时回退到下一个整行边界，不切在行中间", () => {
    // 每行固定 20 字符 × 40 行 = 839 字符；字符上限设 100 → 必须退到整行
    const LINE_LEN = 20;
    const lines = Array.from({ length: 40 }, (_, i) =>
      `line${String(i + 1).padStart(2, "0")}`.padEnd(LINE_LEN, "x"),
    );
    const text = lines.join("\n");
    const out = clipPreview(text, 100, 100);
    const body = out.split("\n").slice(1).join("\n");
    for (const line of body.split("\n")) {
      expect(line).toHaveLength(LINE_LEN);
    }
    expect(out).toContain("已省略");
  });

  it("单行超长且无换行可退时，硬切但仍然标注", () => {
    const out = clipPreview("x".repeat(500), 100, 100);
    expect(out).toContain("已省略");
    expect(out.endsWith("x".repeat(100))).toBe(true);
  });

  it("空串 → 空串", () => {
    expect(clipPreview("")).toBe("");
  });

  it("恰好等于上限时不加省略标记", () => {
    const text = "a\nb";
    expect(clipPreview(text, text.length, 2)).toBe(text);
  });
});
