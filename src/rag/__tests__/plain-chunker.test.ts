import { describe, it, expect } from "vitest";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { chunkPlainText, PLAIN_SEPARATORS } from "../plain-chunker.js";

/**
 * 旧实现的对照物：**刻意内联**（不 import 生产代码）。
 * 若去 import `PLAIN_SEPARATORS`，改错分隔符表会让"回归锁"跟着一起错，锁不住任何东西。
 */
const LEGACY_SEPARATORS = ["\n\n", "\n", " ", ""];

/** 旧实现的等价函数（同一把 splitter、同一段文本），返回 content 数组 */
async function legacySplit(text: string, chunkSize: number, chunkOverlap: number): Promise<string[]> {
  const doc = new Document({ pageContent: text, metadata: { filename: "x.txt" } });
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: LEGACY_SEPARATORS,
  });
  const docs = await splitter.splitDocuments([doc]);
  return docs.map((d) => d.pageContent);
}

/** 纯 ASCII 长文本（无中文标点，模拟 README / 英文技术文档） */
const ASCII_TEXT = (
  "The recursive character text splitter walks a list of separators from coarse to fine, " +
  "splitting on the first one that produces fragments small enough, then merging greedily " +
  "until the chunk size budget is reached. "
).repeat(12);

/** 中文长段落：无换行，但含句末与停顿标点（模拟真实中文正文） */
const CJK_UNIT = "人工智能正在改变软件工程的每一个环节，从需求理解到代码生成，再到测试验证，都在被重新定义。";
const CJK_TEXT = CJK_UNIT.repeat(30);

const countPunct = (s: string): number => (s.match(/[。！？；，]/g) || []).length;

describe("PLAIN_SEPARATORS", () => {
  it("在默认分隔符表的词边界之前插入中文标点（顺序 = 从粗到细）", () => {
    expect(PLAIN_SEPARATORS).toEqual(["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""]);
    expect(PLAIN_SEPARATORS[PLAIN_SEPARATORS.length - 1]).toBe("");
  });
});

describe("chunkPlainText", () => {
  it("回归锁：纯 ASCII 文本的切块结果与旧实现逐片完全相同", async () => {
    const CHUNK = 400;
    const OVERLAP = 80;

    const out = await chunkPlainText(ASCII_TEXT, {
      chunkSize: CHUNK,
      chunkOverlap: OVERLAP,
      filename: "readme.txt",
    });
    const legacy = await legacySplit(ASCII_TEXT, CHUNK, OVERLAP);

    expect(out.map((c) => c.content)).toEqual(legacy);
  });

  it("中文长段落：切点落在标点上（不再切在句中）", async () => {
    const out = await chunkPlainText(CJK_TEXT, {
      chunkSize: 1000,
      chunkOverlap: 0,
      filename: "zh.txt",
    });

    expect(out.length).toBeGreaterThan(1);
    // keepSeparator 默认 true → 片与片拼接后与原文逐字相等（一个字符都不丢）
    expect(out.map((c) => c.content).join("")).toBe(CJK_TEXT);

    // 每个切点后面紧跟的都是中文标点 = 切在句/逗边界，而不是句中
    let cursor = 0;
    for (const c of out.slice(0, -1)) {
      cursor += c.content.length;
      expect("。！？；，").toContain(CJK_TEXT[cursor]);
    }
  });

  it("负向对照：旧分隔符下同一断言不成立（证明上面这条真能抓住旧缺陷）", async () => {
    const legacy = await legacySplit(CJK_TEXT, 1000, 0);
    let cursor = 0;
    let allAtPunct = true;
    for (const c of legacy.slice(0, -1)) {
      cursor += c.length;
      if (!"。！？；，".includes(CJK_TEXT[cursor] ?? "")) allAtPunct = false;
    }
    expect(allAtPunct).toBe(false);
  });

  it("不会把文本切碎（分隔符只是优先切点，仍贪心合并到接近 chunkSize）", async () => {
    const out = await chunkPlainText(CJK_TEXT, {
      chunkSize: 1000,
      chunkOverlap: 0,
      filename: "zh.txt",
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("锁定 keepSeparator 必须为默认 true：标点总量不丢", async () => {
    const out = await chunkPlainText(CJK_TEXT, {
      chunkSize: 1000,
      chunkOverlap: 0,
      filename: "zh.txt",
    });
    expect(countPunct(out.map((c) => c.content).join(""))).toBe(countPunct(CJK_TEXT));
  });

  it("metadata：strategy=text-char，filename/source 正确（source 可被覆盖）", async () => {
    const out = await chunkPlainText("hello world. ".repeat(50), {
      chunkSize: 200,
      chunkOverlap: 0,
      filename: "a.txt",
    });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.metadata.strategy).toBe("text-char");
      expect(c.metadata.filename).toBe("a.txt");
      expect(c.metadata.source).toBe("a.txt");
    }

    const scoped = await chunkPlainText("hello world. ".repeat(50), {
      chunkSize: 200,
      chunkOverlap: 0,
      filename: "a.txt",
      source: "wiki/hello",
    });
    expect(scoped[0].metadata.source).toBe("wiki/hello");
    expect(scoped[0].metadata.filename).toBe("a.txt");
  });
});
