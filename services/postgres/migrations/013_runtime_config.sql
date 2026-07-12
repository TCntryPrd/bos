-- Runtime configuration that persists across container restarts.
-- Key-value store with tenant scoping.
CREATE TABLE IF NOT EXISTS runtime_config (
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, tenant_id)
);
