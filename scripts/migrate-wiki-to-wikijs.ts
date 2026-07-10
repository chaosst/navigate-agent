#!/usr/bin/env tsx
/**
 * Migration script: navigate.db -> Wiki.js
 *
 * Reads old wiki articles and categories from navigate.db (SQLite)
 * and creates them in Wiki.js via its GraphQL API.
 *
 * Usage:
 *   npx tsx scripts/migrate-wiki-to-wikijs.ts
 *
 * Environment (reads from .env automatically via dotenv):
 *   WIKIJS_URL        Wiki.js server URL (default: http://localhost:3003)
 *   WIKIJS_API_TOKEN  Wiki.js GraphQL API token (required)
 *   DB_PATH           Path to navigate.db (default: navigate.db)
 */

import "dotenv/config";
import initSqlJs from "sql.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const WIKIJS_URL = process.env.WIKIJS_URL || "http://localhost:3003";
const WIKIJS_API_TOKEN = process.env.WIKIJS_API_TOKEN;
const DB_PATH = process.env.DB_PATH || "navigate.db";
const GRAPHQL_ENDPOINT = `${WIKIJS_URL}/graphql`;

if (!WIKIJS_API_TOKEN) {
  console.error("❌ WIKIJS_API_TOKEN environment variable is required");
  process.exit(1);
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface OldCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  parentId: string | null;
  sortOrder: number;
}

interface OldArticle {
  id: string;
  title: string;
  slug: string;
  contentMd: string;
  summary: string;
  categoryId: string | null;
  tags: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface MigrationResult {
  articlesMigrated: number;
  articlesTotal: number;
  articlesSkipped: number;
  errors: { type: "article"; name: string; message: string }[];
}

interface ResponseStatus {
  succeeded: boolean;
  errorCode: number;
  slug: string;
  message?: string;
}

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WIKIJS_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const body = await response.json() as { errors?: { message: string }[]; data?: T };

  if (body.errors) {
    throw new Error(body.errors[0]?.message ?? JSON.stringify(body.errors));
  }

  if (!body.data) {
    throw new Error("Empty response data");
  }

  return body.data;
}

// ─── Page creation ───────────────────────────────────────────────────────────

const CREATE_PAGE_MUTATION = `
mutation ($content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
  pages {
    create(content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags, title: $title) {
      responseResult { succeeded errorCode slug message }
    }
  }
}
`;

async function createPage(
  content: string,
  title: string,
  description: string,
  tags: string[],
  path: string,
): Promise<ResponseStatus> {
  const variables = {
    content,
    description,
    editor: "markdown",
    isPublished: true,
    isPrivate: false,
    locale: "zh_CN",
    path,
    tags,
    title,
  };
  const data = await graphqlRequest<{
    pages: { create: { responseResult: ResponseStatus } };
  }>(CREATE_PAGE_MUTATION, variables);
  return data.pages.create.responseResult;
}

// ─── DB reading ──────────────────────────────────────────────────────────────

async function readOldDb(
  dbPath: string,
): Promise<{ categories: OldCategory[]; articles: OldArticle[] }> {
  const resolvedPath = resolve(dbPath);

  if (!existsSync(resolvedPath)) {
    console.log(`\n  No old wiki database found at: ${resolvedPath}`);
    process.exit(0);
  }

  const SQL = await initSqlJs();
  const buf = readFileSync(resolvedPath);
  const db = new SQL.Database(buf);

  const categories: OldCategory[] = [];
  const articles: OldArticle[] = [];

  // Read categories
  try {
    const catResult = db.exec(
      "SELECT id, name, slug, description, parent_id, sort_order FROM wiki_categories ORDER BY sort_order ASC",
    );
    if (catResult.length > 0 && catResult[0].values.length > 0) {
      for (const row of catResult[0].values) {
        categories.push({
          id: row[0] as string,
          name: row[1] as string,
          slug: row[2] as string,
          description: (row[3] as string) ?? "",
          parentId: row[4] ? (row[4] as string) : null,
          sortOrder: (row[5] as number) ?? 0,
        });
      }
    }
  } catch {
    // wiki_categories table doesn't exist — treat as empty
  }

  // Read articles
  try {
    const artResult = db.exec(
      "SELECT id, title, slug, content_md, summary, category_id, tags, status, created_at, updated_at FROM wiki_articles ORDER BY created_at ASC",
    );
    if (artResult.length > 0 && artResult[0].values.length > 0) {
      for (const row of artResult[0].values) {
        const tagsStr = (row[6] as string) ?? "";
        articles.push({
          id: row[0] as string,
          title: row[1] as string,
          slug: row[2] as string,
          contentMd: row[3] as string,
          summary: (row[4] as string) ?? "",
          categoryId: row[5] ? (row[5] as string) : null,
          tags: tagsStr ? tagsStr.split(",").filter(Boolean) : [],
          status: (row[7] as string) ?? "published",
          createdAt: (row[8] as string) ?? "",
          updatedAt: (row[9] as string) ?? "",
        });
      }
    }
  } catch {
    // wiki_articles table doesn't exist — treat as empty
  }

  db.close();
  return { categories, articles };
}

