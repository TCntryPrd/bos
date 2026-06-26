-- 012_board_meetings.sql  (Advisory Board — the meeting value loop)
-- Rollback: DROP TABLE boss_board_meetings;
--
-- A board meeting: the advisors deliberate (round-robin, stored as meeting_turn messages),
-- the Chair synthesizes minutes + decisions + action items; tasks flow into boss_tasks
-- (→ Daily Brief), decisions into boss_board_items. This closes the loop that makes the
-- board's conclusions actually move the principal's operation.

CREATE TABLE boss_board_meetings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  topic        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'in_progress',   -- in_progress | complete | failed
  minutes      TEXT,
  decisions    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_board_meetings_recent ON boss_board_meetings (tenant_id, created_at DESC);
