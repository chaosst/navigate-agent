#!/usr/bin/env node
/**
 * 一次性回填脚本: 将 zyplayer-doc 中所有已存在的页面同步到 RAG 向量库。
 *
 * 场景: 数据从 Wiki.js 迁移到 zyplayer-doc 后，ContentPoller 首次运行
 *       只记录基线时间（不会同步历史内容）。运行本脚本可一次性全量同步。
 *
 * 使用方式:
 *   npx tsx scripts/backfill-zyplayer-rag.ts
 */

import "dotenv/config";
import { loadConfig } from "../src/config/index.js";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PgVectorStore } from "../src/storage/pg-vector-store.js";
import { getPool } from "../src/storage/pool.js";
import { ZyplayerDocAdapter } from "../src/wiki-sync/zyplayer-doc-adapter.js";

async function main() {
  const config = loadConfig();

  // 1. 检查 zyplayer-doc 配置
  const mysqlHost = process.env.ZYPLAYER_MYSQL_HOST;
  if (!mysqlHost) {
    console.error("❌ 未配置 ZYPLAYER_MYSQL_HOST。请检查 .env");
    process.exit(1);
  }

  // 2. 初始化 RAG 存储（与 server-entry.ts 一致）
  console.log("🔌 连接 PostgreSQL...");
  const embeddings = new OpenAIEmbeddings({
    apiKey: config.openAIApiKey,
    model: "text-embedding-3-small",
  });
  const pool = await getPool(config);
  const ragStore = new PgVectorStore(pool, embeddings);

  // 3. 初始化 zyplayer-doc 适配器
  console.log("🔌 连接 zyplayer-doc MySQL...");
  const adapter = new ZyplayerDocAdapter(
    {
      host: mysqlHost,
      port: parseInt(process.env.ZYPLAYER_MYSQL_PORT || "3307", 10),
      user: process.env.ZYPLAYER_MYSQL_USER || "zyplayer",
      password: process.env.ZYPLAYER_MYSQL_PASSWORD || "zyplayer_pass",
      database: process.env.ZYPLAYER_MYSQL_DB || "zyplayer_doc",
    },
    ragStore,
  );

  // 4. 查询所有页面（用 1970 作为起点，全量拉取）
  console.log("📄 拉取所有页面...");
  const pages = await adapter.listChangedPages("1970-01-01T00:00:00.000Z");
  console.log(`   找到 ${pages.length} 篇页面\n`);

  // 5. 逐个同步到 RAG
  let ok = 0;
  let fail = 0;
  for (const page of pages) {
    try {
      const title = await adapter.syncPageToRag(page.pageId);
      console.log(`   ✅ #${page.pageId} "${title}"`);
      ok++;
    } catch (err) {
      console.error(`   ❌ #${page.pageId} 同步失败:`, (err as Error).message);
      fail++;
    }
  }

  console.log(`\n=== 回填完成 ===`);
  console.log(`   成功: ${ok}`);
  console.log(`   失败: ${fail}`);

  await adapter.close();
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
