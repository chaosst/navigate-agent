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

/** Fix Chinese filename encoding from multer (Latin-1 → UTF-8) */
function fixEncoding(str: string): string {
  try {
    const decoded = Buffer.from(str, "latin1").toString("utf8");
    // Only use decoded if it looks different (has multi-byte chars)
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

  // Explicit routes for resume pages (SIG-UI navigation)
  app.get("/resume", (_req, res) => res.sendFile(path.join(__dirname, "public", "resume.html")));
  app.get("/resume/chat", (_req, res) => res.sendFile(path.join(__dirname, "public", "resume-chat.html")));

  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const docId = randomUUID();
      // Fix Chinese filename encoding: browser sends UTF-8, multer may decode as Latin-1
      const filename = fixEncoding(req.file.originalname);
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
    // In-memory store can't remove individual docs yet
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
  const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
  const SESSION_MAX_COUNT = 100;

  interface SessionData {
    messages: { role: string; content: string }[];
    createdAt: number;
  }

  const sessions = new Map<string, SessionData>();

  function cleanSessions(): void {
    const now = Date.now();
    // Remove sessions older than 1 hour
    for (const [sid, data] of sessions) {
      if (now - data.createdAt > SESSION_MAX_AGE_MS) {
        sessions.delete(sid);
      }
    }
    // If still over the limit, evict the oldest
    if (sessions.size > SESSION_MAX_COUNT) {
      const sorted = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = sorted.slice(0, sorted.length - SESSION_MAX_COUNT);
      for (const [sid] of toRemove) {
        sessions.delete(sid);
      }
    }
  }

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
    if (!sessions.has(sid)) {
      cleanSessions();
      sessions.set(sid, { messages: [], createdAt: Date.now() });
    }
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

      res.write(`event: done\ndata: __DONE__\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`);
    }
    res.end();
  });

  app.listen(port, () => console.log(`RAG server on http://localhost:${port}`));
  return app;
}
