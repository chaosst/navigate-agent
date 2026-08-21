# RAG 三层存储架构重构设计

> 日期: 2026-07-29
> 状态: Draft
> 涉及模块: `src/rag/`, `src/memory/`, `src/storage/`, `src/server/`, `src/config/`, `src/index.ts`, `src/server-entry.ts`

## 1. 概述

将原有 RAG 存储从 `MemoryVectorStore` + BM25 + sql.js 的架构重构为 **三层存储架构**：

| 层级 | 存储 | 容量限制 | 职责 |
|------|------|---------|------|
| **L1: Hot Cache** | Node.js 内存 (LRU) | `maxChunks: 5000`, `maxSessions: 50` | 毫秒级响应的热数据缓存 |
| **L2: Relational** | PostgreSQL | 全量 | 元数据、关系查询、权限过滤、复杂筛选 |
| **L3: Vector** | pgvector | 全量 | 语义召回 + 中文全文检索 (FTS) |

## 2. 环境与依赖

### 新增依赖

```json
{
  "dependencies": {
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  }
}
```

### 移除依赖

- `sql.js` / `@types/sql.js` — 不再需要

### Docker 环境

`docker-compose.yml` 使用预装 zhparser 的 pgvector 镜像：

```yaml
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
volumes:
  pgdata:
```

`Dockerfile.pg`:

```dockerfile
FROM pgvector/pgvector:pg16
RUN apt-get update && apt-get install -y \
    postgresql-16-zhparser \
    && rm -rf /var/lib/apt/lists/*
```

### 环境变量

```env
# .env 新增
DATABASE_URL=postgresql://navigate:navigate@localhost:5432/navigate
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10

# OPENAI_API_KEY 等既有配置保持不变
```

## 3. 数据库 Schema

### 迁移 001: 文档与向量存储

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS zhparser;

CREATE TEXT SEARCH CONFIGURATION chinese_zh (PARSER = zhparser);
ALTER TEXT SEARCH CONFIGURATION chinese_zh
  ADD MAPPING FOR n, v, a, i, e, l WITH simple;

-- 文档表（替代 docmeta.json）
CREATE TABLE documents (
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

-- 文档块表（替代 MemoryVectorStore + BM25）
CREATE TABLE doc_chunks (
  id          UUID PRIMARY KEY,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  chunk_index INTEGER NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  fts_vector  tsvector
      GENERATED ALWAYS AS (to_tsvector('chinese_zh', content)) STORED
);

CREATE INDEX idx_chunks_doc_id ON doc_chunks(doc_id);
CREATE INDEX idx_chunks_embedding ON doc_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
CREATE INDEX idx_chunks_fts ON doc_chunks USING GIN (fts_vector);
```

### 迁移 002: 会话与对话记忆

```sql
-- 会话表（替代 SqliteStore.sessions）
CREATE TABLE sessions (
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

-- 消息表（替代 SqliteStore.messages）
CREATE TABLE messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);

-- 摘要表（替代 SqliteStore.summaries + VectorMemory）
CREATE TABLE summaries (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  msg_start_id    BIGINT,
  msg_end_id      BIGINT,
  original_chars  INTEGER DEFAULT 0,
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_summaries_session ON summaries(session_id, created_at);
CREATE INDEX idx_summaries_embedding ON summaries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);
```

## 4. 新文件结构

```
src/
  storage/
    pool.ts                 # pg.Pool 连接池封装
    migrate.ts              # 轻量级迁移执行器（按顺序执行 SQL 文件）
    pg-vector-store.ts      # PgVectorStore — L2+L3 RAG 存储
    pg-session-store.ts     # PgSessionStore — L2 对话记忆存储
    cache.ts                # L1 HotCache — LRU 热数据缓存
    types.ts                # 存储层共享类型

  rag/
    vectorstore.ts          # ← 删除（被 pg-vector-store.ts 替代）
    retriever.ts            # ← 改造：引用 PgVectorStore
    types.ts                # 保留（RagResult 等接口）
    loader.ts               # ✅ 不变
    reranker.ts             # ✅ 不变

  memory/
    sqlite-store.ts         # ← 删除（被 pg-session-store.ts 替代）
    vector-memory.ts        # ← 删除（摘要向量并入 summaries.embedding）
    index.ts                # ← 改造：store 类型改为 PgSessionStore
    summary-manager.ts      # ← 升级：findRelevant 向量搜索，save 自动 embed
    context-manager.ts      # ✅ 不变
    types.ts                # ✅ 不变（接口保持兼容）

  config/
    index.ts                # ← 微调：加载 DATABASE_URL

  index.ts                 # ← 改造：PgVectorStore + PgSessionStore 替代旧实现
  server-entry.ts          # ← 改造：同上

# 新增脚本
scripts/
  import-from-sqlite.ts     # 从 navigate.db 导入数据到 PostgreSQL
  init-pg.sql               # Docker entrypoint 初始化 SQL

# 新增配置
docker-compose.yml
Dockerfile.pg
```

## 5. 核心实现设计

### 5.1 连接池 (`src/storage/pool.ts`)

```typescript
import { Pool } from "pg";
import { migrate } from "./migrate.js";

let pool: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    pool = new Pool({
      connectionString: url,
      min: parseInt(process.env.DATABASE_POOL_MIN ?? "2", 10),
      max: parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10),
    });
    await migrate(pool);
  }
  return pool;
}
```

### 5.2 迁移执行器 (`src/storage/migrate.ts`)

按文件名顺序执行 `src/storage/migrations/` 下的 `.sql` 文件，用内存集合跟踪已执行 ID（无需 migration 表）。

```
src/storage/migrations/
  001_create_documents_and_chunks.sql
  002_create_sessions_and_messages.sql
