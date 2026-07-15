-- 034_whatsapp_scheduled_sending.sql
--
-- The scheduled-message dispatcher (apps/api/src/routes/whatsapp.ts) claims due
-- rows by flipping them to status='sending' before it calls the WhatsApp bridge,
-- so a crash mid-send can't double-send and a stuck row can be reclaimed. The
-- original CHECK constraint only allowed pending/approved/sent/failed/cancelled,
-- so every dispatcher tick threw a constraint violation.
--
-- Idempotent: drops the constraint under either historical name and re-adds it
-- with 'sending'. Safe to re-run.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'boss_whatsapp_scheduled_status_check'
       AND conrelid = 'boss_whatsapp_scheduled'::regclass
  ) THEN
    ALTER TABLE boss_whatsapp_scheduled
      DROP CONSTRAINT boss_whatsapp_scheduled_status_check;
  END IF;

  ALTER TABLE boss_whatsapp_scheduled
    ADD CONSTRAINT boss_whatsapp_scheduled_status_check
    CHECK (status = ANY (ARRAY['pending', 'approved', 'sending', 'sent', 'failed', 'cancelled']));
END
$$;

-- The webhook + history import both rely on this partial unique index for their
-- ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL clause.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_wa_id
  ON boss_whatsapp_messages (tenant_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;
