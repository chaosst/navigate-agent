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
  embedding   vector(1536),
  chunk_index INTEGER NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  fts_vector  tsvector
      GENERATED ALWAYS AS (to_tsvector('chinese_zh', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON doc_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON doc_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON doc_chunks USING GIN (fts_vector);
