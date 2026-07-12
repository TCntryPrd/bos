-- Pipeline Engine — task orchestration backbone for the Little Rascals framework.
-- Replaces Paperclip's pipeline logic with a IR Custom AIOS-native implementation.
-- See /home/tcntryprd/BOSS_V2_MASTER_PLAN.md Phase 1.

-- Pipeline templates — reusable workflow definitions.
CREATE TABLE IF NOT EXISTS boss_pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  stages JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boss_pipelines_tenant
  ON boss_pipelines (tenant_id);

-- Active tasks moving through pipelines.
-- status: pending | active | blocked | done | failed
-- assigned_agent: Little Rascal name (darla, spanky, ...) OR system agent name
-- assigned_client: numbered client directory (e.g. "06-debbie-wooldridge")
-- view_column: denormalized column for Kanban dual-view — client status view.
--   Values: inbox | today | in_progress | to_close | done
CREATE TABLE IF NOT EXISTS boss_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  pipeline_id UUID REFERENCES boss_pipelines(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_agent TEXT,
  assigned_client TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority INTEGER NOT NULL DEFAULT 5,
  view_column TEXT NOT NULL DEFAULT 'inbox',
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT boss_tasks_status_ck
    CHECK (status IN ('pending','active','blocked','done','failed')),
  CONSTRAINT boss_tasks_view_column_ck
    CHECK (view_column IN ('inbox','today','in_progress','to_close','done')),
  CONSTRAINT boss_tasks_priority_ck
    CHECK (priority BETWEEN 1 AND 10)
);

CREATE INDEX IF NOT EXISTS idx_boss_tasks_tenant_status
  ON boss_tasks (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_boss_tasks_agent
  ON boss_tasks (tenant_id, assigned_agent) WHERE status IN ('pending','active','blocked');
CREATE INDEX IF NOT EXISTS idx_boss_tasks_client
  ON boss_tasks (tenant_id, assigned_client);
CREATE INDEX IF NOT EXISTS idx_boss_tasks_view_column
  ON boss_tasks (tenant_id, view_column);
CREATE INDEX IF NOT EXISTS idx_boss_tasks_stage
  ON boss_tasks (tenant_id, current_stage);

-- Stage completion log — one row per stage transition.
CREATE TABLE IF NOT EXISTS boss_stage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id UUID NOT NULL REFERENCES boss_tasks(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  agent TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  output TEXT,
  output_files TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  CONSTRAINT boss_stage_log_status_ck
    CHECK (status IN ('active','completed','skipped','failed','blocked'))
);

CREATE INDEX IF NOT EXISTS idx_boss_stage_log_task
  ON boss_stage_log (task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_boss_stage_log_agent
  ON boss_stage_log (tenant_id, agent, started_at DESC);

-- updated_at triggers — reuse the shared boss_set_updated_at() from 001_foundation.sql.
DROP TRIGGER IF EXISTS trg_boss_tasks_updated_at ON boss_tasks;
CREATE TRIGGER trg_boss_tasks_updated_at
  BEFORE UPDATE ON boss_tasks
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

DROP TRIGGER IF EXISTS trg_boss_pipelines_updated_at ON boss_pipelines;
CREATE TRIGGER trg_boss_pipelines_updated_at
  BEFORE UPDATE ON boss_pipelines
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();
