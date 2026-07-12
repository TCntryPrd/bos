-- 021_chat_session_cc_id.sql — Persist Claude Code's session UUID per
-- rascal chat session so subsequent messages can resume the same CC
-- conversation.
--
-- v1.6.4 introduces architecture A (one perpetual chat per rascal,
-- powered by `claude --print --resume <uuid>` invoked from the
-- rascal's projectDir). The CC session UUID is captured from the
-- first stream-json frame and stored here. Nullable: NULL means the
-- chat has not had its first turn yet.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE boss_chat_sessions
  ADD COLUMN IF NOT EXISTS cc_session_id TEXT;
