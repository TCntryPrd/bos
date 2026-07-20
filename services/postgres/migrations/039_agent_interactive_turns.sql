CREATE TABLE IF NOT EXISTS boss_agent_turns (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('rascal','outsider')),
  handle TEXT NOT NULL,
  chat_session_id UUID NOT NULL REFERENCES boss_chat_sessions(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL REFERENCES boss_chat_messages(id) ON DELETE CASCADE,
  cli_session_id TEXT,
  raw_prompt TEXT NOT NULL,
  enriched_prompt TEXT NOT NULL,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  response TEXT NOT NULL DEFAULT '',
  recap TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','starting','running','interrupting','completed','interrupted','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_boss_agent_turns_handle
  ON boss_agent_turns (tenant_id, agent_kind, handle, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_boss_agent_turns_chat_session
  ON boss_agent_turns (chat_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_boss_agent_turns_recovery
  ON boss_agent_turns (status, started_at)
  WHERE status IN ('queued','starting','running','interrupting');

CREATE UNIQUE INDEX IF NOT EXISTS uq_boss_agent_turns_one_active
  ON boss_agent_turns (tenant_id, agent_kind, handle)
  WHERE status IN ('queued','starting','running','interrupting');
