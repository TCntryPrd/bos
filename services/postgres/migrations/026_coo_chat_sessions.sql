-- 026_coo_chat_sessions.sql — extend boss_chat_sessions to support COO threads.
--
-- Background: boss_chat_sessions was generalized in migration 024 to allow
-- agent_kind IN ('rascal','outsider'). v1.7.7 introduces COO chat — a third
-- kind where each row represents one thread of Kevin's private chat with
-- IR Custom AIOS, scoped to a per-thread workspace directory.
--
-- For agent_kind='coo' rows, rascal_handle is reused as the thread slug
-- (kebab-cased name + 6-char suffix). workspace_dir is required at the
-- application layer; no DB constraint to keep rascal/outsider rows clean.
--
-- Idempotent.

ALTER TABLE boss_chat_sessions
  DROP CONSTRAINT IF EXISTS boss_chat_sessions_agent_kind_ck;
ALTER TABLE boss_chat_sessions
  ADD CONSTRAINT boss_chat_sessions_agent_kind_ck
  CHECK (agent_kind IN ('rascal','outsider','coo'));

ALTER TABLE boss_chat_sessions
  ADD COLUMN IF NOT EXISTS workspace_dir TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_coo
  ON boss_chat_sessions (tenant_id, agent_kind, updated_at DESC)
  WHERE agent_kind = 'coo';
