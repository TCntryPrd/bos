-- Store human-readable sender labels for WhatsApp group messages.
ALTER TABLE boss_whatsapp_messages
  ADD COLUMN IF NOT EXISTS sender_name text;
