-- 002: 会话与对话记忆表（L2 关系型存储）

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'New Chat',
  owner       TEXT NOT NULL DEFAULT 'admin',
  project     TEXT NOT NULL DEFAULT '',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  visibility  TEXT NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private', 'team', 'public')),
  permissions JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS summaries (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  msg_start_id    BIGINT,
  msg_end_id      BIGINT,
  original_chars  INTEGER DEFAULT 0,
  -- 维度与 embedding 模型强相关（当前 nomic-embed-text = 768），换模型需同步 ALTER
  embedding       vector(768),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_summaries_embedding ON summaries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);
