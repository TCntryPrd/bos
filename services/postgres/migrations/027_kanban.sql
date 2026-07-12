-- 027_kanban.sql — Kanban v1.7.11 prep:
--   • archived_at column for soft-archive
--   • normalize current_stage to the 9 project-stage labels
BEGIN;

ALTER TABLE boss_tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_boss_tasks_archived
  ON boss_tasks (tenant_id, archived_at)
  WHERE archived_at IS NULL;

UPDATE boss_tasks
   SET current_stage = 'Initiated'
 WHERE current_stage NOT IN (
   'Initiated',
   'Assessment',
   'Value & Process Mapping',
   'KFR & Roadmap forward',
   'L1 Implementation',
   'L2 Implementation',
   'Delivered',
   'Support',
   'Closed'
 );

COMMIT;
