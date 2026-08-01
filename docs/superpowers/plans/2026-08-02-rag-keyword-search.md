# RAG 纯关键词子串检索实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 RAG 增加独立的纯关键词子串检索(ILIKE '%q%'),补齐 H5 keyword 标签的 `/api/query/fts` 端点,并让 agent 的 `search_documents` 支持 `mode="keyword"`。

**Architecture:** 在 `PgVectorStore` 新增 `searchKeyword()`(位置优先+次数排序,不经过 RRF);新增 `POST /api/query/fts` 端点;`RagSearchTool` 增加 `mode` 参数路由;同时修复 `/api/query` 的 `topK` 参数名不一致与 `threshold` 被忽略两个 bug。前端 keyword 标签直连新端点,去掉对 hybrid 的静默回退。

**Tech Stack:** TypeScript / Express 5 / pg / zod / PostgreSQL 17(pgvector + zhparser + pg_trgm)。

## Global Constraints

- Node >= 18;TypeScript 严格模式,`npx tsc --noEmit` 必须通过。
- PostgreSQL 17(docker 镜像 `liuwenbo/pg_vector_fts:pg17`),`navigate/navigate@localhost:5432/navigate`。验证前先 `docker compose up -d postgres`。
- 迁移执行器(`src/storage/migrate.ts`)每次启动重跑所有 `.sql`(内存 Set 去重),**所有 SQL 必须幂等**(`IF NOT EXISTS`)。
- `RagResult = { content: string; score: number; source: string; docId: string; chunkIndex?: number }`(`src/rag/types.ts:15`)。
- 前端请求体用 `topK`(不是 `k`);`/api/query` 与 `/api/query/fts` 响应结构一致:`{ results: RagResult[] }`。
- 无测试框架:验证用 `npx tsc --noEmit` + curl + `npx tsx` 直连脚本。
- 端口 3001 必须先空闲(残留实例会导致 EADDRINUSE,启动会失败)。用 `netstat -ano | grep ":3001" | grep LISTEN` 检查,发现占用则 `taskkill //PID <pid> //F`。
- 每个任务结束提交一次,commit message 以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。

## File Structure

| 文件 | 变更 | 职责 |
|------|------|------|
| `src/storage/migrations/003_keyword_trgm_index.sql` | 新增 | content 上建 `gin_trgm_ops` GIN 索引,加速 `ILIKE '%q%'` |
| `src/storage/pg-vector-store.ts` | 修改 | 新增 `searchKeyword()` 方法 |
| `src/server/index.ts` | 修改 | 新增 `/api/query/fts`;修 `/api/query`(topK + threshold) |
| `src/rag/retriever.ts` | 修改 | `search_documents` 加 `mode` 参数 |
| `src/server/public/index.html` | 修改 | keyword 标签端点简化为 `["/api/query/fts"]` |

---

### Task 1: 迁移 003 —— trgm GIN 索引

**Files:**
- Create: `src/storage/migrations/003_keyword_trgm_index.sql`

**Interfaces:**
- Consumes: 无
- Produces: `doc_chunks.content` 上的 trigram GIN 索引(`idx_chunks_content_trgm`),供 Task 2 的 `ILIKE '%q%'` 走索引

- [ ] **Step 1: 创建迁移文件**

创建 `src/storage/migrations/003_keyword_trgm_index.sql`:

```sql
-- 003: 关键词子串检索加速索引（ILIKE '%q%'）
-- pg_trgm 扩展已在 001 启用;索引对 >=3 字符的 ILIKE 模式生效

CREATE INDEX IF NOT EXISTS idx_chunks_content_trgm
  ON doc_chunks USING GIN (content gin_trgm_ops);
```

- [ ] **Step 2: 验证索引生效**

确保 Postgres 运行(`docker compose up -d postgres`),然后:

```bash
docker exec navigate-postgres-1 psql -U navigate -d navigate -c \
  "SELECT indexname FROM pg_indexes WHERE tablename='doc_chunks';"
```

Expected: 输出包含 `idx_chunks_content_trgm`(迁移在服务启动时自动执行;若索引不存在,先跑一次 `npm run server` 再查)。

- [ ] **Step 3: 提交**

