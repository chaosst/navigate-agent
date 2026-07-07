import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import path from "path";

export interface LoadedChunk {
  content: string;
  metadata: Record<string, unknown>;
}

export async function loadDocument(filePath: string, filename: string, chunkSize = 1000, chunkOverlap = 200): Promise<LoadedChunk[]> {
  const ext = path.extname(filename).toLowerCase();
  let loader;
  switch (ext) {
    case ".pdf":
      loader = new PDFLoader(filePath);
      break;
    case ".docx":
      loader = new DocxLoader(filePath);
      break;
    default: // .txt, .md, etc
      loader = new TextLoader(filePath);
  }
  const docs = await loader.load();
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  const splitDocs = await splitter.splitDocuments(docs);
  return splitDocs.map(d => ({
    content: d.pageContent,
    metadata: { ...d.metadata, filename, source: filename },
  }));
}
