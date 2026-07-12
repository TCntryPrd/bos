/**
 * QuickBooks Online connection helper — OAuth2 token lifecycle + API base.
 *
 * QuickBooks (unlike Stripe) authenticates with OAuth2 and a ROTATING
 * refresh token:
 *   - access tokens live 1 hour
 *   - refresh tokens live 100 days (rolling), but Intuit rotates the
 *     refresh token VALUE roughly every 24h — the refresh_token returned
 *     by every token response must be persisted or the connection dies
 *     silently the next day.
 *
 * Tokens are stored in the Postgres runtime_config KV (same pattern as
 * Spotify in routes/connectors.ts) under QB_* keys. boss_oauth_tokens
 * is not used because its CHECK constraint limits provider to
 * google|microsoft and it has no column for the QuickBooks realmId.
 *
 * Env required:
 *   - QB_CLIENT_ID / QB_CLIENT_SECRET — Intuit app keys (developer.intuit.com)
 *   - QB_ENVIRONMENT — 'sandbox' (default) or 'production'
 *   - QB_REDIRECT_URI — optional override for the OAuth callback URL;
 *     defaults to ${API_BASE_URL}/api/connectors/oauth/quickbooks/callback
 *
 * Endpoints (verified against Intuit's OpenID discovery doc, July 2026):
 *   - Authorize: https://appcenter.intuit.com/connect/oauth2
 *   - Token:     https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *   - Revoke:    https://developer.api.intuit.com/v2/oauth2/tokens/revoke
 */

import { getRuntimeConfig, setRuntimeConfig, deleteRuntimeConfig } from '../config-store.js';

export const QBO_AUTHORIZE_ENDPOINT = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_REVOKE_ENDPOINT = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

// runtime_config keys (tenant 'default', matching the Spotify pattern)
const KEY_ACCESS = 'QB_ACCESS_TOKEN';
const KEY_REFRESH = 'QB_REFRESH_TOKEN';
const KEY_REALM = 'QB_REALM_ID';
const KEY_EXPIRES = 'QB_TOKEN_EXPIRES';          // access-token expiry, epoch ms
const KEY_REFRESH_EXPIRES = 'QB_REFRESH_EXPIRES'; // refresh-token expiry, epoch ms

const TENANT = 'default';
const REFRESH_SKEW_MS = 5 * 60_000; // refresh access tokens 5 minutes early

export interface QboTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;                  // seconds, typically 3600
  x_refresh_token_expires_in?: number; // seconds, ~100 days
  token_type?: string;
}

export interface QboConnection {
  accessToken: string;
  realmId: string;
  base: string; // https://sandbox-quickbooks.api.intuit.com or production
}

/** True when Intuit app credentials are present in the environment. */
export function qboConfigured(): boolean {
  return !!(process.env.QB_CLIENT_ID && process.env.QB_CLIENT_SECRET);
}

