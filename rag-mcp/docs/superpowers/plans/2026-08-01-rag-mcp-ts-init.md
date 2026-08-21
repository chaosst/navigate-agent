# rag-mcp TypeScript Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize `D:\develop\navigate\rag-mcp` as a minimal TypeScript project with `tsx` development, `tsc` build, and no runtime dependencies.

**Architecture:** A single-entry ESM TypeScript project. `src/index.ts` is the source entry, `tsx` runs it during development, `tsc` emits `dist/index.js`, and `node` runs the compiled output.

**Tech Stack:** TypeScript 5.x, tsx 4.x, Node.js, npm.

## Global Constraints

- Use ESM (`"type": "module"`) with NodeNext module and module resolution.
- Enable strict TypeScript settings.
- Add only `typescript` and `tsx` as devDependencies; do not add runtime dependencies.
- Keep all new files inside `D:\develop\navigate\rag-mcp`; do not modify parent repo files.
- Do not add RAG, MCP, LangChain, or test framework code.
- Preserve existing `name`, `version`, `description`, `license`, and `author` values.
- Commit with Conventional Commits; first line under 72 characters.

---

### Task 1: Initialize Minimal TypeScript Scaffold

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `.gitignore`
- Create: `package-lock.json` via npm install

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run dev`, `npm run build`, `npm run typecheck`, `npm start`, compiled `dist/index.js`.

- [ ] **Step 1: Replace `package.json`**

```json
{
  "name": "rag-mcp",
  "version": "1.0.0",
  "description": "a rag mcp server",
  "license": "ISC",
  "author": "",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "start": "node dist/index.js"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `src/index.ts`**

```ts
console.log("rag-mcp: minimal TypeScript project initialized");
```

- [ ] **Step 4: Create `.gitignore`**

```text
node_modules/
dist/
.env
*.log
```

- [ ] **Step 5: Install dev dependencies**

Run from `D:\develop\navigate\rag-mcp`:

```bash
npm install --save-dev typescript@^5.4.0 tsx@^4.0.0
```

Expected: `node_modules/` and `package-lock.json` are created; no runtime dependencies are added.

- [ ] **Step 6: Type-check**

Run: `npm run typecheck`

Expected: exit code 0 and no TypeScript errors.

- [ ] **Step 7: Build**

Run: `npm run build`

Expected: exit code 0 and `dist/index.js` exists.

- [ ] **Step 8: Run compiled output**

Run: `npm start`

Expected: prints `rag-mcp: minimal TypeScript project initialized`.

- [ ] **Step 9: Commit**

From `D:\develop\navigate\rag-mcp`:

```bash
git add package.json package-lock.json tsconfig.json src/index.ts .gitignore
git commit -m "feat: initialize minimal typescript project"
```

Expected: commit contains only the rag-mcp scaffold files.
