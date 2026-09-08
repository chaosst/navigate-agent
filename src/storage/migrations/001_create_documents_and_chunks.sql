-- 001: 文档与块表（L2 元数据 + L3 向量）

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS zhparser;

-- 中文全文搜索配置（PostgreSQL 不支持 CREATE TS CONFIG IF NOT EXISTS，用 DO 块）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'chinese_zh') THEN
    CREATE TEXT SEARCH CONFIGURATION chinese_zh (PARSER = zhparser);
    ALTER TEXT SEARCH CONFIGURATION chinese_zh
      ADD MAPPING FOR n, v, a, i, e, l WITH simple;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY,
  filename        TEXT NOT NULL,
  stored_filename TEXT,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  owner           TEXT NOT NULL DEFAULT 'admin',
  project         TEXT NOT NULL DEFAULT '',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  visibility      TEXT NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private', 'team', 'public')),
  permissions     JSONB NOT NULL DEFAULT '[]',
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  wiki_page_id    INTEGER,
  metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id          UUID PRIMARY KEY,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  -- 维度与 embedding 模型强相关：nomic-embed-text=768 / bge-m3=1024 / text-embedding-3-small=1536。
  -- 换模型需同步 ALTER COLUMN + 重建索引。
  embedding   vector(768),
  chunk_index INTEGER NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  fts_vector  tsvector
      GENERATED ALWAYS AS (to_tsvector('chinese_zh', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON doc_chunks(doc_id);
-- 向量索引用 hnsw 而非 ivfflat：ivfflat 中心只在建索引时训练一次，
-- 空表/小数据量建索引后增量插入会导致 ANN 召回系统性崩塌（scoped 检索归零）。
-- hnsw 无需训练、对增量数据直接生效，小库（<10k chunks）召回与精度均更稳。
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON doc_chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON doc_chunks USING GIN (fts_vector);