```

### 5.3 PgVectorStore (`src/storage/pg-vector-store.ts`)

核心方法：

- **`addChunks(chunks, docId)`** — 插入文档行 + 批量插入 chunk 行（含 embedding 和 fts_vector）
- **`deleteDoc(docId)`** — `DELETE FROM doc_chunks WHERE doc_id = $1; DELETE FROM documents WHERE id = $1;`
- **`search(query, k?)`** — 混合检索：
  1. 向量检索：`SELECT ... ORDER BY embedding <=> $embedding LIMIT $k*2`
  2. FTS 检索：`SELECT ... WHERE fts_vector @@ plainto_tsquery('chinese_zh', $query) ORDER BY ts_rank DESC LIMIT $k*2`
  3. RRF 融合（复用现有 `rrfMerge()` 逻辑）
- **`listDocs()`** — `SELECT * FROM documents ORDER BY indexed_at DESC;`
- **`getDocMeta(docId)`** / **`saveDocMeta(meta)`** / **`deleteDocMeta(docId)`** — 文档元数据 CRUD

**接口保持与原 `RagVectorStore` 兼容**，`RagSearchTool` 只需要改构造函数参数类型。

### 5.4 PgSessionStore (`src/storage/pg-session-store.ts`)

**接口与 `SqliteStore` 完全兼容**，确保 `AgentMemory` 内部替换无侵入：

- `createSession(name?)`, `getSession(id)`, `listSessions()`, `deleteSession(id)`
- `addMessage(sessionId, role, content)`, `getMessages(sessionId, limit?)`, `getRecentContext(sessionId, limit?)`
- `saveSummary(...)`, `getSummaries(...)`, `deleteSummaries(...)`

### 5.5 HotCache (`src/storage/cache.ts`)

LRU 缓存，典型配置 `maxChunks: 5000`（~25MB），`maxSessions: 50`。

**cache-aside 模式：**

```
search(query):
  1. L3: pgvector + FTS → candidate chunk IDs
  2. L1: for each candidate ID → cache.getChunk(id)
  3. L2: cache miss IDs → SELECT content, metadata FROM doc_chunks WHERE id = ANY($missedIds)
  4. L1: cache.setChunk() — 回填新捞取的 chunk
  5. 组装结果返回

getSession(id):
  1. L1: cache.getSession(id) → hit → return
  2. L2: SELECT * FROM sessions WHERE id = $1 → cache.setSession() → return
