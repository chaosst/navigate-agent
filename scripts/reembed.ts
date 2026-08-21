#!/usr/bin/env node
/**
 * 为所有没有 embedding 的 chunk 重新生成向量。
 *
 * 用法: npx tsx scripts/reembed.ts
 */
import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { config } from "dotenv";

config();

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error("OPENAI_API_KEY required"); process.exit(1); }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL required"); process.exit(1); }

  const pg = new Pool({ connectionString: dbUrl });
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-embedding-v1",
  });

  // 找出所有没有 embedding 的 chunk
  const { rows: chunks } = await pg.query(
    "SELECT id, content FROM doc_chunks WHERE embedding IS NULL",
  );
  console.log(`Found ${chunks.length} chunks without embeddings`);

  if (chunks.length === 0) { await pg.end(); return; }

  // 分批处理（OpenAI 有限速）
  const BATCH = 20;
  let done = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    try {
      const texts = batch.map((c) => c.content);
      const vectors = await embeddings.embedDocuments(texts);
      const client = await pg.connect();
      try {
        await client.query("BEGIN");
        for (let j = 0; j < batch.length; j++) {
          await client.query(
            "UPDATE doc_chunks SET embedding = $1::vector WHERE id = $2",
            [`[${vectors[j].join(",")}]`, batch[j].id],
          );
        }
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      done += batch.length;
      console.log(`Progress: ${done}/${chunks.length}`);
    } catch (e) {
      console.error(`Batch ${i} failed:`, (e as Error).message);
      // 继续下一批
    }
  }

  console.log(`Done! ${done} chunks embedded`);
  await pg.end();
}

main().catch(console.error);
