import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mountMcpRoutes } from "../mcp-http.js";
import { ApiKeyStore } from "../key-store.js";
import { computeSignature } from "../api-key-auth.js";

const AUTH = { keyStore: ApiKeyStore.fromEnv("sk-test:2099-01-01T00:00:00Z", undefined) };

const store = {
  async search(query: string, k = 5) {
    return [{ content: `r:${query}`, score: 0.9, source: "a.pdf", docId: "d1" }];
  },
  async searchKeyword(query: string, k = 5) {
    return [{ content: `kw:${query}`, score: 1, source: "a.pdf", docId: "d1" }];
  },
  async listDocs() {
    return [{ id: "d1", filename: "a.pdf", pages: 0, chunkCount: 1, indexedAt: new Date("2026-01-01") }];
  },
  getCacheStats() {
    return { total: 1 };
  },
} as any;

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

describe("MCP HTTP endpoint", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
    mountMcpRoutes(app, store, AUTH);
    server = app.listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  it("rejects an unauthenticated initialize with 401", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing credentials");
  });

  it("rejects an invalid bearer key", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-wrong" },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid key");
  });

  it("accepts a valid bearer key and lists tools via the SDK client", async () => {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer sk-test" } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("search_documents");
    await client.close();
  });

  it("accepts a valid HMAC-signed initialize", async () => {
    const ts = String(Date.now());
    const nonce = `n-init-${ts}`;
    const body = JSON.stringify(INIT);
    const sig = computeSignature("sk-test", "POST", "/mcp", ts, nonce, Buffer.from(body));
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Signature": sig, "X-Timestamp": ts, "X-Nonce": nonce,
      },
      body,
    });
    expect([200, 201]).toContain(res.status);
  });

  it("rejects a replayed HMAC request", async () => {
    const ts = String(Date.now());
    const nonce = `n-replay-${ts}`;
    const body = JSON.stringify(INIT);
    const sig = computeSignature("sk-test", "POST", "/mcp", ts, nonce, Buffer.from(body));
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "X-Signature": sig, "X-Timestamp": ts, "X-Nonce": nonce,
    };
    const first = await fetch(`${base}/mcp`, { method: "POST", headers, body });
    const second = await fetch(`${base}/mcp`, { method: "POST", headers, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect((await second.json()).error).toBe("replay detected");
  });
});
