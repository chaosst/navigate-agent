import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { makeTestPdf } from "./test-pdf.js";
import {
  extractPdfPages,
  stripRepeatedLines,
  reflowLines,
  chunkPdfPages,
  PDF_DEFAULTS,
  PDF_REFLOW_ENABLED,
  type PdfPage,
} from "../pdf-chunker.js";

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

// ─────────────────────────────── 纯函数：去噪 / reflow / 页感知切块 ───────────────────────────────

const pg = (num: number, text: string, label?: string): PdfPage =>
  label ? { num, text, label } : { num, text };

/** 页码/正文里不要用数字做"唯一标记"：数字会被折叠成 #，反而变成"重复行"被删 */
const MARK = ["甲", "乙", "丙", "丁", "戊", "己"];

describe("stripRepeatedLines", () => {
  it("剔除跨页重复的页脚（页码数字折叠后同 key）", () => {
    const pages = [0, 1, 2, 3, 4].map((i) =>
      pg(i + 1, `正文-${MARK[i]}\n第 ${i + 1} 页 / 共 5 页`),
    );
    const out = stripRepeatedLines(pages);
    out.forEach((p, i) => {
      expect(p.text).toContain(`正文-${MARK[i]}`);
      expect(p.text).not.toContain("共 5 页");
    });
  });

  it("剔除跨页重复的页眉（纯文本，无数字）", () => {
    const pages = [0, 1, 2, 3, 4].map((i) => pg(i + 1, `XX 公司内部资料\n正文-${MARK[i]}`));
    const out = stripRepeatedLines(pages);
    out.forEach((p) => expect(p.text).not.toContain("公司内部资料"));
    out.forEach((p, i) => expect(p.text).toContain(`正文-${MARK[i]}`));
  });

  it("页数不足 minPages 时一行不删（统计没有意义）", () => {
    const pages = [pg(1, "正文-甲\n第 1 页 / 共 2 页"), pg(2, "正文-乙\n第 2 页 / 共 2 页")];
    expect(stripRepeatedLines(pages)).toEqual(pages);
    expect(PDF_DEFAULTS.headerFooterMinPages).toBe(3);
  });

  it("反例：只在 1/5 页出现的短句必须保留", () => {
    const pages = [0, 1, 2, 3, 4].map((i) =>
      pg(i + 1, i === 2 ? `正文-${MARK[i]}\n临时通知：系统维护` : `正文-${MARK[i]}`),
    );
    const out = stripRepeatedLines(pages);
    expect(out[2].text).toContain("临时通知：系统维护");
  });

  it("反例：不在页首/页末的孤立纯数字行必须保留（表格里的数值）", () => {
    const pages = [0, 1, 2, 3, 4].map((i) =>
      i === 1 ? pg(2, `首行-乙\n2024\n末行-乙`) : pg(i + 1, `首行-${MARK[i]}\n中段-${MARK[i]}\n末行-${MARK[i]}`),
    );
    const out = stripRepeatedLines(pages);
    expect(out[1].text).toContain("2024");
  });

  it("纯页码行位于该页首行/末行时被剔除（即便只出现在单页）", () => {
    const pages = [0, 1, 2, 3, 4].map((i) =>
      i === 3 ? pg(4, `首行-丁\n中段-丁\n    7    `) : pg(i + 1, `首行-${MARK[i]}\n中段-${MARK[i]}\n末行-${MARK[i]}`),
    );
    const out = stripRepeatedLines(pages);
    expect(out[3].text).not.toContain("7");
    expect(out[3].text).toContain("中段-丁");
  });
});

describe("reflowLines", () => {
  // 白名单规则要求"两侧都不是短行"（< 15 字视为标题/图注/单元格），所以样本行必须够长
  const EN_A = "The quick brown fox jumps over";
  const EN_B = "the lazy dog and runs away";
  const ZH_A = "人工智能正在改变软件工程的每一个环节";
  const ZH_B = "从需求理解到代码生成再到测试验证都在被重新定义";

  it("软连字符：行尾 '-' + 行首小写字母 → 直接拼合且丢掉连字符", () => {
    expect(reflowLines("soft hyph-\nenation works")).toBe("soft hyphenation works");
  });

  it("段内换行：英文行间补一个空格，中文行间不补", () => {
    expect(reflowLines(`${EN_A}\n${EN_B}`)).toBe(`${EN_A} ${EN_B}`);
    expect(reflowLines(`${ZH_A}\n${ZH_B}`)).toBe(`${ZH_A}${ZH_B}`);
  });

  it("连续多行同段落可链式合并", () => {
    const ZH_C = "这套策略先落地页感知与噪声清洗两项确定性收益";
    expect(reflowLines(`${ZH_A}\n${ZH_B}\n${ZH_C}`)).toBe(`${ZH_A}${ZH_B}${ZH_C}`);
  });

  it("空行保留为段落边界", () => {
    const src = `${EN_A}\n\n${EN_B}`;
    expect(reflowLines(src)).toBe(src);
  });

  it("★ 含 \\t 的行（表格行）不被合并，前后文也不被粘进表格", () => {
    const table = "名称\t数量\t状态";
    expect(reflowLines(`${ZH_A}\n${table}\n${ZH_B}`)).toBe(`${ZH_A}\n${table}\n${ZH_B}`);
  });

  it("反例：'| a | b |' 形状的表格行保留原样", () => {
    const row = `| ${ZH_A} | ${ZH_B} |`;
    expect(reflowLines(`${EN_A}\n${row}`)).toBe(`${EN_A}\n${row}`);
  });

  it("保守规则：上行以句末标点收尾 → 不合并", () => {
    const src = `今天先把页感知切块落地了。\n明天再评估视觉换行重建的收益`;
    expect(reflowLines(src)).toBe(src);
  });

  it("保守规则：短行（标题/图注）不参与合并", () => {
    const src = `${ZH_A}\n风险提示`;
    expect(reflowLines(src)).toBe(src);
  });
});

