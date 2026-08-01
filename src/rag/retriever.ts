import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { PgVectorStore } from "../storage/pg-vector-store.js";

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
    if (results.length === 0) return "No relevant documents found.";
    return results.map((r, i) =>
      `[${i + 1}] Source: ${r.source}\n${r.content}\n`
    ).join("\n---\n");
  }
}
