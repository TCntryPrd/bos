-- =============================================================================
-- IR Custom AIOS v2 — Migration 012: Invites
-- Persistent invite store to replace in-memory INVITE_STORE in auth routes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT        PRIMARY KEY,
  email       TEXT        NOT NULL,
  role        TEXT        NOT NULL DEFAULT 'user'
                  CHECK (role IN ('admin', 'user')),
  status      TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'expired')),
  invited_by  TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL DEFAULT 'default',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idx_invites_email  ON invites (email);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites (status);
