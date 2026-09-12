import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { makeTestPdf } from "./test-pdf.js";
import { extractPdfPages } from "../pdf-chunker.js";

/** 把生成的 PDF 落到临时目录，返回路径 */
function writeTempPdf(pages: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rag-pdf-"));
  const p = path.join(dir, "probe.pdf");
  writeFileSync(p, makeTestPdf(pages));
  return p;
}

describe("extractPdfPages", () => {
  it("按页返回文本与页号（1-based）", async () => {
    const p = writeTempPdf(["Page one alpha", "Page two beta"]);
    const pages = await extractPdfPages(p);

    expect(pages).toHaveLength(2);
    expect(pages.map((x) => x.num)).toEqual([1, 2]);
    expect(pages[0].text).toContain("Page one alpha");
    expect(pages[1].text).toContain("Page two beta");
  });

  it("无标注页码时 label 为 undefined 且不抛错（pageLabel 是尽力而为）", async () => {
    const p = writeTempPdf(["Only page"]);
    const pages = await extractPdfPages(p);
    expect(pages).toHaveLength(1);
    expect(pages[0].label).toBeUndefined();
  });

  /**
   * P0 回归锁：修复前的写法是 `new PDFParse({})` + `load(buf)`。
   * v2 的 data 必须给在构造函数里，load() 的入参同样是 LoadParameters 而不是 Buffer，
   * 于是 pdfjs 抛 "getDocument - no `url` parameter provided" → 上传 PDF 返回 500。
   * 这条用例把"此前的路径必然失败"钉死在测试里；若将来 pdf-parse 改了行为，这里会先炸。
   */
  it("回归锁：旧写法 new PDFParse({}) + load(buf) 必然抛错", async () => {
    const p = writeTempPdf(["x"]);
    const legacyExtract = async (): Promise<string> => {
      const buf = readFileSync(p);
      const pdfP = new (PDFParse as unknown as new (o: object) => {
        load: (b: Buffer) => Promise<void>;
        getText: (o: object) => Promise<string>;
      })({});
      await pdfP.load(buf);
      return await pdfP.getText({});
    };
    await expect(legacyExtract()).rejects.toThrow();
  });
});
