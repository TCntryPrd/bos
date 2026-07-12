-- IR Custom AIOS v3 — action items extracted from meetings/streams, routed to owners (M4).
CREATE TABLE IF NOT EXISTS boss_action_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default',
  source       text NOT NULL,                 -- otter | littlebird | manual
  meeting      text,
  text         text NOT NULL,
  owner_rascal text NOT NULL DEFAULT 'unassigned',
  status       text NOT NULL DEFAULT 'open',   -- open | done | dropped
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_items_owner ON boss_action_items(owner_rascal, status, created_at DESC);