// ─── Migration logic ─────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
  const resolvedDbPath = resolve(DB_PATH);

  console.log("📚 Wiki.js Migration Script");
  console.log(`   Source DB: ${resolvedDbPath}`);
  console.log(`   Target:    ${WIKIJS_URL}`);
  console.log("");

  const { categories, articles } = await readOldDb(DB_PATH);

  if (articles.length === 0) {
    console.log("  No articles found in old wiki database.");
    process.exit(0);
  }

  const result: MigrationResult = {
    articlesMigrated: 0,
    articlesTotal: articles.length,
    articlesSkipped: 0,
    errors: [],
  };

  // Build category-id -> slug map for path construction
  const categorySlugMap = new Map<string, string>();
  for (const cat of categories) {
    categorySlugMap.set(cat.id, cat.slug);
  }

  // ── Step 1: Migrate articles -> pages ───────────────────────────────────

  console.log(`Found ${articles.length} articles, migrating...`);
  for (const article of articles) {
    // Build path: /category-slug/article-slug or /uncategorized/article-slug
    const catSlug = article.categoryId && categorySlugMap.has(article.categoryId)
      ? categorySlugMap.get(article.categoryId)!
      : "uncategorized";
    const slug = article.slug || article.title.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-|-$/g, "");
    const path = `/${catSlug}/${slug}`;

    try {
      const resp = await createPage(
        article.contentMd,
        article.title,
        article.summary || "",
        article.tags,
        path,
      );
      if (resp.succeeded) {
        console.log(`  ✓ Migrated: ${article.title} → ${path}`);
        result.articlesMigrated++;
      } else if (resp.errorCode === 4102) {
        // errorCode 4102 = slug already taken (duplicate path)
        console.log(`  ~ Skipped (path exists): ${article.title} → ${path}`);
        result.articlesSkipped++;
      } else {
        const msg = resp.message ?? `errorCode ${resp.errorCode}`;
        result.errors.push({ type: "article", name: article.title, message: `${msg} (path: ${path})` });
        console.log(`  ✗ Failed: ${article.title} — ${msg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ type: "article", name: article.title, message: `${msg} (path: ${path})` });
      console.log(`  ✗ Error: ${article.title} — ${msg}`);
    }
  }
  console.log("");

  // ── Step 3: Print report ────────────────────────────────────────────────

  printReport(result);
}

// ─── Report ──────────────────────────────────────────────────────────────────

function printReport(result: MigrationResult): void {
  const sep = "═".repeat(44);
  console.log(sep);
  console.log("      Migration Report");
  console.log(sep);
  console.log(
    `  Articles migrated:   ${result.articlesMigrated}/${result.articlesTotal}`,
  );
  console.log(`  Articles skipped:    ${result.articlesSkipped}`);
  console.log(`  Errors:              ${result.errors.length}`);
  console.log(sep);

  if (result.errors.length > 0) {
    console.log("");
    for (const err of result.errors) {
      console.log(`  [${err.type}] ${err.name}: ${err.message}`);
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

migrate().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n❌ Migration failed: ${msg}`);
  process.exit(1);
});
