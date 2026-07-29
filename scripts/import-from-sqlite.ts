#!/usr/bin/env node
/**
 * 从旧 sqlite (navigate.db) + JSON (vectorstore.json, docmeta.json) 导入数据到 PostgreSQL。
 *
 * 使用方式：
 *   1. docker-compose up -d          # 确保 PostgreSQL 在运行
 *   2. npx tsx scripts/import-from-sqlite.ts
 *
 * 前提条件：
 *   - PostgreSQL 已启动且 schema 已就绪（应用启动时自动迁移）
 *   - 旧数据文件存在于项目根目录 (navigate.db, rag_data/ 等)
 */

import { Pool } from "pg";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════
//  SQLite → PostgreSQL 导入 (对话记忆)
// ═══════════════════════════════════════════════

async function migrateSqlite(pg: Pool, dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    console.log(`[import] No sqlite db found at ${dbPath}, skipping`);
    return;
  }

  // 使用动态 import 加载 sql.js（仅在需要时加载）
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const buf = readFileSync(dbPath);
  const sqldb = new SQL.Database(buf);

  // 检查表是否存在
  const tables = sqldb.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = tables[0]?.values?.map((r: any) => r[0]) ?? [];
  console.log(`[import] Found tables in sqlite: ${tableNames.join(", ")}`);

  const client = await pg.connect();
  try {
    await client.query("BEGIN");

    // 迁移 sessions
    if (tableNames.includes("sessions")) {
      const sessions = sqldb.exec("SELECT id, name, created_at, updated_at FROM sessions");
      let count = 0;
      for (const s of sessions[0]?.values ?? []) {
        await client.query(
          `INSERT INTO sessions (id, name, created_at, updated_at)
           VALUES ($1, $2, to_timestamp($3/1000), to_timestamp($4/1000))
           ON CONFLICT (id) DO NOTHING`,
          [s[0], s[1], Math.floor(Number(s[2]) / 1000), Math.floor(Number(s[3]) / 1000)],
        );
        count++;
      }
      console.log(`[import] Migrated ${count} sessions`);
    }

    // 迁移 messages
    if (tableNames.includes("messages")) {
      const messages = sqldb.exec("SELECT session_id, role, content, created_at FROM messages ORDER BY id ASC");
      let count = 0;
      for (const m of messages[0]?.values ?? []) {
        await client.query(
          `INSERT INTO messages (session_id, role, content, created_at)
           VALUES ($1, $2, $3, to_timestamp($4/1000))`,
          [m[0], m[1], m[2], Math.floor(Number(m[3]) / 1000)],
        );
        count++;
      }
      console.log(`[import] Migrated ${count} messages`);
    }

    // 迁移 summaries
    if (tableNames.includes("summaries")) {
      const summaries = sqldb.exec("SELECT session_id, content, msg_start_id, msg_end_id, original_tokens, created_at FROM summaries ORDER BY id ASC");
      let count = 0;
      for (const s of summaries[0]?.values ?? []) {
        await client.query(
          `INSERT INTO summaries (session_id, content, msg_start_id, msg_end_id, original_chars, created_at)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6/1000))`,
          [s[0], s[1], s[3] ?? null, s[4] ?? null, s[5] ?? 0, Math.floor(Number(s[6]) / 1000)],
        );
        count++;
      }
      console.log(`[import] Migrated ${count} summaries`);
    }

    await client.query("COMMIT");
    console.log("[import] SQLite migration completed successfully");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    sqldb.close();
  }
}

// ═══════════════════════════════════════════════
//  JSON → PostgreSQL 导入 (文档元数据)
// ═══════════════════════════════════════════════

async function migrateDocMeta(pg: Pool): Promise<void> {
  const metaPath = "rag_data/docmeta.json";
  if (!existsSync(metaPath)) {
    console.log(`[import] No docmeta found at ${metaPath}, skipping`);
    return;
  }

  const raw = readFileSync(metaPath, "utf-8");
  const items = JSON.parse(raw) as any[];

  const client = await pg.connect();
  try {
    await client.query("BEGIN");
    let count = 0;
    for (const item of items) {
      await client.query(
        `INSERT INTO documents (id, filename, stored_filename, chunk_count, indexed_at, wiki_page_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          item.id ?? randomUUID(),
          item.filename ?? "unknown",
          item.storedFilename ?? null,
          item.chunks ?? 0,
          item.indexedAt ? new Date(item.indexedAt).toISOString() : new Date().toISOString(),
          item.wikiPageId ?? null,
        ],
      );
      count++;
    }
    await client.query("COMMIT");
    console.log(`[import] Migrated ${count} document metadata entries`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════
//  主入口
// ═══════════════════════════════════════════════

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[import] DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const pg = new Pool({ connectionString: dbUrl });

  try {
    console.log("[import] Starting migration from legacy stores...");
    await migrateSqlite(pg, "navigate.db");
    await migrateDocMeta(pg);
    console.log("[import] All migrations completed!");
  } catch (err) {
    console.error("[import] Migration failed:", (err as Error).message);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

main();
