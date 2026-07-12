-- 016_rascals.sql — Little Rascals registry.
--
-- Kevin's rule (locked 2026-04-24): IR Custom AIOS boots with zero rascals; each
-- rascal is created per-client via import or onboarding. This table is the
-- source of truth — the rascals-presets.ts file is import data only.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + constraint guards).

CREATE TABLE IF NOT EXISTS boss_rascals (
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
  CONSTRAINT boss_rascals_handle_ck
    CHECK (handle ~ '^[a-z]{2,24}$'),
  CONSTRAINT boss_rascals_cli_ck
    CHECK (cli IN ('claude','ollama'))
);

CREATE INDEX IF NOT EXISTS idx_boss_rascals_enabled
  ON boss_rascals (tenant_id, enabled)
  WHERE enabled = TRUE;

-- updated_at trigger — reuses the foundation function from migration 010
DROP TRIGGER IF EXISTS boss_rascals_set_updated_at ON boss_rascals;
CREATE TRIGGER boss_rascals_set_updated_at
  BEFORE UPDATE ON boss_rascals
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();
