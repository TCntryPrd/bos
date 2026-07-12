-- 014_advisor_memory.sql — cognitive-memory-lite for AI advisors.
-- Each advisor accumulates durable memories (identity/knowledge/procedure/episode) and recalls
-- them before responding, so they learn the business and grow into their advisory role.
-- Rollback: DROP TABLE boss_advisor_memory;
CREATE TABLE boss_advisor_memory (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  advisor_id   UUID NOT NULL REFERENCES boss_advisors(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'knowledge',   -- identity | knowledge | procedure | episode
  content      TEXT NOT NULL,
  salience     REAL NOT NULL DEFAULT 1.0,            -- decays over time, reinforced on recall
  use_count    INT  NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX idx_advisor_mem ON boss_advisor_memory (tenant_id, advisor_id, salience DESC, last_used_at DESC NULLS LAST);
