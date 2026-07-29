import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

/**
 * 轻量级迁移执行器。
 * 按文件名顺序执行 migrations/ 下的 .sql 文件。
 * 幂等：每个迁移文件只执行一次（跟踪在内存中）。
 */
const executed = new Set<string>();

export async function migrate(pool: Pool): Promise<void> {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.log("[migrate] No migrations directory found, skipping");
    return;
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 按文件名排序 = 按序号执行

  for (const file of files) {
    if (executed.has(file)) {
      console.log(`[migrate] Skipping already-executed: ${file}`);
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`[migrate] Running: ${file}...`);

    try {
      await pool.query(sql);
      executed.add(file);
      console.log(`[migrate] Done: ${file}`);
    } catch (err) {
      console.error(`[migrate] Failed: ${file}`, (err as Error).message);
      throw err;
    }
  }
}
