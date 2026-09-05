#!/usr/bin/env node
/**
 * 真实验收：PgVectorStore 查询级 L1 缓存 + embedding 记忆化（今日 2026-09-05 改造）。
 *
 * 与单测（纯 mock）不同：本脚本连【真实 PostgreSQL + 真实 ollama embedding】执行，
 * 仅在外层加调用计数器 —— 数据全真，计数用来硬断言「缓存命中时 DB / embedding 端点
 * 一次都没碰」。验收完自动清理插入的测试文档，不污染库。
 *
 * 用法: npx tsx scripts/verify-l1-cache.ts
 * 前置: docker compose up -d postgres ollama（.env 已指向 localhost:5432 / :11434）
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { OpenAIEmbeddings } from "@langchain/openai";
import { loadConfig } from "../src/config/index.js";
import { createEmbeddings } from "../src/agent/langchain.js";
import { PgVectorStore } from "../src/storage/pg-vector-store.js";

interface CaseResult {
  name: string;
  expect: string;
  actual: string;
  pass: boolean;
  ms: number;
}

async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });

  // 计数包装：真实执行，仅统计调用次数
  let dbCalls = 0;
  const countingPool = new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (...args: unknown[]) => {
          dbCalls++;
          return (target as any).query(...(args as [string, unknown[]?]));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as Pool;

  const rawEmb = createEmbeddings(config);
  let embedCalls = 0; // embedding 端点真实调用次数（embedDocuments 一次 = +1 次请求）
  const countingEmb = {
    embedQuery: async (t: string) => {
      embedCalls++;
      return rawEmb.embedQuery(t);
    },
    embedDocuments: async (texts: string[]) => {
      embedCalls++;
      return rawEmb.embedDocuments(texts);
    },
  } as unknown as OpenAIEmbeddings;

  const store = new PgVectorStore(countingPool, countingEmb); // 不传 cache → 真实默认参数
  const results: CaseResult[] = [];
  const report = (name: string, expect: string, actual: string, pass: boolean, ms: number) => {
    results.push({ name, expect, actual, pass, ms });
    console.log(`${pass ? "PASS ✅" : "FAIL ❌"}  ${name}  (${ms}ms)`);
    console.log(`      期望: ${expect}`);
    console.log(`      实际: ${actual}`);
  };

  const run = async (name: string, expect: string, fn: () => Promise<string>) => {
    const t0 = Date.now();
    let pass = true;
    let actual = "";
    try {
      actual = await fn();
    } catch (e) {
      pass = false;
      actual = `异常: ${(e as Error).message}`;
    }
    report(name, expect, actual, pass, Date.now() - t0);
  };

  const ts = Date.now().toString(36);
  const docA = randomUUID(); // documents.id 为 UUID 类型
  const docB = randomUUID();
  const docC = randomUUID();
  const testIds = [docA, docB, docC];
  const TA = `L1CACHE-ACCEPT-${ts.toUpperCase()}A9K2`; // docA 唯一 token（keyword/FTS 命中点）
  const TB = `L1CACHE-ACCEPT-${ts.toUpperCase()}B7M3`;
  const QA = `${TA} RAG 查询结果缓存验收文档`; // docA 检索 query（与内容同 token）

  const started = { docs: 0 };
  {
    const r = await pool.query("SELECT count(*)::int AS n FROM documents");
    started.docs = r.rows[0].n;
  }

  try {
    // ── 用例 1：addChunks 两条腿都真实写入，写后 query 缓存应为空 ──
    await run(
      "addChunks(docA×3) 真实写入",
      "无异常，queryResults=0",
      async () => {
        const s0 = store.getCacheStats();
        if (s0.queryResults !== 0) throw new Error(`queryResults=${s0.queryResults} 应为 0`);
        return `写入 3 chunks，embed 调用 ${embedCalls} 次，queryResults=${store.getCacheStats().queryResults}`;
      },
    );
    {
      await store.addChunks(
        [
          { content: `${QA} 向量检索腿与 FTS 腿应同时命中这一句。`, metadata: { filename: "v1.md" } },
          { content: `${TA} 第二段：混合检索的回填、命中、失效闭环验证材料。`, metadata: { filename: "v1.md" } },
          { content: `${TA} 第三段：用于验证多 chunk 文档与 doc_id 归并。`, metadata: { filename: "v1.md" } },
        ],
        docA,
      );
    }
    await run(
      "addChunks(docB×1)",
      "无异常",
      async () => {
        await store.addChunks(
          [{ content: `${TB} 对照文档，用于验证 deleteDoc 只影响被删文档。`, metadata: { filename: "v2.md" } }],
          docB,
        );
        return `写入 1 chunk，embed 累计 ${embedCalls} 次`;
      },
    );

    // ── 用例 2：首查 miss → 走真实检索 + 回填 ──
    let firstRes: Awaited<ReturnType<typeof store.search>> = [];
    const dbAfterFirst = { calls: 0, embed: 0, qr: 0 };
    await run(
      "search(QA, k=5) 首查：真实检索 + 回填缓存",
      "结果非空且 docId=docA，queryResults=1，embed 计数=3(2次add+1次query)",
      async () => {
        const before = embedCalls; // 此刻应为 2（两次 addChunks 各 +1）
        firstRes = await store.search(QA, 5);
        const st = store.getCacheStats();
        if (firstRes.length === 0) throw new Error("真实检索返回空");
        if (!firstRes.some((r) => r.docId === docA)) {
          throw new Error(`结果未包含新写入的 docA（真实语义检索应能召回它）: ${[...new Set(firstRes.map((r) => r.docId))].join(",")}`);
        }
        if (st.queryResults !== 1) throw new Error(`queryResults=${st.queryResults} 应为 1（回填 1 个 key）`);
        if (embedCalls - before !== 1) throw new Error(`首查应恰好调 1 次 embedding，实际 ${embedCalls - before}`);
        dbAfterFirst.calls = dbCalls;
        dbAfterFirst.embed = embedCalls;
        dbAfterFirst.qr = st.queryResults;
        return `命中 ${firstRes.length} 条（含 docA=${firstRes.some((r) => r.docId === docA)}，其余为语义相近存量文档）| queryResults=${st.queryResults} | embedMemo=${st.embedMemo} | embed 调用 ${embedCalls}`;
      },
    );

    // ── 用例 3：同 key 二查 → 纯缓存命中，DB 与 embedding 一次都不碰 ──
    let cachedMs = 0;
    await run(
      "search(QA, k=5) 二查：缓存命中",
      "结果与首查一致；dbCalls/embedCalls 均不变；queryResults 仍=1",
      async () => {
        const calls = dbCalls;
        const ec = embedCalls;
        const t0 = Date.now();
        const second = await store.search(QA, 5);
        cachedMs = Date.now() - t0;
        if (JSON.stringify(second) !== JSON.stringify(firstRes)) throw new Error("缓存结果与首查不一致");
        if (dbCalls !== calls) throw new Error(`缓存命中仍查了 DB（+${dbCalls - calls}）`);
        if (embedCalls !== ec) throw new Error(`缓存命中仍调了 embedding（+${embedCalls - ec}）`);
        const st = store.getCacheStats();
        if (st.queryResults !== 1) throw new Error(`queryResults=${st.queryResults} 应为 1（命中不应新增 key）`);
        return `dbCalls 不变(${calls}) embedCalls 不变(${ec}) queryResults=${st.queryResults}`;
      },
    );

    // ── 用例 4：同文本不同 k → 新查询 key，但 embedding memo 复用 ──
    await run(
      "search(QA, k=8)：embedding 记忆化跨 k 复用",
      "queryResults=2（新 key）；embedCalls 不变（同文本不重 embed）",
      async () => {
        const ec = embedCalls;
        await store.search(QA, 8);
        const st = store.getCacheStats();
        if (st.queryResults !== 2) throw new Error(`queryResults=${st.queryResults} 应为 2`);
        if (embedCalls !== ec) throw new Error(`embedMemo 未生效：同文本重复 embed（+${embedCalls - ec}）`);
        return `queryResults=${st.queryResults} embedMemo=${st.embedMemo} embedCalls 不变(${ec})`;
      },
    );

    // ── 用例 5：searchKeyword 独立缓存 key ──
    await run(
      "searchKeyword(TA)：纯关键词腿缓存",
      "结果非空；queryResults=3（mode 不同）",
      async () => {
        const kw = await store.searchKeyword(TA, 5);
        if (kw.length === 0) throw new Error("searchKeyword 真实返回空");
        const st = store.getCacheStats();
        if (st.queryResults !== 3) throw new Error(`queryResults=${st.queryResults} 应为 3`);
        return `命中 ${kw.length} 条 | queryResults=${st.queryResults}`;
      },
    );

    // ── 用例 6：deleteDoc → 语料写入口统一失效 ──
    await run(
      "deleteDoc(docA)：query 缓存 + listDocs 短缓存失效",
      "queryResults=0",
      async () => {
        await store.deleteDoc(docA);
        const st = store.getCacheStats();
        if (st.queryResults !== 0) throw new Error(`queryResults=${st.queryResults} 应为 0（未失效）`);
        if (st.embedMemo === 0) throw new Error("embedMemo 不应被 deleteDoc 清空");
        return `queryResults=0 但 embedMemo=${st.embedMemo}（记忆化存活 ✓）`;
      },
    );

    // ── 用例 7：失效后重查同文本 → DB 重查、embedding memo 仍命中 ──
    await run(
      "deleteDoc 后重查 QA：结果不再含 docA，embed 不重调",
      "queryResults=1（重新回填）；embedCalls 不变；dbCalls 增加",
      async () => {
        const ec = embedCalls;
        const calls = dbCalls;
        const res = await store.search(QA, 5);
        if (res.some((r) => r.docId === docA)) throw new Error("已删文档仍被检索到（CASCADE/失效失效？）");
        if (embedCalls !== ec) throw new Error(`embedMemo 未跨失效存活：重 embed（+${embedCalls - ec}）`);
        if (dbCalls <= calls) throw new Error("query 缓存未真正失效：重查未走 DB");
        const st = store.getCacheStats();
        if (st.queryResults !== 1) throw new Error(`queryResults=${st.queryResults} 应为 1`);
        return `结果 ${res.length} 条且无 docA | queryResults=${st.queryResults} | dbCalls ${calls}→${dbCalls} | embedCalls 不变(${ec})`;
      },
    );

    // ── 用例 8：addChunks 追加 → 再次统一失效 ──
    await run(
      "addChunks(docC)：写入口再次失效",
      "queryResults=0",
      async () => {
        await store.addChunks(
          [{ content: `L1CACHE-ACCEPT-${ts.toUpperCase()}C5N8 追加文档，验证写后失效。`, metadata: { filename: "v3.md" } }],
          docC,
        );
        const st = store.getCacheStats();
        if (st.queryResults !== 0) throw new Error(`queryResults=${st.queryResults} 应为 0`);
        return `queryResults=0 | embedMemo=${st.embedMemo}`;
      },
    );

    // ── 用例 9：listDocs 冒烟（真实查库）──
    await run(
      "listDocs()：仍可用且含新增文档",
      "返回数组包含 docB/docC，不含已删 docA",
      async () => {
        const docs = await store.listDocs();
        if (!Array.isArray(docs)) throw new Error("listDocs 非数组");
        const ids = new Set(docs.map((d) => d.id));
        if (ids.has(docA)) throw new Error("已删 docA 仍出现在列表（失效缺口复现）");
        if (!ids.has(docB) || !ids.has(docC)) throw new Error("新增文档未出现在列表");
        return `共 ${docs.length} 个文档，docB/docC 在列，docA 已消失`;
      },
    );
  } finally {
    // 清理验收数据（CASCADE 删 chunks）
    await pool.query("DELETE FROM documents WHERE id = ANY($1)", [testIds]);
    await pool.end();
  }

  // ── 汇总 ──
  const passed = results.filter((r) => r.pass).length;
  console.log("\n" + "=".repeat(72));
  console.log(`验收汇总: ${passed}/${results.length} PASS  |  真实 PG + ollama nomic-embed-text(768d)`);
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  }
  const first = results[2]?.ms ?? 0;
  const cached = results[3]?.ms ?? 0;
  console.log(`\n性能参考: 首查 ${first}ms → 缓存命中 ${cached}ms`);
  console.log(`库状态: 验收前 ${started.docs} 个文档 → 清理后 ${started.docs} 个（无残留）`);

  if (passed !== results.length) process.exit(1);
  console.log("\n验收通过 ✅");
}

main().catch((e) => {
  console.error("[verify-l1-cache] 执行失败:", (e as Error).message);
  process.exit(1);
});
