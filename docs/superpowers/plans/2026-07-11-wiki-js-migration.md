# Wiki.js 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将自建的 Wiki 知识库（SQLite + 内联 HTML）替换为 Wiki.js，保持 RAG 同步能力

**Architecture:** Wiki.js 作为独立服务运行在 localhost:3003，通过 Webhook 将文章变更通知主应用，主应用通过 GraphQL API 拉取内容后分块注入 RagVectorStore

**Tech Stack:** Wiki.js（发布包）、TypeScript（NodeNext）、Express 5、sql.js（仅迁移用）、OpenAI Embeddings

## Global Constraints

- 所有新 TS 文件使用 `.js` 后缀的 import（NodeNext module resolution）
- Webhook 端点为 `/api/wiki-sync`
- Wiki.js 端口固定为 3003，主应用端口固定为 3001
- 现有 `navigate.db` 中的 wiki 数据仅迁移用，不修改
- Wiki.js API token 通过环境变量 `WIKIJS_API_TOKEN` 配置

---
## Phase 1: Wiki.js 安装与首次启动

### Task 1: 下载并配置 Wiki.js

**Files:**
- Create: `wiki-js/config.yml`

- [ ] **Step 1: 下载 Wiki.js 发布包**

```bash
cd D:/develop/navigate
# 下载 Wiki.js 最新稳定版 (2.x)
curl -L https://github.com/requarks/wiki/releases/latest/download/wiki-js.tar.gz -o wiki-js.tar.gz
mkdir wiki-js
tar -xzf wiki-js.tar.gz -C wiki-js
rm wiki-js.tar.gz
```

如果 Windows 下 curl/tar 不可用，手工从 https://github.com/requarks/wiki/releases 下载并解压到 `wiki-js/`。

- [ ] **Step 2: 创建配置文件**

创建 `wiki-js/config.yml`：

```yaml
port: 3003
host: 'localhost'
db:
  type: sqlite
  file: ./data/wiki.db
  storage:
    engine: 'sqlite'
uploads:
  mode: local
  path: ./data/uploads
auth:
  autoLogin: true
  local:
    enabled: true
offline: false
seeding: false
```

- [ ] **Step 3: 首次启动并设置管理员**

```bash
cd wiki-js
node server start
```

浏览器访问 `http://localhost:3003`，首次启动会进入安装向导：
1. 设置管理员邮箱和密码（记下密码）
2. 语言选择 **中文 (简体)**
3. 关闭不需要的功能（邮件通知、远程存储等）
4. 进入管理后台 → **API 访问** → 生成一个 API Token，复制保存

- [ ] **Step 4: 启用 Webhook 功能**

Wiki.js 管理后台 → **Webhook** → 启用 Webhook 引擎
（URL 暂时不填，等 Task 3 完成后配置）

- [ ] **Step 5: 配置环境变量**

在 `.env` 文件（或 `.env.local`）中增加：

```
WIKIJS_API_TOKEN=<从管理后台复制的 API Token>
WIKIJS_URL=http://localhost:3003
```

- [ ] **Step 6: 添加启动脚本到 package.json**

编辑 `D:\develop\navigate\package.json`，在 `scripts` 中增加：

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "dev:wiki": "cd wiki-js && node server start",
    "dev:all": "concurrently \"npm run dev\" \"npm run dev:wiki\""
  }
}
```

> 注：不强制同时启动两个服务，`dev:all` 用 `concurrently`，需手动安装：`npm i -D concurrently` 或分别启动。

---

## Phase 2: 后端集成（WikiSyncService + Webhook）

### Task 2: 创建 WikiSyncService

**Files:**
- Create: `src/wiki-sync/service.ts`

- [ ] **Step 1: 创建目录和文件**

```bash
mkdir -p src/wiki-sync
```

- [ ] **Step 2: 编写 WikiSyncService**

创建 `src/wiki-sync/service.ts`：

```typescript
import { RagVectorStore } from "../rag/vectorstore.js";

