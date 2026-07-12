-- 024_chat_sessions_agent_kind.sql — generalize chat sessions to support
-- both rascals and outsiders.
--
-- Background: boss_chat_sessions was added in 020 keyed by
-- (tenant_id, rascal_handle). v1.6.9 introduces the Outsider Workspace,
-- which needs to write rows into the same table without colliding with
-- a hypothetical rascal that shares a handle (none today, but cheap to
-- prevent).
--
-- Strategy: add an agent_kind column with default 'rascal' so all
-- existing rows pass the CHECK without modification. Update the lookup
-- index to include the kind. Column rename of rascal_handle is
-- intentionally skipped — no callers break that way.
--
-- Idempotent.

ALTER TABLE boss_chat_sessions
  ADD COLUMN IF NOT EXISTS agent_kind TEXT NOT NULL DEFAULT 'rascal';

ALTER TABLE boss_chat_sessions
  DROP CONSTRAINT IF EXISTS boss_chat_sessions_agent_kind_ck;
ALTER TABLE boss_chat_sessions
  ADD CONSTRAINT boss_chat_sessions_agent_kind_ck
  CHECK (agent_kind IN ('rascal','outsider'));

DROP INDEX IF EXISTS idx_chat_sessions_rascal;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent
  ON boss_chat_sessions (tenant_id, agent_kind, rascal_handle, updated_at DESC);
