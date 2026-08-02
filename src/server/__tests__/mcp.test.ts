import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type RagStoreLike } from "../mcp.js";

function fakeStore(): RagStoreLike {
  return {
    async search(query: string, k = 5) {
      return [{ content: `result for ${query}`, score: 0.9, source: "a.pdf", docId: "d1", chunkIndex: 0 }];
    },
    async searchKeyword(query: string, k = 5) {
      return [{ content: `kw ${query}`, score: 1, source: "a.pdf", docId: "d1" }];
    },
    async listDocs() {
      return [{ id: "d1", filename: "a.pdf", pages: 0, chunkCount: 3, indexedAt: new Date("2026-01-01") }];
    },
    getCacheStats() {
      return { total: 1 } as any;
    },
  };
}

describe("createMcpServer tools", () => {
  let client: Client;

  async function connect() {
    client = new Client({ name: "test-client", version: "1.0.0" });
    const server = createMcpServer(fakeStore());
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
  }

  afterEach(async () => {
    if (client) await client.close();
  });

  it("lists 4 tools", async () => {
    await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      "search_documents",
      "search_keyword",
      "list_documents",
      "get_stats",
    ]);
  });

  it("calls search_documents with args", async () => {
    await connect();
    const res = await client.callTool({ name: "search_documents", arguments: { query: "hello", topK: 3 } });
    const text = (res.content as any)?.[0] as { type: "text"; text: string };
    expect(JSON.parse(text.text)[0].content).toBe("result for hello");
  });

  it("applies threshold filter in search_documents", async () => {
    await connect();
    const res = await client.callTool({ name: "search_documents", arguments: { query: "x", threshold: 0.95 } });
    const text = (res.content as any)?.[0] as { type: "text"; text: string };
    expect(JSON.parse(text.text)).toEqual([]); // fake score 0.9 < 0.95
  });

  it("calls search_keyword", async () => {
    await connect();
    const res = await client.callTool({ name: "search_keyword", arguments: { query: "doc", topK: 2 } });
    const text = (res.content as any)?.[0] as { type: "text"; text: string };
    expect(JSON.parse(text.text)[0].score).toBe(1);
  });

  it("calls list_documents and get_stats", async () => {
    await connect();
    const docs = await client.callTool({ name: "list_documents" });
    const docsText = (docs.content as any)?.[0] as { type: "text"; text: string };
    expect(JSON.parse(docsText.text)[0].filename).toBe("a.pdf");

    const stats = await client.callTool({ name: "get_stats" });
    const statsText = (stats.content as any)?.[0] as { type: "text"; text: string };
    expect(JSON.parse(statsText.text).total).toBe(1);
  });
});