```bash
git add src/storage/migrations/003_keyword_trgm_index.sql
git commit -m "feat: add trgm GIN index migration for keyword search

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `PgVectorStore.searchKeyword()` 方法

**Files:**
- Modify: `src/storage/pg-vector-store.ts` — 在 `search()` 方法结束(约 298 行 `}`)之后、`rrfMerge` 的 doc 注释(约 300 行)之前插入新方法
- Test: `scripts/verify-keyword.ts`(临时文件,验证后删除)

**Interfaces:**
- Consumes: `Pool`(构造器 `this.pool`)、`RagResult` 类型
- Produces: `searchKeyword(query: string, k?: number): Promise<RagResult[]>` — Task 3 端点与 Task 4 工具调用

- [ ] **Step 1: 写实现**

插入以下方法:

```ts
  /**
   * 纯关键词子串检索（ILIKE '%q%'）。
   * 与 search() 的混合检索相互独立：无 embedding、无 FTS、无 RRF。
   * 排序：位置优先 → 出现次数次之。
   */
  async searchKeyword(query: string, k: number = 5): Promise<RagResult[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    try {
      const { rows } = await this.pool.query(
        `SELECT c.id, c.content, c.doc_id, c.chunk_index, d.filename,
                strpos(LOWER(c.content), LOWER($1)) AS pos,
                1.0 / strpos(LOWER(c.content), LOWER($1)) AS score,
                (length(c.content) - length(replace(lower(c.content), lower($1), '')))
                   / NULLIF(length($1), 0) AS cnt
         FROM doc_chunks c
         JOIN documents d ON d.id = c.doc_id
         WHERE c.content ILIKE '%' || $1 || '%'
         ORDER BY pos ASC, cnt DESC
         LIMIT $2`,
        [q, k],
      );
      return rows.map((r) => ({
        content: r.content,
        score: Number(r.score),
        source: r.filename || "",
        docId: r.doc_id,
        chunkIndex: r.chunk_index,
      }));
    } catch (e) {
      console.warn("[pgvector] Keyword search failed:", (e as Error).message);
      return [];
    }
  }
```

- [ ] **Step 2: 写验证脚本**

创建 `scripts/verify-keyword.ts`:

```ts
import { getPool } from "../src/storage/pool.js";
import { loadConfig } from "../src/config/index.js";
import { PgVectorStore } from "../src/storage/pg-vector-store.js";