/**
 * Wiki.js → RAG 同步服务
 *
 * 通过 Wiki.js GraphQL API 获取页面内容，分块后同步到 RagVectorStore。
 * 由 Webhook 端点触发，处理 page:created / page:updated / page:deleted 事件。
 */
export class WikiSyncService {
  constructor(
    private wikiUrl: string,
    private apiToken: string,
    private ragStore: RagVectorStore,
  ) {}

  /** 处理 Wiki.js webhook 事件 */
  async handleEvent(event: string, pageId: number, slug: string): Promise<void> {
    switch (event) {
      case "page:created":
      case "page:updated": {
        const title = await this.syncPageToRag(pageId, slug);
        console.log(`[wiki-sync] Synced "${title}" (${slug}) to RAG`);
        break;
      }
      case "page:deleted": {
        await this.ragStore.deleteDoc(`wiki:${pageId}`);
        console.log(`[wiki-sync] Removed wiki:${pageId} from RAG`);
        break;
      }
      default:
        console.log(`[wiki-sync] Ignored unknown event: ${event}`);
    }
  }

  /** 通过 Wiki.js GraphQL API 获取页面内容并同步到 RAG */
  async syncPageToRag(pageId: number, slug: string): Promise<string> {
    const content = await this.fetchPageContent(pageId);

    const wikiDocId = `wiki:${pageId}`;
    await this.ragStore.deleteDoc(wikiDocId);

    const { RecursiveCharacterTextSplitter } = await import("langchain/text_splitter");
    const { Document } = await import("@langchain/core/documents");

    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const docs = await splitter.splitDocuments([
      new Document({
        pageContent: content,
        metadata: { filename: `${slug}.md`, source: `wiki/${slug}` },
      }),
    ]);

    const chunks = docs.map((d) => ({
      content: d.pageContent,
      metadata: { ...d.metadata },
    }));

    await this.ragStore.addChunks(chunks, wikiDocId);

    // Extract title from first heading
    const firstLine = content.split("\n")[0];
    return firstLine.replace(/^#\s+/, "").trim() || `Page ${pageId}`;
  }

  /** 调用 Wiki.js GraphQL API */
  private async fetchPageContent(pageId: number): Promise<string> {
    const query = `
      query ($id: Int!) {
        pages {
          single(id: $id) {
            id
            title
            content
            path
          }
        }
      }
    `;

    const res = await fetch(`${this.wikiUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({ query, variables: { id: pageId } }),
    });

    if (!res.ok) {
      throw new Error(`Wiki.js GraphQL API error: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as {
      data: { pages: { single: { title: string; content: string; path: string } } };
    };

    if (!json.data?.pages?.single) {
      throw new Error(`Wiki.js page ${pageId} not found`);
    }

    return json.data.pages.single.content;
  }
}
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit
```
Expected: 无类型错误。

---

### Task 3: 修改服务器 — 添加 Webhook 端点 + 移除旧 Wiki 路由

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 修改 createRagServer — 移除 wikiStore 参数和相关逻辑**

编辑 `src/server/index.ts`：

移除函数签名中的 `wikiStore` 参数：

```typescript
// 修改前（第68行附近）
export function createRagServer(
  store: RagVectorStore,
  port: number = 3001,
  executor?: AgentExecutor,
  resumeStore?: ResumeStore,
  resumeData?: ResumeData,
  wikiStore?: WikiStore,   // ← 删除这行
) {

// 修改后
export function createRagServer(
  store: RagVectorStore,
  port: number = 3001,
  executor?: AgentExecutor,
  resumeStore?: ResumeStore,
  resumeData?: ResumeData,
) {
```

移除 `WikiStore` import：

```typescript
// 删除这行
import type { WikiStore } from "../wiki/store.js";
```

移除文件尾的 Wiki 路由挂载（第312-314行）：

```typescript
// 删除整个块
if (wikiStore) {
    app.use(createWikiRouter(wikiStore));
}
```

移除 `createWikiRouter` import：

```typescript
// 删除这行
import { createWikiRouter } from "../wiki/router.js";
```

移除 upload handler 中的 wiki 文章创建代码（第159-168行）：

```typescript
// 删除整个 if (wikiStore) 块
if (wikiStore) {
    try {
      const fullContent = chunks.map(c => c.content).join("\n\n");
      const article = await wikiStore.createArticleFromUpload(filename, fullContent);
      console.log(`[wiki] Created article from upload: ${article.title} (${article.slug})`);
    } catch (wikiErr) {
      console.warn(`[wiki] Could not create article from upload:`, (wikiErr as Error).message);
    }
}
```

- [ ] **Step 2: 添加 Webhook 端点和 WikiSyncService 初始化**

在 `src/server/index.ts` 中，移除 wikiStore 相关代码后，添加 Webhook 端点。

在文件开头添加 import：

```typescript
import { WikiSyncService } from "../wiki-sync/service.js";
```

在函数体内，`app.use(express.json());` 之后添加初始化：

```typescript
// Wiki.js → RAG 同步
const wikiSyncService = new WikiSyncService(
  process.env.WIKIJS_URL || "http://localhost:3003",
  process.env.WIKIJS_API_TOKEN || "",
  store,
);
```

在文件尾部（`app.get("/favicon.ico"` 之前）添加 Webhook 端点：

```typescript
// Wiki.js webhook receiver — 接收页面变更事件并同步到 RAG
app.post("/api/wiki-sync", async (req, res) => {
  try {
    const { event, pageId, slug } = req.body;
    if (!event || !pageId) {
      return res.status(400).json({ error: "Missing event or pageId" });
    }
    await wikiSyncService.handleEvent(event, pageId, slug || "");
    res.json({ ok: true });
  } catch (err) {
    console.error("[wiki-sync] Error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 3: 修改 src/index.ts — 移除 WikiStore 初始化**

编辑 `src/index.ts`：

删除 WikiStore import：
```typescript
// 删除这行
import { WikiStore } from "./wiki/store.js";
```

删除 Wiki 初始化代码块（第67-75行）：
```typescript
// 删除整个块
let wikiStore: WikiStore | undefined;
try {
  wikiStore = await WikiStore.create("navigate.db", ragStore);
  console.log("Wiki knowledge base initialized");
} catch (err) {
  console.warn("Wiki initialization skipped:", (err as Error).message);
}
```

修改 `createRagServer` 调用，移除 `wikiStore` 参数：
```typescript
// 修改前
createRagServer(ragStore, 3001, executor, resumeStore, resumeData, wikiStore);

// 修改后
createRagServer(ragStore, 3001, executor, resumeStore, resumeData);
```

- [ ] **Step 4: 类型检查**

```bash
npx tsc --noEmit
```
Expected: 无类型错误。

- [ ] **Step 5: 配置 Wiki.js Webhook**

Wiki.js 管理后台 → **Webhook** → 新增：

| 字段 | 值 |
|------|-----|
| 名称 | Navigate RAG Sync |
| 触发事件 | `page:created`, `page:updated`, `page:deleted` |
| URL | `http://localhost:3001/api/wiki-sync` |
| 签名密钥 | （留空） |

保存后，在 Wiki.js 中创建/编辑一篇文章，观察主应用控制台是否输出 `[wiki-sync] Synced` 日志。

---

## Phase 3: 前端导航栏集成

### Task 4: 更新导航栏链接

**Files:**
- Modify: `src/server/public/index.html`
- Modify: `src/server/public/resume.html`
- Modify: `src/server/public/resume-chat.html`

- [ ] **Step 1: 更新 index.html 导航栏**

编辑 `src/server/public/index.html`，将 Wiki 链接改为指向 Wiki.js：

```html
<!-- 修改前（第79行） -->
<a href="/wiki" style="color:#6b7280;text-decoration:none;padding:6px 16px;border-radius:8px;">📚 Wiki</a>

<!-- 修改后 -->
<a href="http://localhost:3003" target="_blank" style="color:#6b7280;text-decoration:none;padding:6px 16px;border-radius:8px;">📚 Wiki ↗</a>
```

- [ ] **Step 2: 更新 resume.html 导航栏**

编辑 `src/server/public/resume.html`，在导航栏增加 Wiki 链接：

```html
<!-- 修改前（第134-137行） -->
<div class="nav-bar">
    <a href="/">📄 文档管理</a>
    <a href="/resume" class="active">👤 简历</a>
    <a href="/resume/chat">💬 简历问答</a>
</div>

<!-- 修改后 -->
<div class="nav-bar">
    <a href="/">📄 文档管理</a>
    <a href="http://localhost:3003" target="_blank">📚 Wiki ↗</a>
    <a href="/resume" class="active">👤 简历</a>
    <a href="/resume/chat">💬 简历问答</a>
</div>
```

- [ ] **Step 3: 更新 resume-chat.html 导航栏**

编辑 `src/server/public/resume-chat.html`，在导航栏增加 Wiki 链接：

```html
<!-- 修改前（第180-185行） -->
<div class="nav-bar">
  <span class="title">🤖 简历AI问答</span>
  <a href="/">📄 文档</a>
  <a href="/resume">👤 简历</a>
  <a href="/resume/chat" class="active">💬 问答</a>
</div>

<!-- 修改后 -->
<div class="nav-bar">
  <span class="title">🤖 简历AI问答</span>
  <a href="/">📄 文档</a>
  <a href="http://localhost:3003" target="_blank">📚 Wiki ↗</a>
  <a href="/resume">👤 简历</a>
  <a href="/resume/chat" class="active">💬 问答</a>
</div>
```

- [ ] **Step 4: 验证导航栏修改**

启动主应用：`npm run dev`
检查页面：
1. `http://localhost:3001` → 导航栏有 📚 Wiki ↗ 链接，点击在新标签页打开 localhost:3003
2. `http://localhost:3001/resume` → 同上
3. `http://localhost:3001/resume/chat` → 同上

---

### Task 5: 删除旧的 Wiki HTML 文件

**Files:**
- Delete: `src/server/public/wiki.html`
- Delete: `src/server/public/wiki-edit.html`
- Delete: `src/server/public/wiki-article.html`

- [ ] **Step 1: 删除文件**

```bash
rm src/server/public/wiki.html
rm src/server/public/wiki-edit.html
rm src/server/public/wiki-article.html
```

---

## Phase 4: 数据迁移

### Task 6: 编写迁移脚本

**Files:**
- Create: `scripts/migrate-wiki-to-wikijs.ts`

- [ ] **Step 1: 创建迁移脚本**

创建 `scripts/migrate-wiki-to-wikijs.ts`：

```typescript
/**
 * Wiki 数据迁移脚本
 *
 * 从旧的 navigate.db (SQLite) 读取 wiki_articles 和 wiki_categories，
 * 通过 Wiki.js GraphQL API 在 Wiki.js 中重建页面和目录结构。
 *
 * 用法: npx tsx scripts/migrate-wiki-to-wikijs.ts
 */

import initSqlJs, { Database } from "sql.js";
import { readFileSync, existsSync } from "node:fs";

interface OldArticle {
  id: string;
  title: string;
  contentMd: string;
  categoryId: string | null;
  tags: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface OldCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
}

const WIKIJS_URL = process.env.WIKIJS_URL || "http://localhost:3003";
const WIKIJS_TOKEN = process.env.WIKIJS_API_TOKEN || "";
const DB_PATH = process.env.DB_PATH || "navigate.db";
const PAGE_SIZE = 100; // Wiki.js pages.create 每次创建一页

interface MigrationReport {
  categoriesCreated: number;
  articlesMigrated: number;
  articlesSkipped: number;
  errors: string[];
}

async function createNamespace(name: string, slug: string): Promise<number | null> {
  // Wiki.js namespaces.create mutation
  const query = `
    mutation ($name: String!, $slug: String!) {
      namespaces {
        create(name: $name, slug: $slug) {
          responseResult {
            succeeded
            errorCode
            slug
          }
        }
      }
    }
  `;
  const res = await fetch(`${WIKIJS_URL}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WIKIJS_TOKEN}`,
    },
    body: JSON.stringify({ query, variables: { name, slug } }),
  });
  const json = await res.json();
  const result = json?.data?.namespaces?.create?.responseResult;
  if (result?.succeeded) {
    console.log(`  Created namespace: ${name} (${slug})`);
    return 1;
  }
  if (result?.errorCode === "slug_already_taken") {
    console.log(`  Namespace already exists: ${slug}`);
    return 1;
  }
  console.warn(`  Failed to create namespace ${slug}:`, JSON.stringify(result));
  return null;
}

async function createPage(
  title: string,
  content: string,
  tags: string[],
  namespaceSlug: string,
): Promise<number | null> {
  const query = `
    mutation ($content: String!, $title: String!, $tags: [String], $namespaceSlug: String!) {
      pages {
        create(content: $content, title: $title, tags: $tags, namespaceSlug: $namespaceSlug, isPublished: true, editor: "markdown") {
          responseResult {
            succeeded
            errorCode
            slug
          }
        }
      }
    }
  `;
  const res = await fetch(`${WIKIJS_URL}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WIKIJS_TOKEN}`,
    },
    body: JSON.stringify({
      query,
      variables: { title, content, tags: tags.length > 0 ? tags : undefined, namespaceSlug },
    }),
  });
  const json = await res.json();
  const result = json?.data?.pages?.create?.responseResult;
  if (result?.succeeded) {
    return 1;
  }
  if (result?.errorCode === "slug_already_taken") {
    console.warn(`  Page skipped (slug exists): ${title}`);
    return 0; // skipped
  }
  console.warn(`  Failed to create page "${title}":`, JSON.stringify(result));
  return null;
}

async function migrate(): Promise<void> {
  if (!WIKIJS_TOKEN) {
    console.error("❌ WIKIJS_API_TOKEN environment variable is required");
    console.error("   Get a token from Wiki.js Admin → API Access");
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.log("ℹ️  No old wiki database found at", DB_PATH);
    console.log("   Nothing to migrate.");
    return;
  }

  console.log("📚 Wiki.js Migration Script");
  console.log(`   Source DB: ${DB_PATH}`);
  console.log(`   Target:    ${WIKIJS_URL}`);
  console.log("");

  // 1. Load old database
  const SQL = await initSqlJs();
  const buf = readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  // 2. Read categories
  const catRows = db.exec(
    "SELECT id, name, slug, description FROM wiki_categories ORDER BY sort_order ASC"
  );
  const categories: OldCategory[] = [];
  if (catRows.length && catRows[0].values.length) {
    for (const row of catRows[0].values) {
      categories.push({
        id: row[0] as string,
        name: row[1] as string,
        slug: row[2] as string,
        description: (row[3] as string) || "",
      });
    }
  }
  console.log(`Found ${categories.length} categories, migrating as namespaces...`);

  const report: MigrationReport = {
    categoriesCreated: 0,
    articlesMigrated: 0,
    articlesSkipped: 0,
    errors: [],
  };

  // 3. Create namespaces for categories
  for (const cat of categories) {
    const result = await createNamespace(cat.name, cat.slug);
    if (result === 1) report.categoriesCreated++;
    else if (result === null) report.errors.push(`Category namespace: ${cat.name}`);
    // result === 0 (skipped) doesn't apply to namespaces
  }

  // Always ensure a default namespace for uncategorized articles
  await createNamespace("未分类", "uncategorized");

  // 4. Read articles
  const artRows = db.exec(
    "SELECT id, title, content_md, category_id, tags, status, created_at, updated_at FROM wiki_articles ORDER BY created_at ASC"
  );
  const articles: OldArticle[] = [];
  if (artRows.length && artRows[0].values.length) {
    for (const row of artRows[0].values) {
      articles.push({
        id: row[0] as string,
        title: row[1] as string,
        contentMd: row[2] as string,
        categoryId: (row[3] as string) || null,
        tags: ((row[4] as string) || "").split(",").filter(Boolean),
        status: (row[5] as string) || "published",
        createdAt: (row[6] as string) || new Date().toISOString(),
        updatedAt: (row[7] as string) || new Date().toISOString(),
      });
    }
  }

  if (articles.length === 0) {
    console.log("No articles found to migrate.");
    db.close();
    console.log("\n✅ Migration complete (no data)");
    return;
  }

  console.log(`\nFound ${articles.length} articles, migrating...`);

  // Build category → namespace slug lookup
  const catToNs = new Map<string, string>();
  for (const cat of categories) {
    catToNs.set(cat.id, cat.slug);
  }

  // 5. Create pages
  for (const article of articles) {
    const nsSlug = article.categoryId ? (catToNs.get(article.categoryId) || "uncategorized") : "uncategorized";
    const result = await createPage(article.title, article.contentMd, article.tags, nsSlug);
    if (result === 1) report.articlesMigrated++;
    else if (result === 0) report.articlesSkipped++;
    else report.errors.push(`Article: ${article.title}`);
  }

  db.close();

  // 6. Report
  console.log("\n═══════════════════════════════");
  console.log("      Migration Report");
  console.log("═══════════════════════════════");
  console.log(`  Categories created:  ${report.categoriesCreated}/${categories.length}`);
  console.log(`  Articles migrated:   ${report.articlesMigrated}/${articles.length}`);
  console.log(`  Articles skipped:    ${report.articlesSkipped}`);
  console.log(`  Errors:              ${report.errors.length}`);
  if (report.errors.length > 0) {
    console.log("\n  Errors details:");
    for (const err of report.errors) {
      console.log(`    - ${err}`);
    }
  }
  console.log("═══════════════════════════════\n");
  console.log("Next: verify articles at http://localhost:3003");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: 运行迁移脚本**

确保 Wiki.js 正在运行，API Token 已配置：

```bash
WIKIJS_API_TOKEN=<your-token> npx tsx scripts/migrate-wiki-to-wikijs.ts
```

Expected 输出示例：
```
📚 Wiki.js Migration Script
   Source DB: navigate.db
   Target:    http://localhost:3003

Found 3 categories, migrating as namespaces...
  Created namespace: 开发指南 (dev-guide)
  Created namespace: 使用手册 (manual)
  Created namespace: 未分类 (uncategorized)

Found 15 articles, migrating...

═══════════════════════════════
      Migration Report
═══════════════════════════════
  Categories created:  3/3
  Articles migrated:   15/15
  Articles skipped:    0
  Errors:              0
═══════════════════════════════
```

---

## Phase 5: 验证

### Task 7: 端到端验证

- [ ] **Step 1: 启动两个服务**

```bash
# 终端 1：Wiki.js
cd wiki-js && node server start

# 终端 2：主应用
npx tsx src/index.ts
```

- [ ] **Step 2: 验证导航栏**

打开 `http://localhost:3001` → 点击 📚 Wiki ↗ → 应跳转到 `http://localhost:3003`
打开 `http://localhost:3001/resume` → 导航栏包含 📚 Wiki ↗
打开 `http://localhost:3001/resume/chat` → 导航栏包含 📚 Wiki ↗

- [ ] **Step 3: 验证 Wiki.js 正常运行**

`http://localhost:3003` → Wiki.js 页面加载正常
确认已迁移的文章出现在 Wiki.js 目录中

- [ ] **Step 4: 验证 RAG 同步（Webhook）**

1. 在 Wiki.js 中创建一篇新文章（如 "测试 RAG 同步"）
2. 观察主应用控制台输出 `[wiki-sync] Synced "测试 RAG 同步" to RAG`
3. 在 Agent CLI 中搜索相关内容，确认能检索到新文章

- [ ] **Step 5: 验证 RAG 删除同步**

1. 在 Wiki.js 中删除刚才创建的文章
2. 观察主应用控制台输出 `[wiki-sync] Removed wiki:{pageId} from RAG`
3. 确认搜索结果不再包含已删除的文章内容

- [ ] **Step 6: 验证旧页面已不可访问**

访问以下 URL 应返回 404：
- `http://localhost:3001/wiki`
- `http://localhost:3001/wiki/edit`
- `http://localhost:3001/wiki/article`
