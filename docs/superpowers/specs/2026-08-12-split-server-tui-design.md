# 拆分 server 与 TUI 启动入口

> 日期：2026-08-12 | 状态：已批准

## 背景与目标

**问题**：当前 `npm run server`（`server-entry.ts`）和 `npm run dev`（`index.ts`）职责重叠——`index.ts` 同时启动 HTTP 服务（`createRagServer`）+ TUI，导致两者互斥（都占 3001 端口），且 `dev` 名字暗示"开发模式"却带着生产服务。

**目标**：
- `npm run server` → 只跑 HTTP 服务 + H5 页面（`createRagServer`）
- `npm run tui` → 只跑终端 TUI（React/Ink）
- `npm run dev` → 保留为 `tui` 的别名（兼容旧习惯）

**已确认约束**：
- TUI 模式**不需要** HTTP 服务（不启动 `createRagServer`）
- TUI 模式**仍需要**数据库连接（`ragTool`、`AgentMemory` 依赖 pool）
- 采用**方案 A**：改造 `index.ts` 为 TUI-only，不动 `server-entry.ts`

## 架构

```
┌─ npm run server ──┬─ server-entry.ts ── createRagServer(...)  → HTTP + H5（不变）
└─ npm run tui ─────┬─ tui (主名) ── index.ts ── render(App)    → 只 TUI（本改动）
                    └─ dev (别名)  ── 指向 tui
```

### 改动 1：`src/index.ts` 改为 TUI-only

**删除**：
- `import { createRagServer } from "./server/index.js"`
- `import { ResumeStore } from "./resume/store.js"`
- `createRagServer(ragStore, 3001, executor, resumeStore, resumeData);` 调用
- `resumeStore` / `resumeData` 局部变量（HTTP 页面才用）

**保留**（TUI 依赖）：
- `memory = await AgentMemory.create(pool, embeddings)`（`App` 需要）
- `ragTool` / `resumeTool` / `skillTools`（agent 工具集）
- `resumeSummary`（`buildSystemPrompt` 用）
- `executor`、`render(React.createElement(App, ...))`
- `getPool` / `closePool`、SIGINT/SIGTERM 清理

> 注意：TUI 模式仍调用 `ResumeStore.create` 来建 `resumeTool`（语义搜索工具），只是不再把 `resumeStore`/`resumeData` 传给 HTTP。这块逻辑保留。

### 改动 2：`package.json` scripts

```json
"dev": "npm run tui",                       // 别名，兼容旧习惯
"tui": "npm run db:ensure && tsx src/index.ts",  // 主名：只 TUI
"server": "npm run db:ensure && tsx src/server-entry.ts",  // 不变
```

### 改动 3：`src/server-entry.ts`

**一行不改**。它已是 server+H5 模式。

## 错误处理与边界

- TUI 模式和 server 模式各自独立启动/关闭，无共享端口冲突。
- `db:ensure` 两个脚本都保留（都需要 Postgres）。
- 若同时跑 `npm run server` + `npm run tui`，仍会因同库同端口潜在竞争——但这是用户主动选择，非本改动引入。

## 验证

1. `npm run tui` → 只出现 TUI，无 HTTP 启动日志，3001 端口不被占用
2. `npm run server` → 只启动 HTTP + H5，无 TUI
3. `npm run dev` → 等价 `npm run tui`
4. `npx tsc --noEmit` 通过（确认删除 import 后无残留引用）
5. 手动 `curl localhost:3001` 确认 server 模式的 H5 仍可访问

## 非目标（YAGNI）

- 不抽公共 `setup.ts`
- 不重构任何初始化逻辑
- 不改变 `createRagServer` 签名