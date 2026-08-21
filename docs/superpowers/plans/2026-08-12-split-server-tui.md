# 拆分 server 与 TUI 启动入口 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `npm run server`（服务+H5）与 `npm run tui`（只 TUI）彻底拆分，`dev` 作为 `tui` 别名。

**Architecture:** 改造 `src/index.ts` 为 TUI-only（仅删 `createRagServer` 调用），`server-entry.ts` 保持不变。TUI 保留 `memory`/`ragTool`/`resumeTool`/`skillTools`/`executor`（聊天必需），database 连接保留。

**Tech Stack:** Node/TS, tsx, Ink/React, Express

## Global Constraints

- TUI 模式不启动 `createRagServer`（不占 3001 端口）
- TUI 模式保留 `getPool`/`AgentMemory`（`ragTool`/memory 依赖）
- `resumeStore`/`resumeData` 必须保留（`resumeTool = new ResumeSearchTool(resumeStore)` 需要）
- `server-entry.ts` 一行不改
- 命名：`tui` 主名，`dev` 别名指向 `tui`，`server` 不变

---

### Task 1: 改造 `src/index.ts` 为 TUI-only

**Files:**
- Modify: `src/index.ts`
- Test: 无（手动验证 + tsc）

**Interfaces:**
- Consumes: 现有 `main()` 内所有初始化逻辑
- Produces: 删掉 `createRagServer` 调用后的 TUI-only 入口；`App` 仍接收 `executor`/`memory`/`agentName`

- [ ] **Step 1: 删除 `createRagServer` 的 import**

将 `src/index.ts` 第 17 行：
```ts
import { createRagServer } from "./server/index.js";
```
删除。（`ResumeStore` import 保留——第 18 行，因 `resumeStore` 仍用于建 `resumeTool`）

- [ ] **Step 2: 删除 `createRagServer(...)` 调用**

将第 89 行：
```ts
  createRagServer(ragStore, 3001, executor, resumeStore, resumeData);

```
删除。

- [ ] **Step 3: 确认无残留引用**

`resumeStore`/`resumeData` 仍被第 51-64 行使用（`ResumeStore.create`、`import`、`hasChanged`、`new ResumeSearchTool`），**必须保留**。确认删除后 `createRagServer` 无任何引用。

- [ ] **Step 4: tsc 验证**

Run: `npx tsc --noEmit`
Expected: 退出码 0，无 `createRagServer` 相关报错。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "refactor: make index.ts TUI-only (drop createRagServer)"
```

---

### Task 2: 更新 `package.json` scripts

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: 已改好的 `src/index.ts`
- Produces: `tui` 主脚本、`dev` 别名脚本、`server` 不变

- [ ] **Step 1: 修改 `scripts`**

将：
```json
"dev": "npm run db:ensure && tsx src/index.ts",
```
改为：
```json
"dev": "npm run tui",
"tui": "npm run db:ensure && tsx src/index.ts",
```
`server` 保持：
```json
"server": "npm run db:ensure && tsx src/server-entry.ts",
```

- [ ] **Step 2: 验证脚本可解析**

Run: `node -e "const p=require('./package.json'); console.log(p.scripts.dev, '|', p.scripts.tui, '|', p.scripts.server)"`
Expected: `npm run tui | npm run db:ensure && tsx src/index.ts | npm run db:ensure && tsx src/server-entry.ts`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add tui script, make dev alias to tui"
```

---

### Task 3: 端到端验证

**Files:** 无改动

**Interfaces:**
- Consumes: Task 1 + 2 的结果

- [ ] **Step 1: 验证 `npm run tui` 只起 TUI**

Run: `npm run tui`（前台，观察 5 秒后 Ctrl+C）
Expected: 出现 Ink TUI 界面，无 HTTP 启动日志，3001 端口不被占用。

- [ ] **Step 2: 验证 `npm run dev` 等价**

Run: `npm run dev`（前台，观察后 Ctrl+C）
Expected: 表现与 `npm run tui` 完全一致（同一入口）。

- [ ] **Step 3: 验证 `npm run server` 仍起服务+H5**

Run: `npm run server`（后台），然后 `curl -s -o /dev/null -w "%{http_code}" localhost:3001`
Expected: 返回 200（或 302 到 login，因未带 token），服务正常启动，无 TUI。

- [ ] **Step 4: 收尾**

确认无残留 `repro-graph.ts`、无未提交临时代码。若 server 后台进程仍在，停掉它。