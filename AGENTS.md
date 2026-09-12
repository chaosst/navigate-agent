# Repository Guidelines

## Project Structure & Module Organization

```
src/
├── index.ts            # Application entry point
├── config/             # Environment config (OPENAI_API_KEY, model, etc.)
├── agent/              # Agent loop (LangChain + OpenAIToolsAgent)
├── tools/              # Built-in tools (shell, filesystem, search)
├── memory/             # Conversation persistence (SQLite) + vector memory
├── rag/                # RAG engine (document loader, vector store, retriever)
├── server/             # Express API + public HTML upload page
└── tui/                # ink-based terminal UI
```

All source files live under `src/`. Use `.ts` for TypeScript and `.tsx` for files with JSX. Modules use ES module resolution with explicit `.js` extensions in import paths (`import { X } from "./y.js"`).

## Build, Test, and Development Commands

| Command | Action |
|---|---|
| `npm run dev` | Start the TUI agent via tsx (hot-reload) |
| `npm run build` | Type-check and compile to `dist/` |
| `npx tsc --noEmit` | Type-check without emitting output |
| `npm start` | Run compiled `dist/index.js` |

The RAG document management server starts automatically on port 3001 when the agent runs. The SQLite database (`navigate.db`) is created in the project root on first launch.

## Testing Guidelines

The project uses **vitest** (`npm run test` = `vitest run --dir src`). Type-check with `npx tsc --noEmit`. Test files live in `__tests__/` next to the code they cover (`src/<module>/__tests__/*.test.ts`); names describe the behavior under test.

## RAG Chunking (src/rag/)

`loadDocument(filePath, filename, chunkSize?, chunkOverlap?)` in `src/rag/loader.ts` is the single entry point and **dispatches by file extension**:

| Format | Strategy | Module |
|---|---|---|
| `.txt` / unknown | character split, **CJK-punctuation-aware separators** | `plain-chunker.ts` |
| `.md` | heading-aware (`#`..`######` are boundaries, fences stay intact) | `md-chunker.ts` |
| `.docx` | `convertToHtml` + styleMap → hand-written HTML subset parser → markdown, then the md chunker | `docx-extract.ts` |
| `.pdf` | page-aware (page is atomic; repeated header/footer lines stripped) | `pdf-chunker.ts` |

- Wiki sync (`src/wiki/store.ts`) shares `chunkMarkdownText` with the `.md` path — do not add a second inline splitter.
- `reflowLines` (PDF visual line rebuild) is **off by default** (`PDF_REFLOW_ENABLED = false`); turning it on can glue table rows into one line → wrong column alignment.
- Chunk metadata (`strategy` / `pageStart` / `pageEnd` / `pageLabel` / `headingPath`) is stored in `doc_chunks.metadata` (JSONB) and surfaced in citations by `src/rag/citation.ts`.
- **Chunking only happens on upload and `/api/reindex/:id`** — existing documents must be reindexed one by one to pick up a new strategy.

## Coding Style & Naming Conventions

TypeScript with strict mode enabled. Files use PascalCase for class and interface names, camelCase for functions and variables. Interfaces are preferred over type aliases for object shapes. Use `StructuredTool` from `@langchain/core/tools` for all tool implementations, overriding `_call()` rather than `_input()`. Imports from external packages use bare specifiers; internal imports use relative paths with `.js` extensions.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits:

- `feat:` — new feature or capability
- `fix:` — bug or defect resolution
- `chore:` — maintenance, cleanup, or tooling

Write commit messages in lowercase after the prefix. Use the imperative mood. Keep the first line under 72 characters. Pull requests should include a summary of changes, any breaking notes, and reference related issues where applicable.

## Configuration

Copy `.env.example` to `.env` and set `OPENAI_API_KEY`. The agent reads configuration from environment variables at startup. Additional options (`OPENAI_MODEL`, `OPENAI_BASE_URL`, `MAX_ITERATIONS`) are documented in `.env.example`. The RAG upload server stores temporary files in `rag_uploads/` and vector index metadata in `rag_data/` — both are gitignored.
