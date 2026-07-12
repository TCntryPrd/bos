-- Dashboard support tables for Slack attention and WhatsApp surfaces.
-- Idempotent because existing Hostinger volumes do not rerun initdb migrations.

CREATE TABLE IF NOT EXISTS slack_attention (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL,
  flagged_by TEXT NOT NULL DEFAULT 'slack',
  source_channel TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  source_user TEXT,
  source_user_name TEXT,
  preview TEXT NOT NULL DEFAULT '',
  reason TEXT,
  permalink TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  response_ts TEXT,
  UNIQUE (tenant_id, source_channel, source_ts)
);
CREATE INDEX IF NOT EXISTS idx_slack_attention_status_created ON slack_attention (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS slack_agent_grants (
  tenant_id TEXT NOT NULL,
  agent_handle TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_handle)
);

CREATE TABLE IF NOT EXISTS boss_whatsapp_contacts (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_id TEXT NOT NULL,
  display_name TEXT,
  phone TEXT,
  push_name TEXT,
  verified_name TEXT,
  is_my_contact BOOLEAN,
  is_blocked BOOLEAN,
  is_group BOOLEAN NOT NULL DEFAULT false,
  source_payload JSONB,
  last_seen_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id)
);

CREATE TABLE IF NOT EXISTS boss_whatsapp_threads (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  display_name TEXT,
  phone TEXT,
  is_group BOOLEAN NOT NULL DEFAULT false,
  last_message_wa_id TEXT,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_from_me BOOLEAN,
  unread_count INTEGER NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_threads_last_message ON boss_whatsapp_threads (tenant_id, archived, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS boss_whatsapp_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  wa_message_id TEXT,
  direction TEXT NOT NULL DEFAULT 'inbound',
  from_me BOOLEAN NOT NULL DEFAULT false,
  author TEXT,
  sender_name TEXT,
  body TEXT,
  message_type TEXT NOT NULL DEFAULT 'chat',
  media_url TEXT,
  reply_to_wa_message_id TEXT,
  ack_status TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_messages_wa_id ON boss_whatsapp_messages (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_thread_sent ON boss_whatsapp_messages (tenant_id, chat_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS boss_whatsapp_scheduled (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  message TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'kevin',
  status TEXT NOT NULL DEFAULT 'pending',
  draft_approved BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ,
  wa_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_scheduled_status_send ON boss_whatsapp_scheduled (tenant_id, status, send_at);

CREATE TABLE IF NOT EXISTS boss_whatsapp_monitors (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  chat_id TEXT NOT NULL,
  agent_handle TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  confidence_threshold NUMERIC NOT NULL DEFAULT 0.7,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chat_id, agent_handle)
);
