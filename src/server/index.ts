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
import { tokenManager } from "./token.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fix Chinese filename encoding from multer (Latin-1 → UTF-8) */
function fixEncoding(str: string): string {
  try {
    const decoded = Buffer.from(str, "latin1").toString("utf8");
    return decoded !== str ? decoded : str;
  } catch {
    return str;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentExecutor = any;

interface DocMeta {
  filename: string;
  chunks: number;
  indexedAt: Date;
}

/** HTML page shown when token is missing or invalid */
const ACCESS_DENIED_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Access Denied</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}.card{background:#1e293b;padding:48px 40px;border-radius:16px;max-width:480px;box-shadow:0 4px 24px rgba(0,0,0,.3)}h1{font-size:1.6rem;margin-bottom:8px}.hint{color:#94a3b8;font-size:.9rem;margin:20px 0;line-height:1.6}.token-box{background:#0f172a;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:.85rem;word-break:break-all;color:#60a5fa}.footer{color:#64748b;font-size:.8rem;margin-top:24px}</style></head><body><div class="card"><h1>🔒 Access Denied</h1><p class="hint">需要有效的访问令牌才能使用此页面。<br>请使用 <code>?token=xxx</code> 参数访问。</p><p class="hint">在启动应用的终端中查找访问令牌。</p></div></body></html>`;

/** Helper to extract token from query or body */
function getToken(req: express.Request): string | undefined {
  if (req.query?.token) return req.query.token as string;
  if (req.body?.token) return req.body.token;
  return undefined;
}

/** Middleware: validates token or returns 401 */
function requireToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = getToken(req);
  if (tokenManager.validate(token)) {
    // Attach validated token for downstream use
    (req as any).validToken = token;
    next();
    return;
  }
  // API calls → JSON; browser page loads → HTML denied page
  if (req.accepts("json") || req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Invalid or expired token" });
  } else {
    res.status(401).send(ACCESS_DENIED_PAGE);
  }
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

  // === Token management ===

  // Generate the initial access token on startup
  const initialToken = tokenManager.generate();
  console.log(`\n🔑 Access token: ${initialToken} (valid 30 min)`);
  console.log(`   RAG Document Manager: http://localhost:${port}/?token=${initialToken}`);
  console.log(`   Resume Chat:          http://localhost:${port}/resume/chat?token=${initialToken}\n`);

  // Get token info / check validity
  app.get("/api/token", (req, res) => {
    const token = getToken(req);
    if (token && tokenManager.validate(token)) {
      const createdAt = tokenManager.getCreatedAt(token)!;
      const expiresIn = Math.round((createdAt + 30 * 60 * 1000 - Date.now()) / 1000);
      res.json({ valid: true, token, expiresIn, createdAt });
    } else {
      res.json({ valid: false });
    }
  });

  // Generate a new token (requires valid current token)
  app.post("/api/token/renew", requireToken, (_req, res) => {
    const newToken = tokenManager.generate();
    res.json({ token: newToken, expiresIn: 30 * 60 });
  });

  // === Protected routes (require ?token=xxx) ===

  // Protect the RAG manager page
  app.get("/", requireToken, (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // Protect the resume chat page
  app.get("/resume/chat", requireToken, (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "resume-chat.html"));
  });

  // Protect RAG API endpoints
  app.post("/api/upload", requireToken, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const docId = randomUUID();
      const filename = fixEncoding(req.file.originalname);
      const filePath = req.file.path;
      const chunks = await loadDocument(filePath, filename);
      await store.addChunks(chunks, docId);
      docMeta.set(docId, { filename, chunks: chunks.length, indexedAt: new Date() });
      res.json({ docId, filename, chunks: chunks.length });
    } catch (err) {
      console.error("[upload] Error:", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/documents", requireToken, (_req, res) => {
    const ids = Array.from(docMeta.entries()).map(([id, meta]) => ({
      id,
      filename: meta.filename,
      chunks: meta.chunks,
      indexedAt: meta.indexedAt,
    }));
    res.json(ids);
  });

  app.delete("/api/documents/:id", requireToken, (req, res) => {
    const id = req.params.id as string;
    docMeta.delete(id);
    res.json({ deleted: id });
  });

  app.post("/api/query", requireToken, async (req, res) => {
    try {
      const { query, k } = req.body;
      if (!query) return res.status(400).json({ error: "Missing query" });
      const results = await store.search(query, k || 5);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // === Public routes (no token needed) ===

  // Resume display page — public
  app.get("/resume", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "resume.html"));
  });

  // Resume data API — public
  app.get("/api/resume", async (_req, res) => {
    if (!resumeStore) return res.status(404).json({ error: "Resume not available" });
    const data = await resumeStore.getResumeData();
    if (!data) return res.status(404).json({ error: "No resume data found" });
    res.json({ ...data, sections: resumeData?.sections || [] });
  });

  // === SSE Chat (protected — token used as sessionId) ===

  const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
  const SESSION_MAX_COUNT = 100;

  interface SessionData {
    messages: { role: string; content: string }[];
    createdAt: number;
  }

  const sessions = new Map<string, SessionData>();

  function cleanSessions(): void {
    const now = Date.now();
    for (const [sid, data] of sessions) {
      if (now - data.createdAt > SESSION_MAX_AGE_MS) sessions.delete(sid);
    }
    if (sessions.size > SESSION_MAX_COUNT) {
      const sorted = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = sorted.slice(0, sorted.length - SESSION_MAX_COUNT);
      for (const [sid] of toRemove) sessions.delete(sid);
    }
  }

  app.post("/api/resume/chat", requireToken, async (req, res) => {
    if (!executor) {
      return res.status(503).json({ error: "Agent executor not available" });
    }

    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question" });

    // Token IS the sessionId — same token = same chat history
    const sid = (req as any).validToken;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (!sessions.has(sid)) {
      cleanSessions();
      sessions.set(sid, { messages: [], createdAt: Date.now() });
    }
    const session = sessions.get(sid)!;
    session.messages.push({ role: "user", content: question });

    let fullAnswer = "";
    try {
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
        if (typeof (res as any).flush === "function") (res as any).flush();
      }

      if (session.messages.length > 50) {
        session.messages = session.messages.slice(-50);
      }
      session.messages.push({ role: "assistant", content: fullAnswer });

      res.write(`event: done\ndata: __DONE__\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
    }
    res.end();
  });

  // Chat history endpoint — load past messages by token
  app.get("/api/chat/history", requireToken, (req, res) => {
    const sid = (req as any).validToken;
    const session = sessions.get(sid);
    if (!session) return res.json({ messages: [] });
    res.json({
      messages: session.messages.filter(m => m.role !== "system"),
      createdAt: session.createdAt,
    });
  });

  // Favicon — silent 204
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  // Catch‑all: any unprotected page → denied
  app.use((req, res) => {
    if (req.accepts("json") || req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.status(401).send(ACCESS_DENIED_PAGE);
  });

  app.listen(port, () => console.log(`RAG server on http://localhost:${port}`));
  return app;
}
