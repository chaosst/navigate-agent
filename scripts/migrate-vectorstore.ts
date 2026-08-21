#!/usr/bin/env node
/**
 * 从旧的 vectorstore.json + docmeta.json 导入文档到 PostgreSQL。
 *
 * 用法: npx tsx scripts/migrate-vectorstore.ts
 */

import { Pool } from "pg";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";

/** 将任意字符串转成 UUID v5 格式 */
function strToUuid(s: string): string {
  const hash = createHash("md5").update(s).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL required"); process.exit(1); }

  const pg = new Pool({ connectionString: dbUrl });

  // 读取 docMeta
  const metaPath = "rag_data/docmeta.json";
  const docMetas: { id: string; filename: string; chunks: number; indexedAt: string }[] =
    existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : [];

  // 读取 vectorstore
  const vsPath = "rag_data/vectorstore.json";
  if (!existsSync(vsPath)) { console.log("No vectorstore.json found"); await pg.end(); return; }
  const vs = JSON.parse(readFileSync(vsPath, "utf-8"));
  const rawChunks: { content: string; metadata: Record<string, unknown> }[] = vs.rawChunks ?? [];
  const vectors: number[][] = vs.vectors ?? [];

  console.log(`DocMeta entries: ${docMetas.length}, Chunks: ${rawChunks.length}, Vectors: ${vectors.length}`);

  // 按 docId 分组 chunks（旧数据可能用字符串而非 UUID）
  const chunkGroups = new Map<string, { content: string; metadata: Record<string, unknown>; vector?: number[] }[]>();
  for (let i = 0; i < rawChunks.length; i++) {
    const c = rawChunks[i];
    const rawId = (c.metadata?.docId as string) || (c.metadata?.source as string) || `legacy-${i}`;
    const docId = strToUuid(rawId);
    if (!chunkGroups.has(docId)) chunkGroups.set(docId, []);
    chunkGroups.get(docId)!.push({ ...c, vector: vectors[i] });
  }

  const client = await pg.connect();
  let totalChunks = 0;
  let totalDocs = 0;

  try {
    await client.query("BEGIN");

    for (const [docId, chunks] of chunkGroups) {
      // 找对应的 docMeta
      const meta = docMetas.find(m => m.id === docId);
      const filename = meta?.filename || (chunks[0]?.metadata?.filename as string) || "legacy";

      // 创建 documents 行
      await client.query(
        `INSERT INTO documents (id, filename, chunk_count, indexed_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET chunk_count = documents.chunk_count + $3`,
        [docId, filename, chunks.length, meta?.indexedAt ? new Date(meta.indexedAt).toISOString() : new Date().toISOString()],
      );

      // 插入 chunks
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const chunkId = randomUUID();
        const embedding = c.vector ? `[${c.vector.join(",")}]` : null;
        await client.query(
          `INSERT INTO doc_chunks (id, doc_id, content, embedding, chunk_index, metadata)
           VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [chunkId, docId, c.content, embedding, i, JSON.stringify(c.metadata)],
        );
        totalChunks++;
      }
      totalDocs++;
    }

    await client.query("COMMIT");
    console.log(`Migrated ${totalDocs} documents with ${totalChunks} chunks`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", (e as Error).message);
    throw e;
  } finally {
    client.release();
    await pg.end();
  }
}

main().catch(console.error);
