import initSqlJs, { Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

    this.db.run("BEGIN");

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

    this.db.run("COMMIT");
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

  /** Cryptographic MD5 hash for reliable change detection. */
  private md5(content: string): string {
    return createHash("md5").update(content).digest("hex");
  }

  /** Non-cryptographic hash for lightweight comparisons (legacy). */
  private simpleHash(content: string): string {
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
