/**
 * Encrypted token storage in Postgres (AES-256-GCM).
 *
 * SECURITY:
 * - All tokens encrypted at rest with AES-256-GCM (authenticated encryption)
 * - Encryption key sourced from env var only, never hardcoded
 * - Key length validated on startup
 * - IV is unique per encryption operation (cryptographically random)
 * - Auth tag prevents ciphertext tampering
 * - PKCE code_verifier stored encrypted alongside OAuth state
 * - encrypt/decrypt are NOT exported publicly (internal use only)
 */

import crypto from 'node:crypto';
import type { Provider, StoredToken } from '../types.js';
import { logger } from '../logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const EXPECTED_KEY_LENGTH = 32; // 256 bits

function getEncryptionKey(): Buffer {
  const key = process.env.BOSS_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be set (64-char hex = 32 bytes)');
  }
  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== EXPECTED_KEY_LENGTH) {
    throw new Error(
      `BOSS_TOKEN_ENCRYPTION_KEY must be exactly ${EXPECTED_KEY_LENGTH} bytes (${EXPECTED_KEY_LENGTH * 2} hex chars), got ${keyBuffer.length} bytes`,
    );
  }
  return keyBuffer;
}

/** Internal: encrypt a plaintext string. Returns iv:authTag:ciphertext in hex. */
function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/** Internal: decrypt an encrypted string. */
function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }
  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  if (iv.length !== IV_LENGTH) {
    throw new Error('Invalid IV length in encrypted token');
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid auth tag length in encrypted token');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// -- DB Interface -------------------------------------------------------------

export interface TokenStoreDB {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

let db: TokenStoreDB | null = null;

export function initTokenStore(database: TokenStoreDB): void {
  db = database;
  // Validate encryption key is configured correctly at init time
  getEncryptionKey();
}

function getDB(): TokenStoreDB {
  if (!db) throw new Error('Token store not initialized -- call initTokenStore()');
  return db;
}

export const TOKEN_STORE_MIGRATION = `
CREATE TABLE IF NOT EXISTS boss_oauth_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL,
  provider      TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'linkedin')),
  email         TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, email)
);

CREATE TABLE IF NOT EXISTS boss_oauth_state (
  state          TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  services       TEXT[] NOT NULL,
  code_verifier  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider_email ON boss_oauth_tokens (provider, email);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account_id ON boss_oauth_tokens (account_id);
`;

interface TokenRow {
  id: string;
  account_id: string;
  provider: Provider;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[];
  created_at: string;
}

export async function storeToken(token: StoredToken): Promise<void> {
  const database = getDB();
  await database.query(
    `INSERT INTO boss_oauth_tokens
       (account_id, provider, email, access_token, refresh_token, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, email) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       scopes = EXCLUDED.scopes,
       updated_at = now()`,
    [token.accountId, token.provider, token.email,
     encrypt(token.accessToken), encrypt(token.refreshToken),
     token.expiresAt.toISOString(), token.scopes],
  );
  // SECURITY: Never log token values, only metadata
  logger.info({ provider: token.provider, email: token.email }, 'Token stored');
}

export async function getToken(provider: Provider, email: string): Promise<StoredToken | null> {
  const database = getDB();
  const result = await database.query<TokenRow>(
    `SELECT * FROM boss_oauth_tokens WHERE provider = $1 AND email = $2`,
    [provider, email],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    accountId: row.account_id, provider: row.provider, email: row.email,
    accessToken: decrypt(row.access_token), refreshToken: decrypt(row.refresh_token),
    expiresAt: new Date(row.expires_at), scopes: row.scopes,
    connectedAt: new Date(row.created_at),
  };
}

export async function getTokenByAccountId(accountId: string): Promise<StoredToken | null> {
  const database = getDB();
  const result = await database.query<TokenRow>(
    `SELECT * FROM boss_oauth_tokens WHERE account_id = $1`, [accountId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    accountId: row.account_id, provider: row.provider, email: row.email,
    accessToken: decrypt(row.access_token), refreshToken: decrypt(row.refresh_token),
    expiresAt: new Date(row.expires_at), scopes: row.scopes,
    connectedAt: new Date(row.created_at),
  };
}

export async function getAllTokensForProvider(provider: Provider): Promise<StoredToken[]> {
  const database = getDB();
  const result = await database.query<TokenRow>(
    `SELECT * FROM boss_oauth_tokens WHERE provider = $1`, [provider],
  );
  return result.rows.map((row) => ({
    accountId: row.account_id, provider: row.provider, email: row.email,
    accessToken: decrypt(row.access_token), refreshToken: decrypt(row.refresh_token),
    expiresAt: new Date(row.expires_at), scopes: row.scopes,
    connectedAt: new Date(row.created_at),
  }));
}

export async function updateAccessToken(
  provider: Provider, email: string, accessToken: string, expiresAt: Date,
): Promise<void> {
  const database = getDB();
  await database.query(
    `UPDATE boss_oauth_tokens SET access_token = $1, expires_at = $2, updated_at = now()
     WHERE provider = $3 AND email = $4`,
    [encrypt(accessToken), expiresAt.toISOString(), provider, email],
  );
  logger.debug({ provider, email }, 'Access token updated');
}

export async function deleteToken(provider: Provider, email: string): Promise<void> {
  const database = getDB();
  await database.query(
    `DELETE FROM boss_oauth_tokens WHERE provider = $1 AND email = $2`,
    [provider, email],
  );
  logger.info({ provider, email }, 'Token deleted');
}

/**
 * Store OAuth state with encrypted PKCE code_verifier.
 * SECURITY: code_verifier is encrypted at rest.
 */
export async function storeAuthState(
  state: string, provider: Provider, services: string[], codeVerifier: string,
): Promise<void> {
  const database = getDB();
  await database.query(
    `INSERT INTO boss_oauth_state (state, provider, services, code_verifier) VALUES ($1, $2, $3, $4)`,
    [state, provider, services, encrypt(codeVerifier)],
  );
}

/**
 * Consume OAuth state atomically (DELETE + RETURNING).
 * SECURITY: State is single-use (deleted on consumption) and time-limited (10 min).
 */
export async function consumeAuthState(
  state: string,
): Promise<{ provider: Provider; services: string[]; codeVerifier: string } | null> {
  const database = getDB();
  const result = await database.query<{
    provider: Provider; services: string[]; code_verifier: string; created_at: string;
  }>(
    `DELETE FROM boss_oauth_state WHERE state = $1 RETURNING provider, services, code_verifier, created_at`,
    [state],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > 10 * 60 * 1000) {
    logger.warn('OAuth state expired (older than 10 minutes)');
    return null;
  }
  return {
    provider: row.provider,
    services: row.services,
    codeVerifier: decrypt(row.code_verifier),
  };
}
