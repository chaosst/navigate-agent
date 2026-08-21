#!/usr/bin/env node
/**
 * Wiki.js → zyplayer-doc 数据迁移脚本
 *
 * 从 Wiki.js 的 SQLite 数据库读取已发布页面，导入到 zyplayer-doc 的 MySQL 数据库。
 *
 * 使用方式:
 *   1. 先启动 zyplayer-doc: docker-compose -f docker-compose.zyplayer.yml up -d
 *   2. 在浏览器中访问 http://localhost:8083 完成初始设置并创建默认 Space
 *   3. 运行本脚本:
 *      npx tsx scripts/migrate-wikijs-to-zyplayer.ts
 *
 * 注意: 需要先在 zyplayer-doc UI 中至少创建一个 Space 并记下 space_id。
 *
 * 表结构依据实际运行的 zyplayer-doc MySQL schema:
 *   wiki_page:          id, space_id, name, parent_id, node_type, editor_type,
 *                       edit_type, del_flag, uuid, create_time, update_time, ...
 *   wiki_page_content:  id, page_id, content, search_content, page_summary,
 *                       create_time, update_time, ...
 *   wiki_space:         id, name, ...
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import initSqlJs from "sql.js";
import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// ====== 配置 ======

const WIKIJS_DB_PATH = "wiki-js/db.sqlite";

const MYSQL_CONFIG = {
  host: process.env.ZYPLAYER_MYSQL_HOST || "localhost",
  port: parseInt(process.env.ZYPLAYER_MYSQL_PORT || "3307", 10),
  user: process.env.ZYPLAYER_MYSQL_USER || "zyplayer",
  password: process.env.ZYPLAYER_MYSQL_PASSWORD || "zyplayer_pass",
  database: process.env.ZYPLAYER_MYSQL_DB || "zyplayer_doc",
};

// ====== 辅助函数 ======

function prompt(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

/** 生成页面的 full_path（类似 slug） */
function makeFullPath(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\w一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "untitled"
  );
}

/** 时间戳 → MySQL datetime 格式 */
function toMySQLDate(ts?: string): string {
  const d = ts ? new Date(ts) : new Date();
  return isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 19).replace("T", " ")
    : d.toISOString().slice(0, 19).replace("T", " ");
}

// ====== 主流程 ======

