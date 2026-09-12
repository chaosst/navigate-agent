import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDocument } from "../loader.js";
import { makeTestPdf } from "./test-pdf.js";

function tmpFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rag-dispatch-"));
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

const EN_TEXT = "The recursive character text splitter merges greedily until the budget is reached. ".repeat(20);

const MD_WITH_HEADINGS = [
  "# 方案",
  "",
  "## 一、背景",
  "现有切块策略对所有格式共用一把 splitter。",
  "",
  "## 二、方案",
  "按源格式分派到不同的切块器。",
].join("\n");

const MD_NO_HEADINGS = "| 姓名 | 部门 |\n| --- | --- |\n| 张三 | 工程 |";

const strategies = (chunks: { metadata: Record<string, unknown> }[]): unknown[] =>
  chunks.map((c) => c.metadata.strategy);

describe("loadDocument 分格式分派", () => {
  it(".txt → 字符切块（text-char）", async () => {
    const p = tmpFile("a.txt", EN_TEXT);
    const chunks = await loadDocument(p, "a.txt");
    expect(chunks.length).toBeGreaterThan(0);
    expect(strategies(chunks).every((s) => s === "text-char")).toBe(true);
  });

  it(".md 有标题 → 结构化切块（md-heading）且 headingPath 非空", async () => {
    const p = tmpFile("方案.md", MD_WITH_HEADINGS);
    const chunks = await loadDocument(p, "方案.md");

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.metadata.strategy === "md-heading")).toBe(true);
    expect(chunks.some((c) => (c.metadata.headingPath as string[])?.length > 0)).toBe(true);
  });

  it("★ .md 无标题 → 退回 text-char（证明 md 不再与 txt 同路地拿结构）", async () => {
    const p = tmpFile("表.md", MD_NO_HEADINGS);
    const chunks = await loadDocument(p, "表.md");
    expect(chunks.length).toBeGreaterThan(0);
    expect(strategies(chunks).every((s) => s === "text-char")).toBe(true);
  });

  it("未知扩展名（.log）走纯文本路径，与 txt 同策略", async () => {
    const p = tmpFile("run.log", EN_TEXT);
    const chunks = await loadDocument(p, "run.log");
    expect(chunks.length).toBeGreaterThan(0);
    expect(strategies(chunks).every((s) => s === "text-char")).toBe(true);
  });

  it("扩展名大小写不敏感（.TXT / .MD）", async () => {
    const txt = await loadDocument(tmpFile("b.TXT", EN_TEXT), "b.TXT");
    expect(strategies(txt).every((s) => s === "text-char")).toBe(true);

    const md = await loadDocument(tmpFile("c.MD", MD_WITH_HEADINGS), "c.MD");
    expect(md.every((c) => c.metadata.strategy === "md-heading")).toBe(true);
  });

  it("★ .PDF（大写）→ 页感知切块，pageStart/pageEnd 合法", async () => {
    const p = tmpFile("probe.PDF", makeTestPdf(["Page one alpha", "Page two beta"]));
    const chunks = await loadDocument(p, "probe.PDF");

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.metadata.strategy).toBe("pdf-page");
      expect(c.metadata.pageStart).toBe(1);
      expect(c.metadata.pageEnd).toBe(2);
    }
    expect(chunks.some((c) => c.content.includes("Page one alpha"))).toBe(true);
  });

  it("metadata 始终带 filename / source（addChunks 反查文件名依赖它）", async () => {
    const chunks = await loadDocument(tmpFile("d.txt", EN_TEXT), "d.txt");
    for (const c of chunks) {
      expect(c.metadata.filename).toBe("d.txt");
      expect(c.metadata.source).toBe("d.txt");
    }
  });
});
