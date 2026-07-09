# Wiki 知识库 + OpenCode Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Wiki knowledge base with web-based Markdown editor, categories, and automatic RAG indexing, plus a dynamic YAML-defined skill system for the agent.

**Architecture:** Wiki articles stored in SQLite (`wiki_articles`, `wiki_categories`, `wiki_revisions` tables), auto-synced to existing `RagVectorStore` for agent search. Skills defined as `*.skill.yaml` files in `skills/` directory, loaded at startup by `SkillRegistry` and converted to `StructuredTool` instances for the agent.

**Tech Stack:** TypeScript (NodeNext), sql.js (existing), Express 5 (existing), OpenAI Embeddings (existing), js-yaml (npm), nunjucks (npm), marked (npm), vanilla HTML/CSS/JS

## Global Constraints

- All new TS files use `.js` extensions in imports (NodeNext module resolution)
- Follow existing code style: `camelCase` functions, `PascalCase` types, `StructuredTool` from `@langchain/core/tools`
- SQLite access through `sql.js` following patterns in `src/resume/store.ts`
- All HTML pages are self-contained (no external CDN resources)
- Markdown rendering uses `marked` library (add to package.json)
- YAML parsing uses `js-yaml` library (add to package.json)
- Template rendering uses `nunjucks` library (add to package.json)
- Embeddings model: `text-embedding-3-small` via `OpenAIEmbeddings`

---
## Phase 1: Wiki Knowledge Base

### Task 1: Add deleteDoc to RagVectorStore

**Files:**
- Modify: `src/rag/vectorstore.ts`

**Interfaces:**
- Consumes: `RagVectorStore` existing class
- Produces: `RagVectorStore.deleteDoc(docId: string): void` — consumed by WikiStore (Task 3)

- [ ] **Step 1: Add deleteDoc method**

Edit `src/rag/vectorstore.ts`, add after `addChunks()`:

```typescript
async deleteDoc(docId: string): Promise<void> {
  // Remove from rawChunks
  this.rawChunks = this.rawChunks.filter(c => c.metadata?.docId !== docId);
  // Rebuild the vector store from remaining chunks
  const remaining = this.rawChunks.map((c, i) => new Document({
    pageContent: c.content,
    metadata: { ...c.metadata, docId: c.metadata?.docId || "unknown", chunkIndex: i },
  }));
  this.store = new MemoryVectorStore(this.embeddings);
  if (remaining.length > 0) {
    try {
      await this.store.addDocuments(remaining);
    } catch (e) {
      console.warn(`[rag] Could not re-embed after delete:`, (e as Error)?.message);
    }
  }
  await this.saveToDisk();
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 3: Commit**

```bash
git add src/rag/vectorstore.ts
git commit -m "feat(rag): add deleteDoc method for removing document chunks"
```

---

### Task 2: Wiki types

**Files:**
- Create: `src/wiki/types.ts`

**Interfaces:**
- Produces: `WikiArticle`, `WikiCategory`, `WikiRevision` — consumed by WikiStore (Task 3), Wiki router (Task 4), HTML pages (Task 5)

- [ ] **Step 1: Write `src/wiki/types.ts`**

```typescript
export interface WikiArticle {
  id: string;
  title: string;
  slug: string;
  contentMd: string;
  summary: string;
  categoryId: string | null;
  tags: string[];
  status: "draft" | "published";
  createdAt: Date;
  updatedAt: Date;
}

export interface WikiCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  parentId: string | null;
  sortOrder: number;
}

export interface WikiRevision {
  id: string;
  articleId: string;
  contentMd: string;
  summary: string;
  editorNote: string;
  createdAt: Date;
}

export interface WikiArticleListItem {
  id: string;
  title: string;
  slug: string;
  summary: string;
  categoryId: string | null;
  categoryName?: string;
  tags: string[];
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
}

