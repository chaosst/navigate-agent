import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { PgVectorStore } from "../storage/pg-vector-store.js";

/** 单块检索内容上限（字符）：过长只留头，避免整段长 chunk 每轮回灌撑爆上下文 */
const RESULT_CONTENT_MAX = 4000;
/** search_documents 整体返回上限（字符） */
const TOTAL_MAX = 30_000;

/** 单条 chunk 内容截断（保留开头 + 标记） */
function capChunkContent(content: string): string {
  if (content.length <= RESULT_CONTENT_MAX) return content;
  return (
    content.slice(0, RESULT_CONTENT_MAX) +
    `\n…[检索片段过长已截断：原始 ${content.length} 字符]…`
  );
}

export class RagSearchTool extends StructuredTool {
  name = "search_documents";
  description = "Search uploaded documents for relevant information. Use this when the user asks about their documents or needs information that might be in uploaded files. mode=\"keyword\" does exact substring matching (file names, identifiers, code, error strings); default \"hybrid\" mixes vector + full-text for semantic recall.";
  schema = z.object({
    query: z.string().describe("The search query"),
    k: z.number().optional().describe("Number of results to return (default 5)"),
    mode: z.enum(["hybrid", "keyword"]).optional().describe("hybrid (default): vector+FTS semantic search; keyword: exact substring matching"),
  });

  private store: PgVectorStore;

  constructor(store: PgVectorStore) {
    super();
    this.store = store;
  }

  async _call({ query, k, mode }: z.infer<typeof this.schema>): Promise<string> {
    const results = mode === "keyword"
      ? await this.store.searchKeyword(query, k || 5)
      : await this.store.search(query, k || 5);
    if (results.length === 0) {
      // 空命中措辞刻意带方向性：让模型尽早收敛，避免反复换词空检索（agt-06 曾 8 轮/54k token 空转）
      return "No relevant documents found in the uploaded document library. Stop retrieving unless you have a clearly different keyword or reason to believe content exists — answer from your own knowledge or tell the user the library lacks matching content.";
    }

    const parts: string[] = [];
    let total = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const chunk = `[${i + 1}] Source: ${r.source}\n${capChunkContent(r.content)}\n`;
      if (total + chunk.length > TOTAL_MAX) break; // 整体超限即止，不再多拼
      parts.push(chunk);
      total += chunk.length;
    }
    if (parts.length === 0) return "No relevant documents found.";
    return parts.join("\n---\n");
  }
}
