-- Store WhatsApp contacts discovered from OpenWA contact syncs and message traffic.
CREATE TABLE IF NOT EXISTS boss_whatsapp_contacts (
  tenant_id text NOT NULL DEFAULT 'default',
  contact_id text NOT NULL,
  display_name text,
  phone text,
  push_name text,
  verified_name text,
  is_my_contact boolean,
  is_blocked boolean,
  is_group boolean NOT NULL DEFAULT false,
  source_payload jsonb,
  last_seen_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_contacts_name
  ON boss_whatsapp_contacts (tenant_id, lower(display_name))
  WHERE display_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone
  ON boss_whatsapp_contacts (tenant_id, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_contacts_synced
  ON boss_whatsapp_contacts (tenant_id, synced_at DESC);
