# RAG 三层存储架构 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 RAG 存储从 MemoryVectorStore + sql.js 重构为 PostgreSQL + pgvector 的三层架构（HotCache / SQL / Vector）

**Architecture:** 五阶段渐进式迁移。Phase 0 建基础设施（Docker + 连接池 + 迁移框架）；Phase 1 替换 RAG 向量层（pgvector + zhparser FTS 替代 MemoryVectorStore + BM25）；Phase 2 替换对话记忆层（PgSessionStore 替代 sql.js，摘要向量化）；Phase 3 添加 L1 热缓存（LRU cache-aside）；Phase 4 数据迁移与清理。

**Tech Stack:** PostgreSQL 16 + pgvector + zhparser, `pg` (Node.js driver), OpenAI `text-embedding-3-small`, Docker Compose

## Global Constraints

- 开发环境强制使用 PostgreSQL，不支持降级回退
- PostgreSQL 使用 Docker Compose 管理（`docker-compose up -d` 一键启动）
- 所有数据库迁移文件使用原始 SQL，存放在 `src/storage/migrations/` 下
- 迁移框架用内存跟踪已执行 ID，无需 migration 表
- 旧文件（`sqlite-store.ts`, `vector-memory.ts`, `vectorstore.ts`）在 Phase 4 最终删除，各 Phase 先保留旧文件确保回退路径
- 删除 `sql.js` 和 `@types/sql.js` 依赖在 Phase 4 执行

---

## File Structure

```
src/
  storage/
    pool.ts                       # 连接池封装 (pg.Pool)
    migrate.ts                    # 迁移执行器
    types.ts                      # 存储层共享类型
    cache.ts                      # L1 HotCache 实现
    pg-vector-store.ts            # PgVectorStore (L2+L3)
    pg-session-store.ts           # PgSessionStore (L2)
    migrations/
      001_create_documents_and_chunks.sql
      002_create_sessions_and_messages.sql

  rag/
    vectorstore.ts                # ← Phase 4 删除
    retriever.ts                  # ← Phase 1 改造
    types.ts                      # ✅ 不变
    loader.ts                     # ✅ 不变
    reranker.ts                   # ✅ 不变

  memory/
    sqlite-store.ts               # ← Phase 4 删除
    vector-memory.ts              # ← Phase 2 删除
    index.ts                      # ← Phase 2 改造
    summary-manager.ts            # ← Phase 2 升级
    context-manager.ts            # ✅ 不变
    types.ts                      # ✅ 不变

  config/
    index.ts                      # ← Phase 0 微调

  index.ts                        # ← Phase 1/2 改造
  server-entry.ts                 # ← Phase 1/2 改造

scripts/
  import-from-sqlite.ts            # ← Phase 4 创建
  init-pg.sql                      # ← Phase 0 创建

docker-compose.yml                 # ← Phase 0 创建
Dockerfile.pg                      # ← Phase 0 创建
```

---

## Phase 0: 基础设施

### Task 0.1: 创建 Docker Compose + pgvector 镜像配置

**Files:**
- Create: `Dockerfile.pg`
- Create: `docker-compose.yml`
- Create: `scripts/init-pg.sql`

**Interfaces:**
- Produces: `docker-compose up -d` 一键启动 PostgreSQL 16 + pgvector + zhparser

- [ ] **Step 1: 创建 `Dockerfile.pg`**

```dockerfile
FROM pgvector/pgvector:pg16
RUN apt-get update && apt-get install -y \
    postgresql-16-zhparser \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: 创建 `docker-compose.yml`**

```yaml
version: "3.9"
services:
  postgres:
    build:
      context: .
      dockerfile: Dockerfile.pg
    environment:
      POSTGRES_DB: navigate
      POSTGRES_USER: navigate
      POSTGRES_PASSWORD: navigate
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-pg.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U navigate -d navigate"]
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  pgdata:
```

- [ ] **Step 3: 创建 `scripts/init-pg.sql`**

```sql
-- Docker entrypoint 初始化脚本
-- 仅创建 extension，表结构通过迁移脚本在应用启动时创建
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;

-- 中文全文搜索配置
CREATE TEXT SEARCH CONFIGURATION chinese_zh (PARSER = zhparser);
ALTER TEXT SEARCH CONFIGURATION chinese_zh
  ADD MAPPING FOR n, v, a, i, e, l WITH simple;
