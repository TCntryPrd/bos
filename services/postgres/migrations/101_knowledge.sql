-- IR Custom AIOS v3 — knowledge store + platform-manager registry (M3).
-- Managers normalize their domain into boss_knowledge; IR Custom AIOS reads it to answer instantly.
CREATE TABLE IF NOT EXISTS boss_knowledge (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'default',
  domain      text NOT NULL,            -- slack | infra | email | drive | ...
  k           text NOT NULL,            -- topic/key within the domain
  summary     text NOT NULL,            -- normalized, human-readable fact
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_manager text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, domain, k)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_domain ON boss_knowledge(domain, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_manager (
  handle       text PRIMARY KEY,
  platform     text NOT NULL,
  display_name text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  poll_seconds integer NOT NULL DEFAULT 900,
  status       text NOT NULL DEFAULT 'registered',  -- registered | active | stub
  last_run_at  timestamptz,
  last_result  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- the standing org (DoD #4). active ones have live pulls; others fill in via the agent factory (M5).
INSERT INTO platform_manager(handle, platform, display_name, status) VALUES
  ('infra-manager',     'infra',      'Infra / Health Manager', 'registered'),
  ('slack-manager',     'slack',      'Slack Manager',          'registered'),
  ('email-manager',     'gmail',      'Email Manager',          'stub'),
  ('drive-manager',     'gdrive',     'Drive Manager',          'stub'),
  ('calendar-manager',  'gcal',       'Calendar Manager',       'stub'),
  ('otter-manager',     'otter',      'Otter / Meeting Manager','stub'),
  ('littlebird-manager','littlebird', 'LittleBird Manager',     'stub'),
  ('whatsapp-manager',  'whatsapp',   'WhatsApp Manager',       'stub'),
  ('n8n-manager',       'n8n',        'n8n Manager',            'stub'),
  ('make-manager',      'make',       'Make Manager',           'stub')
ON CONFLICT (handle) DO NOTHING;
