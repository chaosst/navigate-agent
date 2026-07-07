import initSqlJs, { Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import type { Session, MemoryMessage } from "./types.js";

export class SqliteStore {
  private db: Database;
  private dbPath: string;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.initTables();
  }

  static async create(dbPath: string): Promise<SqliteStore> {
    const SQL = await initSqlJs();
    let db: Database;
    if (existsSync(dbPath)) {
      const buf = readFileSync(dbPath);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }
    db.run("PRAGMA journal_mode=WAL");
    return new SqliteStore(db, dbPath);
  }

  private initTables(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)");
    this.save();
  }

  private save(): void {
    writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  createSession(name?: string): Session {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.run("INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [id, name || "New Chat", now, now]);
    this.save();
    return { id, name: name || "New Chat", createdAt: new Date(now), updatedAt: new Date(now) };
  }

  getSession(id: string): Session | null {
    const r = this.db.exec("SELECT * FROM sessions WHERE id = ?", [id]);
    if (!r.length || !r[0].values.length) return null;
    const row = r[0].values[0];
    return { id: row[0] as string, name: row[1] as string, createdAt: new Date(row[2] as number), updatedAt: new Date(row[3] as number) };
  }

  listSessions(): Session[] {
    const r = this.db.exec("SELECT * FROM sessions ORDER BY updated_at DESC");
    if (!r.length) return [];
    return r[0].values.map(row => ({
      id: row[0] as string, name: row[1] as string,
      createdAt: new Date(row[2] as number), updatedAt: new Date(row[3] as number)
    }));
  }

  deleteSession(id: string): void {
    this.db.run("DELETE FROM messages WHERE session_id = ?", [id]);
    this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    this.save();
  }

  addMessage(sessionId: string, role: string, content: string): MemoryMessage {
    const now = Date.now();
    this.db.run("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      [sessionId, role, content, now]);
    this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, sessionId]);
    this.save();
    return { role: role as MemoryMessage["role"], content, createdAt: new Date(now) };
  }

  getMessages(sessionId: string, limit?: number): MemoryMessage[] {
    let sql = "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC";
    const params: any[] = [sessionId];
    if (limit !== undefined) { sql += " LIMIT ?"; params.push(limit); }
    const r = this.db.exec(sql, params);
    if (!r.length) return [];
    return r[0].values.map(row => ({
      role: row[2] as MemoryMessage["role"], content: row[3] as string,
      createdAt: new Date(row[4] as number)
    }));
  }

  getRecentContext(sessionId: string, limit: number = 10): string {
    return this.getMessages(sessionId, limit)
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
  }

  close(): void {
    this.save();
  }
}