/** API base URL for the configured environment (sandbox unless QB_ENVIRONMENT=production). */
export function qboApiBase(): string {
  return process.env.QB_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/** OAuth callback URL — env override wins, else derived from API_BASE_URL. */
export function qboRedirectUri(): string {
  if (process.env.QB_REDIRECT_URI) return process.env.QB_REDIRECT_URI;
  const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/api/connectors/oauth/quickbooks/callback`;
}

function basicAuthHeader(): string {
  const id = process.env.QB_CLIENT_ID ?? '';
  const secret = process.env.QB_CLIENT_SECRET ?? '';
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

/**
 * Persist a token response (and optionally the realmId from the OAuth
 * callback). Called from the OAuth callback AND after every refresh —
 * Intuit rotates refresh tokens, so every response must be saved.
 */
export async function storeQboTokens(tokens: QboTokenResponse, realmId?: string): Promise<void> {
  await setRuntimeConfig(KEY_ACCESS, tokens.access_token, TENANT);
  await setRuntimeConfig(KEY_REFRESH, tokens.refresh_token, TENANT);
  await setRuntimeConfig(KEY_EXPIRES, String(Date.now() + (tokens.expires_in ?? 3600) * 1000), TENANT);
  if (tokens.x_refresh_token_expires_in) {
    await setRuntimeConfig(
      KEY_REFRESH_EXPIRES,
      String(Date.now() + tokens.x_refresh_token_expires_in * 1000),
      TENANT,
    );
  }
  if (realmId) {
    await setRuntimeConfig(KEY_REALM, realmId, TENANT);
  }
}

/** True when a QuickBooks company connection exists (refresh token + realm stored). */
export async function qboConnected(): Promise<boolean> {
  const [refresh, realm] = await Promise.all([
    getRuntimeConfig(KEY_REFRESH, TENANT),
    getRuntimeConfig(KEY_REALM, TENANT),
  ]);
  return !!(refresh && realm);
}

/** Exchange an authorization code for tokens (OAuth callback step). */
export async function exchangeQboCode(code: string): Promise<QboTokenResponse> {
  const res = await fetch(QBO_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: qboRedirectUri(),
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuickBooks token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as QboTokenResponse;
}

// Dedupe concurrent refreshes — Intuit rotates the refresh token on use,
// so two parallel tool calls both refreshing would race to persist
// different tokens. One in-flight refresh serves all callers. The refresh
// token is re-read from runtime_config INSIDE the critical section (not
// passed in by callers) so a caller holding a stale, already-rotated token
// can never replay it after an earlier refresh completed.
let refreshInFlight: Promise<string> | null = null;

async function refreshQboAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const refreshToken = await getRuntimeConfig(KEY_REFRESH, TENANT);
      if (!refreshToken) {
        throw new Error('QuickBooks is not connected.');
      }
      const res = await fetch(QBO_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `QuickBooks token refresh failed (${res.status}): ${text.slice(0, 300)}. ` +
            'If this persists, reconnect: call GET /api/connectors/quickbooks/connect (authenticated) and open the returned url.',
        );
      }
      const tokens = (await res.json()) as QboTokenResponse;
      await storeQboTokens(tokens); // persists the ROTATED refresh token
      return tokens.access_token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Returns a live QuickBooks connection (fresh access token + realmId + base
 * URL), refreshing the access token if it is expired or about to expire.
 * Throws with an actionable message when not configured/connected — the
 * tool executor converts throws into readable failure strings.
 */
export async function getQboConnection(): Promise<QboConnection> {
  if (!qboConfigured()) {
    throw new Error('QuickBooks is not configured. Set QB_CLIENT_ID and QB_CLIENT_SECRET.');
  }
  const [accessToken, refreshToken, realmId, expiresStr] = await Promise.all([
    getRuntimeConfig(KEY_ACCESS, TENANT),
    getRuntimeConfig(KEY_REFRESH, TENANT),
    getRuntimeConfig(KEY_REALM, TENANT),
    getRuntimeConfig(KEY_EXPIRES, TENANT),
  ]);
  if (!refreshToken || !realmId) {
    throw new Error(
      'QuickBooks is not connected. Connect: call GET /api/connectors/quickbooks/connect (authenticated) and open the returned url.',
    );
  }

  const expires = parseInt(expiresStr ?? '0', 10);
  if (accessToken && Date.now() < expires - REFRESH_SKEW_MS) {
    return { accessToken, realmId, base: qboApiBase() };
  }
  const fresh = await refreshQboAccessToken();
  return { accessToken: fresh, realmId, base: qboApiBase() };
}

/**
 * Force-refresh once (used by the API client on an unexpected 401 — e.g.
 * the access token was revoked server-side before its expiry timestamp).
 */
export async function forceQboRefresh(): Promise<QboConnection> {
  const realmId = await getRuntimeConfig(KEY_REALM, TENANT);
  if (!realmId) {
    throw new Error('QuickBooks is not connected.');
  }
  const fresh = await refreshQboAccessToken();
  return { accessToken: fresh, realmId, base: qboApiBase() };
}

/** Revoke the connection at Intuit (best-effort) and clear stored tokens. */
export async function disconnectQbo(): Promise<void> {
  const refreshToken = await getRuntimeConfig(KEY_REFRESH, TENANT);
  if (refreshToken && qboConfigured()) {
    try {
      await fetch(QBO_REVOKE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token: refreshToken }),
      });
    } catch {
      // Best-effort — clearing local tokens below still severs the connection.
    }
  }
  for (const key of [KEY_ACCESS, KEY_REFRESH, KEY_REALM, KEY_EXPIRES, KEY_REFRESH_EXPIRES]) {
    await deleteRuntimeConfig(key, TENANT);
  }
}
