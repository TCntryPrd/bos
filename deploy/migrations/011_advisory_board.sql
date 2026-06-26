-- 011_advisory_board.sql  (Advisory Board — THE differentiator)
-- Rollback: DROP TABLE boss_board_items, boss_board_messages, boss_boards,
--           boss_advisor_human, boss_advisor_ai, boss_advisors CASCADE;
--
-- AI advisors = static portrait + voice (Kevin: no live avatars anywhere, incl Zoom).
-- boss_personas stays pure (AI brain); advisor presentation (voice + portrait) lives here.

CREATE TABLE boss_advisors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'ai' CHECK (type IN ('ai','human')),
  display_name  TEXT NOT NULL,
  title         TEXT,                              -- e.g. "Chief Strategist"
  bio           TEXT,                              -- right-panel detail
  avatar_image_url TEXT,                           -- STATIC portrait
  persona_id    UUID,                              -- -> boss_personas(id) when type='ai' (optional)
  seat_index    INT,                               -- position at the round table
  status        TEXT NOT NULL DEFAULT 'active',    -- active|inactive|archived
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE boss_advisor_ai (
  advisor_id      UUID PRIMARY KEY REFERENCES boss_advisors(id) ON DELETE CASCADE,
  model_label     TEXT,                            -- model-route label (boss_model_routes) or concrete model id
  voice_provider  TEXT NOT NULL DEFAULT 'omnivoice',
  voice_id        TEXT,                            -- stable, swap-safe voice handle
  voice_settings  JSONB,
  system_addendum TEXT,                            -- persona prompt (used if persona_id is null)
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE boss_advisor_human (
  advisor_id    UUID PRIMARY KEY REFERENCES boss_advisors(id) ON DELETE CASCADE,
  email         TEXT,
  timezone      TEXT,
  zoom_join_url TEXT,                              -- humans join with live video via Zoom
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE boss_boards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT 'Advisory Board',
  layout_variant TEXT NOT NULL DEFAULT 'round',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE boss_board_messages (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  advisor_id      UUID,                            -- thread advisor (NULL = board-wide post)
  author_type     TEXT NOT NULL,                   -- user|advisor
  author_name     TEXT,
  kind            TEXT NOT NULL DEFAULT 'dm',       -- dm|board_post|meeting_turn
  body            TEXT NOT NULL,
  has_audio       BOOLEAN NOT NULL DEFAULT false,
  conversation_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_board_messages_thread ON boss_board_messages (tenant_id, advisor_id, created_at DESC);

CREATE TABLE boss_board_items (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note',          -- note|task|reminder|decision
  title       TEXT NOT NULL,
  body        TEXT,
  due_at      TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'open',
  source      TEXT,                                  -- e.g. meeting:<id>
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
