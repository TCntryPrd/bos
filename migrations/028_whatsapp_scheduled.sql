-- Scheduled WhatsApp messages (reminders, follow-ups)
CREATE TABLE IF NOT EXISTS boss_whatsapp_scheduled (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  chat_id text NOT NULL,
  message text NOT NULL,
  send_at timestamptz NOT NULL,
  created_by text NOT NULL, -- 'kevin', agent handle, etc
  draft_approved boolean DEFAULT false,
  sent_at timestamptz,
  wa_message_id text,
  status text NOT NULL DEFAULT 'pending', -- pending, approved, sent, failed, cancelled
  context jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, chat_id)
    REFERENCES boss_whatsapp_threads(tenant_id, chat_id) ON DELETE CASCADE,
  CHECK (status IN ('pending', 'approved', 'sent', 'failed', 'cancelled'))
);

CREATE INDEX idx_wa_scheduled_send_at
  ON boss_whatsapp_scheduled(tenant_id, send_at)
  WHERE status = 'approved' AND sent_at IS NULL;

CREATE INDEX idx_wa_scheduled_chat
  ON boss_whatsapp_scheduled(tenant_id, chat_id, created_at DESC);

COMMENT ON TABLE boss_whatsapp_scheduled IS 'Scheduled WhatsApp messages for reminders and follow-ups';
