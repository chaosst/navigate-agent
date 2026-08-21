# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev                # Start TUI agent (tsx src/index.ts)
npm run server             # Start headless server (tsx src/server-entry.ts)

# Build & Run
npm run build              # TypeScript compile
npm start                  # Run production build (node dist/server-entry.js)

# Database
npm run db:up              # Start PostgreSQL via docker-compose
npm run db:down            # Stop PostgreSQL
npm run db:reset           # Reset database (drops volumes)
npm run db:import          # Import data from SQLite to PostgreSQL

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
- **`custom-loop.ts`** — Custom ReAct loop (not `AgentExecutor`). Yields `{ output?, intermediateSteps? }` chunks compatible with LangChain's interface. Features tool filtering, tracer, and graceful LLM failure fallback.
- **`loop.ts`** — `runAgent()` wraps the custom loop with history management, context truncation (~6000 token budget), and summary injection. Called by both TUI and server.
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

### Memory (`src/memory/`)
- **`sqlite-store.ts`** — SQLite persistence via `sql.js` (sessions, messages, summaries)
- **`vector-memory.ts`** — Semantic search of past conversations using OpenAI embeddings
- **`context-manager.ts`** — Token-aware context truncation (~6000 token budget, character estimation)
- **`summary-manager.ts`** — LLM-generated conversation summaries with keyword-based retrieval
- **`index.ts`** — `AgentMemory` facade with automatic summary generation

### RAG (`src/rag/`)
- **`vectorstore.ts`** — Hybrid search (OpenAI embeddings + BM25) with RRF merging. Custom tokenizer: English words + Chinese bi-gram. Persists to `rag_data/vectorstore.json`.
- **`retriever.ts`** — `RagSearchTool` (tool: `search_documents`) with optional LLM reranking
- **`reranker.ts`** — LLM-based listwise reranker
- **`loader.ts`** — Parses PDF, DOCX, TXT/MD and splits into chunks

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
- **Config** (`src/config/`) — Reads `.env`: `OPENAI_API_KEY`, `OPENAI_MODEL` (default: `gpt-4o`), `OPENAI_BASE_URL`, `MAX_ITERATIONS` (25), `MCP_SERVERS` (JSON array)

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
