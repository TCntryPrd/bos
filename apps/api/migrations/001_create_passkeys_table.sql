CREATE TABLE IF NOT EXISTS boss_pending_passkeys (
  email VARCHAR(255) PRIMARY KEY,
  passkey_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
