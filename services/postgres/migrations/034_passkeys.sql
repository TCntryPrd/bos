-- Passkey auth support for onboarding/register/login.
-- Idempotent so it can be applied to existing fresh-install volumes and future initdb runs.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS passkey_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_users_passkey_hash
  ON users(passkey_hash)
  WHERE passkey_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS boss_pending_passkeys (
  email VARCHAR(320) PRIMARY KEY,
  passkey_hash VARCHAR(64) NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'boss-internal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + make_interval(days => 7))
);

CREATE INDEX IF NOT EXISTS idx_boss_pending_passkeys_hash
  ON boss_pending_passkeys(passkey_hash);
