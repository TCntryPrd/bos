-- 017_rascals_coo_backfill.sql — bind rascals to the workspace tenant UUID
-- and seed the COO rascal that points at /home/tcntryprd/.claude.
--
-- v1.4.x imported the 10 presets with tenant_id = 'default' (a literal slug)
-- because the import path read req.tenant?.tenantId ?? 'default'. The
-- workspace tenant has the slug 'default' but the actual primary key is a
-- UUID, so browser-auth bearers (which carry the UUID) couldn't see those
-- rows. v1.5.1 patched the live DB by hand; this migration makes the fix
-- declarative for any environment that still has the legacy rows. Idempotent.

-- 1. Rebind any 'default' rows to the workspace tenant UUID.
UPDATE boss_rascals
SET tenant_id = (SELECT id::text FROM tenants WHERE slug = 'default' LIMIT 1)
WHERE tenant_id = 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE slug = 'default');

-- 2. Seed the COO rascal — Kevin's main /home/tcntryprd/.claude session.
--    Modeled as a rascal so the agent registry stays uniform: every
--    tmux-backed agent (per-client + COO) lives in one table.
INSERT INTO boss_rascals (tenant_id, handle, display_name, cli, client, project_dir, enabled)
SELECT
  t.id::text,
  'coo',
  'COO · IR Custom AIOS Chief',
  'claude',
  'Kevin (self)',
  '/home/tcntryprd/.claude',
  TRUE
FROM tenants t
WHERE t.slug = 'default'
ON CONFLICT (tenant_id, handle) DO NOTHING;
