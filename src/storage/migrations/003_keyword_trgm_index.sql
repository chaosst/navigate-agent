-- 003: 关键词子串检索加速索引（ILIKE '%q%'）
-- pg_trgm 扩展已在 001 启用;索引对 >=3 字符的 ILIKE 模式生效

CREATE INDEX IF NOT EXISTS idx_chunks_content_trgm
  ON doc_chunks USING GIN (content gin_trgm_ops);
