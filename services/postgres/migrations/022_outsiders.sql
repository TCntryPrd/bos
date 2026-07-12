-- 022_outsiders.sql — Outsiders registry (staff agents).
--
-- Mirrors boss_rascals (016) shape. Outsiders are staff-side agents
-- (vs. rascals which are per-client field agents). Their character names
-- come from The Outsiders (1983); first seeded entry is Ponyboy
-- Productions (the agent that owns SP Productions work).
--
-- Schema parity with boss_rascals lets v1.6.9 generalize the workspace
-- surface across both registries with a `kind` discriminator.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING seed).

CREATE TABLE IF NOT EXISTS boss_outsiders (
  tenant_id     TEXT        NOT NULL DEFAULT 'default',
  handle        TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  cli           TEXT        NOT NULL,
  client        TEXT        NOT NULL,
  project_dir   TEXT        NOT NULL,
  enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, handle),
  CONSTRAINT boss_outsiders_handle_ck
    CHECK (handle ~ '^[a-z]{2,24}$'),
  CONSTRAINT boss_outsiders_cli_ck
    CHECK (cli IN ('claude','ollama'))
);

CREATE INDEX IF NOT EXISTS idx_boss_outsiders_enabled
  ON boss_outsiders (tenant_id, enabled)
  WHERE enabled = TRUE;

DROP TRIGGER IF EXISTS boss_outsiders_set_updated_at ON boss_outsiders;
CREATE TRIGGER boss_outsiders_set_updated_at
  BEFORE UPDATE ON boss_outsiders
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();

-- Seed: Ponyboy Productions (SP Productions, Outsider character name).
-- Idempotent — re-running this migration is a no-op for existing rows.
INSERT INTO boss_outsiders
  (tenant_id, handle, display_name, cli, client, project_dir, enabled)
VALUES
  ('default', 'ponyboy', 'Ponyboy Productions', 'claude', 'SP Productions',
   '/home/tcntryprd/outsiders/ponyboy', TRUE)
ON CONFLICT (tenant_id, handle) DO NOTHING;