describe("chunkPdfPages", () => {
  const fill = (n: number) => "甲".repeat(n);
  const OPTS = { chunkSize: 1000, chunkOverlap: 0, filename: "年报.pdf" };

  it("全局开关默认关闭（先只吃页感知 + 去噪的确定性收益）", () => {
    expect(PDF_REFLOW_ENABLED).toBe(false);
  });

  it("3 页各 300 字 → 合并成 1 片，覆盖 p.1-3", async () => {
    const pages = [pg(1, fill(300)), pg(2, fill(300)), pg(3, fill(300))];
    const out = await chunkPdfPages(pages, OPTS);
    expect(out).toHaveLength(1);
    expect(out[0].metadata.pageStart).toBe(1);
    expect(out[0].metadata.pageEnd).toBe(3);
  });

  it("5 页各 500 字 → 贪心分组为 (1-2)(3-4)(5)，不跨组", async () => {
    const pages = [1, 2, 3, 4, 5].map((n) => pg(n, fill(500)));
    const out = await chunkPdfPages(pages, OPTS);
    expect(out.map((c) => [c.metadata.pageStart, c.metadata.pageEnd])).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
  });

  it("短尾并页：5 页各 400 字 → 末页（400 < 50% 预算）回并进上一片", async () => {
    const pages = [1, 2, 3, 4, 5].map((n) => pg(n, fill(400)));
    const out = await chunkPdfPages(pages, OPTS);
    expect(out.map((c) => [c.metadata.pageStart, c.metadata.pageEnd])).toEqual([
      [1, 2],
      [3, 5],
    ]);
  });

  it("单页超过 chunkSize → 页内切分，每片 pageStart === pageEnd === 该页号", async () => {
    const out = await chunkPdfPages([pg(4, fill(5000))], OPTS);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.metadata.pageStart).toBe(4);
      expect(c.metadata.pageEnd).toBe(4);
    }
  });

  it("页码覆盖连续且不重叠", async () => {
    const pages = [1, 2, 3, 4, 5, 6, 7].map((n) => pg(n, fill(350)));
    const out = await chunkPdfPages(pages, OPTS);
    let expected = 1;
    for (const c of out) {
      expect(c.metadata.pageStart).toBe(expected);
      expect(c.metadata.pageEnd!).toBeGreaterThanOrEqual(c.metadata.pageStart!);
      expected = c.metadata.pageEnd! + 1;
    }
    expect(expected).toBe(8);
  });

  it("空数组 / 全空页（扫描版抽不到文本）→ []，不抛错", async () => {
    expect(await chunkPdfPages([], OPTS)).toEqual([]);
    expect(await chunkPdfPages([pg(1, ""), pg(2, "   \n  ")], OPTS)).toEqual([]);
  });

  it("metadata：strategy=pdf-page，filename/source/pageLabel 正确", async () => {
    const pages = [pg(1, fill(300), "A-1"), pg(2, fill(300), "A-2")];
    const out = await chunkPdfPages(pages, { ...OPTS, source: "wiki/x" });
    expect(out).toHaveLength(1);
    expect(out[0].metadata.strategy).toBe("pdf-page");
    expect(out[0].metadata.filename).toBe("年报.pdf");
    expect(out[0].metadata.source).toBe("wiki/x");
    expect(out[0].metadata.pageLabel).toBe("A-1");
  });

  it("无 pageLabel 时不写入该字段（引用侧必须能容错）", async () => {
    const out = await chunkPdfPages([pg(1, fill(300))], OPTS);
    expect("pageLabel" in out[0].metadata).toBe(false);
  });

  it("reflow=true 时视觉折行被拼回（reflow=false 保留原换行）", async () => {
    const ZH_A = "人工智能正在改变软件工程的每一个环节";
    const ZH_B = "从需求理解到代码生成再到测试验证都在被重新定义";
    const wrapped = `${ZH_A}\n${ZH_B}`;

    const off = await chunkPdfPages([pg(1, wrapped)], { ...OPTS, reflow: false });
    expect(off[0].content).toBe(wrapped);

    const on = await chunkPdfPages([pg(1, wrapped)], { ...OPTS, reflow: true });
    expect(on[0].content).toBe(`${ZH_A}${ZH_B}`);
  });
});
