import { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import { migrate } from "./migrate.js";

let pool: Pool | null = null;

export async function getPool(config: AppConfig): Promise<Pool> {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      min: config.databasePoolMin,
      max: config.databasePoolMax,
    });
    // 启动时运行迁移
    await migrate(pool);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
