# Iter 2: Memory Implementation Plan

Goal: Add persistent conversation memory with SQLite storage and vector-based memory retrieval.

## Tasks

### Task M1: Install dependencies + Memory types
Modify package.json: add better-sqlite3, @langchain/community, @types/better-sqlite3
Create src/memory/types.ts: Session, MemoryMessage, MemoryConfig, SearchResult

### Task M2: SqliteStore
Create src/memory/sqlite-store.ts
SqliteStore class with: createSession, getSession, listSessions, deleteSession, addMessage, getMessages, getRecentContext, close
Tables: sessions(id TEXT PK, name TEXT, created_at INT, updated_at INT)
Tables: messages(id INTEGER PK, session_id TEXT FK, role TEXT, content TEXT, created_at INT)
Use WAL mode, better-sqlite3 sync API

### Task M3: VectorMemory
Create src/memory/vector-memory.ts
OpenAIEmbeddings(text-embedding-3-small) + MemoryVectorStore
Methods: storeSummary(sessionId, summary), search(query, k?), deleteSessionMemories(sessionId)

### Task M4: AgentMemory facade
Create src/memory/index.ts
Wrapper combining SqliteStore + VectorMemory
Methods: getOrCreateSession, addMessage, getContextWindow, searchRelated, buildMemoryContext, close

### Task M5: Wire into TUI
Modify src/index.ts: init memory, pass to App
Modify src/tui/app.tsx: accept memory prop, load/save history per turn, /session commands

### Task M6: Verify
npm install, npx tsc --noEmit, module loading check
