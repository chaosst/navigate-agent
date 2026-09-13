/**
 * 静默断点 #4（2026-09-13 修复）：`addChunks` 收到 0 片时静默 return。
 *
 * 现场：三个写入方（`/api/upload`、`/api/reindex/:id`、wiki 同步）用的都是
 * 「先 deleteDoc 再 addChunks」的破坏性顺序。0 片于是意味着：
 *   旧索引已经删掉 → 新索引一行没写 → 调用方拿到 200 / "Synced xxx"。
 * reindex 尤其致命：一次「重新索引」会把文档从 RAG 里彻底抹掉，接口还报成功。
 *
 * 这里锁两件事：
 *   ① 0 片必须告警 —— 日志里要能直接看见，而不是靠人去猜为什么文档不见了；
 *   ② 0 片不得偷偷建 `documents` 行 —— 没有任何可检索内容的条目是幽灵数据。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgVectorStore } from "../pg-vector-store.js";

const DOC_ID = "00000000-0000-4000-8000-000000000001";

/** 记录所有 SQL 的假 PG：0 片时连 `connect()` 都不该被调用 */
function makeStore() {
  const queries: string[] = [];
  let connectCalls = 0;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => {
      connectCalls++;
      return client;
    },
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
  const embeddings = { embedDocuments: async () => [] };
  const store = new PgVectorStore(pool as never, embeddings as never);
  return { store, queries, connects: () => connectCalls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PgVectorStore.addChunks 的 0 片语义", () => {
  it("★ 回归锁：0 片必须告警（旧实现静默 return，日志里一个字都没有）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, queries } = makeStore();

    await store.addChunks([], DOC_ID);

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("0 chunks");
    expect(msg).toContain(DOC_ID);
    // 不碰 PG：既不该建 documents 行，也不该插 doc_chunks
    expect(queries).toHaveLength(0);
  });

  it("对照组：有片时照常写 documents + doc_chunks，且不告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, queries, connects } = makeStore();

    await store.addChunks(
      [{ content: "正文一段。", metadata: { filename: "a.md" } }],
      "00000000-0000-4000-8000-000000000002",
    );

    expect(warn).not.toHaveBeenCalled();
    expect(connects()).toBe(1);
    expect(queries.some((q) => q.includes("INSERT INTO documents"))).toBe(true);
    expect(queries.some((q) => q.includes("INSERT INTO doc_chunks"))).toBe(true);
  });
});
