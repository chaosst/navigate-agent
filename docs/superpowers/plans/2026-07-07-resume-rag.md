# Resume RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent resume Q&A system with Web display page, SSE chat interface, and CLI agent integration.

**Architecture:** ResumeStore (SQLite + embeddings) provides persistent storage independent of the in-memory RAG store. ResumeParser reads `resume.md` and produces structured data. ResumeSearchTool exposes search to the agent. The Express server serves both REST APIs and HTML pages. The chat endpoint reuses the same AgentExecutor for consistent behavior between CLI and Web.

**Tech Stack:** TypeScript (NodeNext), sql.js, OpenAI Embeddings (text-embedding-3-small), Express 5, SSE, vanilla HTML/CSS/JS

## Global Constraints

- All new files go in `src/resume/` (TS) or `src/server/public/` (HTML)
- Use `.js` extensions in all relative imports (NodeNext module resolution)
- Follow existing code style: `camelCase` functions, `PascalCase` types, `StructuredTool` from `@langchain/core/tools`
- SQLite access through `sql.js` (already a dependency) following patterns in `src/memory/sqlite-store.ts`
- Embeddings model: `text-embedding-3-small` via `OpenAIEmbeddings` from `@langchain/openai`
- SSE endpoint for chat, no WebSocket dependency
- All HTML pages are self-contained (no external CDN resources)

---
### Task 1: Resume types

**Files:**
- Create: `src/resume/types.ts`

**Interfaces:**
- Produces: `ResumeData`, `SectionType`, `ResumeSection`, `ResumeItem` — consumed by all later tasks

- [ ] **Write `src/resume/types.ts`**

```typescript
export interface ResumeData {
  name: string;
  title: string;
  summary: string;
  contact: ResumeContact;
  sections: ResumeSection[];
}

export interface ResumeContact {
  email: string;
  phone?: string;
  github?: string;
  website?: string;
  linkedin?: string;
}

export type SectionType =
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "languages";

export interface ResumeSection {
  type: SectionType;
  title: string;
  items: ResumeItem[];
}

export interface ResumeItem {
  title: string;
  subtitle?: string;
  dateRange?: string;
  description: string;
  highlights?: string[];
  tags?: string[];
}
```

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Commit**

```bash
git add src/resume/types.ts
git commit -m "feat(resume): add ResumeData types"
```

---

### Task 2: Resume Parser

**Files:**
- Create: `src/resume/parser.ts`

**Interfaces:**
- Consumes: `ResumeData`, `ResumeSection`, `ResumeItem` (from Task 1)
- Produces: `ResumeParser.parseFile(path: string): ResumeData` — consumed by Task 3 and Task 11

- [ ] **Write `src/resume/parser.ts`**

The parser reads a Markdown file and extracts:
- `--- frontmatter ---` block for `name`, `title`, `email`, `phone`, `github`, `website`, `linkedin`
- `## 工作经历` / `## 教育背景` / `## 技能` / `## 项目` etc. as sections
- Section items from `### ` sub-headings
- Highlights from bullet lists within items
- Tags from comma-separated lists or inline tags

```typescript
import { readFileSync } from "node:fs";
import type { ResumeData, ResumeSection, ResumeItem, SectionType } from "./types.js";

function parseFrontmatter(lines: string[]): { meta: Record<string, string>; rest: string[] } {
  const meta: Record<string, string> = {};
  if (!lines[0]?.trim().startsWith("---")) return { meta, rest: lines };

  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim().startsWith("---")) { i++; break; }
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      meta[lines[i].slice(0, colon).trim()] = lines[i].slice(colon + 1).trim();
    }
  }
  return { meta, rest: lines.slice(i) };
}

const SECTION_MAP: Record<string, SectionType> = {
  "工作经历": "experience",
  "工作经验": "experience",
  "教育背景": "education",
  "教育": "education",
  "技能": "skills",
  "项目": "projects",
  "项目经历": "projects",
  "证书": "certifications",
  "语言": "languages",
};

function parseSections(lines: string[]): ResumeSection[] {
  const sections: ResumeSection[] = [];
  let currentSection: ResumeSection | null = null;
  let currentItem: ResumeItem | null = null;
  let descriptionLines: string[] = [];
  let highlights: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Section heading (##)
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
      if (currentSection && currentSection.items.length === 0 && currentItem) {
        currentSection.items.push(currentItem);
      }
      if (currentSection) sections.push(currentSection);
      const title = sectionMatch[1].trim();
      currentSection = {
        type: SECTION_MAP[title] || "experience",
        title,
        items: [],
      };
      currentItem = null;
      descriptionLines = [];
      highlights = [];
      continue;
    }

    // Item heading (###)
    const itemMatch = line.match(/^###\s+(.+)/);
    if (itemMatch && currentSection) {
      if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
      const title = itemMatch[1].trim();
      currentItem = {
        title,
        description: "",
        highlights: [],
      };
      // Check for date range in parenthes e.g. "Company (2020-2023)"
      const dateMatch = title.match(/\(([^)]+)\)$/);
      if (dateMatch) {
        currentItem.dateRange = dateMatch[1];
        currentItem.title = title.slice(0, title.lastIndexOf("(")).trim();
      }
      descriptionLines = [];
      highlights = [];
      continue;
    }

    // Bullet — highlight
    const bulletMatch = line.match(/^-\s+(.+)/);
    if (bulletMatch && currentItem) {
      highlights.push(bulletMatch[1].trim());
      continue;
    }

    // Empty line between items
    if (line === "" && currentItem && descriptionLines.length > 0) {
      descriptionLines.push("");
      continue;
    }

    // Regular description text (for subtitle detection)
    if (currentItem && line && !line.startsWith("#")) {
      descriptionLines.push(line);
    }
  }

  // Finalize last item/section
  if (currentItem) finalizeItem(currentItem, descriptionLines, highlights);
  if (currentSection) {
    if (currentItem && !currentSection.items.includes(currentItem)) {
      currentSection.items.push(currentItem);
    }
    sections.push(currentSection);
  }

  return sections;
}

function finalizeItem(item: ResumeItem, descLines: string[], highlights: string[]) {
  // First line of description is often the subtitle (company / school name)
  const nonEmpty = descLines.filter(l => l.trim());
  if (nonEmpty.length > 0 && !item.subtitle) {
    // Check if first non-empty line looks like a subtitle (not markdown, short)
    const first = nonEmpty[0].trim();
    if (!first.startsWith("[") && !first.startsWith("!") && first.length < 80) {
      item.subtitle = first;
      descLines = descLines.filter(l => l.trim() !== first);
    }
  }
  item.description = descLines.join("\n").trim();
  item.highlights = highlights;
}

export function parseResume(filePath: string): ResumeData {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const { meta, rest } = parseFrontmatter(lines);
  const sections = parseSections(rest);

  // Combine description-less text before any section as summary
  let summary = "";
  if (sections.length > 0) {
    const firstSectionStart = lines.findIndex(l => l.startsWith("## "));
    if (firstSectionStart > 0) {
      const preLines = lines.slice(meta.name ? lines.indexOf("---", 1) + 1 : 0, firstSectionStart)
        .filter(l => l.trim() && !l.startsWith("---"))
        .join(" ")
        .trim();
      if (preLines) summary = preLines;
    }
  }

  return {
    name: meta.name || "",
    title: meta.title || "",
    summary,
    contact: {
      email: meta.email || "",
      phone: meta.phone || undefined,
      github: meta.github || undefined,
      website: meta.website || undefined,
      linkedin: meta.linkedin || undefined,
    },
    sections,
  };
}
```

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Commit**

