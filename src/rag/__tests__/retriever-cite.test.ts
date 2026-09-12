import { describe, it, expect } from "vitest";
import { formatChunkSource, pickCitationFields } from "../citation.js";
import { RagSearchTool } from "../retriever.js";
import type { RagResult } from "../types.js";
import type { PgVectorStore } from "../../storage/pg-vector-store.js";

const base: RagResult = { content: "正文", score: 1, source: "年报.pdf", docId: "d1", chunkIndex: 0 };

describe("formatChunkSource", () => {
  it("PDF → 页码范围", () => {
    expect(formatChunkSource({ ...base, pageStart: 12, pageEnd: 13 }, 1)).toBe("[1] Source: 年报.pdf · p.12-13");
  });

  it("PDF 单页 → 单个页号", () => {
    expect(formatChunkSource({ ...base, pageStart: 7, pageEnd: 7 }, 3)).toBe("[3] Source: 年报.pdf · p.7");
  });

  it("有正文标注页码时优先用它（可能是 iii / A-1 这类）", () => {
    expect(formatChunkSource({ ...base, pageStart: 4, pageEnd: 5, pageLabel: "iii" }, 1)).toBe(
      "[1] Source: 年报.pdf · p.iii",
    );
  });

  it("MD / DOCX → 标题面包屑", () => {
    const r: RagResult = {
      ...base,
      source: "方案.docx",
      headingPath: ["四、专业技能", "后端能力"],
    };
    expect(formatChunkSource(r, 2)).toBe("[2] Source: 方案.docx · 四、专业技能 > 后端能力");
  });

  it("无元数据 → 维持旧格式（向后兼容老 chunk）", () => {
    expect(formatChunkSource(base, 1)).toBe("[1] Source: 年报.pdf");
    expect(formatChunkSource({ ...base, headingPath: [] }, 1)).toBe("[1] Source: 年报.pdf");
  });
});

describe("pickCitationFields", () => {
  it("从 JSONB 元数据里安全取值", () => {
    expect(pickCitationFields({ pageStart: 1, pageEnd: 2, pageLabel: "iv", headingPath: ["a", "b"] })).toEqual({
      pageStart: 1,
      pageEnd: 2,
      pageLabel: "iv",
      headingPath: ["a", "b"],
    });
  });

  it("null / undefined / 类型不符 → 全部 undefined，不抛错", () => {
    const empty = { pageStart: undefined, pageEnd: undefined, pageLabel: undefined, headingPath: undefined };
    expect(pickCitationFields(null)).toEqual(empty);
    expect(pickCitationFields(undefined)).toEqual(empty);
    expect(pickCitationFields({ pageStart: "12", pageEnd: null, headingPath: "x" })).toEqual(empty);
  });

  it("空标题数组视作无标题（避免渲染出空的 ' · '）", () => {
    expect(pickCitationFields({ headingPath: [] }).headingPath).toBeUndefined();
  });
});

describe("RagSearchTool 接线", () => {
  it("检索工具输出里带上定位信息", async () => {
    const store = {
      search: async (): Promise<RagResult[]> => [
        { ...base, pageStart: 12, pageEnd: 13 },
        { ...base, source: "方案.docx", headingPath: ["二、方案"] },
      ],
    } as unknown as PgVectorStore;

    const tool = new RagSearchTool(store);
    const out = await (tool as unknown as { _call(a: { query: string }): Promise<string> })._call({ query: "x" });

    expect(out).toContain("[1] Source: 年报.pdf · p.12-13");
    expect(out).toContain("[2] Source: 方案.docx · 二、方案");
  });
});
