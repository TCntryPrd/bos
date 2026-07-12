-- 025_agent_model_column.sql — give every rascal and outsider an explicit
-- model so the spawn paths can pin per-agent defaults. Sonnet 4.6 is the
-- house default; Opus is opt-in per task when token-heavy work demands it.
--
-- Per-message override stays on the chat-turn payload (no DB hit).
--
-- Idempotent.

ALTER TABLE boss_rascals
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6';

ALTER TABLE boss_outsiders
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6';
