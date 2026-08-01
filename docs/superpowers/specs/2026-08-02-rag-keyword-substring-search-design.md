# RAG 纯关键词子串检索设计

> 日期: 2026-08-02
> 状态: Draft
> 涉及模块: `src/storage/pg-vector-store.ts`, `src/server/index.ts`, `src/rag/retriever.ts`, `src/server/public/index.html`, `src/storage/migrations/`

## 1. 概述

为 RAG 增加一路**纯关键词字符串匹配检索**(字面子串包含),与现有 hybrid(向量 + 中文 FTS + pg_trgm 兜底 + RRF)完全独立:

- 补齐 H5 页面 keyword 标签的缺口 —— 前端预留的 `POST /api/query/fts` 端点从未在后端实现,当前 keyword 模式 404 后静默回退到 hybrid
- 提供零成本、确定性的精确检索通道:文件名、文档 ID、代码片段、错误串、URL 等 embedding/FTS 无法稳定命中的字面量
- agent 的 `search_documents` 工具支持 `mode="keyword"` 走子串检索
- 顺手修复 `/api/query` 的 `topK` 参数失效、`threshold` 被忽略两个 bug

## 2. 已确认的设计决策

| 维度 | 决策 |
|------|------|
| 匹配语义 | `ILIKE '%q%'`,大小写不敏感子串包含 |
| 排序规则 | 位置优先(出现越靠前越相关)→ 出现次数次之 |
| 消费方 | H5 端点 + agent `search_documents` 工具 mode 参数 |
| 实现形态 | 独立方法 + 独立端点(方案 A),不并入 hybrid/RRF |
| bug 修复 | 一并修 `topK`/`k` 参数名不一致与 `threshold` 过滤失效 |
| 结果分 | 伪分数 `score = 1 / pos`(纯展示,随排序单调) |

## 3. 现状与缺口

- `doc_chunks` 表:已有 `fts_vector`(tsvector 生成列 + GIN 索引)、已启用 `pg_trgm` 扩展,**但没有 content 的 trigram GIN 索引**
- hybrid `search()`(`pg-vector-store.ts:204`)三段式:向量 → 中文 FTS → pg_trgm 兜底(`similarity` + `ILIKE`,仅当 FTS 返回 0 条时触发,按 `similarity` 排序)
- 现有 pg_trgm 兜底是"模糊+子串"混合,不是纯子串,且不是一等公民
- 前端 keyword 模式调 `/api/query/fts`(不存在)→ 回退 `/api/query`
- `/api/query` 读 `req.body.k`,前端发 `topK` → 恒为 undefined → 永远默认 5;`threshold` 被忽略

## 4. 组件设计

### 4.1 `PgVectorStore.searchKeyword()`

```ts
async searchKeyword(query: string, k: number = 5): Promise<RagResult[]>
```

SQL(位置优先 + 次数次之):

```sql
SELECT c.id, c.content, c.doc_id, c.chunk_index, d.filename,
       strpos(LOWER(c.content), LOWER($1)) AS pos,
       1.0 / strpos(LOWER(c.content), LOWER($1)) AS score,
       (length(c.content) - length(replace(lower(c.content), lower($1), '')))
          / NULLIF(length($1), 0) AS cnt
FROM doc_chunks c
JOIN documents d ON d.id = c.doc_id
WHERE c.content ILIKE '%' || $1 || '%'
ORDER BY pos ASC, cnt DESC
LIMIT $2
```

说明:
- `pos` 即 `strpos(LOWER(content), LOWER(query))`,首个命中位置(1-based);`WHERE` 保证存在,`pos >= 1`
- 排序:`ORDER BY pos ASC, cnt DESC`
- `score = 1/pos`,与排序单调一致,供前端 `score.toFixed(4)` 展示
- 短查询防护:`query.trim().length < 2` → 直接返回 `[]`(单字命中面过大且无法走 trigram 索引)
- 返回结构与 `search()` 一致的 `RagResult[]`(`content/score/source/docId/chunkIndex`)

### 4.2 端点 `POST /api/query/fts`

- `requireToken` 保护(与 `/api/query` 一致)
- 请求 body:`{ query: string, topK?: number }`
- 响应:`{ results: RagResult[] }`,与 `/api/query` 同构
- 错误:`query` 缺失/为空 → 400 `{error}`;DB 异常 → 500 `{error}`

### 4.3 修复 `POST /api/query`

- 参数:接受 `topK`(前端实际发送)与 `k`(旧客户端兼容):`const topK = req.body.topK ?? req.body.k ?? 5`
- `threshold` 生效:hybrid 结果 RRF 融合后,`threshold > 0` 时过滤 `r.score >= threshold`

### 4.4 `RagSearchTool` 增加 keyword 模式

- schema 增加:`mode: z.enum(["hybrid", "keyword"]).optional()`
- `_call`: `mode === "keyword"` → `this.store.searchKeyword(query, k || 5)`,否则走 `this.store.search(query, k || 5)`
- 工具描述补充:"keyword 模式用于精确字符串 / 文件名 / 标识符检索"

### 4.5 前端 `index.html`

- keyword 标签 endpoints:`["/api/query/fts", "/api/query"]` → **`["/api/query/fts"]`**(端点已实现,去掉对 hybrid 的静默回退;旧服务器下会明确报错而非假结果)
- keyword body 已是 `{ query, topK }`,无需改动

### 4.6 迁移 `003_keyword_trgm_index.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_chunks_content_trgm
  ON doc_chunks USING GIN (content gin_trgm_ops);
```

- 加速 `ILIKE '%q%'`;trigram 索引要求模式 ≥3 字符,1-2 字符查询仍顺序扫(短查询防护兜底)
- `pg_trgm` 扩展已在 001 启用,迁移安全幂等

## 5. 数据流

H5 keyword 标签:

```
用户输入 → POST /api/query/fts?token → { query, topK }
  → requireToken → store.searchKeyword(query, topK)
  → SQL ILIKE 子串 → [{content, score, source, docId, chunkIndex}]
  → { results } → 前端渲染
```

agent:

```
LLM 选择 search_documents(query=..., mode="keyword")
  → RagSearchTool._call → store.searchKeyword → 文本格式化返回
```

## 6. 错误处理

| 场景 | 行为 |
|------|------|
| 无 token / token 失效 | 401(requireToken 统一处理) |
| `query` 缺失或为空 | 400 `{error: "Missing query"}` |
| 查询长度 < 2 | 返回 `[]`,不报错 |
| 无命中 | 返回 `{ results: [] }` |
| DB 异常 | 500 `{error}`(try/catch,与 `/api/query` 一致) |

## 7. 测试计划

| 项 | 验证 |
|----|------|
| `tsc --noEmit` | 编译通过 |
| `/api/query/fts` 精确串 | 返回含该串的 chunk |
| `/api/query/fts` 无命中串 | `{ results: [] }` |
| `/api/query/fts` 无 token | 401 |
| `/api/query/fts` 缺 query | 400 |
| `/api/query?topK=3` | 恰好 3 条(验证 bug 修复) |
| `/api/query?threshold=0.5` | 结果被阈值过滤 |
| `search_documents` mode=keyword | 走子串检索路径(直接调 store 验证) |

## 8. 涉及文件

- `src/storage/pg-vector-store.ts` — 新增 `searchKeyword()`
- `src/server/index.ts` — 新增 `/api/query/fts`,修 `/api/query`
- `src/rag/retriever.ts` — schema 加 `mode`,路由分发
- `src/server/public/index.html` — keyword endpoints 简化
- `src/storage/migrations/003_keyword_trgm_index.sql` — 新增索引迁移