```

- [ ] **Step 4: 创建 `.env` 数据库配置（追加到 `.env.example`）**

```env
# PostgreSQL (三层存储架构)
DATABASE_URL=postgresql://navigate:navigate@localhost:5432/navigate
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10
```

- [ ] **Step 5: 验证 Docker 启动**

```bash
docker-compose up -d
docker-compose logs postgres
# 确认: "database system is ready to accept connections"
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile.pg docker-compose.yml scripts/init-pg.sql .env.example
git commit -m "chore: add PostgreSQL + pgvector + zhparser docker setup"
```

---

### Task 0.2: 安装 pg 依赖 + 创建连接池

**Files:**
- Modify: `package.json`
- Create: `src/storage/pool.ts`
- Modify: `src/config/index.ts`

**Interfaces:**
- Produces: `getPool(): Promise<Pool>` — 全局单例连接池，启动时自动执行迁移
- Produces: `loadConfig()` 返回新增 `databaseUrl` 字段

- [ ] **Step 1: 安装 pg**

```bash
npm install pg@^8.13.0
npm install -D @types/pg@^8.11.0
```

- [ ] **Step 2: 更新 `src/config/index.ts` — 加载 `DATABASE_URL`**

在 `AppConfig` 接口中追加：

```typescript
export interface AppConfig {
  // ... 现有字段
  databaseUrl: string;
  databasePoolMin: number;
  databasePoolMax: number;
}
```

在 `loadConfig()` 函数中追加读取：

```typescript
export function loadConfig(): AppConfig {
  config(); // 现有

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required but not set.");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required but not set.");

  // ... 现有 mcpServers / maxIterations 等

  return {
    // ... 现有
    databaseUrl,
    databasePoolMin: parseInt(process.env.DATABASE_POOL_MIN ?? "2", 10),
    databasePoolMax: parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10),
  };
}
```

- [ ] **Step 3: 创建 `src/storage/pool.ts`**

```typescript
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
```

- [ ] **Step 4: 验证编译通过**

```bash
npx tsc --noEmit
# Expected: no errors
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/config/index.ts src/storage/pool.ts
git commit -m "feat(storage): add PostgreSQL connection pool and config"
```

---

### Task 0.3: 创建迁移框架

**Files:**
- Create: `src/storage/migrate.ts`
- Create: `src/storage/migrations/001_create_documents_and_chunks.sql`
- Create: `src/storage/migrations/002_create_sessions_and_messages.sql`

**Interfaces:**
- Produces: `migrate(pool: Pool): Promise<void>` — 按文件名顺序执行迁移 SQL，幂等

- [ ] **Step 1: 创建 `src/storage/migrate.ts`**

```typescript
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
```

- [ ] **Step 2: 创建 `src/storage/migrations/001_create_documents_and_chunks.sql`**

```sql
-- 001: 文档与块表（L2 元数据 + L3 向量）
-- 幂等创建 extension 和 text search config（不依赖 init-pg.sql）

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config WHERE cfgname = 'chinese_zh'
  ) THEN
    CREATE TEXT SEARCH CONFIGURATION chinese_zh (PARSER = zhparser);
    ALTER TEXT SEARCH CONFIGURATION chinese_zh
      ADD MAPPING FOR n, v, a, i, e, l WITH simple;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY,
  filename        TEXT NOT NULL,
  stored_filename TEXT,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  owner           TEXT NOT NULL DEFAULT 'admin',
  project         TEXT NOT NULL DEFAULT '',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  visibility      TEXT NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private', 'team', 'public')),
  permissions     JSONB NOT NULL DEFAULT '[]',
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  wiki_page_id    INTEGER,
  metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id          UUID PRIMARY KEY,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  chunk_index INTEGER NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  fts_vector  tsvector
      GENERATED ALWAYS AS (to_tsvector('chinese_zh', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON doc_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON doc_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON doc_chunks USING GIN (fts_vector);
```

- [ ] **Step 3: 创建 `src/storage/migrations/002_create_sessions_and_messages.sql`**

```sql
-- 002: 会话与对话记忆表（L2 关系型存储）

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'New Chat',
  owner       TEXT NOT NULL DEFAULT 'admin',
  project     TEXT NOT NULL DEFAULT '',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  visibility  TEXT NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private', 'team', 'public')),
  permissions JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS summaries (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  msg_start_id    BIGINT,
  msg_end_id      BIGINT,
  original_chars  INTEGER DEFAULT 0,
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_summaries_embedding ON summaries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);
```

- [ ] **Step 4: 验证启动流程**

```bash
docker-compose up -d  # 确保 PostgreSQL 在跑
# 写一个临时脚本来验证 migrate() 能正确执行
node -e "
  import('./dist/storage/pool.js').then(async m => {
    const { getPool } = m;
    const pool = await getPool({ databaseUrl: 'postgresql://navigate:navigate@localhost:5432/navigate', databasePoolMin: 2, databasePoolMax: 10 });
    const { rows } = await pool.query('SELECT count(*) FROM documents');
    console.log('documents table exists:', rows);
    await pool.end();
  }).catch(console.error);
"
```

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrate.ts src/storage/migrations/
git commit -m "feat(storage): add migration framework and initial schemas"
```

---

## Phase 1: L3 向量层 (pgvector)

### Task 1.1: 创建 PgVectorStore — 基础 CRUD

**Files:**
- Create: `src/storage/types.ts`
- Create: `src/storage/pg-vector-store.ts`

**Interfaces:**
- Produces: `PgVectorStore` class with:
  - `addChunks(chunks: { content, metadata }[], docId: string): Promise<void>`
  - `deleteDoc(docId: string): Promise<void>`
  - `getDocMeta(docId: string): Promise<DocMeta | null>`
  - `listDocs(): Promise<RagDocument[]>`
  - `saveDocMeta(meta: DocMeta): Promise<void>`
  - `deleteDocMeta(docId: string): Promise<void>`
  - `getChunkCount(): Promise<number>`
  - `listDocIds(): Promise<string[]>`

- [ ] **Step 1: 创建 `src/storage/types.ts`**

```typescript
import type { RagDocument, RagResult } from "../rag/types.js";

export { RagDocument, RagResult };

export interface DocMeta {
  filename: string;
  storedFilename?: string;
  chunkCount: number;
  indexedAt: Date;
  wikiPageId?: number;
  owner?: string;
  project?: string;
  tags?: string[];
  visibility?: "private" | "team" | "public";
  permissions?: { user: string; role: "reader" | "editor" | "admin" }[];
  metadata?: Record<string, unknown>;
}

export interface ChunkRecord {
  id: string;
  docId: string;
  content: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
}

// 与 PgSessionStore 共享的接口
export interface SessionRecord {
  id: string;
  name: string;
  owner: string;
  project: string;
  tags: string[];
  visibility: "private" | "team" | "public";
  permissions: { user: string; role: "reader" | "editor" | "admin" }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}
```

- [ ] **Step 2: 实现 `PgVectorStore` 构造函数 + addChunks**

```typescript
// src/storage/pg-vector-store.ts

import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { randomUUID } from "node:crypto";
import type { RagResult } from "./types.js";
import type { DocMeta } from "./types.js";

export class PgVectorStore {
  constructor(
    private pool: Pool,
    private embeddings: OpenAIEmbeddings,
  ) {}

  async addChunks(
    chunks: { content: string; metadata: Record<string, unknown> }[],
    docId: string,
  ): Promise<void> {
    if (chunks.length === 0) return;

    // 为 chunks 预计算 embedding
    const texts = chunks.map((c) => c.content);
    let vectors: number[][] = [];
    try {
      vectors = await this.embeddings.embedDocuments(texts);
    } catch (e) {
      console.warn(`[pgvector] Embeddings unavailable, storing ${chunks.length} chunks text-only:`, (e as Error).message);
    }

    // 批量插入（单条 INSERT 带多个 VALUES 避免 ORM 开销）
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        const embedding = vectors[i]
          ? `[${vectors[i].join(",")}]`
          : null;
        await client.query(
          `INSERT INTO doc_chunks (id, doc_id, content, embedding, chunk_index, metadata)
           VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [
            chunkId,
            docId,
            chunks[i].content,
            embedding,
            i,
            JSON.stringify(chunks[i].metadata),
          ],
        );
      }

      // 更新文档的 chunk_count
      await client.query(
        `UPDATE documents SET chunk_count = chunk_count + $1 WHERE id = $2`,
        [chunks.length, docId],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  // ... 后续步骤添加其他方法
```

- [ ] **Step 3: 实现 deleteDoc + 文档 CRUD**

在 PgVectorStore 中追加：

```typescript
  async deleteDoc(docId: string): Promise<void> {
    // CASCADE 会自动删除关联的 doc_chunks
    await this.pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  }

  async getDocMeta(docId: string): Promise<DocMeta | null> {
    const { rows } = await this.pool.query(
      `SELECT filename, stored_filename, chunk_count, indexed_at,
              wiki_page_id, owner, project, tags, visibility, permissions, metadata
       FROM documents WHERE id = $1`,
      [docId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      filename: r.filename,
      storedFilename: r.stored_filename,
      chunkCount: r.chunk_count,
      indexedAt: r.indexed_at,
      wikiPageId: r.wiki_page_id,
      owner: r.owner,
      project: r.project,
      tags: r.tags,
      visibility: r.visibility,
      permissions: r.permissions,
      metadata: r.metadata,
    };
  }

  async listDocs(): Promise<RagDocument[]> {
    const { rows } = await this.pool.query(
      `SELECT id, filename, chunk_count, indexed_at
       FROM documents ORDER BY indexed_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      pages: 0,
      chunkCount: r.chunk_count,
      indexedAt: r.indexed_at,
    }));
  }

  async saveDocMeta(docId: string, meta: DocMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO documents (id, filename, stored_filename, chunk_count, owner, project, tags, visibility, permissions, metadata, indexed_at, wiki_page_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         filename = EXCLUDED.filename,
         stored_filename = EXCLUDED.stored_filename,
         chunk_count = EXCLUDED.chunk_count,
         owner = EXCLUDED.owner,
         project = EXCLUDED.project,
         tags = EXCLUDED.tags,
         visibility = EXCLUDED.visibility,
         permissions = EXCLUDED.permissions,
         metadata = EXCLUDED.metadata,
         wiki_page_id = EXCLUDED.wiki_page_id`,
      [
        docId,
        meta.filename,
        meta.storedFilename ?? null,
        meta.chunkCount,
        meta.owner ?? "admin",
        meta.project ?? "",
        meta.tags ?? [],
        meta.visibility ?? "private",
        JSON.stringify(meta.permissions ?? []),
        JSON.stringify(meta.metadata ?? {}),
        meta.indexedAt.toISOString(),
        meta.wikiPageId ?? null,
      ],
    );
  }

  async deleteDocMeta(docId: string): Promise<void> {
    await this.pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  }

  async getChunkCount(): Promise<number> {
    const { rows } = await this.pool.query("SELECT count(*)::int AS cnt FROM doc_chunks");
    return rows[0]?.cnt ?? 0;
  }

  async listDocIds(): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT id FROM documents");
    return rows.map((r) => r.id);
  }
```

- [ ] **Step 4: 验证**

```typescript
// 写一个快速测试：创建 store → addChunks → getChunkCount → deleteDoc
```

- [ ] **Step 5: Commit**

```bash
git add src/storage/types.ts src/storage/pg-vector-store.ts
git commit -m "feat(storage): PgVectorStore CRUD operations"
```

---

### Task 1.2: PgVectorStore — 混合检索 (pgvector + FTS + RRF)

**Files:**
- Modify: `src/storage/pg-vector-store.ts`

**Interfaces:**
- Produces: `PgVectorStore.search(query: string, k?: number): Promise<RagResult[]>`
- Consumes: `this.embeddings.embedQuery(query)` (L3 vector), `this.pool.query()` (L3 FTS)
- Uses: `rrfMerge()` 逻辑（内联实现，与旧版兼容）

- [ ] **Step 1: 实现 `search()` 方法**

在 `PgVectorStore` 中追加：

```typescript
  async search(query: string, k: number = 5): Promise<RagResult[]> {
    const vectorResults: RagResult[] = [];
    const ftsResults: RagResult[] = [];

    // 1. 向量检索
    try {
      const embedding = await this.embeddings.embedQuery(query);
      const { rows } = await this.pool.query(
        `SELECT id, content, doc_id, chunk_index,
                1 - (embedding <=> $1::vector) AS score
         FROM doc_chunks
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [`[${embedding.join(",")}]`, k * 2],
      );
      for (const r of rows) {
        vectorResults.push({
          content: r.content,
          score: r.score,
          source: "",
          docId: r.doc_id,
        });
      }
    } catch (e) {
      console.warn("[pgvector] Vector search failed:", (e as Error).message);
    }

    // 2. 中文 FTS 检索（替代 BM25）
    try {
      const { rows } = await this.pool.query(
        `SELECT id, content, doc_id, chunk_index,
                ts_rank(fts_vector, plainto_tsquery('chinese_zh', $1)) AS score
         FROM doc_chunks
         WHERE fts_vector @@ plainto_tsquery('chinese_zh', $1)
         ORDER BY score DESC
         LIMIT $2`,
        [query, k * 2],
      );
      for (const r of rows) {
        ftsResults.push({
          content: r.content,
          score: r.score,
          source: "",
          docId: r.doc_id,
        });
      }
    } catch (e) {
      console.warn("[pgvector] FTS search failed:", (e as Error).message);
    }

    // 3. RRF 融合
    return this.rrfMerge(vectorResults, ftsResults, k);
  }

  /**
   * Reciprocal Rank Fusion
   * 与旧版 RagVectorStore.rrfMerge 完全兼容
   */
  private rrfMerge(
    vectorResults: RagResult[],
    ftsResults: RagResult[],
    k: number,
  ): RagResult[] {
    const K = 60;
    const combined = new Map<string, { result: RagResult; score: number }>();

    for (let i = 0; i < vectorResults.length; i++) {
      combined.set(vectorResults[i].content, {
        result: vectorResults[i],
        score: 1 / (K + i + 1),
      });
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const key = ftsResults[i].content;
      if (combined.has(key)) {
        combined.get(key)!.score += 1 / (K + i + 1);
      } else {
        combined.set(key, {
          result: ftsResults[i],
          score: 1 / (K + i + 1),
        });
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((e) => e.result);
  }
```

- [ ] **Step 2: 验证搜索**

连接 PostgreSQL → addChunks → search → 确认结果包含 content + score + docId

- [ ] **Step 3: Commit**

```bash
git add src/storage/pg-vector-store.ts
git commit -m "feat(storage): hybrid search with pgvector + zhparser FTS + RRF"
```

---

### Task 1.3: 改造 retriever.ts + 入口文件

**Files:**
- Modify: `src/rag/retriever.ts`
- Modify: `src/index.ts`
- Modify: `src/server-entry.ts`

**Interfaces:**
- `RagSearchTool` 构造函数签名变化：`(store: PgVectorStore, llm?: ChatOpenAI)`（原为 `RagVectorStore`）
- `createRagServer()` 签名变化：`(store: PgVectorStore, ...)`（原为 `RagVectorStore`）

- [ ] **Step 1: 改造 `retriever.ts` — 只改类型引用**

```typescript
// 文件顶部
import { PgVectorStore } from "../storage/pg-vector-store.js";
// 删除: import { RagVectorStore } from "./vectorstore.js";

export class RagSearchTool extends StructuredTool {
  // 原来: private store: RagVectorStore;
  private store: PgVectorStore;

  // 原来: constructor(store: RagVectorStore, llm?: ChatOpenAI) {
  constructor(store: PgVectorStore, llm?: ChatOpenAI) {
    super();
    this.store = store;
    this.llm = llm;
  }

  // 其余代码完全不变（仍然调 store.search()）
}
```

- [ ] **Step 2: 改造 `src/index.ts`**

```typescript
// 替换导入
import { PgVectorStore } from "./storage/pg-vector-store.js";
import { getPool } from "./storage/pool.js";
// 删除: import { RagVectorStore } from "./rag/vectorstore.js";

// 在 main() 中替换初始化
const pool = await getPool(config);
const ragStore = new PgVectorStore(pool, embeddings);
// 原来: const ragStore = new RagVectorStore(embeddings, "rag_data");
// ragStore.loadFromDisk() 不再需要 — PostgreSQL 持久化由迁移框架处理
```

- [ ] **Step 3: 改造 `src/server-entry.ts`**

与 `src/index.ts` 同样的改动：用 `PgVectorStore` + `getPool()` 替换 `RagVectorStore`。

- [ ] **Step 4: 验证编译 + 功能**

```bash
npx tsc --noEmit
# 无类型错误
npm run server
# 启动后确认: "RAG server on http://localhost:3001"
# POST /api/upload 上传一个文档 → GET /api/documents 确认返回
# POST /api/query 搜索确认返回结果
```

- [ ] **Step 5: Commit**

```bash
git add src/rag/retriever.ts src/index.ts src/server-entry.ts
git commit -m "feat: switch from RagVectorStore to PgVectorStore"
```

---

## Phase 2: L2 关系层 (对话记忆)

### Task 2.1: 创建 PgSessionStore

**Files:**
- Create: `src/storage/pg-session-store.ts`

**Interfaces:**
- Produces: `PgSessionStore` class with interface 100% 兼容 `SqliteStore`:
  - `createSession(name?): Session`
  - `getSession(id): Session | null`
  - `listSessions(): Session[]`
  - `deleteSession(id): void`
  - `addMessage(sessionId, role, content): MemoryMessage`
  - `getMessages(sessionId, limit?): MemoryMessage[]`
  - `getRecentContext(sessionId, limit?): string`
  - `saveSummary(...): Summary`
  - `getSummaries(sessionId, limit?): Summary[]`
  - `deleteSummaries(sessionId): void`
  - `close(): void`

- [ ] **Step 1: 实现 `PgSessionStore`**

```typescript
// src/storage/pg-session-store.ts
import { Pool } from "pg";
import type { Session, MemoryMessage, Summary } from "../memory/types.js";

export class PgSessionStore {
  private pool: Pool;
  private embeddings?: OpenAIEmbeddings;

  constructor(pool: Pool, embeddings?: OpenAIEmbeddings) {
    this.pool = pool;
    this.embeddings = embeddings;
  }

  /** 注入 embedding 模型（也可以在构造时传入） */
  setEmbeddings(emb: OpenAIEmbeddings): void {
    this.embeddings = emb;
  }

  async createSession(name?: string): Promise<Session> {
    const id = crypto.randomUUID();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO sessions (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [id, name || "New Chat", now.toISOString()],
    );
    return { id, name: name || "New Chat", createdAt: now, updatedAt: now };
  }

  async getSession(id: string): Promise<Session | null> {
    const { rows } = await this.pool.query(
      `SELECT id, name, created_at, updated_at FROM sessions WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  async listSessions(): Promise<Session[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, created_at, updated_at FROM sessions ORDER BY updated_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  }

  async addMessage(sessionId: string, role: string, content: string): Promise<MemoryMessage> {
    const now = new Date();
    await this.pool.query(
      `INSERT INTO messages (session_id, role, content, created_at) VALUES ($1, $2, $3, $4)`,
      [sessionId, role, content, now.toISOString()],
    );
    await this.pool.query(
      `UPDATE sessions SET updated_at = $1 WHERE id = $2`,
      [now.toISOString(), sessionId],
    );
    return { role: role as MemoryMessage["role"], content, createdAt: now };
  }

  async getMessages(sessionId: string, limit?: number): Promise<MemoryMessage[]> {
    let sql = `SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC`;
    const params: any[] = [sessionId];
    if (limit !== undefined) {
      sql += ` LIMIT $2`;
      params.push(limit);
    }
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      role: r.role as MemoryMessage["role"],
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  async getRecentContext(sessionId: string, limit?: number): Promise<string> {
    const msgs = await this.getMessages(sessionId, limit);
    return msgs
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
  }

  async saveSummary(
    sessionId: string,
    content: string,
    msgStartId: number | null,
    msgEndId: number | null,
    originalChars: number,
  ): Promise<Summary> {
    const now = new Date();

    // 如果有 embedding 模型，自动计算摘要向量
    let embeddingVec: string | null = null;
    if (this.embeddings) {
      try {
        const vec = await this.embeddings.embedQuery(content);
        embeddingVec = `[${vec.join(",")}]`;
      } catch (e) {
        // embedding 失败不阻塞主流程
        console.warn("[pg-session-store] Summary embedding failed:", (e as Error).message);
      }
    }

    const { rows } = await this.pool.query(
      `INSERT INTO summaries (session_id, content, msg_start_id, msg_end_id, original_chars, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
       RETURNING id`,
      [sessionId, content, msgStartId, msgEndId, originalChars, embeddingVec, now.toISOString()],
    );
    return {
      id: rows[0].id,
      sessionId,
      content,
      msgStartId,
      msgEndId,
      originalTokens: originalChars,
      createdAt: now,
    };
  }

  async getSummaries(sessionId: string, limit?: number): Promise<Summary[]> {
    let sql = `SELECT id, session_id, content, msg_start_id, msg_end_id, original_chars, created_at
               FROM summaries WHERE session_id = $1 ORDER BY created_at ASC`;
    const params: any[] = [sessionId];
    if (limit !== undefined) { sql += ` LIMIT $2`; params.push(limit); }
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      content: r.content,
      msgStartId: r.msg_start_id,
      msgEndId: r.msg_end_id,
      originalTokens: r.original_chars,
      createdAt: r.created_at,
    }));
  }

  async deleteSummaries(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM summaries WHERE session_id = $1", [sessionId]);
  }

  async close(): Promise<void> {
    // 连接池由 getPool/closePool 统一管理，这里不做操作
  }
}
```

- [ ] **Step 2: 验证**

```typescript
// 创建 store → createSession → addMessage → getMessages → 确认返回正确
```

- [ ] **Step 3: Commit**

```bash
git add src/storage/pg-session-store.ts
git commit -m "feat(storage): PgSessionStore with full SqliteStore-compatible interface"
```

---

### Task 2.2: 升级 SummaryManager — 向量化摘要 + 语义检索

**Files:**
- Modify: `src/memory/summary-manager.ts`

**Interfaces:**
- `SummaryManager.findRelevant(sessionId, query, maxResults?)` — 从关键词匹配改为 pgvector 语义检索
- `SummaryManager.save(...)` — 自动对摘要内容做 embedding

- [ ] **Step 1: 在 SummaryManager 中注入 embedding 依赖**

```typescript
// src/memory/summary-manager.ts 改动
import type { OpenAIEmbeddings } from "@langchain/openai";

export class SummaryManager {
  // 新增字段
  private embeddings?: OpenAIEmbeddings;

  constructor(
    private store: PgSessionStore,  // 类型从 SqliteStore 改为 PgSessionStore
    private maxSummariesPerSession = 10,
    embeddings?: OpenAIEmbeddings,
  ) {
    this.store = store;
    this.maxSummariesPerSession = maxSummariesPerSession;
    this.embeddings = embeddings;
  }
```

- [ ] **Step 2: 升级 `findRelevant()` — 语义检索**

`PgSessionStore.saveSummary()` 已经自动计算并存储 embedding（Task 2.1 已实现）。现在改造 `SummaryManager.findRelevant()` 优先使用向量检索，降级到关键词匹配：

```typescript
  async findRelevant(
    sessionId: string,
    query: string,
    maxResults = 3,
  ): Promise<Summary[]> {
    // 如果有 embedding 模型，做向量检索
    if (this.embeddings) {
      try {
        const vec = await this.embeddings.embedQuery(query);
        const { rows } = await (this.store as any).pool.query(
          `SELECT id, session_id, content, msg_start_id, msg_end_id, original_chars, created_at
           FROM summaries
           WHERE session_id = $1 AND embedding IS NOT NULL
           ORDER BY embedding <=> $2::vector
           LIMIT $3`,
          [sessionId, `[${vec.join(",")}]`, maxResults],
        );
        if (rows.length > 0) {
          return rows.map((r: any) => ({
            id: r.id,
            sessionId: r.session_id,
            content: r.content,
            msgStartId: r.msg_start_id,
            msgEndId: r.msg_end_id,
            originalTokens: r.original_chars,
            createdAt: r.created_at,
          }));
        }
      } catch (e) {
        console.warn("[summary] Vector search failed, falling back to keyword:", (e as Error).message);
      }
    }

    // 降级：原有关键词匹配逻辑
    return this.keywordFindRelevant(sessionId, query, maxResults);
  }

  private keywordFindRelevant(
    sessionId: string,
    query: string,
    maxResults = 3,
  ): Summary[] {
    const summaries = this.store.getSummaries(sessionId);
    if (summaries.length === 0 || !query) return [];
    const keywords = query.toLowerCase().split(/[\s,，。；;：:！!？?]+/).filter((k) => k.length > 1);
    if (keywords.length === 0) return [];
    const scored = summaries
      .map((s) => {
        const lower = s.content.toLowerCase();
        const matches = keywords.filter((k) => lower.includes(k));
        return { summary: s, score: matches.length / keywords.length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    return scored.map((s) => s.summary);
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/memory/summary-manager.ts src/storage/pg-session-store.ts
git commit -m "feat(memory): vectorized summary storage and semantic retrieval"
```

---

### Task 2.3: 改造 AgentMemory — 从 SqliteStore 切换到 PgSessionStore

**Files:**
- Modify: `src/memory/index.ts`
- Modify: `src/index.ts`（memory 初始化参数变化）
- Modify: `src/server-entry.ts`（同上）

- [ ] **Step 1: 改造 `AgentMemory.create()`**

```typescript
// src/memory/index.ts

import { PgSessionStore } from "../storage/pg-session-store.js";
// 删除: import { SqliteStore } from "./sqlite-store.js";
// 删除: import { VectorMemory } from "./vector-memory.js";

export class AgentMemory {
  // 原来: public store: SqliteStore;
  // 原来: public vector: VectorMemory;
  public store: PgSessionStore;
  // VectorMemory 移除 — 摘要向量化已整合进 summaries.embedding

  // 构造器签名微调：去掉 vector 参数
  private constructor(
    store: PgSessionStore,
    context: ContextManager,
    summary: SummaryManager,
    sessionId: string,
  ) {
    this.store = store;
    this.context = context;
    this.summary = summary;
    this.activeSessionId = sessionId;
  }

  static async create(
    // 原来: dbPath: string
    // 改为接收 pool 或 dbUrl
    poolOrUrl: Pool | string,
    embedding: OpenAIEmbeddings,
    sessionId?: string,
    config?: MemoryConfig,
    llm?: ChatOpenAI,
  ): Promise<AgentMemory> {
    const pool = typeof poolOrUrl === "string"
      ? new Pool({ connectionString: poolOrUrl })
      : poolOrUrl;

    const store = new PgSessionStore(pool);
    // 注入 embedding 到 store 用于摘要向量化
    store.setEmbeddings(embedding);

    const context = new ContextManager(
      config?.maxContextTokens,
      config?.responseReserve,
    );
    const summary = new SummaryManager(store, 10, embedding);

    let sid = sessionId;
    if (!sid) {
      const sessions = await store.listSessions();
      sid = sessions.length > 0 ? sessions[0].id : (await store.createSession()).id;
    } else if (!(await store.getSession(sid))) {
      await store.createSession("New Chat");
    }

    const mem = new AgentMemory(store, context, summary, sid);
    mem.llm = llm;
    return mem;
  }

  // searchRelated 方法移除 — 摘要检索通过 SummaryManager.findRelevant 完成
  // summarizeAndStore 方法移除 — 由 saveSummary 自动处理

  // close() 不再需要 save() — pg 连接池由外部管理
  close(): void {
    // PgSessionStore.close() 是空操作
  }
}
```

- [ ] **Step 2: 改造入口文件**

```typescript
// src/index.ts
// 原来:
// const memory = await AgentMemory.create("navigate.db", embeddings, undefined, undefined, llm);

// 改为:
const memory = await AgentMemory.create(pool, embeddings, undefined, undefined, llm);
```

`src/server-entry.ts` 同理。

- [ ] **Step 3: 验证编译 + 启动**

```bash
npx tsc --noEmit
npm run dev
# 确认: TUI 启动成功，对话可以正常发送和接收
```

- [ ] **Step 4: Commit**

```bash
git add src/memory/index.ts src/index.ts src/server-entry.ts
git commit -m "feat(memory): switch from SqliteStore to PgSessionStore"
```

---

## Phase 3: L1 热缓存

### Task 3.1: 实现 HotCache (LRU)

**Files:**
- Create: `src/storage/cache.ts`
- Modify: `src/storage/pg-vector-store.ts`（注入缓存）
- Modify: `src/storage/pg-session-store.ts`（注入缓存）

- [ ] **Step 1: 实现 `HotCache`**

```typescript
// src/storage/cache.ts

export interface CacheConfig {
  maxChunks: number;      // 默认 5000
  maxSessions: number;    // 默认 50
  ttlMs: number;          // 默认 30 分钟
}

interface CacheEntry<T> {
  value: T;
  lastAccess: number;
}

export class HotCache {
  private chunks = new Map<string, CacheEntry<any>>();
  private sessions = new Map<string, CacheEntry<any>>();
  private config: CacheConfig;

  constructor(config?: Partial<CacheConfig>) {
    this.config = {
      maxChunks: 5000,
      maxSessions: 50,
      ttlMs: 30 * 60 * 1000,
      ...config,
    };
  }

  getChunk(id: string): any | null {
    return this.get(this.chunks, id);
  }

  setChunk(id: string, value: any): void {
    this.set(this.chunks, id, value, this.config.maxChunks);
  }

  getSession(id: string): any | null {
    return this.get(this.sessions, id);
  }

  setSession(id: string, value: any): void {
    this.set(this.sessions, id, value, this.config.maxSessions);
  }

  invalidateDoc(docId: string): void {
    // 清除文档元数据缓存
    this.chunks.delete(`doc:${docId}`);
    // 清除该文档的所有 chunk 内容缓存（如果后续扩展了 chunk 缓存）
  }

  invalidateSession(id: string): void {
    this.sessions.delete(id);
  }

  clear(): void {
    this.chunks.clear();
    this.sessions.clear();
  }

  get stats(): { chunks: number; sessions: number } {
    return {
      chunks: this.chunks.size,
      sessions: this.sessions.size,
    };
  }

  private get<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.lastAccess > this.config.ttlMs) {
      map.delete(key);
      return null;
    }
    entry.lastAccess = Date.now();
    return entry.value;
  }

  private set<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, max: number): void {
    if (map.size >= max) {
      // LRU: 淘汰最久未访问的
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of map) {
        if (v.lastAccess < oldestTime) {
          oldestTime = v.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) map.delete(oldestKey);
    }
    map.set(key, { value, lastAccess: Date.now() });
  }
}
```

- [ ] **Step 2: 在 PgVectorStore 中注入 HotCache**

```typescript
// src/storage/pg-vector-store.ts
import { HotCache } from "./cache.js";

export class PgVectorStore {
  private cache: HotCache;

  constructor(pool: Pool, embeddings: OpenAIEmbeddings, cache?: HotCache) {
    this.cache = cache ?? new HotCache({ maxChunks: 5000 });
    // ...
  }

  // 缓存策略：按实体 ID 缓存，不缓存动态搜索结果
  // - getDocMeta(id) → 缓存文档元数据（小对象，高命中率）
  // - listDocs() → 结果短暂缓存（~5s TTL）
  // - search() 不走缓存（pgvector 检索本身已经很快）

  async getDocMeta(docId: string): Promise<DocMeta | null> {
    // 尝试缓存命中
    const cached = this.cache.getDocMeta(docId);
    if (cached) return cached as DocMeta;

    // PG 查询
    const meta = await this._queryDocMeta(docId);
    if (meta) this.cache.setDocMeta(docId, meta);
    return meta;
  }

  async deleteDoc(docId: string): Promise<void> {
    this.cache.invalidateDoc(docId);
    await this.pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  }
}
```

注意：HotCache 目前没有 `getDocMeta`/`setDocMeta` 方法，需要在 cache.ts 中追加：

```typescript
// src/storage/cache.ts HotCache 类追加

getDocMeta(id: string): DocMeta | null {
  const key = `doc:${id}`;
  const entry = this.chunks.get(key); // 复用 chunks Map 但 key 加前缀
  if (!entry) return null;
  if (Date.now() - entry.lastAccess > this.config.ttlMs) {
    this.chunks.delete(key);
    return null;
  }
  entry.lastAccess = Date.now();
  return entry.value;
}

setDocMeta(id: string, meta: DocMeta): void {
  const key = `doc:${id}`;
  if (this.chunks.size >= this.config.maxChunks) {
    this.evictLRU(this.chunks);
  }
  this.chunks.set(key, { value: meta, lastAccess: Date.now() });
}

private evictLRU(map: Map<string, CacheEntry<any>>): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [k, v] of map) {
    if (v.lastAccess < oldestTime) {
      oldestTime = v.lastAccess;
      oldestKey = k;
    }
  }
  if (oldestKey) map.delete(oldestKey);
}
```

- [ ] **Step 3: 在 PgSessionStore 中注入 HotCache**

```typescript
// src/storage/pg-session-store.ts

export class PgSessionStore {
  private cache: HotCache;

  constructor(pool: Pool, cache?: HotCache) {
    this.cache = cache ?? new HotCache({ maxSessions: 50 });
    // ...
  }

  async getSession(id: string): Promise<Session | null> {
    const cached = this.cache.getSession(id);
    if (cached) return cached as Session;
    const session = await this._querySession(id);
    if (session) this.cache.setSession(id, session);
    return session;
  }

  async addMessage(...): Promise<MemoryMessage> {
    // 会话有变更 → 使 session 缓存失效
    this.cache.invalidateSession(sessionId);
    // ... 原有逻辑
  }
}
```

- [ ] **Step 4: 验证**

启动应用，执行几次查询，确认缓存的 stats 正确增长。

- [ ] **Step 5: Commit**

```bash
git add src/storage/cache.ts src/storage/pg-vector-store.ts src/storage/pg-session-store.ts
git commit -m "feat(storage): L1 HotCache with LRU eviction"
```

---

## Phase 4: 数据迁移与清理

### Task 4.1: 从旧 navigate.db 导入数据

**Files:**
- Create: `scripts/import-from-sqlite.ts`

- [ ] **Step 1: 创建导入脚本**

```typescript
// scripts/import-from-sqlite.ts
// 读取 navigate.db (sql.js) 中的 sessions/messages/summaries，
// 批量插入 PostgreSQL

import { Pool } from "pg";
import initSqlJs from "sql.js";
import { readFileSync, existsSync } from "node:fs";

async function migrate() {
  // 1. 检查 navigate.db 是否存在
  if (!existsSync("navigate.db")) {
    console.log("No navigate.db found, skipping import");
    return;
  }

  // 2. 读取 sqlite
  const SQL = await initSqlJs();
  const buf = readFileSync("navigate.db");
  const sqldb = new SQL.Database(buf);

  // 3. 连接 PostgreSQL
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  await pg.query("BEGIN");

  try {
    // 4. 迁移 sessions
    const sessions = sqldb.exec("SELECT * FROM sessions");
    for (const s of sessions[0]?.values ?? []) {
      await pg.query(
        `INSERT INTO sessions (id, name, created_at, updated_at)
         VALUES ($1, $2, to_timestamp($3/1000), to_timestamp($4/1000))
         ON CONFLICT (id) DO NOTHING`,
        [s[0], s[1], Math.floor((s[2] as number) / 1000), Math.floor((s[3] as number) / 1000)],
      );
    }

    // 5. 迁移 messages
    const messages = sqldb.exec("SELECT * FROM messages ORDER BY id ASC");
    for (const m of messages[0]?.values ?? []) {
      await pg.query(
        `INSERT INTO messages (session_id, role, content, created_at)
         VALUES ($1, $2, $3, to_timestamp($4/1000))`,
        [m[1], m[2], m[3], Math.floor((m[4] as number) / 1000)],
      );
    }

    // 6. 迁移 summaries
    const summaries = sqldb.exec("SELECT * FROM summaries ORDER BY id ASC");
    for (const s of summaries[0]?.values ?? []) {
      await pg.query(
        `INSERT INTO summaries (session_id, content, msg_start_id, msg_end_id, original_chars, created_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6/1000))`,
        [s[1], s[2], s[3], s[4], s[5] ?? 0, Math.floor((s[6] as number) / 1000)],
      );
    }

    await pg.query("COMMIT");
    console.log("Import completed successfully");
  } catch (e) {
    await pg.query("ROLLBACK");
    throw e;
  } finally {
    await pg.end();
    sqldb.close();
  }
}

migrate().catch(console.error);
```

- [ ] **Step 2: 从旧 vectorstore.json 导入文档**

```typescript
// 同样在 scripts/import-from-sqlite.ts 中追加逻辑
// 读取 rag_data/vectorstore.json → 重建 documents + doc_chunks + 重新 embedding
// 读取 rag_data/docmeta.json → documents 元数据
```

- [ ] **Step 3: 运行导入**

```bash
npx tsx scripts/import-from-sqlite.ts
```

- [ ] **Step 4: Commit**

```bash
git add scripts/import-from-sqlite.ts
git commit -m "feat: data migration script from sqlite to postgresql"
```

---

### Task 4.2: 删除旧文件 + 旧依赖

**Files:**
- Delete: `src/rag/vectorstore.ts`
- Delete: `src/memory/sqlite-store.ts`
- Delete: `src/memory/vector-memory.ts`
- Delete: `rag_data/vectorstore.json`
- Delete: `rag_data/docmeta.json`
- Modify: `package.json`（移除 `sql.js`, `@types/sql.js`）

- [ ] **Step 1: 删除旧源文件**

```bash
git rm src/rag/vectorstore.ts
git rm src/memory/sqlite-store.ts
git rm src/memory/vector-memory.ts
```

- [ ] **Step 2: 删除旧数据文件**

```bash
# 确认 PG 数据已导入后再删除
rm -f rag_data/vectorstore.json
rm -f rag_data/docmeta.json
# navigate.db 保留作为备份，可以后续手动删除
```

- [ ] **Step 3: 移除 sql.js 依赖**

```bash
npm uninstall sql.js
npm uninstall @types/sql.js
```

- [ ] **Step 4: 验证编译**

```bash
npm install
npx tsc --noEmit
# 确认无遗漏引用
```

- [ ] **Step 5: 端到端测试**

```bash
npm run dev
# 测试全流程：启动 → 上传文档 → 搜索 → 对话 → 退出
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git rm src/rag/vectorstore.ts src/memory/sqlite-store.ts src/memory/vector-memory.ts
git commit -m "chore: remove legacy sqlite and memory-vector-store files"
```

---

### Task 4.3: 更新 package.json scripts（可选）

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 添加便捷脚本**

```json
{
  "scripts": {
    "db:up": "docker-compose up -d",
    "db:down": "docker-compose down",
    "db:import": "tsx scripts/import-from-sqlite.ts",
    "db:reset": "docker-compose down -v && docker-compose up -d"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add database management scripts"
```