```bash
git add src/resume/parser.ts
git commit -m "feat(resume): add Markdown resume parser"
```

---

### Task 3: Resume SQLite Store

**Files:**
- Create: `src/resume/store.ts`

**Interfaces:**
- Consumes: `ResumeData`, `ResumeSection`, `ResumeItem`, `SectionType` (from Task 1), `OpenAIEmbeddings` from `@langchain/openai`
- Produces: `ResumeStore` class with `import()`, `hasChanged()`, `search()`, `getSummary()`, `getResumeData()` — consumed by Tasks 4, 7, 11

- [ ] **Write `src/resume/store.ts`**

```typescript
import initSqlJs, { Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { ResumeData, ResumeSection, SectionType } from "./types.js";
import type { RagResult } from "../rag/types.js";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function embedToBase64(vec: number[]): string {
  const buf = new Float32Array(vec);
  return Buffer.from(buf.buffer).toString("base64");
}

function base64ToEmbed(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

export class ResumeStore {
  private db: Database;
  private dbPath: string;
  private embeddings: OpenAIEmbeddings;

  private constructor(db: Database, dbPath: string, embeddings: OpenAIEmbeddings) {
    this.db = db;
    this.dbPath = dbPath;
    this.embeddings = embeddings;
    this.initTables();
  }

  static async create(dbPath: string, embeddings: OpenAIEmbeddings): Promise<ResumeStore> {
    const SQL = await initSqlJs();
    let db: Database;
    if (existsSync(dbPath)) {
      const buf = readFileSync(dbPath);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }
    db.run("PRAGMA journal_mode=WAL");
    return new ResumeStore(db, dbPath, embeddings);
  }

  private initTables(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS resume_meta (
      id TEXT PRIMARY KEY DEFAULT 'current',
      name TEXT, title TEXT, email TEXT,
      summary TEXT, raw_md TEXT,
      version INTEGER DEFAULT 1,
      updated_at TEXT
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS resume_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_type TEXT NOT NULL,
      item_title TEXT,
      content TEXT NOT NULL,
      embedding TEXT,
      seq INTEGER
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS resume_versions (
      version INTEGER PRIMARY KEY AUTOINCREMENT,
      md_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      changes TEXT
    )`);
    this.save();
  }

  private save(): void {
    writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  async hasChanged(mdHash: string): Promise<boolean> {
    const r = this.db.exec(
      "SELECT md_hash FROM resume_versions ORDER BY version DESC LIMIT 1"
    );
    if (!r.length || !r[0].values.length) return true;
    return r[0].values[0][0] as string !== mdHash;
  }

  async import(data: ResumeData, rawMd: string): Promise<void> {
    const mdHash = this.md5(rawMd);

    // Update meta
    const now = new Date().toISOString();
    const existing = this.db.exec("SELECT version FROM resume_meta WHERE id = 'current'");
    const version = (existing.length && existing[0].values.length
      ? (existing[0].values[0][0] as number) + 1
      : 1);

    this.db.run(`INSERT OR REPLACE INTO resume_meta (id, name, title, email, summary, raw_md, version, updated_at)
      VALUES ('current', ?, ?, ?, ?, ?, ?, ?)`,
      [data.name, data.title, data.contact.email, data.summary, rawMd, version, now]);

    // Clear old chunks
    this.db.run("DELETE FROM resume_chunks");

    // Generate chunks with embeddings
    const chunks: { content: string; sectionType: string; itemTitle: string; seq: number }[] = [];
    let seq = 0;

    // Summary chunk
    if (data.summary) {
      chunks.push({ content: data.summary, sectionType: "summary", itemTitle: "个人简介", seq: seq++ });
    }

    for (const section of data.sections) {
      if (section.items.length === 0) {
        // Section with just text (e.g. skills as flat list)
        chunks.push({ content: section.items.map(i => i.description).join("\n"), sectionType: section.type, itemTitle: section.title, seq: seq++ });
      }
      for (const item of section.items) {
        let content = `${item.title}`;
        if (item.dateRange) content += ` (${item.dateRange})`;
        if (item.subtitle) content += ` — ${item.subtitle}`;
        content += `\n${item.description}`;
        if (item.highlights && item.highlights.length > 0) {
          content += "\n" + item.highlights.map(h => `- ${h}`).join("\n");
        }
        if (item.tags && item.tags.length > 0) {
          content += "\nTags: " + item.tags.join(", ");
        }
        chunks.push({ content, sectionType: section.type, itemTitle: item.title, seq: seq++ });
      }
    }

    // Generate embeddings in batches
    const batchSize = 20;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(c => c.content);
      try {
        const embeddings = await this.embeddings.embedDocuments(texts);
        for (let j = 0; j < batch.length; j++) {
          const c = batch[j];
          this.db.run(
            `INSERT INTO resume_chunks (section_type, item_title, content, embedding, seq) VALUES (?, ?, ?, ?, ?)`,
            [c.sectionType, c.itemTitle, c.content, embedToBase64(embeddings[j]), c.seq]
          );
        }
      } catch {
        // Embeddings failed — insert without embeddings
        for (const c of batch) {
          this.db.run(
            `INSERT INTO resume_chunks (section_type, item_title, content, embedding, seq) VALUES (?, ?, ?, NULL, ?)`,
            [c.sectionType, c.itemTitle, c.content, c.seq]
          );
        }
      }
    }

    // Record version
    this.db.run(
      "INSERT INTO resume_versions (md_hash, changes) VALUES (?, ?)",
      [mdHash, version === 1 ? "Initial import" : `Update to version ${version}`]
    );

    this.save();
  }

  async search(query: string, section?: SectionType | "all", k: number = 5): Promise<RagResult[]> {
    // Generate query embedding
    let queryVec: number[] | null = null;
    try {
      queryVec = await this.embeddings.embedQuery(query);
    } catch {
      // Embedding failed — fallback to keyword match
      return this.keywordSearch(query, section, k);
    }

    // Load all chunks with embeddings
    let sql = "SELECT content, section_type, item_title, embedding, seq FROM resume_chunks WHERE embedding IS NOT NULL";
    const params: any[] = [];
    if (section && section !== "all") {
      sql += " AND section_type = ?";
      params.push(section);
    }
    sql += " ORDER BY seq ASC";

    const r = this.db.exec(sql, params);
    if (!r.length || !r[0].values.length) return [];

    const scored: { content: string; score: number; source: string; docId: string }[] = [];

    for (const row of r[0].values) {
      const content = row[0] as string;
      const sectionType = row[1] as string;
      const itemTitle = row[2] as string;
      const embeddingB64 = row[3] as string | null;
      if (!embeddingB64) continue;
      const vec = base64ToEmbed(embeddingB64);
      const score = cosineSimilarity(queryVec, vec);
      scored.push({
        content,
        score,
        source: `简历 / ${sectionType} / ${itemTitle || ""}`,
        docId: "resume",
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  private keywordSearch(query: string, section?: string, k: number = 5): RagResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    let sql = "SELECT content, section_type, item_title, seq FROM resume_chunks WHERE 1=1";
    const params: any[] = [];
    if (section && section !== "all") {
      sql += " AND section_type = ?";
      params.push(section);
    }

    const likeClauses = terms.map(() => "content LIKE ?");
    sql += ` AND (${likeClauses.join(" OR ")})`;
    for (const t of terms) params.push(`%${t}%`);
    sql += " ORDER BY seq ASC";

    const r = this.db.exec(sql, params);
    if (!r.length || !r[0].values.length) return [];

    return r[0].values.map(row => ({
      content: row[0] as string,
      score: 1.0,
      source: `简历 / ${row[1] as string} / ${(row[2] as string) || ""}`,
      docId: "resume",
    })).slice(0, k);
  }

  async getSummary(): Promise<string> {
    const r = this.db.exec("SELECT name, title, summary, version FROM resume_meta WHERE id = 'current'");
    if (!r.length || !r[0].values.length) return "";
    const row = r[0].values[0];
    const name = row[0] as string;
    const title = row[1] as string;
    const summary = row[2] as string;
    return `Name: ${name || "—"}\nTitle: ${title || "—"}\nSummary: ${summary ? summary.slice(0, 200) : "—"}`;
  }

  async getResumeData(): Promise<ResumeData | null> {
    const r = this.db.exec("SELECT name, title, email, summary FROM resume_meta WHERE id = 'current'");
    if (!r.length || !r[0].values.length) return null;
    const row = r[0].values[0];

    // Load sections from chunks
    const c = this.db.exec(
      "SELECT DISTINCT section_type, item_title FROM resume_chunks ORDER BY seq ASC"
    );

    // Note: For simplicity, getResumeData returns basic info.
    // Full structured sections are re-parsed from resume.md on startup
    return {
      name: row[0] as string,
      title: row[1] as string,
      summary: (row[2] as string) || "",
      contact: { email: (row[3] as string) || "" },
      sections: [],
    };
  }

  private md5(content: string): string {
    // Simple hash for content comparison
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const chr = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(16);
  }

  close(): void {
    this.save();
  }
}
```

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Commit**

```bash
git add src/resume/store.ts
git commit -m "feat(resume): add SQLite-backed persistent resume store"
```

---

### Task 4: Resume Search Tool

**Files:**
- Create: `src/resume/search-tool.ts`

**Interfaces:**
- Consumes: `ResumeStore` (from Task 3)
- Produces: `ResumeSearchTool` (a `StructuredTool` named `search_resume`) — consumed by Task 11

- [ ] **Write `src/resume/search-tool.ts`**

```typescript
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ResumeStore } from "./store.js";

export class ResumeSearchTool extends StructuredTool {
  name = "search_resume";
  description = "Search the user's resume for professional experience, skills, education, and project details. "
    + "Use this when asked about the user's background, skills, work history, or qualifications. "
    + "You can filter by section type: experience, education, skills, projects, certifications. "
    + "Use section='all' to search everything.";

  schema = z.object({
    query: z.string().describe("The search query for resume content. Use empty string to list all items in a section."),
    section: z.enum(["experience", "education", "skills", "projects", "certifications", "all"])
      .optional()
      .describe("Filter results to a specific resume section. Omit or use 'all' to search everything."),
    k: z.number().optional().describe("Number of results to return (default 5)"),
  });

  constructor(private store: ResumeStore) {
    super();
  }

  async _call({ query, section, k }: z.infer<typeof this.schema>): Promise<string> {
    const results = await this.store.search(query, section || "all", k || 5);
    if (results.length === 0) {
      return "No relevant information found in the resume.";
    }
    return results.map((r, i) =>
      `[${i + 1}] ${r.source}\n${r.content}\n`
    ).join("\n---\n");
  }
}
```

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Commit**

```bash
git add src/resume/search-tool.ts
git commit -m "feat(resume): add search_resume agent tool"
```

---

### Task 5: Sample resume

**Files:**
- Create: `resume.md`

- [ ] **Write `resume.md`**

Write a sample resume that will be replaced by the user's actual resume:

```markdown
---
name: 张三
title: 全栈工程师
email: zhang@example.com
github: github.com/zhangsan
linkedin: linkedin.com/in/zhangsan
---

拥有 5 年前端和后端开发经验的全栈工程师，擅长 React、Node.js 和 TypeScript，关注代码质量和用户体验。

## 工作经历

### 创新科技公司 (2022-03 — 至今)
高级全栈工程师

- 主导公司核心产品从 Vue 2 到 React 18 + TypeScript 的架构迁移，性能提升 40%
- 设计并实现了基于 LangChain 的智能客服系统，服务 10 万+ 日活用户
- 搭建 CI/CD 流水线（GitHub Actions + Docker），部署效率提升 60%
- 带领 4 人前端团队完成 3 个中大型项目交付

### 云帆科技 (2020-01 — 2022-02)
前端工程师

- 使用 React + Redux + TypeScript 开发 B 端后台管理系统
- 实现基于 WebSocket 的实时数据看板，支撑千人同时在线
- 编写单元测试（Jest + RTL），代码覆盖率从 20% 提升到 85%

## 教育背景

### 北京大学 (2016-09 — 2020-06)
计算机科学与技术 · 学士

- 主修课程：数据结构、算法设计、操作系统、计算机网络
- 毕业设计：基于机器学习的代码缺陷检测系统（优秀论文）

## 技能

- **前端**: React, TypeScript, Next.js, Tailwind CSS, Webpack
- **后端**: Node.js, Express, NestJS, Python, PostgreSQL
- **AI/ML**: LangChain, OpenAI API, RAG, 向量数据库
- **DevOps**: Docker, GitHub Actions, Linux, Nginx
- **工具**: Git, VS Code, Figma, Postman

## 项目

### Navigate Agent (2025-06 — 至今)
一个基于 LangChain 的终端 AI 助手，支持工具调用、RAG 文档检索和对话记忆。

- 设计工具注册系统，支持 6+ 内置工具（Shell、文件系统、搜索、RAG）
- 集成 OpenAI Embeddings 实现 RAG 文档检索
- 使用 Ink + React 构建终端 UI，支持流式输出

### 智能客服平台 (2023-01 — 2023-08)
基于 LLM 的企业级智能客服解决方案。

- 设计多轮对话管理系统，上下文窗口优化减少 35% Token 消耗
- 实现 RAG 知识库检索增强生成，准确率提升至 92%
```

- [ ] **Commit**

```bash
git add resume.md
git commit -m "feat(resume): add sample resume markdown file"
```

---

### Task 6: Update system prompt

**Files:**
- Modify: `src/agent/prompt.ts`

**Interfaces:**
- Consumes: `ResumeStore.getSummary()` (from Task 3)

- [ ] **Edit `src/agent/prompt.ts`**

Change from:
```typescript
export function buildSystemPrompt(): string {
  return `You are an AI assistant with access to file system and shell tools...`;
}
```

To:
```typescript
export function buildSystemPrompt(resumeSummary?: string): string {
  let prompt = `You are an AI assistant with access to file system and shell tools...`;

  if (resumeSummary) {
    prompt += `\n\n## About the User\n${resumeSummary}\n\n`
      + `You have access to the user's resume via the search_resume tool. `
      + `The resume contains sections: experience, education, skills, projects, certifications. `
      + `When asked about the user's background, experience, or qualifications, use search_resume.`;
  }

  return prompt;
}
```

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Commit**

```bash
git add src/agent/prompt.ts
git commit -m "feat(resume): inject resume summary into system prompt"
```

---

### Task 7: Update Express server with resume routes

**Files:**
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `ResumeStore`, `ResumeData` (from Tasks 1, 3)
- Produces: Express routes: `GET /resume`, `GET /resume/chat`, `GET /api/resume`, `POST /api/resume/chat`
- Consumes: `AgentExecutor` for SSE chat streaming

- [ ] **Edit `src/server/index.ts`**

Replace the current implementation with one that accepts optional `AgentExecutor`, `ResumeStore`, and `ResumeData` parameters and adds resume routes:

```typescript
import express from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { RagVectorStore } from "../rag/vectorstore.js";
import { loadDocument } from "../rag/loader.js";
import { dirname } from "path";
import { fileURLToPath } from "url";
import type { ResumeStore } from "../resume/store.js";
import type { ResumeData } from "../resume/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentExecutor = any;

interface DocMeta {
  filename: string;
  chunks: number;
  indexedAt: Date;
}

export function createRagServer(
  store: RagVectorStore,
  port: number = 3001,
  executor?: AgentExecutor,
  resumeStore?: ResumeStore,
  resumeData?: ResumeData,
) {
  const app = express();
  const upload = multer({ dest: "rag_uploads/" });
  const docMeta = new Map<string, DocMeta>();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // ... existing routes unchanged ...

  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const docId = randomUUID();
      const filename = req.file.originalname;
      const filePath = req.file.path;
      const chunks = await loadDocument(filePath, filename);
      await store.addChunks(chunks, docId);
      docMeta.set(docId, { filename, chunks: chunks.length, indexedAt: new Date() });
      res.json({ docId, filename, chunks: chunks.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/documents", (_req, res) => {
    const ids = Array.from(docMeta.entries()).map(([id, meta]) => ({
      id,
      filename: meta.filename,
      chunks: meta.chunks,
      indexedAt: meta.indexedAt,
    }));
    res.json(ids);
  });

  app.delete("/api/documents/:id", (req, res) => {
    docMeta.delete(req.params.id);
    res.json({ deleted: req.params.id });
  });

  app.post("/api/query", async (req, res) => {
    try {
      const { query, k } = req.body;
      if (!query) return res.status(400).json({ error: "Missing query" });
      const results = await store.search(query, k || 5);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // === Resume routes ===

  // Provide resume data as JSON
  app.get("/api/resume", async (_req, res) => {
    if (!resumeStore) return res.status(404).json({ error: "Resume not available" });
    const data = await resumeStore.getResumeData();
    if (!data) return res.status(404).json({ error: "No resume data found" });
    // For full sections, return the parsed data passed from index.ts
    res.json({ ...data, sections: resumeData?.sections || [] });
  });

  // SSE chat endpoint
  const sessions = new Map<string, { messages: { role: string; content: string }[] }>();

  app.post("/api/resume/chat", async (req, res) => {
    if (!executor) {
      return res.status(503).json({ error: "Agent executor not available" });
    }

    const { question, sessionId } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const sid = sessionId || randomUUID();
    if (!sessions.has(sid)) sessions.set(sid, { messages: [] });
    const session = sessions.get(sid)!;
    session.messages.push({ role: "user", content: question });

    let fullAnswer = "";
    try {
      // Build LangChain message history from session messages
      const { HumanMessage, AIMessage } = await import("@langchain/core/messages");
      const messages = session.messages.map((m: { role: string; content: string }) =>
        m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)
      );

      const stream = await executor.stream({ messages });
      for await (const chunk of stream) {
        if (chunk.output !== undefined && chunk.output !== null) {
          const text = String(chunk.output);
          fullAnswer += text;
          res.write(`event: token\ndata: ${JSON.stringify(text)}\n\n`);
        }
        // Flush if res.flushHeaders exists (Express 5)
        if (typeof (res as any).flush === "function") (res as any).flush();
      }

      // Limit history to last 50 messages
      if (session.messages.length > 50) {
        session.messages = session.messages.slice(-50);
      }
      session.messages.push({ role: "assistant", content: fullAnswer });

      res.write(`event: done\ndata: ${JSON.stringify(fullAnswer)}\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
    }
    res.end();
  });

  app.listen(port, () => console.log(`RAG server on http://localhost:${port}`));
  return app;
}
```

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Commit**

```bash
git add src/server/index.ts
git commit -m "feat(resume): add resume API routes and SSE chat endpoint"
```

---

### Task 8: Resume display page

**Files:**
- Create: `src/server/public/resume.html`

- [ ] **Write `src/server/public/resume.html`**

A polished, responsive resume display page with:
- Header with name, title, contact links
- Summary section
- Work experience timeline
- Skills tag cloud (colored by category)
- Project cards
- Education section
- PDF download button
- Dark/light mode support via CSS custom properties
- All data fetched from `/api/resume` and rendered client-side

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>简历</title>
<style>
  :root {
    --bg: #f8f9fa;
    --surface: #ffffff;
    --text: #1a1a2e;
    --text-muted: #6b7280;
    --primary: #2563eb;
    --primary-light: #eff6ff;
    --border: #e5e7eb;
    --shadow: rgba(0,0,0,0.06);
    --radius: 12px;
    --tag-frontend: #3b82f6;
    --tag-backend: #10b981;
    --tag-ai: #8b5cf6;
    --tag-devops: #f59e0b;
    --tag-tool: #6b7280;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #60a5fa;
      --primary-light: #1e3a5f;
      --border: #334155;
      --shadow: rgba(0,0,0,0.3);
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 24px;
  }
  .container { max-width: 860px; margin: 0 auto; }
  .card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 32px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px var(--shadow);
  }
  .header { text-align: center; }
  .header h1 { font-size: 2rem; font-weight: 700; margin-bottom: 4px; }
  .header .title { font-size: 1.1rem; color: var(--primary); font-weight: 500; margin-bottom: 16px; }
  .contact-row {
    display: flex; flex-wrap: wrap; gap: 12px; justify-content: center;
    font-size: 0.85rem; color: var(--text-muted);
  }
  .contact-row a { color: var(--primary); text-decoration: none; }
  .contact-row a:hover { text-decoration: underline; }

  .section-title {
    font-size: 1.25rem; font-weight: 600; margin-bottom: 20px;
    padding-bottom: 8px; border-bottom: 2px solid var(--primary);
  }
  .summary-text { color: var(--text-muted); line-height: 1.8; }

  /* Timeline */
  .timeline-item {
    padding-left: 20px; border-left: 2px solid var(--border);
    margin-bottom: 24px; position: relative;
  }
  .timeline-item::before {
    content: ""; position: absolute; left: -6px; top: 6px;
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--primary); border: 2px solid var(--surface);
  }
  .timeline-item h3 { font-size: 1rem; font-weight: 600; }
  .timeline-item .meta {
    font-size: 0.85rem; color: var(--text-muted); margin: 4px 0 8px;
  }
  .timeline-item ul { padding-left: 20px; color: var(--text-muted); font-size: 0.9rem; }
  .timeline-item li { margin-bottom: 4px; }

  /* Skills */
  .skills-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .skill-tag {
    padding: 6px 14px; border-radius: 20px; font-size: 0.85rem;
    font-weight: 500; color: #fff; cursor: default;
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .skill-tag:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }

  /* Projects */
  .project-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 600px) { .project-grid { grid-template-columns: 1fr; } }
  .project-card {
    border: 1px solid var(--border); border-radius: 8px; padding: 16px;
  }
  .project-card h4 { font-size: 0.95rem; font-weight: 600; margin-bottom: 4px; }
  .project-card .date { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 8px; }
  .project-card p { font-size: 0.85rem; color: var(--text-muted); }
  .project-card ul { padding-left: 16px; font-size: 0.85rem; color: var(--text-muted); margin-top: 8px; }

  .footer { text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 16px; }
  .footer a { color: var(--primary); text-decoration: none; }
  .footer a:hover { text-decoration: underline; }

  .nav-bar {
    display: flex; gap: 16px; margin-bottom: 24px;
    justify-content: center; font-size: 0.9rem;
  }
  .nav-bar a { color: var(--text-muted); text-decoration: none; padding: 6px 16px; border-radius: 8px; }
  .nav-bar a:hover, .nav-bar a.active { background: var(--primary-light); color: var(--primary); }

  .loading { text-align: center; padding: 48px; color: var(--text-muted); }
  .loading::after { content: "..."; animation: dots 1.5s steps(4, end) infinite; }
  @keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }

  .btn {
    display: inline-block; padding: 8px 20px; border-radius: 8px;
    font-size: 0.85rem; font-weight: 500; cursor: pointer;
    border: 1px solid var(--border); background: var(--surface);
    color: var(--text); text-decoration: none; transition: all 0.15s;
  }
  .btn:hover { border-color: var(--primary); color: var(--primary); }
  .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
  .btn-primary:hover { opacity: 0.9; color: #fff; }
</style>
</head>
<body>
<div class="container">
  <div class="nav-bar">
    <a href="/">📄 文档管理</a>
    <a href="/resume" class="active">👤 简历</a>
    <a href="/resume/chat">💬 简历问答</a>
  </div>

  <div id="app">
    <div class="loading">加载中</div>
  </div>

  <div class="footer">
    <span id="footer-info"></span>
    <br><br>
    <a href="javascript:void(0)" id="downloadPdf" class="btn">⬇ 下载 PDF</a>
  </div>
</div>

<script>
async function loadResume() {
  try {
    const res = await fetch("/api/resume");
    const data = await res.json();
    renderResume(data);
  } catch (err) {
    document.getElementById("app").innerHTML =
      `<div style="text-align:center;padding:48px;color:#dc2626;">
        ❌ 简历加载失败: ${err.message}
      </div>`;
  }
}

function getSkillCategory(tag) {
  const t = tag.toLowerCase();
  if (["react","vue","angular","next.js","nuxt","tailwind","css","html","svelte","webpack","vite","redux","typescript"].some(s => t.includes(s))) return "前端";
  if (["node.js","node","express","nestjs","python","go","java","rust","postgresql","mysql","mongodb","redis","graphql","rest","api"].some(s => t.includes(s))) return "后端";
  if (["langchain","openai","rag","llm","machine learning","ai","tensorflow","pytorch","vector"].some(s => t.includes(s))) return "AI/ML";
  if (["docker","kubernetes","ci/cd","github actions","linux","nginx","aws","gcp","azure","devops"].some(s => t.includes(s))) return "DevOps";
  return "工具";
}

function skillColor(category) {
  const map = {
    "前端": "var(--tag-frontend)",
    "后端": "var(--tag-backend)",
    "AI/ML": "var(--tag-ai)",
    "DevOps": "var(--tag-devops)",
  };
  return map[category] || "var(--tag-tool)";
}

function renderResume(data) {
  document.getElementById("footer-info").textContent =
    `最后更新: ${new Date().toLocaleDateString("zh-CN")}`;

  const html = [];
  html.push(`<div class="card header"><h1>${esc(data.name)}</h1>`);
  if (data.title) html.push(`<div class="title">${esc(data.title)}</div>`);
  if (data.contact) {
    html.push(`<div class="contact-row">`);
    if (data.contact.email) html.push(`<a href="mailto:${esc(data.contact.email)}">✉ ${esc(data.contact.email)}</a>`);
    if (data.contact.github) html.push(`<a href="https://${esc(data.contact.github)}" target="_blank">🐙 ${esc(data.contact.github)}</a>`);
    if (data.contact.linkedin) html.push(`<a href="https://${esc(data.contact.linkedin)}" target="_blank">💼 ${esc(data.contact.linkedin)}</a>`);
    if (data.contact.website) html.push(`<a href="${esc(data.contact.website)}" target="_blank">🌐 ${esc(data.contact.website)}</a>`);
    html.push(`</div>`);
  }
  html.push(`</div>`);

  if (data.summary) {
    html.push(`<div class="card"><h2 class="section-title">📋 个人简介</h2><p class="summary-text">${esc(data.summary)}</p></div>`);
  }

  if (data.sections) {
    for (const section of data.sections) {
      if (section.type === "experience" || section.type === "education") {
        const icon = section.type === "experience" ? "💼" : "🎓";
        html.push(`<div class="card"><h2 class="section-title">${icon} ${esc(section.title)}</h2>`);
        for (const item of section.items) {
          html.push(`<div class="timeline-item"><h3>${esc(item.title)}</h3>`);
          if (item.subtitle || item.dateRange) {
            html.push(`<div class="meta">${[item.subtitle, item.dateRange].filter(Boolean).join(" · ")}</div>`);
          }
          if (item.highlights && item.highlights.length) {
            html.push(`<ul>${item.highlights.map(h => `<li>${esc(h)}</li>`).join("")}</ul>`);
          }
          html.push(`</div>`);
        }
        html.push(`</div>`);
      }

      if (section.type === "skills") {
        html.push(`<div class="card"><h2 class="section-title">🔧 ${esc(section.title)}</h2><div class="skills-grid">`);
        for (const item of section.items) {
          if (item.tags) {
            for (const tag of item.tags) {
              const cat = getSkillCategory(tag);
              html.push(`<span class="skill-tag" style="background:${skillColor(cat)}">${esc(tag)}</span>`);
            }
          }
          if (item.description) {
            item.description.split(/[,，\/\n]/).map(t => t.trim()).filter(Boolean).forEach(t => {
              const cat = getSkillCategory(t);
              html.push(`<span class="skill-tag" style="background:${skillColor(cat)}">${esc(t)}</span>`);
            });
          }
        }
        html.push(`</div></div>`);
      }

      if (section.type === "projects") {
        html.push(`<div class="card"><h2 class="section-title">🚀 ${esc(section.title)}</h2><div class="project-grid">`);
        for (const item of section.items) {
          html.push(`<div class="project-card"><h4>${esc(item.title)}</h4>`);
          if (item.dateRange) html.push(`<div class="date">${esc(item.dateRange)}</div>`);
          if (item.subtitle) html.push(`<p>${esc(item.subtitle)}</p>`);
          if (item.description) html.push(`<p>${esc(item.description)}</p>`);
          if (item.highlights && item.highlights.length) {
            html.push(`<ul>${item.highlights.map(h => `<li>${esc(h)}</li>`).join("")}</ul>`);
          }
          html.push(`</div>`);
        }
        html.push(`</div></div>`);
      }
    }
  }

  document.getElementById("app").innerHTML = html.join("");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

loadResume();
</script>
</body>
</html>
```

- [ ] **Commit**

```bash
git add src/server/public/resume.html
git commit -m "feat(resume): add polished resume display page"
```

---

### Task 9: Resume Q&A chat page

**Files:**
- Create: `src/server/public/resume-chat.html`

**Interfaces:**
- Consumes: `POST /api/resume/chat` SSE endpoint (from Task 7)

- [ ] **Write `src/server/public/resume-chat.html`**

A chat UI with:
- Recommended question buttons
- Chat message area with streaming display
- Text input box
- Auto-scroll to bottom
- Session management (simple in-memory sessionId)
- Loading states and error handling

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>简历问答</title>
<style>
  :root {
    --bg: #f8f9fa;
    --surface: #ffffff;
    --text: #1a1a2e;
    --text-muted: #6b7280;
    --primary: #2563eb;
    --primary-light: #eff6ff;
    --border: #e5e7eb;
    --user-bg: #2563eb;
    --user-text: #ffffff;
    --ai-bg: #f0f4ff;
    --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #60a5fa;
      --primary-light: #1e3a5f;
      --border: #334155;
      --user-bg: #3b82f6;
      --ai-bg: #1e293b;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .nav-bar {
    display: flex; gap: 16px; padding: 12px 24px;
    background: var(--surface); border-bottom: 1px solid var(--border);
    font-size: 0.9rem; align-items: center;
  }
  .nav-bar a { color: var(--text-muted); text-decoration: none; padding: 6px 16px; border-radius: 8px; }
  .nav-bar a:hover, .nav-bar a.active { background: var(--primary-light); color: var(--primary); }
  .nav-bar .title { font-weight: 600; margin-right: auto; }

  #chat-area {
    flex: 1; overflow-y: auto; padding: 24px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .message { max-width: 75%; padding: 12px 16px; border-radius: var(--radius); 
    white-space: pre-wrap; word-wrap: break-word; line-height: 1.7; }
  .message.user {
    align-self: flex-end; background: var(--user-bg); color: var(--user-text);
    border-bottom-right-radius: 4px;
  }
  .message.ai {
    align-self: flex-start; background: var(--ai-bg); color: var(--text);
    border-bottom-left-radius: 4px;
  }
  .message.ai.streaming::after {
    content: "▊"; animation: blink 0.8s infinite;
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  .suggestions-area {
    padding: 8px 24px 16px;
    display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
  }
  .suggestion-btn {
    padding: 8px 18px; border-radius: 20px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text-muted); font-size: 0.85rem;
    cursor: pointer; transition: all 0.15s;
  }
  .suggestion-btn:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-light); }

  .input-area {
    display: flex; gap: 8px; padding: 16px 24px;
    border-top: 1px solid var(--border); background: var(--surface);
  }
  .input-area input {
    flex: 1; padding: 10px 16px; border: 1px solid var(--border);
    border-radius: 8px; font-size: 0.9rem; outline: none;
    background: var(--bg); color: var(--text);
  }
  .input-area input:focus { border-color: var(--primary); }
  .input-area input:disabled { opacity: 0.5; }
  .input-area button {
    padding: 10px 24px; border-radius: 8px; border: none;
    background: var(--primary); color: #fff; font-size: 0.9rem;
    cursor: pointer; transition: opacity 0.15s; font-weight: 500;
  }
  .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
  .input-area button:hover:not(:disabled) { opacity: 0.9; }

  .placeholder {
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    color: var(--text-muted); gap: 12px;
  }
  .placeholder .icon { font-size: 3rem; }
  .placeholder p { font-size: 0.95rem; }

  .error-msg { color: #dc2626; text-align: center; padding: 8px; font-size: 0.85rem; }

  @media (max-width: 600px) {
    .message { max-width: 90%; }
    #chat-area { padding: 12px; }
    .suggestions-area { padding: 8px 12px 12px; }
    .input-area { padding: 12px; }
  }
</style>
</head>
<body>
<div class="nav-bar">
  <span class="title">🤖 简历AI问答</span>
  <a href="/">📄 文档</a>
  <a href="/resume">👤 简历</a>
  <a href="/resume/chat" class="active">💬 问答</a>
</div>

<div id="chat-area">
  <div class="placeholder">
    <div class="icon">👋</div>
    <p>欢迎！我可以回答关于你简历的任何问题。</p>
    <p style="font-size:0.85rem;">试试点击下面的推荐问题，或直接输入你的问题。</p>
  </div>
</div>

<div class="suggestions-area" id="suggestions"></div>

<div class="input-area">
  <input type="text" id="question-input" placeholder="输入你的问题..." autofocus>
  <button id="send-btn">发送 🚀</button>
</div>

<script>
const SUGGESTIONS = [
  "📋 介绍我的背景",
  "💡 我有哪些技能",
  "💼 我的工作经历",
  "🎓 我的教育背景",
  "🚀 我的项目经历",
  "🎯 我适合什么岗位",
  "📄 帮我写求职信",
  "📊 分析我的技能优势",
];

let sessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
let loading = false;

const chatArea = document.getElementById("chat-area");
const input = document.getElementById("question-input");
const sendBtn = document.getElementById("send-btn");
const suggestionsEl = document.getElementById("suggestions");

// Render suggestion buttons
SUGGESTIONS.forEach(text => {
  const btn = document.createElement("button");
  btn.className = "suggestion-btn";
  btn.textContent = text;
  btn.addEventListener("click", () => ask(text));
  suggestionsEl.appendChild(btn);
});

input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", send);

async function send() {
  const q = input.value.trim();
  if (!q || loading) return;
  ask(q);
  input.value = "";
}

async function ask(question) {
  if (loading) return;
  loading = true;
  sendBtn.disabled = true;
  input.disabled = true;

  // Remove placeholder
  const placeholder = chatArea.querySelector(".placeholder");
  if (placeholder) placeholder.remove();

  // Add user message
  appendMessage("user", question);

  // Add AI message placeholder
  const aiMsgEl = appendMessage("ai", "", true);

  try {
    const res = await fetch("/api/resume/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, sessionId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "请求失败");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullAnswer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          // event type line — skip, we handle by data
        } else if (line.startsWith("data: ")) {
          try {
            const payload = JSON.parse(line.slice(6));
            if (typeof payload === "string") {
              fullAnswer += payload;
              aiMsgEl.textContent = fullAnswer;
              chatArea.scrollTop = chatArea.scrollHeight;
            }
          } catch { /* ignore parse errors */ }
        }
      }
    }

    // Process remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const payload = JSON.parse(buffer.slice(6));
        if (typeof payload === "string") {
          fullAnswer += payload;
          aiMsgEl.textContent = fullAnswer;
        }
      } catch { /* ignore */ }
    }

    aiMsgEl.classList.remove("streaming");

  } catch (err) {
    aiMsgEl.classList.remove("streaming");
    aiMsgEl.textContent = `❌ ${err.message}`;
    aiMsgEl.style.color = "#dc2626";
  }

  loading = false;
  sendBtn.disabled = false;
  input.disabled = false;
  input.focus();
  chatArea.scrollTop = chatArea.scrollHeight;
}

function appendMessage(role, content, streaming = false) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  if (streaming) el.classList.add("streaming");
  el.textContent = content;
  chatArea.appendChild(el);
  chatArea.scrollTop = chatArea.scrollHeight;
  return el;
}
</script>
</body>
</html>
```

- [ ] **Commit**

```bash
git add src/server/public/resume-chat.html
git commit -m "feat(resume): add resume Q&A chat page with SSE streaming"
```

---

### Task 10: Update RAG page navigation

**Files:**
- Modify: `src/server/public/index.html`

- [ ] **Edit `src/server/public/index.html`**

Add a navigation bar at the top of the RAG document manager page:

```html
<!-- After <body> opening tag, before <div class="container"> -->
<div style="text-align:center;margin-bottom:24px;font-size:0.9rem;">
  <a href="/" style="color:#2563eb;text-decoration:none;padding:6px 16px;border-radius:8px;font-weight:600;">📄 文档管理</a>
  <a href="/resume" style="color:#6b7280;text-decoration:none;padding:6px 16px;border-radius:8px;">👤 简历</a>
  <a href="/resume/chat" style="color:#6b7280;text-decoration:none;padding:6px 16px;border-radius:8px;">💬 简历问答</a>
</div>
```

- [ ] **Commit**

```bash
git add src/server/public/index.html
git commit -m "feat(resume): add resume navigation links to RAG page"
```

---

### Task 11: Wire everything up in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Edit `src/index.ts`**

```typescript
#!/usr/bin/env node
import "dotenv/config";
import React from "react";
import { render } from "ink";
import { App } from "./tui/app.js";
import { loadConfig } from "./config/index.js";
import { createChatModel } from "./agent/langchain.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { createAgentExecutor } from "./agent/loop.js";
import { createTools } from "./tools/registry.js";
import { OpenAIEmbeddings } from "@langchain/openai";
import { AgentMemory } from "./memory/index.js";
import { RagVectorStore } from "./rag/vectorstore.js";
import { RagSearchTool } from "./rag/retriever.js";
import { createRagServer } from "./server/index.js";
import { ResumeStore } from "./resume/store.js";
import { ResumeSearchTool } from "./resume/search-tool.js";
import { parseResume } from "./resume/parser.js";
import { existsSync, readFileSync } from "node:fs";

async function main() {
  const config = loadConfig();
  const llm = createChatModel(config);

  const embeddings = new OpenAIEmbeddings({
    apiKey: config.openAIApiKey,
    model: "text-embedding-3-small",
  });

  const memory = await AgentMemory.create("navigate.db", embeddings);

  // RAG setup
  const ragStore = new RagVectorStore(embeddings);
  const ragTool = new RagSearchTool(ragStore);

  // Resume setup
  let resumeSummary: string | undefined;
  let resumeTool: ResumeSearchTool | undefined;
  let resumeData: Awaited<ReturnType<typeof parseResume>> | undefined;
  let resumeStore: ResumeStore | undefined;

  if (existsSync("resume.md")) {
    try {
      resumeStore = await ResumeStore.create("navigate.db", embeddings);
      const rawMd = readFileSync("resume.md", "utf-8");
      resumeData = parseResume("resume.md");

      const hash = simpleHash(rawMd);
      if (await resumeStore.hasChanged(hash)) {
        await resumeStore.import(resumeData, rawMd);
        console.log("Resume indexed successfully");
      } else {
        console.log("Resume unchanged, using cached index");
      }

      resumeSummary = await resumeStore.getSummary();
      resumeTool = new ResumeSearchTool(resumeStore);
    } catch (err) {
      console.error("Resume loading skipped:", (err as Error).message);
    }
  }

  const allTools = [
    ...createTools(),
    ragTool,
    ...(resumeTool ? [resumeTool] : []),
  ];

  const systemPrompt = buildSystemPrompt(resumeSummary);
  const executor = await createAgentExecutor(llm, allTools, systemPrompt, config.maxIterations);

  createRagServer(ragStore, 3001, executor, resumeStore, resumeData);

  render(React.createElement(App, { executor, memory }));
}

function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(16);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
```

- [ ] **Run typecheck**

```bash
npx tsc --noEmit
```
Expected: pass

- [ ] **Commit**

```bash
git add src/index.ts
git commit -m "feat(resume): wire up ResumeStore, parser, and tool into application"
```

---

### Task 12: Final typecheck and smoke test

- [ ] **Full typecheck**

```bash
npx tsc --noEmit
```
Expected: pass cleanly, zero errors

- [ ] **Verify file structure**

```bash
echo "=== New files ===" && ls -la src/resume/ && echo "=== Web pages ===" && ls -la src/server/public/
```

Expected:
```
src/resume/:
  types.ts
  parser.ts
  store.ts
  search-tool.ts
src/server/public/:
  index.html
  resume.html
  resume-chat.html
```

- [ ] **Quick smoke test (start app, check server boots without crash)**

```bash
timeout 10 npx tsx src/index.ts 2>&1 || true
```
Expected: Prints "RAG server on http://localhost:3001" and optionally "Resume indexed successfully"

- [ ] **Commit any remaining changes**

```bash
git add -A && git commit -m "chore: finalize resume RAG implementation" || echo "Nothing to commit"
```
