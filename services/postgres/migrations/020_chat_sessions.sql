-- 020_chat_sessions.sql — Persistent DB-backed chat sessions for the
-- Rascal Workspace (v1.6.3+).
--
-- Per the locked plan at /home/tcntryprd/BOSS_RASCAL_WORKSPACE_PLAN.md:
-- the workspace UI talks to the Anthropic API directly via the backend,
-- with messages persisted in Postgres. Each session loads the rascal's
-- SOUL.md as the system prompt at creation time (snapshot, not live read).
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS boss_chat_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  rascal_handle TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  model         TEXT        NOT NULL DEFAULT 'claude-sonnet-4-5',
  system_prompt TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived      BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_rascal
  ON boss_chat_sessions (tenant_id, rascal_handle, updated_at DESC);

DROP TRIGGER IF EXISTS boss_chat_sessions_set_updated_at ON boss_chat_sessions;
CREATE TRIGGER boss_chat_sessions_set_updated_at
  BEFORE UPDATE ON boss_chat_sessions
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

CREATE TABLE IF NOT EXISTS boss_chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID        NOT NULL REFERENCES boss_chat_sessions(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('user','assistant','system')),
  content    TEXT        NOT NULL,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
  ON boss_chat_messages (session_id, created_at);
