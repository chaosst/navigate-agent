import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { PgVectorStore } from "../storage/pg-vector-store.js";

export class RagSearchTool extends StructuredTool {
  name = "search_documents";
  description = "Search uploaded documents for relevant information. Use this when the user asks about their documents or needs information that might be in uploaded files.";
  schema = z.object({
    query: z.string().describe("The search query"),
    k: z.number().optional().describe("Number of results to return (default 5)"),
  });

  private store: PgVectorStore;

  constructor(store: PgVectorStore) {
    super();
    this.store = store;
  }

  async _call({ query, k }: z.infer<typeof this.schema>): Promise<string> {
    const results = await this.store.search(query, k || 5);
    if (results.length === 0) return "No relevant documents found.";
    return results.map((r, i) =>
      `[${i + 1}] Source: ${r.source}\n${r.content}\n`
    ).join("\n---\n");
  }
}
