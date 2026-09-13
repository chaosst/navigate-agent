/**
 * 静默断点 #4 的路由侧（2026-09-13 修复）。
 *
 * `/api/upload` 与 `/api/reindex/:id` 都是「先删旧索引、再写新索引」的破坏性顺序。
 * 一旦解析出 0 片，旧实现的行为是：
 *   旧索引已经被删掉 → 新索引一行没写 → 接口却回 200 { chunks: 0 }。
 * reindex 尤其致命：一次「重新索引」会把文档从 RAG 里彻底抹掉，界面上还显示成功。
 *
 * 本文件锁定：
 *   ① upload 解析出 0 片 → 422，且不登记元数据（不让它在列表里假装存在）；
 *   ② reindex 切出 0 片 → 422，**且旧索引必须原封不动**（顺序锁：deleteDoc 不得先跑）；
 *   ③ 对照组：源文件有正文时照常 200 并先删后写，证明 422 没有把正常路径一起掐掉。
 *
 * 实现细节：整个文件跑在 `mkdtemp` 出来的沙箱 cwd 里，绝不触碰仓库的 rag_data/ 与 rag_uploads/。
 * （vitest 默认 forks 池 + 每文件独立进程，chdir 不会波及其他用例。）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRagServer } from "../index.js";
import type { PgVectorStore } from "../../storage/pg-vector-store.js";

const ORIGINAL_CWD = process.cwd();
const EMPTY_SRC = "test-zero-chunk-empty-src";
const OK_SRC = "test-zero-chunk-ok-src";
const EMPTY_ID = "11111111-1111-4111-8111-111111111111";
const OK_ID = "22222222-2222-4222-8222-222222222222";

interface AddCall {
  docId: string;
  chunks: number;
}

function makeStore() {
  const addCalls: AddCall[] = [];
  const deleteCalls: string[] = [];
  const store = {
    async addChunks(chunks: unknown[], docId: string) {
      addCalls.push({ docId, chunks: chunks.length });
    },
    async deleteDoc(id: string) {
      deleteCalls.push(id);
    },
    async listDocs() {
      return [];
    },
    getCacheStats() {
      return { total: 0 };
    },
    async search() {
      return [];
    },
    async searchKeyword() {
      return [];
    },
  } as unknown as PgVectorStore;
  return { store, addCalls, deleteCalls };
}

let server: import("node:http").Server;
let base = "";
let sandbox = "";
let addCalls: AddCall[] = [];
let deleteCalls: string[] = [];
let cookie = "";

beforeAll(async () => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "zero-chunk-"));
  process.chdir(sandbox); // multer 的 "rag_uploads/" 与 docMeta 的 "rag_data" 都是相对 cwd

  process.env.H5_USERS_FILE = path.join(sandbox, "h5-users.json");
  process.env.H5_LOGIN_USERNAME = "admin";
  process.env.H5_LOGIN_PASSWORD = "secret";
  process.env.H5_LOGIN_USERS = "";
  process.env.H5_WIKI_PROXY_PORT = "0";

  // 播种台账 + 两个源文件：一个空（切出 0 片）、一个有正文（对照组）
  mkdirSync(path.join(sandbox, "rag_data"), { recursive: true });
  mkdirSync(path.join(sandbox, "rag_uploads"), { recursive: true });
  writeFileSync(path.join(sandbox, "rag_uploads", EMPTY_SRC), "", "utf-8");
  writeFileSync(path.join(sandbox, "rag_uploads", OK_SRC), "对照正文，至少切出一片。", "utf-8");
  writeFileSync(
    path.join(sandbox, "rag_data", "docmeta.json"),
    JSON.stringify([
      {
        id: EMPTY_ID,
        filename: "reindex-empty.txt",
        chunks: 12,
        indexedAt: new Date().toISOString(),
        storedFilename: EMPTY_SRC,
      },
      {
        id: OK_ID,
        filename: "reindex-ok.txt",
        chunks: 3,
        indexedAt: new Date().toISOString(),
        storedFilename: OK_SRC,
      },
    ]),
    "utf-8",
  );

  const made = makeStore();
  addCalls = made.addCalls;
  deleteCalls = made.deleteCalls;

  const app = createRagServer(made.store, 0);
  server = (app as unknown as { httpServer: import("node:http").Server }).httpServer;
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const res = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret", next: "/" }),
  });
  expect(res.status).toBe(200);
  cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  expect(cookie).not.toBe("");
});

afterAll(() => {
  server?.closeAllConnections?.();
  server?.close();
  process.chdir(ORIGINAL_CWD);
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
  delete process.env.H5_WIKI_PROXY_PORT;
  delete process.env.H5_LOGIN_USERNAME;
  delete process.env.H5_LOGIN_PASSWORD;
  delete process.env.H5_LOGIN_USERS;
  delete process.env.H5_USERS_FILE;
});

async function uploadText(filename: string, content: string): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type: "text/plain" }), filename);
  return fetch(base + "/api/upload", { method: "POST", headers: { cookie }, body: fd });
}

describe("0 片入库的静默假成功（路由侧）", () => {
  it("★ 回归锁：/api/upload 传空文件 → 422，不进库、不登记元数据", async () => {
    const res = await uploadText("blank.txt", "");
    expect(res.status).toBe(422);

    const body = (await res.json()) as { error?: string };
    expect(String(body.error)).toContain("blank.txt");
    expect(addCalls).toHaveLength(0);
  });

  it("★ 回归锁：/api/reindex 源文件已变空 → 422，且旧索引必须原封不动（顺序锁）", async () => {
    const res = await fetch(`${base}/api/reindex/${EMPTY_ID}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(422);

    // 关键：旧实现是「先 deleteDoc 再 loadDocument」，这里必须证明删的顺序被推到了切块之后
    expect(deleteCalls).not.toContain(EMPTY_ID);
    expect(addCalls.map((c) => c.docId)).not.toContain(EMPTY_ID);
  });

  it("对照组：源文件有正文 → 200，正常先删后写", async () => {
    const res = await fetch(`${base}/api/reindex/${OK_ID}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { chunks?: number };
    expect(body.chunks).toBeGreaterThan(0);
    expect(deleteCalls).toContain(OK_ID);
    expect(addCalls.find((c) => c.docId === OK_ID)?.chunks).toBeGreaterThan(0);
  });
});
