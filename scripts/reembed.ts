#!/usr/bin/env node
/**
 * 为所有没有 embedding 的 chunk 重新生成向量。
 *
 * 用法: npx tsx scripts/reembed.ts
 */
import { Pool } from "pg";
import "dotenv/config";
import { loadConfig } from "../src/config/index.js";
import { createEmbeddings } from "../src/agent/langchain.js";

async function main() {
  // 统一走 loadConfig + createEmbeddings：baseURL/模型/apiKey 全部跟随 provider 解析，
  // 此前硬编码 baseURL="https://api.deepseek.com/v1" 且模型写死，切 provider 就得改脚本。
  const config = loadConfig();
  const dbUrl = config.databaseUrl;

  const pg = new Pool({ connectionString: dbUrl });
  const embeddings = createEmbeddings(config);

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
