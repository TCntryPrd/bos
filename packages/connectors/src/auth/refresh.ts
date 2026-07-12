/**
 * Auto-refresh token management.
 * Gets a valid access token, refreshing automatically if within 5 minutes of expiry.
 */

import type { OAuthConfig, StoredToken } from '../types.js';
import { NotConnectedError, TokenExpiredError } from '../types.js';
import { refreshAccessToken } from './oauth2.js';
import { getToken, getTokenByAccountId, getAllTokensForProvider, updateAccessToken } from './token-store.js';
import { logger } from '../logger.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const refreshLocks = new Map<string, Promise<string>>();

export async function getValidToken(config: OAuthConfig, email: string): Promise<string> {
  const token = await getToken(config.provider, email);
  if (!token) throw new NotConnectedError(config.provider);
  return ensureTokenFresh(config, token);
}

export async function getValidTokenByAccountId(config: OAuthConfig, accountId: string): Promise<string> {
  const token = await getTokenByAccountId(accountId);
  if (!token) throw new NotConnectedError(config.provider);
  return ensureTokenFresh(config, token);
}

export async function getAllValidTokens(
  config: OAuthConfig,
): Promise<{ email: string; accountId: string; accessToken: string }[]> {
  const tokens = await getAllTokensForProvider(config.provider);
  const results: { email: string; accountId: string; accessToken: string }[] = [];
  for (const token of tokens) {
    try {
      const accessToken = await ensureTokenFresh(config, token);
      results.push({ email: token.email, accountId: token.accountId, accessToken });
    } catch (err) {
      logger.warn({ provider: config.provider, email: token.email, err }, 'Failed to refresh, skipping');
    }
  }
  return results;
}

async function ensureTokenFresh(config: OAuthConfig, token: StoredToken): Promise<string> {
  if (token.expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
    return token.accessToken;
  }

  const lockKey = `${token.provider}:${token.email}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;

  const promise = doRefresh(config, token).finally(() => refreshLocks.delete(lockKey));
  refreshLocks.set(lockKey, promise);
  return promise;
}

async function doRefresh(config: OAuthConfig, token: StoredToken): Promise<string> {
  logger.info({ provider: token.provider, email: token.email }, 'Refreshing token');
  try {
    const result = await refreshAccessToken(config, token.refreshToken);
    const newExpiresAt = new Date(Date.now() + result.expiresIn * 1000);
    await updateAccessToken(token.provider, token.email, result.accessToken, newExpiresAt);
    return result.accessToken;
  } catch (err) {
    logger.error({ provider: token.provider, email: token.email, err }, 'Refresh failed');
    throw new TokenExpiredError(token.provider, token.email);
  }
}
