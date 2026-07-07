import express from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { RagVectorStore } from "../rag/vectorstore.js";
import { loadDocument } from "../rag/loader.js";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DocMeta {
  filename: string;
  chunks: number;
  indexedAt: Date;
}

export function createRagServer(store: RagVectorStore, port: number = 3001) {
  const app = express();
  const upload = multer({ dest: "rag_uploads/" });
  const docMeta = new Map<string, DocMeta>();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

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

  app.listen(port, () => console.log(`RAG server on http://localhost:${port}`));
  return app;
}
