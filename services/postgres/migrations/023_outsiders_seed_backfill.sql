-- 023_outsiders_seed_backfill.sql — fix Ponyboy seed tenant.
--
-- Migration 022 seeded Ponyboy Productions under tenant_id='default', but
-- the live workspace tenant is the UUID assigned at onboarding (rascals
-- live there too). The v1.6.8 deploy smoke caught the gap: bearer-JWT
-- queries the workspace tenant and got an empty array.
--
-- Strategy: for every distinct tenant in boss_rascals (i.e., every
-- tenant that's actually been onboarded), upsert Ponyboy. Then drop the
-- orphan 'default' row so the table has exactly one Ponyboy per real
-- tenant.
--
-- Safe to re-run: ON CONFLICT DO NOTHING on the INSERT, idempotent
-- DELETE on the orphan.

INSERT INTO boss_outsiders
  (tenant_id, handle, display_name, cli, client, project_dir, enabled)
SELECT
  DISTINCT r.tenant_id,
  'ponyboy',
  'Ponyboy Productions',
  'claude',
  'SP Productions',
  '/home/tcntryprd/outsiders/ponyboy',
  TRUE
FROM boss_rascals r
ON CONFLICT (tenant_id, handle) DO NOTHING;

DELETE FROM boss_outsiders
 WHERE tenant_id = 'default'
   AND handle    = 'ponyboy';
