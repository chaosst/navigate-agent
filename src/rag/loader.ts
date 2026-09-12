import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import mammoth from "mammoth";
import path from "path";
import { readFileSync } from "node:fs";
import type { LoadedChunk } from "./types.js";

// LoadedChunk 已上移到 ./types.js（pdf / md / plain 三个 chunker 共用同一契约）。
// 此处 re-export 保持既有 import 路径不破。
export type { LoadedChunk };

export async function loadDocument(filePath: string, filename: string, chunkSize = 1000, chunkOverlap = 200): Promise<LoadedChunk[]> {
  const ext = path.extname(filename).toLowerCase();
  let content: string;
  switch (ext) {
    case ".pdf":
      // Use pdf-parse directly instead of LangChain PDFLoader
      const { PDFParse } = await import("pdf-parse");
      const pdfBuf = readFileSync(filePath);
      const pdfP = new (PDFParse as any)({}) as { load: (b: Buffer) => Promise<void>; getText: (o: object) => Promise<string> };
      await pdfP.load(pdfBuf);
      content = await pdfP.getText({});
      break;
    case ".docx":
      const result = await mammoth.extractRawText({ path: filePath });
      content = result.value;
      break;
    default: // .txt, .md, etc
      content = readFileSync(filePath, "utf-8");
  }

  const doc = new Document({ pageContent: content, metadata: { filename } });
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  const splitDocs = await splitter.splitDocuments([doc]);
  return splitDocs.map(d => ({
    content: d.pageContent,
    metadata: { ...d.metadata, filename, source: filename, strategy: "text-char" },
  }));
}
