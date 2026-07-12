-- 032_gio_chat_sessions.sql — allow Gio /oc chat to use the shared
-- boss_chat_sessions + boss_chat_messages bridge.
--
-- Gio is a Codex CLI operator, not a rascal/outsider/COO Claude thread,
-- but the UI needs the same DB-backed message log and last-50 reconnect
-- behavior.

ALTER TABLE boss_chat_sessions
  DROP CONSTRAINT IF EXISTS boss_chat_sessions_agent_kind_ck;
ALTER TABLE boss_chat_sessions
  ADD CONSTRAINT boss_chat_sessions_agent_kind_ck
  CHECK (agent_kind IN ('rascal','outsider','coo','gio'));

CREATE INDEX IF NOT EXISTS idx_chat_sessions_gio
  ON boss_chat_sessions (tenant_id, agent_kind, updated_at DESC)
  WHERE agent_kind = 'gio';