```

**失效策略：**
- `invalidateDoc(docId)` — 文档重建/删除时调用
- `invalidateSession(sessionId)` — 新消息写入时调用（缓存内 session 数据变 stale）

### 5.6 SummaryManager 升级

- `save()` — 写入摘要时自动对 `content` 做 embedding → 存入 `summaries.embedding`
- `findRelevant()` — 对 `query` 做 embedding → `SELECT ... ORDER BY embedding <=> $query LIMIT $k`（替代当前 `.includes()` 关键词匹配）

### 5.7 AgentMemory 改造

```typescript
// 签名从:
//   static async create(dbPath: string, embedding, sessionId?, config?, llm?)
// 变为:
//   static async create(dbUrl: string, embedding, sessionId?, config?, llm?)
//
// 内部 store 从 SqliteStore 切换为 PgSessionStore
```

### 5.8 入口文件改造

`src/index.ts` 和 `src/server-entry.ts`：

```typescript
// 原来:
// const ragStore = new RagVectorStore(embeddings, "rag_data");
// const memory = await AgentMemory.create("navigate.db", ...);

// 变为:
const pool = await getPool();
const ragStore = new PgVectorStore(pool, embeddings);
const memory = await AgentMemory.create(process.env.DATABASE_URL!, ...);
```

## 6. 分阶段实施计划

### Phase 0 — 基础设施
- `docker-compose.yml` + `Dockerfile.pg`
- `scripts/init-pg.sql`
- `src/storage/pool.ts` + `src/storage/migrate.ts`
- `src/storage/migrations/001_create_documents_and_chunks.sql`
- `.env` 新增 `DATABASE_URL`
- `package.json` 新增 `pg`、移除 `sql.js`

### Phase 1 — L3 向量层
- `src/storage/pg-vector-store.ts` 实现
- `src/storage/types.ts` 共享类型
- 改造 `src/rag/retriever.ts` 引用 PgVectorStore
- 删除 `src/rag/vectorstore.ts`
- 验证：search 返回正确结果

### Phase 2 — L2 关系层（对话记忆）
- `src/storage/migrations/002_create_sessions_and_messages.sql`
- `src/storage/pg-session-store.ts` 实现
- `src/memory/index.ts` 改造
- `src/memory/summary-manager.ts` 升级（向量化摘要 + 语义检索）
- 删除 `src/memory/sqlite-store.ts`、`src/memory/vector-memory.ts`

### Phase 3 — L1 热缓存
- `src/storage/cache.ts` HotCache 实现
- 在 PgVectorStore 和 PgSessionStore 中注入缓存层

### Phase 4 — 数据迁移与清理
- `scripts/import-from-sqlite.ts` — 从旧 `navigate.db` 导入数据
- 删除 `rag_data/vectorstore.json`、`rag_data/docmeta.json`
- 端到端集成测试

## 7. 数据流对比

### 当前数据流

```
User Query → LangChain Agent → RagSearchTool
  → RagVectorStore.search()
    → MemoryVectorStore.similaritySearchWithScore()  (内存)
    → BM25.tokenize() → linear scan                    (内存)
    → RRF merge
  → LLM rerank (optional)
  → return
```

### 新数据流

```
User Query → LangChain Agent → RagSearchTool
  → PgVectorStore.search()
    → HotCache.getChunk()       (L1, 可能 miss)
    → PostgreSQL:
        - SELECT ORDER BY embedding <=>              (L3, pgvector HNSW)
        - SELECT WHERE fts_vector @@ plainto_tsquery (L3, zhparser + GIN)
    → RRF merge in application layer
    → HotCache.setChunk()       (L1, 回填热数据)
  → LLM rerank (optional)
  → return
```

## 8. 错误处理策略

- **PostgreSQL 不可用** → `getPool()` 在启动时失败，进程退出（开发环境强制 PostgreSQL）
- **Embedding API 失败** → 回退为纯 FTS 检索（降级，不阻塞）
- **单条查询超时** → pg Pool `query_timeout` 配置（默认 30s）
- **连接池耗尽** → 抛出明确的 `ConnectionError`，不静默吞掉
- **L1 缓存满** → LRU 自动淘汰最久未访问条目

## 9. 权限查询模式示例

```sql
-- 按用户隔离文档
SELECT * FROM documents WHERE owner = $userId;

-- 按项目 + 可见性筛选
SELECT * FROM documents
WHERE project = $projectId
  AND (owner = $userId
       OR visibility = 'team'
       OR permissions @> '[{"user": "' || $userId || '", "role": "reader"}]');

-- 标签筛选（OR 逻辑）
SELECT * FROM documents WHERE tags && $tags;
```