(async () => {
  const config = loadConfig();
  const pool = await getPool(config);
  const store = new PgVectorStore(pool, {} as any);
  try {
    const hit = await store.searchKeyword("测试", 5);
    console.log("HIT count:", hit.length, "| first content:", hit[0]?.content?.slice(0, 30));
    if (hit.length === 0) throw new Error("HIT 应返回匹配 chunk");
    if (hit[0]?.chunkIndex === undefined) throw new Error("结果应含 chunkIndex");

    const miss = await store.searchKeyword("zzzzqqqqnoexist123", 5);
    console.log("MISS count:", miss.length);
    if (miss.length !== 0) throw new Error("无命中应返回空数组");

    const short = await store.searchKeyword("测", 5);
    console.log("SHORT guard count:", short.length);
    if (short.length !== 0) throw new Error("长度<2 应返回空数组");

    console.log("✓ searchKeyword 验证通过");
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error("验证失败:", e);
  process.exit(1);
});
```

- [ ] **Step 3: 运行脚本,验证通过**

```bash
docker compose up -d postgres
npx tsx scripts/verify-keyword.ts
```

Expected: `HIT count: >=1`、`MISS count: 0`、`SHORT guard count: 0`、`✓ searchKeyword 验证通过`。

- [ ] **Step 4: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 退出码 0,无输出。

- [ ] **Step 5: 删除临时脚本并提交**

```bash
rm scripts/verify-keyword.ts
git add src/storage/pg-vector-store.ts
git commit -m "feat: add PgVectorStore.searchKeyword substring search

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `/api/query/fts` 端点 + 修复 `/api/query`

**Files:**
- Modify: `src/server/index.ts` — 替换 `/api/query` 处理器(约 297-306 行),在它后面新增 `/api/query/fts`

**Interfaces:**
- Consumes: `store.search()`(hybrid)、`store.searchKeyword()`(Task 2)、`requireToken`(已存在)
- Produces: `POST /api/query/fts`,body `{ query, topK }`,响应 `{ results: RagResult[] }`;Task 5 前端调用

- [ ] **Step 1: 替换 `/api/query` 并新增 `/api/query/fts`**

把现有 `/api/query` 处理器:

```ts
  app.post("/api/query", requireToken, async (req, res) => {
    try {
      const { query, k } = req.body;
      if (!query) return res.status(400).json({ error: "Missing query" });
      const results = await store.search(query, k || 5);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
```

替换为:

```ts
  app.post("/api/query", requireToken, async (req, res) => {
    try {
      const { query, topK, k, threshold } = req.body;
      if (!query) return res.status(400).json({ error: "Missing query" });
      // topK 为前端实际发送的参数;k 兼容旧客户端
      let results = await store.search(query, topK ?? k ?? 5);
      if (typeof threshold === "number" && threshold > 0) {
        results = results.filter((r) => r.score >= threshold);
      }
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 纯关键词子串检索（H5 keyword 标签）
  app.post("/api/query/fts", requireToken, async (req, res) => {
    try {
      const { query, topK } = req.body;
      if (!query) return res.status(400).json({ error: "Missing query" });
      const results = await store.searchKeyword(query, topK ?? 5);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 退出码 0。

- [ ] **Step 3: 提交**

```bash
git add src/server/index.ts
git commit -m "feat: add /api/query/fts endpoint, fix topK and threshold

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `RagSearchTool` 增加 keyword 模式

**Files:**
- Modify: `src/rag/retriever.ts` — schema 加 `mode`,`_call` 路由分发
- Test: `scripts/verify-tool-mode.ts`(临时,验证后删除)

**Interfaces:**
- Consumes: `store.searchKeyword()`(Task 2)
- Produces: `search_documents` 工具 schema 含 `mode?: "hybrid" | "keyword"`

- [ ] **Step 1: 修改工具实现**

把 `src/rag/retriever.ts` 整个类替换为:

```ts
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { PgVectorStore } from "../storage/pg-vector-store.js";

export class RagSearchTool extends StructuredTool {
  name = "search_documents";
  description = "Search uploaded documents for relevant information. Use this when the user asks about their documents or needs information that might be in uploaded files. mode=\"keyword\" does exact substring matching (file names, identifiers, code, error strings); default \"hybrid\" mixes vector + full-text for semantic recall.";
  schema = z.object({
    query: z.string().describe("The search query"),
    k: z.number().optional().describe("Number of results to return (default 5)"),
    mode: z.enum(["hybrid", "keyword"]).optional().describe("hybrid (default): vector+FTS semantic search; keyword: exact substring matching"),
  });

  private store: PgVectorStore;

  constructor(store: PgVectorStore) {
    super();
    this.store = store;
  }

  async _call({ query, k, mode }: z.infer<typeof this.schema>): Promise<string> {
    const results = mode === "keyword"
      ? await this.store.searchKeyword(query, k || 5)
      : await this.store.search(query, k || 5);
    if (results.length === 0) return "No relevant documents found.";
    return results.map((r, i) =>
      `[${i + 1}] Source: ${r.source}\n${r.content}\n`
    ).join("\n---\n");
  }
}
```

- [ ] **Step 2: 写并运行验证脚本**

创建 `scripts/verify-tool-mode.ts`:

```ts
import { getPool } from "../src/storage/pool.js";
import { loadConfig } from "../src/config/index.js";
import { PgVectorStore } from "../src/storage/pg-vector-store.js";
import { RagSearchTool } from "../src/rag/retriever.js";

(async () => {
  const config = loadConfig();
  const pool = await getPool(config);
  const store = new PgVectorStore(pool, {} as any);
  const tool = new RagSearchTool(store);
  try {
    const kw = await tool._call({ query: "测试", mode: "keyword", k: 3 });
    console.log("KEYWORD mode first line:", kw.split("\n")[0]);
    const hy = await tool._call({ query: "测试", k: 3 });
    console.log("HYBRID mode first line:", hy.split("\n")[0]);
    console.log("✓ tool mode 验证通过");
  } finally {
    await pool.end();
  }
})().catch((e) => {
  console.error("验证失败:", e);
  process.exit(1);
});
```

```bash
docker compose up -d postgres
npx tsx scripts/verify-tool-mode.ts
```

Expected: 两行 first line 均以 `[1] Source:` 开头,`✓ tool mode 验证通过`。

- [ ] **Step 3: 类型检查 + 删除脚本 + 提交**

```bash
npx tsc --noEmit
rm scripts/verify-tool-mode.ts
git add src/rag/retriever.ts
git commit -m "feat: add keyword mode to search_documents tool

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 前端 keyword 标签直连新端点

**Files:**
- Modify: `src/server/public/index.html` — `endpoints` 数组(约 300-302 行)

**Interfaces:**
- Consumes: `POST /api/query/fts`(Task 3)
- Produces: 前端 keyword 标签不再回退 hybrid

- [ ] **Step 1: 修改 endpoints 数组**

把:

```js
    const endpoints = queryMode === "hybrid"
      ? ["/api/query"]
      : ["/api/query/fts", "/api/query"];
```

改为:

```js
    const endpoints = queryMode === "hybrid"
      ? ["/api/query"]
      : ["/api/query/fts"];
```

说明:端点已实现,去掉 404 回退;`endpoints.length > 1` 的 404 分支自然失效(单元素数组),旧服务器下会明确报错而非返回 hybrid 假结果。

- [ ] **Step 2: 验证前端文件已更新**

```bash
curl -s http://localhost:3001/ | grep -n "api/query/fts"
```

Expected: 只出现 `["/api/query/fts"]`(无 `, "/api/query"]` 形式)。若服务未启动,先启动再测(见 Task 6 启动步骤)。

- [ ] **Step 3: 提交**

```bash
git add src/server/public/index.html
git commit -m "fix: keyword tab uses /api/query/fts directly

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 端到端验证

