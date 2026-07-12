-- 031_kanban_kind.sql
--
-- Adds the `kind` discriminator to boss_tasks so the board can
-- carry two semantically different rows: real work ('task') and
-- read-only replies from Outsiders to Rascals ('response').
--
-- Response rows are auto-created by the API when an Outsider posts
-- /complete on a task whose context.from is a Rascal handle. They
-- preserve the directional rule (Outsiders still cannot create
-- new TASKS for Rascals) while closing the round-trip so a Rascal
-- knows their request was answered.
--
-- The 48hr auto-close pipeline for client deliverables reuses the
-- existing `to_close` view_column and `updated_at` trigger field —
-- no new column needed for the timer itself.

BEGIN;

ALTER TABLE boss_tasks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task';

ALTER TABLE boss_tasks
  DROP CONSTRAINT IF EXISTS boss_tasks_kind_ck;

ALTER TABLE boss_tasks
  ADD CONSTRAINT boss_tasks_kind_ck
  CHECK (kind IN ('task', 'response'));

-- Index for the auto-close sweep (Darry scans this every hour)
CREATE INDEX IF NOT EXISTS idx_boss_tasks_pending_review
  ON boss_tasks (tenant_id, updated_at)
  WHERE view_column = 'to_close'
    AND archived_at IS NULL
    AND kind = 'task';

-- Index for response cards on a handle (rascals ack them on heartbeat)
CREATE INDEX IF NOT EXISTS idx_boss_tasks_response
  ON boss_tasks (tenant_id, assigned_agent, created_at)
  WHERE kind = 'response'
    AND view_column = 'inbox'
    AND archived_at IS NULL;

COMMIT;
