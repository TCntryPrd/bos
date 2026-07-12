-- 030_wo_buckets.sql — Work Order time-bucket queue on boss_tasks.
--
-- AIOS v2.1 section 9 #6: Kevin submits work orders via the UI with one of
-- four buckets (today / tomorrow / this_week / next_week). Rascal heartbeats
-- poll for tasks whose gate_at has elapsed. WOs ARE kanban tasks: they live
-- in boss_tasks, the kanban surface shows them with a bucket pill.
--
-- Existing kanban rows keep bucket / gate_at / picked_at NULL — heartbeats
-- ignore them. Only rows with a non-null bucket flow through the WO path.
BEGIN;

ALTER TABLE boss_tasks
  ADD COLUMN IF NOT EXISTS bucket     TEXT,
  ADD COLUMN IF NOT EXISTS gate_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS picked_at  TIMESTAMPTZ;

ALTER TABLE boss_tasks
  DROP CONSTRAINT IF EXISTS boss_tasks_bucket_ck;
ALTER TABLE boss_tasks
  ADD  CONSTRAINT boss_tasks_bucket_ck
       CHECK (bucket IS NULL OR bucket IN ('today','tomorrow','this_week','next_week'));

-- Heartbeat read path: assigned_agent + pending + gate elapsed.
CREATE INDEX IF NOT EXISTS idx_boss_tasks_wo_heartbeat
  ON boss_tasks (tenant_id, assigned_agent, gate_at)
  WHERE status = 'pending' AND bucket IS NOT NULL AND picked_at IS NULL;

COMMIT;
