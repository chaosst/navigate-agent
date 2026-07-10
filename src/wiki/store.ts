import initSqlJs, { Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { WikiArticle, WikiCategory, WikiRevision, WikiArticleListItem, WikiArticleListResponse } from "./types.js";
import { RagVectorStore } from "../rag/vectorstore.js";

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

  /** Generate a unique slug from title (checks both articles and categories) */
  private slugify(title: string, forCategory = false): string {
    let slug = title.toLowerCase()
      .replace(/[^\w一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!slug) slug = "article";

    // Check uniqueness across both articles and categories
    const table = forCategory ? "wiki_categories" : "wiki_articles";
    const existing = this.db.exec(`SELECT slug FROM ${table} WHERE slug = ?`, [slug]);
    if (existing.length && existing[0].values.length > 0) {
      let i = 2;
      while (true) {
        const candidate = `${slug}-${i}`;
        const r = this.db.exec(`SELECT slug FROM ${table} WHERE slug = ?`, [candidate]);
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
    let countSql = "SELECT COUNT(*) as cnt FROM wiki_articles a";
    if (category) {
      countSql += " LEFT JOIN wiki_categories c ON a.category_id = c.id";
      countSql += " WHERE a.category_id = ?";
    } else {
      countSql += " WHERE 1=1";
    }
    if (search) {
      countSql += " AND (a.title LIKE ? OR a.content_md LIKE ?)";
    }
    const countParams = category
      ? [category, ...(search ? [`%${search}%`, `%${search}%`] : [])]
      : (search ? [`%${search}%`, `%${search}%`] : []);
    const countResult = this.db.exec(countSql, countParams);
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

    this.db.run("BEGIN");
    try {
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
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }

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

  /** Create a wiki article from an uploaded file (no RAG sync — already indexed by upload handler) */
  async createArticleFromUpload(filename: string, content: string): Promise<WikiArticle> {
    const id = randomUUID();
    const title = filename.replace(/\.(md|txt|pdf|docx)$/i, "");
    const slug = this.slugify(title);
    const now = new Date().toISOString();
    const summary = content.slice(0, 200).replace(/\n/g, " ");

    this.db.run("BEGIN");
    try {
      this.db.run(
        `INSERT INTO wiki_articles (id, title, slug, content_md, summary, category_id, tags, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, slug, content, summary, null, "", "published", now, now]
      );
      this.db.run(
        `INSERT INTO wiki_revisions (id, article_id, content_md, summary, editor_note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), id, content, summary, "从文件上传创建", now]
      );
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
    this.save();

    return {
      id, title, slug, contentMd: content,
      summary, categoryId: null, tags: [],
      status: "published", createdAt: new Date(now), updatedAt: new Date(now),
    };
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

    this.db.run("BEGIN");
    try {
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
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
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
    this.db.run("BEGIN");
    try {
      this.db.run("DELETE FROM wiki_revisions WHERE article_id = ?", [id]);
      this.db.run("DELETE FROM wiki_articles WHERE id = ?", [id]);
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
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
    const slug = this.slugify(data.name, true);
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
    const slug = data.name ? this.slugify(name, true) : (row[2] as string);
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
    // Unlink articles + delete category
    this.db.run("BEGIN");
    try {
      this.db.run("UPDATE wiki_articles SET category_id = NULL WHERE category_id = ?", [id]);
      this.db.run("DELETE FROM wiki_categories WHERE id = ?", [id]);
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
    this.save();
    return true;
  }

  close(): void {
    this.save();
  }
}
