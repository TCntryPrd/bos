CREATE TABLE IF NOT EXISTS aios_memory_ledger (
  content_hash TEXT PRIMARY KEY,
  weaviate_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  redacted BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_aios_memory_ledger_accepted
  ON aios_memory_ledger (accepted_at DESC);

CREATE INDEX IF NOT EXISTS idx_aios_memory_ledger_device
  ON aios_memory_ledger (device_id, accepted_at DESC);
