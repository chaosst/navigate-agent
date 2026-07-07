import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Document } from "@langchain/core/documents";
import mammoth from "mammoth";
import path from "path";

export interface LoadedChunk {
  content: string;
  metadata: Record<string, unknown>;
}

export async function loadDocument(filePath: string, filename: string, chunkSize = 1000, chunkOverlap = 200): Promise<LoadedChunk[]> {
  const ext = path.extname(filename).toLowerCase();
  let content: string;
  switch (ext) {
    case ".pdf":
      const pdfLoader = new PDFLoader(filePath);
      const pdfDocs = await pdfLoader.load();
      content = pdfDocs.map(d => d.pageContent).join("\n");
      break;
    case ".docx":
      const result = await mammoth.extractRawText({ path: filePath });
      content = result.value;
      break;
    default: // .txt, .md, etc
      const txtLoader = new TextLoader(filePath);
      const txtDocs = await txtLoader.load();
      content = txtDocs.map(d => d.pageContent).join("\n");
  }

  const doc = new Document({ pageContent: content, metadata: { filename } });
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  const splitDocs = await splitter.splitDocuments([doc]);
  return splitDocs.map(d => ({
    content: d.pageContent,
    metadata: { ...d.metadata, filename, source: filename },
  }));
}
