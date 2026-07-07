# Fix Final Report — Code Review Remediation

**Date:** 2026-07-07  
**Commit:** `b957d64` — `fix: address final review - history, gitignore, async shell, zod`

## Summary

4 issues from the final code review were addressed. All fixes applied cleanly and `tsc --noEmit` passes with zero errors.

## Fixes Applied

### Fix 1 (Critical): Conversation History in `src/tui/app.tsx`

- Imported `AgentMessage` from `../agent/types.js` and `useRef` from React.
- Added `historyRef = useRef<AgentMessage[]>([])` to maintain message history across turns.
- Changed `runAgent(executor, value, undefined, {...})` → passes `historyRef.current` as the history argument.
- After each assistant response, pushes `{ role: "user" }` and `{ role: "assistant" }` entries into `historyRef`.
- `/clear` handler resets `historyRef.current = []` alongside clearing messages.

### Fix 2 (Critical): `.gitignore`

Replaced the existing `.gitignore` with entries covering:
- `node_modules/`, `dist/`
- `.env`, `*.log`
- `.superpowers/sdd/task-*-brief.md`, `task-*-report.md`, `review-*.diff`

### Fix 3 (Important): Async `ShellTool` in `src/tools/shell.ts`

- Replaced `execSync` from `node:child_process` with `exec` + `promisify` from `node:util`.
- Created `const execPromise = promisify(exec)` at module scope (before the class).
- `_call` now awaits `execPromise(command, ...)` and destructures `{ stdout, stderr }`.
- Error catch updated: `status` → `code` (the property exposed by `ExecException`).

### Fix 4 (Important): `zod` added to `package.json`

Added `"zod": "^3.23.0"` to `dependencies`. The package was already installed as a transitive dependency via `@langchain/core` / `langchain`, so no additional install was needed.

## Verification

- `npx tsc --noEmit`: **passes cleanly** — zero errors.
- All 4 files committed: `.gitignore`, `package.json`, `src/tools/shell.ts`, `src/tui/app.tsx`.

## Issues Encountered

- Patch churn on `app.tsx`: the initial patch applied a duplicate CLEAR guard and a separate `useRef` import. These were cleaned up with two follow-up patches to merge the import and remove the extra line.
- `execPromise` was initially placed after the `ShellTool` class, which would cause a TDZ runtime error. Moved it above the class to fix.
- `.gitignore` already existed in the repo (3 lines); the new content replaced it, resulting in 6 insertions / 3 deletions rather than a pure add.
