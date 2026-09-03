#!/usr/bin/env node
/**
 * 线上（服务器）补向量脚本 —— 自包含、零项目源码依赖。
 *
 * 适用场景：PG 数据卷快照早于本地补向量，导致 doc_chunks.embedding 全为 NULL
 * （本机已验证 DeepSeek 无 embedding 服务 → 切 ollama 后才补的向量，旧快照里没有）。
 *
 * 在 app 容器内执行：容器已由 compose 注入 DATABASE_URL / EMBEDDING_BASE_URL
 * / EMBEDDING_MODEL，且 node_modules 里含 pg 生产依赖；ollama 服务名容器内网直通。
 *
 * 用法（在服务器上，仓库根目录）：
 *   scp scripts/backfill-embedding-remote.cjs <user>@<server>:/tmp/
 *   ssh <user>@<server> "docker cp /tmp/backfill-embedding-remote.cjs navigate-app-1:/app/ \
 *     && docker exec navigate-app-1 node /app/backfill-embedding-remote.cjs"
 *
 * 注意：必须 cp 到 /app/ 下（而非 /tmp/）——require("pg") 从脚本所在目录向上找
 * node_modules，/app/node_modules 才能命中。
 *
 * 幂等：只处理 embedding IS NULL 的行，中途失败可安全重跑。
 */
"use strict";

const { Pool } = require("pg");

const BATCH = 16; // 每批 embedding 的文本数（ollama 一次请求支持多输入）

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL 未设置（应由 compose env_file 注入）");
  const base = process.env.EMBEDDING_BASE_URL || "http://ollama:11434/v1";
  const model = process.env.EMBEDDING_MODEL || "nomic-embed-text";
  const embedUrl = `${base.replace(/\/+$/, "")}/embeddings`;

  const pool = new Pool({ connectionString: dbUrl });

  // 1) 找出待补向量的 chunk
  const { rows } = await pool.query(
    `SELECT id, content FROM doc_chunks WHERE embedding IS NULL ORDER BY chunk_index`
  );
  if (rows.length === 0) {
    console.log("没有需要补向量的行（已全部就位）");
    await pool.end();
    return;
  }
  console.log(`待补向量: ${rows.length} 条 | endpoint=${embedUrl} model=${model}`);

  // 2) 分批 embedding + 逐条更新
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const resp = await fetch(embedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: batch.map((r) => r.content) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      throw new Error(`embedding HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    const data = await resp.json();
    for (let j = 0; j < batch.length; j++) {
      const vec = data.data[j]?.embedding;
      if (!vec) throw new Error(`第 ${i + j + 1} 条未返回向量`);
      await pool.query(
        `UPDATE doc_chunks SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(vec), batch[j].id]
      );
      done++;
    }
    console.log(`进度 ${done}/${rows.length}`);
  }

  // 3) 校验
  const chk = await pool.query(
    `SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS has_vec, count(*) AS total FROM doc_chunks`
  );
  console.log(`✅ 完成 ${done} 条，当前 has_vec=${chk.rows[0].has_vec} / total=${chk.rows[0].total}`);
  await pool.end();
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
