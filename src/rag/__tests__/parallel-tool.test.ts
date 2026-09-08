import { describe, it, expect } from "vitest";
import { ParallelDocsTool } from "../parallel-tool.js";

/** 假 LLM：区分 worker（user 含【文档】）与合成（user 含【各文档提炼】） */
function fakeLlm() {
  return {
    invoke: async (messages: Array<{ content: string }>) => {
      const sys = String(messages[0]?.content ?? "");
      const user = String(messages.at(-1)?.content ?? "");
      if (user.includes("【各文档提炼】")) return { content: "汇总答案。" };
      const m = user.match(/【文档】(.+?)(?:\n|$)/);
      const fname = m ? m[1] : "";
      return { content: JSON.stringify({ summary: `${fname} 要点`, used: [0] }) };
    },
  } as any;
}

function makeStore(docs: Array<{ id: string; filename: string }>, wholeEmpty = false) {
  return {
    listDocs: async () => docs,
    search: async (_q: string, _k?: number, docIds?: string[]) => {
      if (wholeEmpty) return [];
      if (docIds && docIds.length) {
        return docs
          .filter((d) => docIds.includes(d.id))
          .map((d) => ({ content: `${d.id} 内容`, score: 1, source: d.filename, docId: d.id, chunkIndex: 0 }));
      }
      return docs.map((d) => ({ content: `${d.id} 内容`, score: 1, source: d.filename, docId: d.id, chunkIndex: 0 }));
    },
  } as any;
}

const llm = fakeLlm();
const docs = [
  { id: "docA", filename: "a.md" },
  { id: "docB", filename: "b.md" },
];

describe("ParallelDocsTool（显式文档名）", () => {
  it("按文件名解析并跨文档并行，返回含清单与终答的字符串", async () => {
    const tool = new ParallelDocsTool(makeStore(docs), llm);
    const out = await tool.invoke({ question: "两者差异", docs: ["a.md", "b.md"] });
    expect(out).toContain("a.md");
    expect(out).toContain("b.md");
    expect(out).toContain("汇总答案");
  });

  it("未知名返回可读错误并列出文档库现有文件", async () => {
    const tool = new ParallelDocsTool(makeStore(docs), llm);
    const out = await tool.invoke({ question: "q", docs: ["nope.md"] });
    expect(out).toContain("未找到文档：nope.md");
    expect(out).toContain("a.md");
  });
});

describe("ParallelDocsTool（自动选档 B）", () => {
  it("不传 docs 时自动定位多份文档并行", async () => {
    const tool = new ParallelDocsTool(makeStore(docs), llm);
    const out = await tool.invoke({ question: "库里有什么差异" });
    expect(out).toContain("已并行检索 2 份文档");
    expect(out).toContain("a.md");
    expect(out).toContain("汇总答案");
  });

  it("全库无命中时返回『没有检索到』文案", async () => {
    const tool = new ParallelDocsTool(makeStore(docs, true), llm);
    const out = await tool.invoke({ question: "完全无关" });
    expect(out).toContain("没有检索到");
  });
});
