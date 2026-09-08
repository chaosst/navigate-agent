import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ChatOpenAI } from "@langchain/openai";
import {
  answerAcrossDocs,
  answerAutoDocs,
  type ParallelEvent,
  type RagStoreLike,
} from "./parallel-answer.js";
import type { RagDocument } from "./types.js";

export interface ParallelDocsToolOptions {
  maxConcurrency?: number;
  maxDocs?: number;
  llmTimeoutMs?: number;
  topK?: number;
}

const schema = z.object({
  question: z.string().describe("跨文档的问题"),
  docs: z.array(z.string()).optional().describe("限定范围的文档文件名列表；不传则自动从文档库定位最相关文档"),
  topK: z.number().int().min(1).max(20).optional().describe("每份文档检索片段数（默认 6）"),
  maxDocs: z.number().int().min(1).max(20).optional().describe("自动定位的候选文档上限（默认 5）"),
});

/**
 * 把问题分给每份相关文档独立检索+提炼，再汇总成统一答案。
 * 显式给文件名（docs）→ 按文件名并行；不给 → 全库自动定位候选再并行。
 * 返回字符串开头会列出实际检索的文档，便于 agent/用户核验与纠错。
 */
export class ParallelDocsTool extends StructuredTool {
  name = "ask_documents_parallel";
  description =
    "跨多份文档并行问答：把问题同时分给每份相关文档独立检索+提炼，再汇总成统一答案。当问题需要同时参考多份上传文档（跨文档对比、找差异、汇总不同文档说法）时使用；不确定涉及哪些文档时也适用（会自动从文档库定位最相关的若干文档）。单份文档的小问题请用 search_documents 更省。返回开头列出实际检索的文档。";

  schema = schema;

  private store: RagStoreLike;
  private llm: ChatOpenAI;
  private opts: { maxConcurrency?: number; maxDocs: number; llmTimeoutMs: number; topK: number };

  constructor(store: RagStoreLike, llm: ChatOpenAI, opts: ParallelDocsToolOptions = {}) {
    super();
    this.store = store;
    this.llm = llm;
    this.opts = {
      maxConcurrency: opts.maxConcurrency,
      llmTimeoutMs: opts.llmTimeoutMs ?? 120_000,
      topK: opts.topK ?? 6,
      maxDocs: opts.maxDocs ?? 5,
    };
  }

  async _call({ question, docs, topK, maxDocs }: z.infer<typeof schema>): Promise<string> {
    const q = question.trim();
    const k = topK ?? this.opts.topK;
    const picked: string[] = [];
    let answer = "";
    let error: string | undefined;

    for await (const ev of this.makeGen(q, docs, k, maxDocs)) {
      if (ev.type === "plan") for (const d of ev.docs) picked.push(d.filename);
      else if (ev.type === "answer") answer = ev.text;
      else if (ev.type === "error") error = ev.message;
      // worker / sources 事件不回传（模型拿成稿即可）
    }

    if (error) return `错误：${error}`;
    const head = picked.length > 0
      ? `（已并行检索 ${picked.length} 份文档：${picked.join("、")}）\n\n`
      : "";
    return head + answer;
  }

  private makeGen(q: string, docs: string[] | undefined, topK: number, maxDocs?: number): AsyncGenerator<ParallelEvent> {
    const self = this;
    return (async function* () {
      if (docs && docs.length > 0) {
        // A：显式文件名 → 解析为 docId
        let all: RagDocument[];
        try {
          all = await self.store.listDocs();
        } catch (e) {
          yield { type: "error", message: `读取文档列表失败：${(e as Error).message}` };
          return;
        }
        const byName = new Map(all.map((d) => [d.filename, d.id]));
        const unknown = docs.filter((n) => !byName.has(n));
        if (unknown.length > 0) {
          const valid = all.map((d) => d.filename);
          yield {
            type: "error",
            message: `未找到文档：${unknown.join("、")}。文档库现有：${valid.length ? valid.join("、") : "（空）"}。`,
          };
          return;
        }
        yield* answerAcrossDocs({
          question: q,
          docIds: docs.map((n) => byName.get(n)!),
          store: self.store,
          llm: self.llm,
          topK,
          maxConcurrency: self.opts.maxConcurrency,
          llmTimeoutMs: self.opts.llmTimeoutMs,
        });
      } else {
        // B：自动选档
        yield* answerAutoDocs({
          question: q,
          store: self.store,
          llm: self.llm,
          topK,
          maxConcurrency: self.opts.maxConcurrency,
          llmTimeoutMs: self.opts.llmTimeoutMs,
          maxDocs: maxDocs ?? self.opts.maxDocs,
        });
      }
    })();
  }
}
