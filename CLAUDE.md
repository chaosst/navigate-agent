# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev                # Start TUI agent (db:ensure + tsx src/index.ts)
npm run server             # Start headless server (db:ensure + tsx src/server-entry.ts)

# Build & Run
npm run build              # TypeScript compile
npm start                  # Run production build (node dist/server-entry.js)

# Database
npm run db:ensure          # Start PostgreSQL if not running (dev/server 会自动先跑)
npm run db:up              # Start PostgreSQL via docker-compose
npm run db:down            # Stop PostgreSQL
npm run db:reset           # Reset database (drops volumes)
npm run db:import          # Legacy: 一次性把旧 SQLite 数据导入 PostgreSQL

# Testing
npm run test               # Run tests (vitest)
npm run test:watch         # Run tests in watch mode

# Utilities
npm run gen-token          # Generate access token for API
npm run dev:zyplayer       # Start zyplayer-doc (Java + MySQL) via Docker
```

## Project Overview

**Navigate** is an AI agent system that runs as a terminal TUI (React/Ink) with an optional REST API server. It uses LangChain with a custom ReAct loop (not `AgentExecutor`) to orchestrate tools — filesystem operations, shell commands, RAG document search, resume search, MCP tools, and YAML-defined skills.

The agent connects to OpenAI-compatible LLMs and supports MCP servers for external tooling.

## Architecture

### Entry Points
- `src/index.ts` — Full TUI agent (default). Loads MCP servers, embeddings, memory, RAG, resume, skills, then renders the Ink TUI.
- `src/server-entry.ts` — Headless server mode. Same setup but no TUI — just starts Express on port 3001.

### Agent Engine (`src/agent/`)
- **`graph-agent-executor.ts`** — 在跑的主引擎 `GraphAgentExecutor`：基于 `@langchain/langgraph` StateGraph 自建的 agent 图（工具节点 `TrackingToolNode`，非 LangChain `AgentExecutor`），支持流式、tool filter、tracer。另有分层 `HierarchicalAgentLangGraph`（hierarchical-agent-langgraph.ts）与 PTC 变体（`src/ptc/`）。
- **`custom-loop.ts`** — Legacy：早期自定义 ReAct 循环，`src/` 内已无引用，仅保留作参考。
- **`loop.ts`** — Executor 工厂（`createAgentExecutor`/`createHierarchicalAgent`/`createPtcAgent`）+ `runAgent()` 流式封装：把传入的 `history` parse 成 BaseMessage、推入当前输入，流式转发 token/工具事件并带整体超时。**这里不做摘要注入或上下文截断**。
- **`langchain.ts`** — Creates `ChatOpenAI` instance. Falls back to character-count estimator when tiktoken doesn't recognize the model.

### Tools (`src/tools/`)
All tools are `StructuredTool` subclasses wrapped in `PermissionWrapper` (rate limiting, circuit breakers). Three permission levels: `read`, `write`, `dangerous`.

- **`shell.ts`** — `execute_command` (dangerous, rate-limited)
- **`filesystem.ts`** — `read_file`, `write_file`, `edit_file` (path traversal prevention)
- **`search.ts`** — `list_files`, `search_files` (Windows `findstr`)
- **`mcp.ts`** — `McpClientManager` for MCP stdio servers with auto-reconnect
- **`permission.ts`** — `PermissionWrapper` decorator with sliding window rate limits and circuit breaker
- **`tool-filter.ts`** — Dynamically restricts visible tools per-query (read-only by default, promotes on keyword match)
- **`registry.ts`** — `createTools()` factory for all tools

### Memory (`src/memory/` + `src/storage/`)
对话记忆已从 SQLite 迁到 **PostgreSQL + pgvector**（`src/storage/`，见下方 Storage 段）。`src/memory/` 只放业务逻辑，持久化全部委托给 `PgSessionStore`。

- **`index.ts`** — `AgentMemory` facade。`create(pool, embeddings)` 组装 `PgSessionStore` + `ContextManager` + `SummaryManager`，维护 `activeSessionId`（自动建/复用 session）。高层 API：`addUserMessage`/`addAssistantMessage`、`getSession`/`listSessions`/`switchSession`、`summarizeAndStore`（每轮原文入库，无 LLM）。
- **`context-manager.ts`** — Token 感知上下文截断（预算默认 6000 + 回复预留 2000）。**刻意不用 tiktoken**：字符估算（ASCII≈4 字符/token、CJK≈1.5），对第三方模型（DeepSeek 等）友好、快且误差 <10%。
- **`summary-manager.ts`** — 摘要管理器。`findRelevant()` 优先 pgvector 余弦检索（`embeddings` 存在时），失败降级关键词匹配；每 session 上限默认 10 条，超出 `pruneSummaries` 删最旧。
- **`types.ts`** — 共享类型：`Session`/`MemoryMessage`/`Summary`/`MemoryConfig`（`dbPath` 字段为遗留，未用）。

> 接线现状：TUI 实时路径只有「每轮持久化 + 会话内历史重放」。跨会话语义召回（`findRelevant`）、批量 LLM 摘要（`summarizeAfterTurn`）、`ContextManager.truncate()` **均已实现但未接入 agent loop**——找代码时不要假设它们生效。

### RAG (`src/rag/` + `src/storage/`)
- **`retriever.ts`** — `RagSearchTool` (tool: `search_documents`)，包装 `PgVectorStore.search()` 混合检索，可选 LLM rerank
- **`reranker.ts`** — LLM-based listwise reranker
- **`loader.ts`** — Parses PDF, DOCX, TXT/MD and splits into chunks，随后经 `PgVectorStore.addChunks()` 入库

> 旧版 JSON 落点的 `src/rag/vectorstore.ts`（OpenAI embeddings + BM25、`rag_data/vectorstore.json`）已删除，向量检索整体迁到 `PgVectorStore`。

### Storage (`src/storage/`) — PostgreSQL/pgvector 统一持久化层
对话记忆与 RAG **共享同一个连接池**（`src/index.ts` 中 `getPool()` → `AgentMemory.create` + `new PgVectorStore`）。

- **`pool.ts`** — 单例 `Pool`（`getPool(config)`/`closePool()`），首次创建即自动跑迁移
- **`migrate.ts`** + **`migrations/`** — 轻量迁移器，按文件名顺序执行 `.sql`（进程内幂等）。001：`documents`/`doc_chunks` + zhparser 中文 FTS 配置；002：`sessions`/`messages`/`summaries`；003：pg_trgm 索引
- **`pg-session-store.ts`** — `PgSessionStore`：对话记忆落点（sessions/messages/summaries CRUD，摘要自动向量化，见 Memory）
- **`pg-vector-store.ts`** — `PgVectorStore`：RAG 落点。混合检索 = pgvector 余弦 + zhparser 中文 FTS + pg_trgm 兜底 + RRF 融合；另有 `searchKeyword()`（ILIKE 子串）
- **`cache.ts`** — `HotCache`：L1 LRU cache-aside（TTL 30min），只缓存文档元数据与会话
- **`types.ts`** — 存储层共享类型（`DocMeta`/`ChunkRecord`/`SessionRecord`/`MessageRecord`）

> **embedding 维度写死为 `vector(768)`**（跟随当前 nomic-embed-text）。换 embedding 模型需 ALTER 表 + 重建 ivfflat 索引（迁移 SQL 注释已标注）。

### Server (`src/server/`)
Express server (port 3001) with endpoints:
- `POST /api/upload` — Upload documents → RAG indexing (token-protected)
- `GET/DELETE /api/documents` — Document management
- `POST /api/query` — RAG search API
- `POST /api/resume/chat` — SSE streaming chat
- `GET /resume` — Resume display
- Token management endpoints in `token.ts` (30 min TTL, 12-char hex)

### Resume (`src/resume/`)
Parses `resume.md` into structured data with SQLite-backed vector embeddings. `ResumeSearchTool` (tool: `search_resume`) provides section-filtered semantic search with cosine similarity and keyword fallback.

### Skills (`src/skills/`)
YAML or Markdown-defined tools with four action types: `template`, `shell`, `http`, `code`.

- **`registry.ts`** — Scans and loads skills with hot-reload support
- **`skill-tool.ts`** — Permission mapping by action type: template→read, http→write, shell/code→dangerous

**Important**: Skills don't use unified `write` permission. `ToolFilter` only exposes `read`-level tools by default; shell/code skills require matching keywords to become visible.

### Other Subsystems
- **MCP Servers** (`src/mcp-servers/`) — Built-in `project-knowledge.ts` exposes git stats, code review prompts via stdio
- **Wiki Sync** (`src/wiki-sync/`) — `ZyplayerDocAdapter` reads from MySQL and syncs to RAG. `ContentPoller` periodically checks for changes.
- **TUI** (`src/tui/`) — React/Ink with performance-critical design: `<Static>` for finalized messages, dynamic area for streaming. Slash commands in `commands.tsx`.
- **Config** (`src/config/`) — `loadConfig()` reads `.env`。推理引擎经 `llm-providers.ts:resolveProvider()` 解析 `PROVIDER`（openai|ollama|vllm|sglang，默认 openai）并取各 provider 专属 `*_BASE_URL`/`*_MODEL`（`OPENAI_*` 作通用兜底）。关键变量：`DATABASE_URL`（必需，PostgreSQL）、`EMBEDDING_MODEL`/`EMBEDDING_BASE_URL`（embedding 专用端点，可与 chat 拆分，如 DeepSeek chat + ollama nomic-embed-text）、`MAX_ITERATIONS`(25)、`MCP_SERVERS`(JSON)、`AGENT_MODE`(normal|plan|ptc)、`PTC_*` 预算、`API_KEYS` 等 API 鉴权项

### Additional Resources
- `docker-compose.zyplayer.yml` — Docker Compose for zyplayer-doc (Java + MySQL)
- `skills/example.skill.yaml` — Example skill file
- `.env.example` — Environment variable template
- `docs/architecture-uml.md` — Mermaid architecture diagrams

## Key Patterns

- **PermissionWrapper** — All tools wrapped with rate limiting and circuit breakers. Never use tools raw.
- **ToolFilter** — Dynamically restricts tools visible to LLM (read-only by default, promotes on keyword match).
- **String returns** — All tools return strings (LangChain `StructuredTool` convention).
- **Chinese comments** — Codebase uses Chinese documentation throughout.