**Files:**
- 无代码变更;全部为验证命令

- [ ] **Step 1: 启动服务并取 token**

确认 3001 空闲后:

```bash
npm run server > /tmp/server.log 2>&1 &
sleep 14
TOKEN=$(grep -oP "Access token: \K[0-9a-f]{12}" /tmp/server.log | head -1)
echo "TOKEN=$TOKEN"
```

Expected: 打印 12 位 hex token,日志含 `RAG server on http://localhost:3001`。

- [ ] **Step 2: `/api/query/fts` 各用例**

```bash
# 精确串命中
curl -s -X POST "http://localhost:3001/api/query/fts?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"测试","topK":3}'
# 期望: {"results":[{...content 含"测试"...}]}

# 无命中
curl -s -X POST "http://localhost:3001/api/query/fts?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"zzzzqqqqnoexist123","topK":3}'
# 期望: {"results":[]}

# 缺 query → 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:3001/api/query/fts?token=$TOKEN" \
  -H "Content-Type: application/json" -d '{}'
# 期望: 400

# 无 token → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:3001/api/query/fts" \
  -H "Content-Type: application/json" -d '{"query":"测试"}'
# 期望: 401
```

- [ ] **Step 3: 验证 `/api/query` bug 修复**

```bash
# topK=3 → 恰好 3 条(修复前恒为 5)
curl -s -X POST "http://localhost:3001/api/query?token=$TOKEN" \
  -H "Content-Type: application/json" -d '{"query":"测试","topK":3}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('topK=3 count:',JSON.parse(s).results.length))"

# threshold=0.99 → 过滤(hybrid 分数普遍较低,预期 0 条或明显变少)
curl -s -X POST "http://localhost:3001/api/query?token=$TOKEN" \
  -H "Content-Type: application/json" -d '{"query":"测试","topK":10,"threshold":0.99}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('threshold=0.99 count:',JSON.parse(s).results.length))"
```

Expected: topK=3 输出 `3`;threshold=0.99 输出明显小于 threshold=0 时的数量。

- [ ] **Step 4: 浏览器路径冒烟 + 收尾**

```bash
# 页面可访问
curl -s -o /dev/null -w "page HTTP %{http_code}\n" "http://localhost:3001/?token=$TOKEN"
# 期望: 200

# 停掉验证服务,留空端口
PID=$(netstat -ano | grep ":3001" | grep LISTEN | awk '{print $5}' | head -1)
taskkill //PID $PID //F
```

- [ ] **Step 5: 确认 git 状态干净(仅计划/设计文档未提交属正常)**

```bash
git status --short
```

Expected: 无 `src/` 或 `scripts/` 下未提交的临时改动(临时验证脚本已删)。

---

## Self-Review 记录

- **Spec 覆盖**:spec §4.1→Task 2,§4.2/4.3→Task 3,§4.4→Task 4,§4.5→Task 5,§4.6→Task 1,§5/6/7→Task 3/6。全部覆盖。
- **占位符扫描**:无 TBD/TODO;每步含确切代码与命令。
- **类型一致性**:`searchKeyword(query: string, k?: number): Promise<RagResult[]>` 在 Task 2 定义、Task 3 端点与 Task 4 工具均按此签名调用;`mode: z.enum(["hybrid","keyword"]).optional()` 在 Task 4 定义与使用一致;`topK` 在 Task 3 端点与 Task 5 前端一致。
