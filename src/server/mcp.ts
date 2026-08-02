import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PgVectorStore } from "../storage/pg-vector-store.js";

export type RagStoreLike = Pick<PgVectorStore, "search" | "searchKeyword" | "listDocs" | "getCacheStats">;

export function createMcpServer(store: RagStoreLike): McpServer {
  const mcp = new McpServer({ name: "navigate-rag", version: "0.1.0" });

  mcp.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        "Hybrid semantic + keyword search over the RAG knowledge base. Returns ranked chunks with scores.",
      inputSchema: {
        query: z.string().describe("Search query"),
        topK: z.number().int().min(1).max(50).optional().describe("Number of results (default 5)"),
        threshold: z.number().min(0).max(1).optional().describe("Minimum score threshold filter"),
      },
    },
    async ({ query, topK = 5, threshold }) => {
      let results = await store.search(query, topK);
      if (threshold !== undefined) results = results.filter((r) => r.score >= threshold);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    },
  );

  mcp.registerTool(
    "search_keyword",
    {
      description: "Keyword substring search (full-text) over indexed document chunks.",
      inputSchema: {
        query: z.string().describe("Keyword query"),
        topK: z.number().int().min(1).max(50).optional().describe("Number of results (default 5)"),
      },
    },
    async ({ query, topK = 5 }) => {
      const results = await store.searchKeyword(query, topK);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    },
  );

  mcp.registerTool(
    "list_documents",
    { description: "List all documents indexed in the knowledge base." },
    async () => {
      const docs = await store.listDocs();
      return { content: [{ type: "text", text: JSON.stringify(docs) }] };
    },
  );

  mcp.registerTool(
    "get_stats",
    { description: "Get RAG cache statistics." },
    async () => {
      const stats = store.getCacheStats();
      return { content: [{ type: "text", text: JSON.stringify(stats) }] };
    },
  );

  return mcp;
}