async function main() {
  console.log("=== Wiki.js → zyplayer-doc 数据迁移 ===\n");

  // 1. 读取 Wiki.js SQLite
  if (!existsSync(WIKIJS_DB_PATH)) {
    console.error(`❌ 找不到 Wiki.js 数据库: ${WIKIJS_DB_PATH}`);
    console.log("请确认 Wiki.js 已运行过且有数据。");
    process.exit(1);
  }

  console.log(`📖 正在读取 Wiki.js 数据库: ${WIKIJS_DB_PATH}`);
  const SQL = await initSqlJs();
  const buf = readFileSync(WIKIJS_DB_PATH);
  const wikiDb = new SQL.Database(buf);

  // 查询 Wiki.js pages 表（content 字段为原始 Markdown）
  const pagesResult = wikiDb.exec(
    `SELECT id, title, content, path, isPublished, createdAt, updatedAt
     FROM pages WHERE isPublished = 1`
  );

  interface WikiJSPage {
    id: number;
    title: string;
    content: string;
    path: string;
    isPublished: number;
    createdAt: string;
    updatedAt: string;
  }

  const pages: WikiJSPage[] = [];
  if (pagesResult.length > 0) {
    const columns = pagesResult[0].columns;
    for (const row of pagesResult[0].values) {
      pages.push({
        id: row[columns.indexOf("id")] as number,
        title: row[columns.indexOf("title")] as string,
        content: row[columns.indexOf("content")] as string,
        path: row[columns.indexOf("path")] as string,
        isPublished: row[columns.indexOf("isPublished")] as number,
        createdAt: row[columns.indexOf("createdAt")] as string,
        updatedAt: row[columns.indexOf("updatedAt")] as string,
      });
    }
  }

  console.log(`📄 从 Wiki.js 中找到 ${pages.length} 篇已发布页面`);
  if (pages.length === 0) {
    console.log("没有需要迁移的页面。");
    wikiDb.close();
    return;
  }

  for (const p of pages) {
    console.log(`   - #${p.id} "${p.title}" (${p.path})`);
  }

  // 2. 连接到 zyplayer-doc MySQL
  console.log(`\n🔌 正在连接 zyplayer-doc MySQL: ${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}`);
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);
  await mysqlConn.ping();
  console.log("✅ MySQL 连接成功");

  // 3. 检查必需的表是否存在
  const [tables] = await mysqlConn.execute("SHOW TABLES");
  const tableList = (tables as mysql.RowDataPacket[]).map((r) => Object.values(r)[0]);

  const requiredTables = ["wiki_page", "wiki_page_content", "wiki_space"];
  const missing = requiredTables.filter((t) => !tableList.includes(t));
  if (missing.length > 0) {
    console.error(`❌ 缺少必需的表: ${missing.join(", ")}`);
    console.log("请确认 zyplayer-doc 已正确初始化并至少访问过一次。");
    await mysqlConn.end();
    wikiDb.close();
    process.exit(1);
  }

  // 4. 获取现有的 Space 列表
  const [spaces] = await mysqlConn.execute("SELECT id, name FROM wiki_space");
  const spaceList = spaces as mysql.RowDataPacket[];
  if (spaceList.length === 0) {
    console.error("❌ zyplayer-doc 中没有 Space。请先在 http://localhost:8083 创建至少一个 Space。");
    await mysqlConn.end();
    wikiDb.close();
    process.exit(1);
  }

  console.log("\n📂 可用的 Space:");
  for (const s of spaceList) {
    console.log(`   ID: ${s.id} — ${s.name}`);
  }

  const spaceIdAns = await prompt("\n请输入要导入到的 Space ID (默认: " + spaceList[0].id + "): ");
  const targetSpaceId = parseInt(spaceIdAns, 10) || (spaceList[0].id as number);
  console.log(`\n📥 开始导入到 Space #${targetSpaceId}...\n`);

  // 5. 导入页面
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const page of pages) {
    try {
      const pageId = page.id; // 保留 Wiki.js 原始 ID，便于追溯
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");

      // 检查是否已存在
      const [existing] = await mysqlConn.execute(
        "SELECT id FROM wiki_page WHERE id = ?",
        [pageId]
      );
      if ((existing as mysql.RowDataPacket[]).length > 0) {
        console.log(`   ⏭️  #${pageId} "${page.title}" 已存在，跳过`);
        skipped++;
        continue;
      }

      // 插入 wiki_page（文档节点）
      // node_type=1 终节点(文档), editor_type=2 Markdown, edit_type=0 可编辑, del_flag=0 有效
      await mysqlConn.execute(
        `INSERT INTO wiki_page
           (id, space_id, name, parent_id, full_path, node_type, edit_type,
            editor_type, del_flag, uuid, create_time, update_time)
         VALUES (?, ?, ?, 0, ?, 1, 0, 2, 0, ?, ?, ?)`,
        [pageId, targetSpaceId, page.title, makeFullPath(page.title), randomUUID(), now, now]
      );

      // 插入 wiki_page_content（Markdown 内容）
      const summary = page.content.replace(/\s+/g, " ").slice(0, 250);
      await mysqlConn.execute(
        `INSERT INTO wiki_page_content
           (page_id, content, search_content, page_summary, create_time, update_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [pageId, page.content, page.content.replace(/#{1,6}\s+/g, ""), summary, now, now]
      );

      imported++;
      console.log(`   ✅ #${pageId} "${page.title}"`);
    } catch (err) {
      errors++;
      console.error(`   ❌ #${page.id} "${page.title}" 导入失败:`, (err as Error).message);
    }
  }

  // 6. 报告
  console.log(`\n=== 迁移完成 ===`);
  console.log(`   总计: ${pages.length}`);
  console.log(`   成功: ${imported}`);
  console.log(`   跳过: ${skipped}`);
  console.log(`   失败: ${errors}`);
  console.log(`   请到 zyplayer-doc 验证: http://localhost:8083`);

  // 清理
  await mysqlConn.end();
  wikiDb.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
