import { describe, it, expect } from "vitest";
import { answerAcrossDocs } from "../parallel-answer.js";
import { capChunkContent } from "../retriever.js";
import type { RagStoreLike } from "../parallel-answer.js";

/** 收集生成器全部事件 */
async function collect(opts: Parameters<typeof answerAcrossDocs>[0]) {
  const events = [];
  for await (const ev of answerAcrossDocs(opts)) events.push(ev);
  return events;
}

/** 假 LLM：合成阶段（user 含【各文档提炼】）直接给综合文本；worker 阶段按文档名返回 JSON 提炼 */
function fakeLlm(delayMs = 0) {
  return {
    invoke: async (messages: Array<{ content: string }>) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const user = String(messages.at(-1)?.content ?? "");
      // 合成调用：synth user 不含 ASCII 文档 id，先命中此分支避免落入空 JSON 兜底
      if (user.includes("【各文档提炼】")) {
        return { content: "综合答案：文档A 有 A 要点，文档B 有 B 要点。" };
      }
      if (user.includes("docA")) return { content: '{"summary":"文档A：该问题有 A 要点","used":[0]}' };
      if (user.includes("docB")) return { content: '{"summary":"文档B：该问题有 B 要点","used":[0]}' };
      return { content: '{"summary":"","used":[]}' };
    },
  } as any;
}

function makeStore(docs: Array<{ id: string; filename: string }>) {
  return {
    listDocs: async () => docs,
    search: async (_q: string, _k?: number, docIds?: string[]) => {
      const id = docIds?.[0];
      const d = docs.find((x) => x.id === id);
      if (!d) return [];
      return [{ content: `${d.id} 的检索片段`, score: 1, source: d.filename, docId: d.id, chunkIndex: 0 }];
    },
  } as RagStoreLike;
}

describe("answerAcrossDocs 并行跨文档问答", () => {
  it("plan → worker×2 → sources → answer 的事件序，引用去重且带文档名", async () => {
    const store = makeStore([
      { id: "docA", filename: "a.md" },
      { id: "docB", filename: "b.md" },
    ]);
    const events = await collect({
      question: "该问题答案是什么", docIds: ["docA", "docB"],
      store, llm: fakeLlm(), topK: 6, maxConcurrency: 4, llmTimeoutMs: 1000,
    });
    expect(events.map((e) => e.type)).toEqual(["plan", "worker", "worker", "sources", "answer"]);
    const plan = events[0];
    expect(plan.type === "plan" && plan.docs.map((d) => d.id)).toEqual(["docA", "docB"]);
    const srcs = events[3];
    expect(srcs.type === "sources" && srcs.sources).toEqual([
      { docId: "docA", filename: "a.md", chunkIndex: 0 },
      { docId: "docB", filename: "b.md", chunkIndex: 0 },
    ]);
    expect(events[4].type === "answer" && events[4].text).toContain("A 要点");
  });

  it("真并发：maxConcurrency=4 时四份文档总耗时 ≈ 最慢单份而非四份之和", async () => {
    const docs = ["d1", "d2", "d3", "d4"].map((id) => ({ id, filename: `${id}.md` }));
    const store = makeStore(docs);
    const start = Date.now();
    const events = await collect({
      question: "q", docIds: docs.map((d) => d.id),
      store, llm: fakeLlm(200), topK: 6, maxConcurrency: 4, llmTimeoutMs: 1000,
    });
    const elapsed = Date.now() - start;
    expect(events.some((e) => e.type === "answer")).toBe(true);
    expect(elapsed).toBeLessThan(4 * 200); // 远小于串行 800ms
  });

  it("未知 docId 时先发 error 事件并停止", async () => {
    const store = makeStore([{ id: "docA", filename: "a.md" }]);
    const events = await collect({
      question: "q", docIds: ["ghost"],
      store, llm: fakeLlm(), topK: 6, maxConcurrency: 4,
    });
    expect(events).toEqual([{ type: "error", message: "未知文档 id：ghost" }]);
  });

  it("全 worker 空/无关时给『无相关内容』answer，不抛错", async () => {
    const store = makeStore([
      { id: "docA", filename: "a.md" },
      { id: "docB", filename: "b.md" },
    ]);
    const events = await collect({
      question: "完全无关的问题", docIds: ["docA", "docB"],
      store: {
        listDocs: store.listDocs,
        search: async () => [], // 全空命中
      },
      llm: fakeLlm(), topK: 6, maxConcurrency: 4,
    });
    const last = events.at(-1);
    expect(last?.type === "answer" && last.text).toContain("没有找到");
  });

  it("单个 worker 检索抛错不拖垮整体，最终仍给 answer", async () => {
    const docs = [{ id: "docA", filename: "a.md" }, { id: "docB", filename: "b.md" }];
    const store = {
      listDocs: async () => docs,
      search: async (_q: string, _k?: number, docIds?: string[]) => {
        if (docIds?.[0] === "docA") throw new Error("boom");
        return [{ content: "ok", score: 1, source: "b.md", docId: "docB", chunkIndex: 0 }];
      },
    } as RagStoreLike;
    const events = await collect({
      question: "q", docIds: ["docA", "docB"], store, llm: fakeLlm(), topK: 6, maxConcurrency: 4,
    });
    expect(events.some((e) => e.type === "worker" && e.status === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("answer");
  });
});