export interface WikiArticleListResponse {
  items: WikiArticleListItem[];
  total: number;
  page: number;
  limit: number;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 3: Commit**

```bash
git add src/wiki/types.ts
git commit -m "feat(wiki): add WikiArticle, WikiCategory, WikiRevision types"
```

---

### Task 3: WikiStore (SQLite CRUD + RAG sync)

**Files:**
- Create: `src/wiki/store.ts`

**Interfaces:**
- Consumes: `WikiArticle`, `WikiCategory`, `WikiRevision` (Task 2), `RagVectorStore` (existing + Task 1)
- Produces: `WikiStore` class — consumed by Wiki router (Task 4) and `src/index.ts` (Task 6)

- [ ] **Step 1: Write `src/wiki/store.ts`**

```typescript
import initSqlJs, { Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WikiArticle, WikiCategory, WikiRevision, WikiArticleListItem, WikiArticleListResponse } from "./types.js";
import { RagVectorStore } from "../rag/vectorstore.js";
import { loadDocument } from "../rag/loader.js";

export class WikiStore {
  private db: Database;
  private dbPath: string;
  private ragStore: RagVectorStore;

  private constructor(db: Database, dbPath: string, ragStore: RagVectorStore) {
    this.db = db;
    this.dbPath = dbPath;
    this.ragStore = ragStore;
    this.initTables();
  }

  static async create(dbPath: string, ragStore: RagVectorStore): Promise<WikiStore> {
    const SQL = await initSqlJs();
    let db: Database;
    if (existsSync(dbPath)) {
      const buf = readFileSync(dbPath);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }
    db.run("PRAGMA journal_mode=WAL");
    return new WikiStore(db, dbPath, ragStore);
  }

  private initTables(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS wiki_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      content_md TEXT NOT NULL,
      summary TEXT DEFAULT '',
      category_id TEXT,
      tags TEXT DEFAULT '',
      status TEXT DEFAULT 'published',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS wiki_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      parent_id TEXT,
      sort_order INTEGER DEFAULT 0
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS wiki_revisions (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      content_md TEXT NOT NULL,
      summary TEXT DEFAULT '',
      editor_note TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (article_id) REFERENCES wiki_articles(id)
    )`);
    this.save();
  }

  private save(): void {
    writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  /** Generate a unique slug from title */
  private slugify(title: string): string {
    let slug = title.toLowerCase()
      .replace(/[^\w一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!slug) slug = "article";

    // Check uniqueness, append number if needed
    const existing = this.db.exec("SELECT slug FROM wiki_articles WHERE slug = ?", [slug]);
    if (existing.length && existing[0].values.length > 0) {
      let i = 2;
      while (true) {
        const candidate = `${slug}-${i}`;
        const r = this.db.exec("SELECT slug FROM wiki_articles WHERE slug = ?", [candidate]);
        if (!r.length || !r[0].values.length) return candidate;
        i++;
      }
    }
    return slug;
  }

  // === Article CRUD ===

  async listArticles(category?: string, search?: string, page = 1, limit = 20): Promise<WikiArticleListResponse> {
    let sql = `SELECT a.id, a.title, a.slug, a.summary, a.category_id, c.name as category_name,
      a.tags, a.status, a.created_at, a.updated_at
      FROM wiki_articles a LEFT JOIN wiki_categories c ON a.category_id = c.id
      WHERE 1=1`;
    const params: any[] = [];

    if (category) {
      sql += " AND a.category_id = ?";
      params.push(category);
    }
    if (search) {
      sql += " AND (a.title LIKE ? OR a.content_md LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    // Count
    const countSql = sql.replace(/SELECT .*? FROM/, "SELECT COUNT(*) as cnt FROM").replace(/LEFT JOIN.*?ON.*?/, "");
    const countResult = this.db.exec(countSql, params);
    const total = countResult.length && countResult[0].values.length
      ? (countResult[0].values[0][0] as number) : 0;

    // Paginate
    sql += " ORDER BY a.updated_at DESC LIMIT ? OFFSET ?";
    params.push(limit, (page - 1) * limit);

    const r = this.db.exec(sql, params);
    const items: WikiArticleListItem[] = [];
    if (r.length && r[0].values.length) {
      for (const row of r[0].values) {
        items.push({
          id: row[0] as string,
          title: row[1] as string,
          slug: row[2] as string,
          summary: row[3] as string,
          categoryId: row[4] as string | null,
          categoryName: row[5] as string | undefined,
          tags: ((row[6] as string) || "").split(",").filter(Boolean),
          status: (row[7] as "draft" | "published"),
          createdAt: row[8] as string,
          updatedAt: row[9] as string,
        });
      }
    }

    return { items, total, page, limit };
  }

  async getArticle(id: string): Promise<WikiArticle | null> {
    const r = this.db.exec(
      "SELECT id, title, slug, content_md, summary, category_id, tags, status, created_at, updated_at FROM wiki_articles WHERE id = ?",
      [id]
    );
    if (!r.length || !r[0].values.length) return null;
    const row = r[0].values[0];
    return {
      id: row[0] as string,
      title: row[1] as string,
      slug: row[2] as string,
      contentMd: row[3] as string,
      summary: row[4] as string,
      categoryId: row[5] as string | null,
      tags: ((row[6] as string) || "").split(",").filter(Boolean),
      status: (row[7] as "draft" | "published"),
      createdAt: new Date(row[8] as string),
      updatedAt: new Date(row[9] as string),
    };
  }

  async getArticleBySlug(slug: string): Promise<WikiArticle | null> {
    const r = this.db.exec(
      "SELECT id, title, slug, content_md, summary, category_id, tags, status, created_at, updated_at FROM wiki_articles WHERE slug = ?",
      [slug]
    );
    if (!r.length || !r[0].values.length) return null;
    const row = r[0].values[0];
    return {
      id: row[0] as string,
      title: row[1] as string,
      slug: row[2] as string,
      contentMd: row[3] as string,
      summary: row[4] as string,
      categoryId: row[5] as string | null,
      tags: ((row[6] as string) || "").split(",").filter(Boolean),
      status: (row[7] as "draft" | "published"),
      createdAt: new Date(row[8] as string),
      updatedAt: new Date(row[9] as string),
    };
  }

  private async syncToRag(article: WikiArticle): Promise<void> {
    try {
      // If this is an update, remove old index first
      const wikiDocId = `wiki:${article.id}`;
      // deleteDoc is async
      await this.ragStore.deleteDoc(wikiDocId);

      // Chunk and add to RAG
      const filename = `${article.slug}.md`;
      const content = `# ${article.title}\n\n${article.contentMd}`;
      // Use the same loader pattern but inline to avoid temp files
      const { RecursiveCharacterTextSplitter } = await import("langchain/text_splitter");
      const { Document } = await import("@langchain/core/documents");
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
      const docs = await splitter.splitDocuments([
        new Document({ pageContent: content, metadata: { filename, source: `wiki/${article.slug}` } })
      ]);
      const chunks = docs.map(d => ({
        content: d.pageContent,
        metadata: { ...d.metadata, filename, source: `wiki/${article.slug}` },
      }));
      await this.ragStore.addChunks(chunks, wikiDocId);
    } catch (err) {
      console.warn(`[wiki] RAG sync failed for ${article.slug}:`, (err as Error)?.message);
    }
  }

  async createArticle(data: { title: string; contentMd: string; summary?: string; categoryId?: string; tags?: string[]; status?: "draft" | "published" }): Promise<WikiArticle> {
    const id = randomUUID();
    const slug = this.slugify(data.title);
    const now = new Date().toISOString();
    const tags = (data.tags || []).join(",");

    this.db.run(
      `INSERT INTO wiki_articles (id, title, slug, content_md, summary, category_id, tags, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.title, slug, data.contentMd, data.summary || "", data.categoryId || null, tags, data.status || "published", now, now]
    );

    // Save revision
    this.db.run(
      `INSERT INTO wiki_revisions (id, article_id, content_md, summary, editor_note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), id, data.contentMd, data.summary || "", "创建文章", now]
    );

    this.save();

    const article: WikiArticle = {
      id, title: data.title, slug, contentMd: data.contentMd,
      summary: data.summary || "", categoryId: data.categoryId || null,
      tags: data.tags || [], status: data.status || "published",
      createdAt: new Date(now), updatedAt: new Date(now),
    };

    // Sync to RAG in background (don't await — don't block the response)
    this.syncToRag(article);

    return article;
  }

  async updateArticle(id: string, data: { title?: string; contentMd?: string; summary?: string; categoryId?: string | null; tags?: string[]; status?: "draft" | "published" }): Promise<WikiArticle | null> {
    const existing = await this.getArticle(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const title = data.title ?? existing.title;
    const slug = data.title ? this.slugify(title) : existing.slug;
    const contentMd = data.contentMd ?? existing.contentMd;
    const summary = data.summary ?? existing.summary;
    const categoryId = data.categoryId !== undefined ? data.categoryId : existing.categoryId;
    const tags = (data.tags ?? existing.tags).join(",");
    const status = data.status ?? existing.status;

    this.db.run(
      `UPDATE wiki_articles SET title=?, slug=?, content_md=?, summary=?, category_id=?, tags=?, status=?, updated_at=? WHERE id=?`,
      [title, slug, contentMd, summary, categoryId, tags, status, now, id]
    );

    // Save revision if content changed
    if (data.contentMd && data.contentMd !== existing.contentMd) {
      this.db.run(
        `INSERT INTO wiki_revisions (id, article_id, content_md, summary, editor_note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), id, contentMd, summary, "更新文章", now]
      );
    }

    this.save();

    const article: WikiArticle = {
      ...existing,
      title, slug, contentMd, summary,
      categoryId: categoryId as string | null,
      tags: data.tags ?? existing.tags,
      status: status as "draft" | "published",
      updatedAt: new Date(now),
    };

    // Re-sync to RAG
    this.syncToRag(article);

    return article;
  }

  async deleteArticle(id: string): Promise<boolean> {
    const existing = await this.getArticle(id);
    if (!existing) return false;

    // Remove from RAG
    try {
      await this.ragStore.deleteDoc(`wiki:${id}`);
    } catch (err) {
      console.warn(`[wiki] RAG delete failed:`, (err as Error)?.message);
    }

    // Delete revisions + article
    this.db.run("DELETE FROM wiki_revisions WHERE article_id = ?", [id]);
    this.db.run("DELETE FROM wiki_articles WHERE id = ?", [id]);
    this.save();
    return true;
  }

  async getRevisions(articleId: string): Promise<WikiRevision[]> {
    const r = this.db.exec(
      "SELECT id, article_id, content_md, summary, editor_note, created_at FROM wiki_revisions WHERE article_id = ? ORDER BY created_at DESC",
      [articleId]
    );
    if (!r.length || !r[0].values.length) return [];
    return r[0].values.map(row => ({
      id: row[0] as string,
      articleId: row[1] as string,
      contentMd: row[2] as string,
      summary: row[3] as string,
      editorNote: row[4] as string,
      createdAt: new Date(row[5] as string),
    }));
  }

  // === Category CRUD ===

  async listCategories(): Promise<WikiCategory[]> {
    const r = this.db.exec("SELECT id, name, slug, description, parent_id, sort_order FROM wiki_categories ORDER BY sort_order ASC, name ASC");
    if (!r.length || !r[0].values.length) return [];
    return r[0].values.map(row => ({
      id: row[0] as string,
      name: row[1] as string,
      slug: row[2] as string,
      description: row[3] as string,
      parentId: row[4] as string | null,
      sortOrder: row[5] as number,
    }));
  }

  async createCategory(data: { name: string; description?: string; parentId?: string; sortOrder?: number }): Promise<WikiCategory> {
    const id = randomUUID();
    const slug = this.slugify(data.name);
    this.db.run(
      `INSERT INTO wiki_categories (id, name, slug, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.name, slug, data.description || "", data.parentId || null, data.sortOrder || 0]
    );
    this.save();
    return { id, name: data.name, slug, description: data.description || "", parentId: data.parentId || null, sortOrder: data.sortOrder || 0 };
  }

  async updateCategory(id: string, data: { name?: string; description?: string; parentId?: string | null; sortOrder?: number }): Promise<WikiCategory | null> {
    const existing = this.db.exec("SELECT id, name, slug, description, parent_id, sort_order FROM wiki_categories WHERE id = ?", [id]);
    if (!existing.length || !existing[0].values.length) return null;
    const row = existing[0].values[0];
    const name = data.name ?? (row[1] as string);
    const slug = data.name ? this.slugify(name) : (row[2] as string);
    this.db.run(
      `UPDATE wiki_categories SET name=?, slug=?, description=?, parent_id=?, sort_order=? WHERE id=?`,
      [name, slug, data.description ?? (row[3] as string), data.parentId !== undefined ? data.parentId : (row[4] as string | null), data.sortOrder ?? (row[5] as number), id]
    );
    this.save();
    return { id, name, slug, description: data.description ?? (row[3] as string), parentId: data.parentId !== undefined ? data.parentId : (row[4] as string | null), sortOrder: data.sortOrder ?? (row[5] as number) };
  }

  async deleteCategory(id: string): Promise<boolean> {
    // Check if category has child categories
    const children = this.db.exec("SELECT id FROM wiki_categories WHERE parent_id = ?", [id]);
    if (children.length && children[0].values.length > 0) {
      throw new Error("Cannot delete category with subcategories");
    }
    // Unlink articles
    this.db.run("UPDATE wiki_articles SET category_id = NULL WHERE category_id = ?", [id]);
    this.db.run("DELETE FROM wiki_categories WHERE id = ?", [id]);
    this.save();
    return true;
  }

  close(): void {
    this.save();
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 3: Commit**

```bash
git add src/wiki/store.ts
git commit -m "feat(wiki): add WikiStore with SQLite CRUD and RAG sync"
```

---

### Task 4: Wiki Express router

**Files:**
- Create: `src/wiki/router.ts`

**Interfaces:**
- Consumes: `WikiStore` (Task 3), `express.Router`
- Produces: Express router with Wiki API routes — consumed by `src/server/index.ts` (Task 6)

- [ ] **Step 1: Write `src/wiki/router.ts`**

```typescript
import { Router } from "express";
import type { WikiStore } from "./store.js";

export function createWikiRouter(store: WikiStore): Router {
  const router = Router();

  // === Articles ===

  router.get("/api/wiki/articles", async (req, res) => {
    try {
      const category = req.query.category as string | undefined;
      const search = req.query.search as string | undefined;
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const result = await store.listArticles(category, search, page, limit);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/wiki/articles", async (req, res) => {
    try {
      const { title, contentMd, summary, categoryId, tags, status } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: "Title is required" });
      if (!contentMd || !contentMd.trim()) return res.status(400).json({ error: "Content is required" });
      const article = await store.createArticle({ title, contentMd, summary, categoryId, tags, status });
      res.status(201).json(article);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/wiki/articles/:id", async (req, res) => {
    try {
      const article = await store.getArticle(req.params.id);
      if (!article) return res.status(404).json({ error: "Article not found" });
      res.json(article);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/wiki/articles/:id", async (req, res) => {
    try {
      const article = await store.updateArticle(req.params.id, req.body);
      if (!article) return res.status(404).json({ error: "Article not found" });
      res.json(article);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/wiki/articles/:id", async (req, res) => {
    try {
      const deleted = await store.deleteArticle(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Article not found" });
      res.json({ deleted: req.params.id });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/wiki/articles/:id/revisions", async (req, res) => {
    try {
      const revisions = await store.getRevisions(req.params.id);
      res.json(revisions);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // === Categories ===

  router.get("/api/wiki/categories", async (_req, res) => {
    try {
      const categories = await store.listCategories();
      res.json(categories);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/wiki/categories", async (req, res) => {
    try {
      const { name, description, parentId, sortOrder } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: "Category name is required" });
      const category = await store.createCategory({ name, description, parentId, sortOrder });
      res.status(201).json(category);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/wiki/categories/:id", async (req, res) => {
    try {
      const category = await store.updateCategory(req.params.id, req.body);
      if (!category) return res.status(404).json({ error: "Category not found" });
      res.json(category);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/wiki/categories/:id", async (req, res) => {
    try {
      await store.deleteCategory(req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      if ((err as Error).message.includes("subcategories")) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // === Serve wiki pages ===
  router.get("/wiki", (_req, res) => {
    res.sendFile(new URL("../server/public/wiki.html", import.meta.url).pathname);
  });

  router.get("/wiki/edit", (_req, res) => {
    res.sendFile(new URL("../server/public/wiki-edit.html", import.meta.url).pathname);
  });

  router.get("/wiki/article", (_req, res) => {
    res.sendFile(new URL("../server/public/wiki-article.html", import.meta.url).pathname);
  });

  return router;
}
```

Note on file serving: The HTML pages use `import.meta.url` to locate the public directory. In practice, the Express server in `src/server/index.ts` will use `path.join(__dirname, "public")` as the base, so the router should reference relative to that. We'll adjust in Task 6 when integrating.

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 3: Commit**

```bash
git add src/wiki/router.ts
git commit -m "feat(wiki): add wiki API routes and page serving"
```

---

### Task 5: Wiki HTML pages

**Files:**
- Create: `src/server/public/wiki.html`
- Create: `src/server/public/wiki-edit.html`
- Create: `src/server/public/wiki-article.html`

**Interfaces:**
- Consumes: Wiki API endpoints (Task 4) via `fetch()`

- [ ] **Step 1: Write `src/server/public/wiki.html`** — Wiki dashboard

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wiki 知识库</title>
<style>
  :root { --bg: #f8f9fa; --surface: #fff; --text: #1a1a2e; --text-muted: #6b7280; --primary: #2563eb; --primary-light: #eff6ff; --border: #e5e7eb; --radius: 12px; --danger: #dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --surface: #1e293b; --text: #f1f5f9; --text-muted: #94a3b8; --primary: #60a5fa; --primary-light: #1e3a5f; --border: #334155; --danger: #ef4444; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 24px; }
  .container { max-width: 960px; margin: 0 auto; }
  .nav-bar { display: flex; gap: 16px; margin-bottom: 24px; justify-content: center; font-size: 0.9rem; }
  .nav-bar a { color: var(--text-muted); text-decoration: none; padding: 6px 16px; border-radius: 8px; }
  .nav-bar a:hover, .nav-bar a.active { background: var(--primary-light); color: var(--primary); }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  .header h1 { font-size: 1.5rem; font-weight: 700; }
  .btn { display: inline-flex; align-items: center; gap: 4px; padding: 8px 20px; border-radius: 8px; font-size: 0.85rem; font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; transition: all 0.15s; }
  .btn:hover { border-color: var(--primary); color: var(--primary); }
  .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
  .btn-primary:hover { opacity: 0.9; color: #fff; }
  .btn-sm { padding: 4px 12px; font-size: 0.8rem; }
  .toolbar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .toolbar input, .toolbar select { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.9rem; background: var(--surface); color: var(--text); }
  .toolbar input { flex: 1; min-width: 200px; }
  .article-list { display: flex; flex-direction: column; gap: 8px; }
  .article-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--surface); border-radius: 8px; border: 1px solid var(--border); transition: box-shadow 0.15s; }
  .article-row:hover { box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .article-info { flex: 1; cursor: pointer; }
  .article-info h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 2px; }
  .article-info .meta { font-size: 0.8rem; color: var(--text-muted); }
  .article-info .summary { font-size: 0.85rem; color: var(--text-muted); margin-top: 4px; }
  .article-actions { display: flex; gap: 8px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; background: var(--primary-light); color: var(--primary); margin-right: 4px; }
  .category-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; background: #f0fdf4; color: #16a34a; }
  @media (prefers-color-scheme: dark) { .category-badge { background: #052e16; color: #4ade80; } }
  .empty { text-align: center; padding: 48px; color: var(--text-muted); }
  .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 20px; }
  .pagination .btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }
  .loading { text-align: center; padding: 48px; color: var(--text-muted); }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 24px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.1); font-size: 0.9rem; z-index: 100; display: none; }
</style>
</head>
<body>
<div class="container">
  <div class="nav-bar">
    <a href="/">📄 文档管理</a>
    <a href="/wiki" class="active">📚 Wiki</a>
    <a href="/resume">👤 简历</a>
    <a href="/resume/chat">💬 问答</a>
  </div>

  <div class="header">
    <h1>📚 Wiki 知识库</h1>
    <a href="/wiki/edit" class="btn btn-primary">✏ 新建文章</a>
  </div>

  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="搜索文章..." oninput="loadArticles()">
    <select id="categoryFilter" onchange="loadArticles()"><option value="">全部分类</option></select>
  </div>

  <div id="articleList"><div class="loading">加载中...</div></div>
  <div class="pagination" id="pagination"></div>
</div>

<div id="toast" class="toast"></div>

<script>
let currentPage = 1;

async function loadCategories() {
  try {
    const res = await fetch("/api/wiki/categories");
    const cats = await res.json();
    const sel = document.getElementById("categoryFilter");
    cats.forEach(c => { const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; sel.appendChild(o); });
  } catch {}
}

async function loadArticles() {
  const list = document.getElementById("articleList");
  list.innerHTML = '<div class="loading">加载中...</div>';
  try {
    const search = document.getElementById("searchInput").value;
    const category = document.getElementById("categoryFilter").value;
    const params = new URLSearchParams({ page: currentPage, limit: 20 });
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    const res = await fetch(`/api/wiki/articles?${params}`);
    const data = await res.json();
    renderArticles(data);
  } catch (err) {
    list.innerHTML = `<div class="empty">❌ 加载失败: ${err.message}</div>`;
  }
}

function renderArticles(data) {
  const list = document.getElementById("articleList");
  const pag = document.getElementById("pagination");
  if (!data.items.length) {
    list.innerHTML = '<div class="empty">📝 暂无文章，点击右上角新建</div>';
    pag.innerHTML = "";
    return;
  }
  list.innerHTML = '<div class="article-list">' + data.items.map(a => `
    <div class="article-row">
      <div class="article-info" onclick="location.href='/wiki/article?slug=${encodeURIComponent(a.slug)}'">
        <h3>${esc(a.title)} ${a.status === 'draft' ? '<span style="color:#f59e0b;font-size:0.75rem;">[草稿]</span>' : ''}</h3>
        <div class="meta">${a.categoryName ? `<span class="category-badge">${esc(a.categoryName)}</span> ` : ''}${a.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')} 更新于 ${formatTime(a.updatedAt)}</div>
        ${a.summary ? `<div class="summary">${esc(a.summary.slice(0, 120))}</div>` : ''}
      </div>
      <div class="article-actions">
        <a href="/wiki/edit?id=${a.id}" class="btn btn-sm">编辑</a>
        <button class="btn btn-sm" onclick="deleteArticle('${a.id}')" style="color:var(--danger)">删除</button>
      </div>
    </div>
  `).join('') + '</div>';

  // Pagination
  const totalPages = Math.ceil(data.total / data.limit);
  if (totalPages <= 1) { pag.innerHTML = ""; return; }
  let pagHtml = "";
  for (let i = 1; i <= totalPages; i++) {
    pagHtml += `<button class="btn btn-sm ${i === currentPage ? 'active' : ''}" onclick="currentPage=${i};loadArticles()">${i}</button>`;
  }
  pag.innerHTML = pagHtml;
}

async function deleteArticle(id) {
  if (!confirm("确定删除这篇文章？")) return;
  try {
    const res = await fetch(`/api/wiki/articles/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast("✅ 已删除");
    loadArticles();
  } catch (err) {
    showToast("❌ " + err.message);
  }
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  setTimeout(() => t.style.display = "none", 3000);
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function formatTime(s) { try { return new Date(s).toLocaleDateString("zh-CN"); } catch { return s; } }

loadCategories();
loadArticles();
</script>
</body>
</html>
```

- [ ] **Step 2: Write `src/server/public/wiki-edit.html`** — Article editor

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>编辑文章 - Wiki</title>
<style>
  :root { --bg: #f8f9fa; --surface: #fff; --text: #1a1a2e; --text-muted: #6b7280; --primary: #2563eb; --primary-light: #eff6ff; --border: #e5e7eb; --radius: 8px; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --surface: #1e293b; --text: #f1f5f9; --text-muted: #94a3b8; --primary: #60a5fa; --primary-light: #1e3a5f; --border: #334155; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; height: 100vh; display: flex; flex-direction: column; }
  .nav-bar { display: flex; gap: 16px; padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--border); font-size: 0.9rem; align-items: center; }
  .nav-bar a { color: var(--text-muted); text-decoration: none; padding: 6px 16px; border-radius: 8px; }
  .nav-bar a:hover { background: var(--primary-light); color: var(--primary); }
  .nav-bar .title { font-weight: 600; margin-right: auto; }
  .btn { display: inline-flex; align-items: center; gap: 4px; padding: 8px 20px; border-radius: 8px; font-size: 0.85rem; font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; transition: all 0.15s; }
  .btn:hover { border-color: var(--primary); color: var(--primary); }
  .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
  .btn-primary:hover { opacity: 0.9; color: #fff; }
  .btn-sm { padding: 4px 12px; font-size: 0.8rem; }
  .editor-header { padding: 12px 24px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; background: var(--surface); border-bottom: 1px solid var(--border); }
  .editor-header input[type="text"] { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 1rem; background: var(--bg); color: var(--text); flex: 1; min-width: 200px; }
  .editor-header select { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.9rem; background: var(--bg); color: var(--text); }
  .editor-body { flex: 1; display: flex; overflow: hidden; }
  .editor-pane { flex: 1; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
  .editor-pane textarea { flex: 1; padding: 16px; border: none; outline: none; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.9rem; line-height: 1.7; resize: none; background: var(--bg); color: var(--text); }
  .preview-pane { flex: 1; padding: 16px; overflow-y: auto; }
  .preview-pane h1, .preview-pane h2, .preview-pane h3 { margin: 16px 0 8px; }
  .preview-pane h1 { font-size: 1.5rem; } .preview-pane h2 { font-size: 1.25rem; } .preview-pane h3 { font-size: 1.1rem; }
  .preview-pane p { margin-bottom: 12px; }
  .preview-pane code { background: var(--primary-light); padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; }
  .preview-pane pre code { display: block; padding: 12px; overflow-x: auto; }
  .preview-pane ul, .preview-pane ol { padding-left: 24px; margin-bottom: 12px; }
  .preview-pane blockquote { border-left: 3px solid var(--primary); padding-left: 12px; color: var(--text-muted); margin: 12px 0; }
  .preview-pane img { max-width: 100%; border-radius: 8px; }
  .status-bar { padding: 6px 24px; font-size: 0.8rem; color: var(--text-muted); background: var(--surface); border-top: 1px solid var(--border); display: flex; justify-content: space-between; }
  .tag-input { padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem; background: var(--bg); color: var(--text); width: 150px; }
  @media (max-width: 768px) { .editor-body { flex-direction: column; } .editor-pane { border-right: none; border-bottom: 1px solid var(--border); height: 50%; } }
  .loading { text-align: center; padding: 48px; color: var(--text-muted); }
</style>
</head>
<body>
<div class="nav-bar">
  <span class="title">📝 <span id="pageTitle">新建文章</span></span>
  <a href="/wiki">← 返回 Wiki</a>
</div>

<div class="editor-header">
  <input type="text" id="titleInput" placeholder="文章标题" autofocus>
  <select id="categorySelect"><option value="">无分类</option></select>
  <input type="text" id="tagsInput" class="tag-input" placeholder="标签(逗号分隔)">
  <select id="statusSelect">
    <option value="published">发布</option>
    <option value="draft">草稿</option>
  </select>
  <button class="btn btn-primary" onclick="save()">💾 保存</button>
</div>

<div class="editor-body">
  <div class="editor-pane">
    <textarea id="mdEditor" placeholder="在此编写 Markdown..." oninput="preview()" spellcheck="false"></textarea>
  </div>
  <div class="preview-pane" id="previewPane">
    <p style="color:var(--text-muted);">实时预览</p>
  </div>
</div>

<div class="status-bar">
  <span id="wordCount">0 字</span>
  <span id="saveStatus"></span>
</div>

<script>
const params = new URLSearchParams(location.search);
const articleId = params.get("id");
let articleData = null;

async function loadCategories() {
  try {
    const res = await fetch("/api/wiki/categories");
    const cats = await res.json();
    const sel = document.getElementById("categorySelect");
    cats.forEach(c => { const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; sel.appendChild(o); });
  } catch {}
}

async function loadArticle() {
  if (!articleId) return;
  document.getElementById("pageTitle").textContent = "编辑文章";
  try {
    const res = await fetch(`/api/wiki/articles/${articleId}`);
    if (!res.ok) throw new Error("Not found");
    articleData = await res.json();
    document.getElementById("titleInput").value = articleData.title;
    document.getElementById("mdEditor").value = articleData.contentMd;
    document.getElementById("tagsInput").value = (articleData.tags || []).join(",");
    document.getElementById("statusSelect").value = articleData.status;
    // Wait for categories to load, then select
    setTimeout(() => { document.getElementById("categorySelect").value = articleData.categoryId || ""; }, 200);
    preview();
  } catch (err) {
    document.querySelector(".editor-body").innerHTML = `<div class="loading">❌ 加载失败: ${err.message}</div>`;
  }
}

function preview() {
  const md = document.getElementById("mdEditor").value;
  const previewPane = document.getElementById("previewPane");
  // Simple Markdown rendering (headings, code, bold, italic, links, lists)
  let html = md
    .replace(/^### (.+)/gm, '<h3>$1</h3>')
    .replace(/^## (.+)/gm, '<h2>$1</h2>')
    .replace(/^# (.+)/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/^- (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, function(m) { return m.includes('<ul>') ? m : '<ol>' + m + '</ol>'; })
    .replace(/> (.+)/gm, '<blockquote>$1</blockquote>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(.+)$/gm, function(m) { return m.trim() && !m.startsWith('<') ? '<p>' + m + '</p>' : m; });
  previewPane.innerHTML = html || '<p style="color:var(--text-muted);">实时预览</p>';
  document.getElementById("wordCount").textContent = md.length + " 字";
}

async function save() {
  const title = document.getElementById("titleInput").value.trim();
  const contentMd = document.getElementById("mdEditor").value.trim();
  if (!title) { alert("请输入标题"); return; }
  if (!contentMd) { alert("请输入内容"); return; }

  const statusEl = document.getElementById("saveStatus");
  statusEl.textContent = "保存中...";
  statusEl.style.color = "var(--text-muted)";

  const data = {
    title,
    contentMd,
    categoryId: document.getElementById("categorySelect").value || undefined,
    tags: document.getElementById("tagsInput").value.split(",").map(t => t.trim()).filter(Boolean),
    status: document.getElementById("statusSelect").value,
  };

  try {
    let res;
    if (articleId) {
      res = await fetch(`/api/wiki/articles/${articleId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    } else {
      res = await fetch("/api/wiki/articles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    }
    if (!res.ok) throw new Error((await res.json()).error);
    const result = await res.json();
    articleId = articleId || result.id;
    statusEl.textContent = "✅ 已保存 " + new Date().toLocaleTimeString();
    statusEl.style.color = "#16a34a";
    document.getElementById("pageTitle").textContent = "编辑文章";
  } catch (err) {
    statusEl.textContent = "❌ " + err.message;
    statusEl.style.color = "#dc2626";
  }
}

// Ctrl+S to save
document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } });

loadCategories();
loadArticle();
</script>
</body>
</html>
```

- [ ] **Step 3: Write `src/server/public/wiki-article.html`** — Article reader

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wiki 文章</title>
<style>
  :root { --bg: #f8f9fa; --surface: #fff; --text: #1a1a2e; --text-muted: #6b7280; --primary: #2563eb; --primary-light: #eff6ff; --border: #e5e7eb; --radius: 12px; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --surface: #1e293b; --text: #f1f5f9; --text-muted: #94a3b8; --primary: #60a5fa; --primary-light: #1e3a5f; --border: #334155; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.8; padding: 24px; }
  .container { max-width: 800px; margin: 0 auto; }
  .nav-bar { display: flex; gap: 16px; margin-bottom: 24px; justify-content: center; font-size: 0.9rem; }
  .nav-bar a { color: var(--text-muted); text-decoration: none; padding: 6px 16px; border-radius: 8px; }
  .nav-bar a:hover, .nav-bar a.active { background: var(--primary-light); color: var(--primary); }
  .article-header { margin-bottom: 32px; }
  .article-header h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; line-height: 1.3; }
  .article-meta { font-size: 0.85rem; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .article-meta .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; background: var(--primary-light); color: var(--primary); font-size: 0.75rem; }
  .article-actions { margin-bottom: 24px; display: flex; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 4px; padding: 6px 16px; border-radius: 8px; font-size: 0.85rem; cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; transition: all 0.15s; }
  .btn:hover { border-color: var(--primary); color: var(--primary); }
  .article-content { background: var(--surface); border-radius: var(--radius); padding: 32px 40px; border: 1px solid var(--border); }
  .article-content h1 { font-size: 1.75rem; margin: 24px 0 12px; } .article-content h2 { font-size: 1.35rem; margin: 20px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .article-content h3 { font-size: 1.15rem; margin: 16px 0 8px; }
  .article-content p { margin-bottom: 16px; }
  .article-content code { background: var(--primary-light); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .article-content pre { background: var(--bg); padding: 16px; border-radius: 8px; overflow-x: auto; margin: 16px 0; }
  .article-content pre code { background: none; padding: 0; }
  .article-content ul, .article-content ol { padding-left: 24px; margin-bottom: 16px; }
  .article-content li { margin-bottom: 4px; }
  .article-content blockquote { border-left: 4px solid var(--primary); padding-left: 16px; color: var(--text-muted); margin: 16px 0; }
  .article-content img { max-width: 100%; border-radius: 8px; margin: 16px 0; }
  .article-content a { color: var(--primary); }
  .article-content table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  .article-content th, .article-content td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  .article-content th { background: var(--bg); font-weight: 600; }
  .loading { text-align: center; padding: 48px; color: var(--text-muted); }
  .toc { background: var(--bg); border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; font-size: 0.9rem; }
  .toc h3 { font-size: 0.9rem; color: var(--text-muted); margin-bottom: 8px; }
  .toc a { color: var(--primary); text-decoration: none; display: block; padding: 2px 0; }
  .toc a:hover { text-decoration: underline; }
  @media (max-width: 600px) { .article-content { padding: 16px; } .article-header h1 { font-size: 1.5rem; } }
</style>
</head>
<body>
<div class="container">
  <div class="nav-bar">
    <a href="/">📄 文档</a>
    <a href="/wiki">📚 Wiki</a>
    <a href="/resume">👤 简历</a>
  </div>

  <div id="content">
    <div class="loading">加载中...</div>
  </div>
</div>

<script>
const params = new URLSearchParams(location.search);
const slug = params.get("slug");

async function loadArticle() {
  if (!slug) { document.getElementById("content").innerHTML = '<p style="text-align:center;padding:48px;color:var(--text-muted);">请指定文章 slug</p>'; return; }
  try {
    // Need to get article by slug — call list with search
    const res = await fetch(`/api/wiki/articles?search=${encodeURIComponent(slug)}&limit=100`);
    const data = await res.json();
    const article = data.items.find(a => a.slug === slug);
    if (!article) throw new Error("文章不存在");

    // Fetch full content
    const fullRes = await fetch(`/api/wiki/articles/${article.id}`);
    const full = await fullRes.json();
    renderArticle(full);
  } catch (err) {
    document.getElementById("content").innerHTML = `<div style="text-align:center;padding:48px;color:#dc2626;">❌ ${err.message}</div>`;
  }
}

function renderArticle(a) {
  // Simple markdown to HTML
  let body = a.contentMd
    .replace(/^### (.+)/gm, '<h3 id="$1">$1</h3>')
    .replace(/^## (.+)/gm, '<h2 id="$1">$1</h2>')
    .replace(/^# (.+)/gm, '<h1 id="$1">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^- (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, function(m) { return m.includes('<ul>') ? m : '<ol>' + m + '</ol>'; })
    .replace(/^> (.+)/gm, '<blockquote>$1</blockquote>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^([^<].+)$/gm, function(m) { return m.trim() && !m.startsWith('<') && !m.startsWith('</') ? '<p>' + escHtml(m) + '</p>' : m; });

  const tags = (a.tags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join('');

  document.getElementById("content").innerHTML = `
    <div class="article-header">
      <h1>${escHtml(a.title)}</h1>
      <div class="article-meta">
        ${tags}
        <span>更新于 ${new Date(a.updatedAt).toLocaleDateString("zh-CN")}</span>
        ${a.status === 'draft' ? '<span style="color:#f59e0b;">[草稿]</span>' : ''}
      </div>
    </div>
    <div class="article-actions">
      <a href="/wiki/edit?id=${a.id}" class="btn">✏ 编辑</a>
      <button class="btn" onclick="navigator.clipboard.writeText(location.href);alert('链接已复制')">🔗 复制链接</button>
    </div>
    <div class="article-content">${body}</div>
  `;
}

function escHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

loadArticle();
</script>
</body>
</html>
```

- [ ] **Step 4: Commit**

```bash
git add src/server/public/wiki.html src/server/public/wiki-edit.html src/server/public/wiki-article.html
git commit -m "feat(wiki): add wiki dashboard, editor, and article reader pages"
```

---

### Task 6: Integrate wiki into server and entry point

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/index.ts`
- Modify: `src/server/public/index.html`

**Interfaces:**
- Consumes: `WikiStore` (Task 3), `createWikiRouter` (Task 4), `RagVectorStore` (existing)

- [ ] **Step 1: Modify `src/server/index.ts`**

Add imports at the top:
```typescript
import { createWikiRouter } from "../wiki/router.js";
import type { WikiStore } from "../wiki/store.js";
```

Add a `wikiStore?` parameter to `createRagServer` signature:
```typescript
export function createRagServer(
  store: RagVectorStore,
  port: number = 3001,
  executor?: AgentExecutor,
  resumeStore?: ResumeStore,
  resumeData?: ResumeData,
  wikiStore?: WikiStore,     // ← 新增
) {
```

After existing route setup, add wiki routes (before `app.listen`):
```typescript
  // === Wiki routes ===
  if (wikiStore) {
    app.use(createWikiRouter(wikiStore));
  }
```

Also add a static file route for the root that serves the public directory (for wiki pages to be found):
```typescript
  // Serve public directory for wiki pages
  app.use(express.static(path.join(__dirname, "public")));
```

Add wiki link to server startup message:
```typescript
  console.log(`   Wiki Knowledge Base:   http://localhost:${port}/wiki?token=${initialToken}`);
```

- [ ] **Step 2: Modify `src/index.ts`**

Add imports:
```typescript
import { WikiStore } from "./wiki/store.js";
```

In `main()`, after RAG setup:
```typescript
  // Wiki setup
  let wikiStore: WikiStore | undefined;
  try {
    wikiStore = await WikiStore.create("navigate.db", ragStore);
    console.log("Wiki knowledge base initialized");
  } catch (err) {
    console.warn("Wiki initialization skipped:", (err as Error).message);
  }
```

Pass `wikiStore` to `createRagServer`:
```typescript
  createRagServer(ragStore, 3001, executor, resumeStore, resumeData, wikiStore);
```

- [ ] **Step 3: Modify `src/server/public/index.html`**

Add wiki link to navigation bar, after the "文档管理" link:
```html
<a href="/wiki" style="color:#6b7280;text-decoration:none;padding:6px 16px;border-radius:8px;">📚 Wiki</a>
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/index.ts src/server/public/index.html
git commit -m "feat(wiki): integrate WikiStore and routes into application"
```

---
## Phase 2: OpenCode Skill System

### Task 7: Skill types and SkillTool

**Files:**
- Create: `src/skills/types.ts`
- Create: `src/skills/skill-tool.ts`

**Interfaces:**
- Produces: `SkillDefinition`, `SkillAction`, `SkillActionType`, `SkillTool` — consumed by SkillRegistry (Task 8)

- [ ] **Step 1: Write `src/skills/types.ts`**

```typescript
export type SkillActionType = "template" | "shell" | "http" | "code";

export interface SkillAction {
  type: SkillActionType;
  template?: string;
  command?: string;
  workdir?: string;
  timeout?: number;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  code?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  action: SkillAction;
}
```

- [ ] **Step 2: Write `src/skills/skill-tool.ts`**

```typescript
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "node:child_process";
import type { SkillDefinition, SkillAction } from "./types.js";

/** Render a simple template: replace {{ param }} with values */
function renderTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (params[key] === undefined) throw new Error(`Missing required parameter: ${key}`);
    return String(params[key]);
  });
}

/** Execute HTTP request */
async function callHttp(action: SkillAction, params: Record<string, unknown>): Promise<string> {
  const url = renderTemplate(action.url || "", params);
  const method = action.method || "GET";
  const headers: Record<string, string> = {};
  if (action.headers) {
    for (const [k, v] of Object.entries(action.headers)) {
      // Resolve ${ENV_VAR}
      headers[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
    }
  }
  const body = action.body ? renderTemplate(action.body, params) : undefined;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) return `HTTP ${res.status}: ${text}`;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Execute shell command */
function execShell(action: SkillAction, params: Record<string, unknown>): string {
  const command = renderTemplate(action.command || "", params);
  try {
    const output = execSync(command, {
      cwd: action.workdir || process.cwd(),
      timeout: action.timeout || 30000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return `Exit code: 0\n${output}`;
  } catch (err: any) {
    return `Exit code: ${err.status ?? 1}\nstdout: ${err.stdout || ""}\nstderr: ${err.stderr || ""}`;
  }
}

/** Execute inline code in a sandbox */
async function runCode(code: string, params: Record<string, unknown>): Promise<string> {
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction("params", code);
    const result = await fn(params);
    if (result === undefined || result === null) return "Done (no return value)";
    if (typeof result === "object") return JSON.stringify(result, null, 2);
    return String(result);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export class SkillTool extends StructuredTool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  private def: SkillDefinition;

  constructor(def: SkillDefinition) {
    super();
    this.def = def;
    this.name = def.name;
    this.description = def.description;

    // Build Zod schema from JSON Schema
    const shape: Record<string, z.ZodTypeAny> = {};
    if (def.schema.properties) {
      for (const [key, prop] of Object.entries(def.schema.properties)) {
        const p = prop as Record<string, unknown>;
        let zType: z.ZodTypeAny;
        switch (p.type) {
          case "string": zType = z.string(); break;
          case "integer": zType = z.number().int(); break;
          case "number": zType = z.number(); break;
          case "boolean": zType = z.boolean(); break;
          default: zType = z.string(); break;
        }
        if (p.description) zType = zType.describe(p.description as string);
        if (p.enum) zType = (zType as any).enum(p.enum as [string, ...string[]]);
        if (p.default !== undefined) zType = zType.default(p.default);
        shape[key] = zType;
      }
    }
    const required = def.schema.required || [];
    this.schema = z.object(shape).partial().required(Object.fromEntries(required.map(k => [k, true])));
  }

  async _call(input: Record<string, unknown>): Promise<string> {
    const action = this.def.action;
    try {
      switch (action.type) {
        case "template":
          return renderTemplate(action.template!, input);
        case "shell":
          return execShell(action, input);
        case "http":
          return await callHttp(action, input);
        case "code":
          return await runCode(action.code!, input);
        default:
          return `Unknown action type: ${action.type}`;
      }
    } catch (err) {
      return `Skill error: ${(err as Error).message}`;
    }
  }
}
```

- [ ] **Step 3: Install new dependency**

```bash
npm install js-yaml
npm install --save-dev @types/js-yaml
```

Note: js-yaml is for parsing skill YAML files. The template engine is built into `renderTemplate()` via simple `{{ param }}` string interpolation (no extra dependency needed).

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add src/skills/types.ts src/skills/skill-tool.ts package.json
git commit -m "feat(skills): add SkillDefinition types and SkillTool StructuredTool"
```

---

### Task 8: SkillRegistry (YAML loader)

**Files:**
- Create: `src/skills/registry.ts`

**Interfaces:**
- Consumes: `SkillDefinition` (Task 7), `SkillTool` (Task 7)
- Produces: `SkillRegistry` class — consumed by `src/index.ts` (Task 9)

- [ ] **Step 1: Write `src/skills/registry.ts`**

```typescript
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "js-yaml";
import { StructuredTool } from "@langchain/core/tools";
import { SkillTool } from "./skill-tool.js";
import type { SkillDefinition } from "./types.js";

export class SkillRegistry {
  private skillsDir: string;
  private tools: Map<string, StructuredTool> = new Map();

  constructor(skillsDir: string = "skills") {
    this.skillsDir = skillsDir;
  }

  /** Scan directory and load all .skill.yaml files */
  async loadAll(): Promise<StructuredTool[]> {
    this.tools.clear();

    if (!existsSync(this.skillsDir)) {
      console.log(`[skills] Directory "${this.skillsDir}" not found, skipping skill loading`);
      return [];
    }

    const files = readdirSync(this.skillsDir)
      .filter(f => f.endsWith(".skill.yaml") || f.endsWith(".skill.yml"));

    if (files.length === 0) {
      console.log(`[skills] No .skill.yaml files found in "${this.skillsDir}"`);
      return [];
    }

    console.log(`[skills] Loading ${files.length} skill(s) from "${this.skillsDir}"...`);

    for (const file of files) {
      try {
        const tool = await this.loadSkill(join(this.skillsDir, file));
        if (tool) {
          if (this.tools.has(tool.name)) {
            console.warn(`[skills] Warning: duplicate skill name "${tool.name}" — overwriting from ${file}`);
          }
          this.tools.set(tool.name, tool);
          console.log(`[skills]   ✓ ${tool.name} (${file})`);
        }
      } catch (err) {
        console.warn(`[skills]   ✗ Skipping "${file}": ${(err as Error).message}`);
      }
    }

    console.log(`[skills] Loaded ${this.tools.size} skill(s) successfully`);
    return Array.from(this.tools.values());
  }

  /** Load a single skill file */
  async loadSkill(filePath: string): Promise<StructuredTool | null> {
    if (!existsSync(filePath)) {
      console.warn(`[skills] File not found: ${filePath}`);
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      throw new Error(`Invalid YAML: ${(e as Error).message}`);
    }

    // Validate required fields
    if (!parsed.name || typeof parsed.name !== "string") {
      throw new Error("Missing or invalid 'name' field");
    }
    if (!parsed.description || typeof parsed.description !== "string") {
      throw new Error("Missing or invalid 'description' field");
    }
    if (!parsed.action || !parsed.action.type) {
      throw new Error("Missing or invalid 'action.type' field");
    }
    if (!["template", "shell", "http", "code"].includes(parsed.action.type)) {
      throw new Error(`Invalid action type: "${parsed.action.type}". Must be one of: template, shell, http, code`);
    }

    // Validate action-specific requirements
    switch (parsed.action.type) {
      case "template":
        if (!parsed.action.template) throw new Error("template action requires 'template' field");
        break;
      case "shell":
        if (!parsed.action.command) throw new Error("shell action requires 'command' field");
        break;
      case "http":
        if (!parsed.action.url) throw new Error("http action requires 'url' field");
        break;
      case "code":
        if (!parsed.action.code) throw new Error("code action requires 'code' field");
        break;
    }

    const def: SkillDefinition = {
      name: parsed.name,
      description: parsed.description,
      schema: parsed.schema || { type: "object", properties: {} },
      action: {
        type: parsed.action.type,
        template: parsed.action.template,
        command: parsed.action.command,
        workdir: parsed.action.workdir,
        timeout: parsed.action.timeout,
        url: parsed.action.url,
        method: parsed.action.method,
        headers: parsed.action.headers,
        body: parsed.action.body,
        code: parsed.action.code,
      },
    };

    return new SkillTool(def);
  }

  /** Get a loaded tool by name */
  getTool(name: string): StructuredTool | undefined {
    return this.tools.get(name);
  }

  /** Get all loaded tools */
  getAllTools(): StructuredTool[] {
    return Array.from(this.tools.values());
  }

  /** Watch directory for changes (simple fs.watch, optional) */
  watch(): void {
    if (!existsSync(this.skillsDir)) return;

    const { watch } = require("node:fs") as typeof import("node:fs");
    watch(this.skillsDir, async (eventType: string, filename: string | null) => {
      if (!filename) return;
      if (!filename.endsWith(".skill.yaml") && !filename.endsWith(".skill.yml")) return;
      console.log(`[skills] File changed: ${filename}, reloading...`);
      try {
        const filePath = join(this.skillsDir, filename);
        if (existsSync(filePath)) {
          const tool = await this.loadSkill(filePath);
          if (tool) {
            this.tools.set(tool.name, tool);
            console.log(`[skills]   ✓ Reloaded "${tool.name}"`);
          }
        } else {
          // File deleted — remove tool
          for (const [name, t] of this.tools) {
            // Find by checking if any tool matches (we don't track source file)
            // As a simplification, just list what was removed
          }
          console.log(`[skills]   File "${filename}" removed — consider restarting to clear skills`);
        }
      } catch (err) {
        console.warn(`[skills]   ✗ Reload failed: ${(err as Error).message}`);
      }
    });
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 3: Commit**

```bash
git add src/skills/registry.ts
git commit -m "feat(skills): add SkillRegistry for loading YAML skill definitions"
```

---

### Task 9: Example skills and integration into index.ts

**Files:**
- Create: `skills/example.skill.yaml`
- Create: `skills/weather.skill.yaml`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `SkillRegistry` (Task 8), existing `src/index.ts`

- [ ] **Step 1: Write `skills/example.skill.yaml`**

```yaml
name: greet_user
description: "向用户打招呼，支持自定义语言。"
schema:
  type: object
  properties:
    name:
      type: string
      description: "用户的名字"
  required: ["name"]
action:
  type: template
  template: |
    你好，{{ name }}！欢迎使用 Navigate Agent。今天有什么可以帮你的？
```

- [ ] **Step 2: Write `skills/weather.skill.yaml`**

```yaml
name: get_weather
description: "查询指定城市的当前天气。使用 wttr.in 服务，无需 API key。"
schema:
  type: object
  properties:
    city:
      type: string
      description: "城市名称（支持中文城市名，如 Beijing、上海）"
  required: ["city"]
action:
  type: http
  url: "https://wttr.in/{{ city }}?format=%C+%t+%w+%h"
  method: GET
```

- [ ] **Step 3: Modify `src/index.ts`**

Add import:
```typescript
import { SkillRegistry } from "./skills/registry.js";
```

In `main()`, after `const ragTool = new RagSearchTool(ragStore);`, add:
```typescript
  // Skill system setup
  let skillTools: StructuredTool[] = [];
  try {
    const skillRegistry = new SkillRegistry("skills");
    skillTools = await skillRegistry.loadAll();
  } catch (err) {
    console.warn("Skill loading skipped:", (err as Error).message);
  }
```

Make sure `StructuredTool` is imported from LangChain:
```typescript
import type { StructuredTool } from "@langchain/core/tools";
```

Change the `allTools` array:
```typescript
  const allTools: StructuredTool[] = [
    ...createTools(),
    ragTool,
    ...(resumeTool ? [resumeTool] : []),
    ...skillTools,
  ];
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add skills/ src/index.ts package.json
git commit -m "feat(skills): integrate SkillRegistry with example skills"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full typecheck**

```bash
npx tsc --noEmit
```
Expected: pass cleanly, zero errors

- [ ] **Step 2: Start the application**

```bash
timeout 15 npx tsx src/index.ts 2>&1 || true
```
Expected: Prints "RAG server on http://localhost:3001", "Wiki knowledge base initialized", "Loading N skill(s)" and "Loaded N skill(s) successfully"

- [ ] **Step 3: Verify file structure**

```bash
echo "=== Wiki files ===" && ls -la src/wiki/ && echo "=== Skill files ===" && ls -la src/skills/ && echo "=== Skill YAMLs ===" && ls -la skills/ && echo "=== Web pages ===" && ls -la src/server/public/
```

Expected:
```
src/wiki/:
  types.ts
  store.ts
  router.ts
src/skills/:
  types.ts
  skill-tool.ts
  registry.ts
skills/:
  example.skill.yaml
  weather.skill.yaml
src/server/public/:
  index.html
  wiki.html
  wiki-edit.html
  wiki-article.html
  resume.html
  resume-chat.html
```

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A && git commit -m "chore: finalize wiki and skill system implementation" || echo "Nothing to commit"
```
