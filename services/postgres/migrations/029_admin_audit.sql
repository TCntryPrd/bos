-- vS.1.0 — Admin audit log
-- Every admin-tier tool invocation gets logged here for accountability.
-- IR Custom AIOS's host management tools write an audit row BEFORE executing.

CREATE TABLE IF NOT EXISTS boss_admin_audit (
  id          BIGSERIAL PRIMARY KEY,
  tool_name   TEXT NOT NULL,
  args        JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run     BOOLEAN NOT NULL DEFAULT TRUE,
  result      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending, success, failure, denied
  invoked_by  TEXT NOT NULL DEFAULT 'boss',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_tool ON boss_admin_audit (tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON boss_admin_audit (created_at DESC);
