-- 019_pipeline_default_to_workspace.sql — finish the v1.5.1 tenant rebind
--
-- Migration 017 rebound boss_rascals.tenant_id from the literal slug
-- 'default' to the workspace tenant UUID. The same regression class
-- ALSO landed pipeline-engine rows (boss_pipelines, boss_tasks,
-- boss_stage_log) under the 'default' slug, but those tables were
-- never rebound — Kevin's bearer-auth Dashboard saw 0 tasks / 0
-- live-activity entries on v1.6.0 because the 'default' literal
-- doesn't match his JWT's workspace UUID.
--
-- This migration finishes the rebind for the three remaining tables.
-- Idempotent: running on an already-clean DB is a no-op.

UPDATE boss_pipelines
SET tenant_id = (SELECT id::text FROM tenants WHERE slug = 'default' LIMIT 1)
WHERE tenant_id = 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE slug = 'default');

UPDATE boss_tasks
SET tenant_id = (SELECT id::text FROM tenants WHERE slug = 'default' LIMIT 1)
WHERE tenant_id = 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE slug = 'default');

UPDATE boss_stage_log
SET tenant_id = (SELECT id::text FROM tenants WHERE slug = 'default' LIMIT 1)
WHERE tenant_id = 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE slug = 'default');
