/**
 * Unit tests — auto-refresh logic (refresh.ts)
 *
 * Tests cover:
 * - getValidToken: returns token directly when not near expiry
 * - getValidToken: refreshes token when within 5-minute buffer
 * - getValidToken: throws NotConnectedError when no token in store
 * - getValidToken: throws TokenExpiredError when refresh fails
 * - getAllValidTokens: skips accounts where refresh fails
 * - Deduplication lock: concurrent calls for same account don't double-refresh
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mock setup ────────────────────────────────────────────────
// We mock the imports that refresh.ts depends on so we can control
// what getToken / getAllTokensForProvider / refreshAccessToken return.

vi.mock('./token-store.js', () => ({
  getToken: vi.fn(),
  getTokenByAccountId: vi.fn(),
  getAllTokensForProvider: vi.fn(),
  updateAccessToken: vi.fn(),
}));

vi.mock('./oauth2.js', () => ({
  refreshAccessToken: vi.fn(),
}));

import { getValidToken, getValidTokenByAccountId, getAllValidTokens } from './refresh.js';
import { getToken, getTokenByAccountId, getAllTokensForProvider, updateAccessToken } from './token-store.js';
import { refreshAccessToken } from './oauth2.js';
import { NotConnectedError, TokenExpiredError } from '../types.js';
import type { OAuthConfig, StoredToken } from '../types.js';

const OAUTH_CONFIG: OAuthConfig = {
  provider: 'google',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://example.com/cb',
  scopes: [],
};

function makeFreshToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accountId: 'account-1',
    provider: 'google',
    email: 'user@example.com',
    accessToken: 'fresh-access-token',
    refreshToken: 'refresh-token',
    // expires 1 hour from now — well past the 5-min buffer
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scopes: ['email'],
    ...overrides,
  };
}

function makeExpiringToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    ...makeFreshToken(),
    accessToken: 'expiring-access-token',
    // expires in 2 minutes — within the 5-min buffer
    expiresAt: new Date(Date.now() + 2 * 60 * 1000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getValidToken ─────────────────────────────────────────────────────

describe('getValidToken', () => {
  it('returns the current accessToken when token is not near expiry', async () => {
    vi.mocked(getToken).mockResolvedValue(makeFreshToken());

    const token = await getValidToken(OAUTH_CONFIG, 'user@example.com');
    expect(token).toBe('fresh-access-token');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('throws NotConnectedError when getToken returns null', async () => {
    vi.mocked(getToken).mockResolvedValue(null);

    await expect(
      getValidToken(OAUTH_CONFIG, 'unknown@example.com'),
    ).rejects.toThrow(NotConnectedError);
  });

  it('refreshes the token when within 5-minute expiry buffer', async () => {
    vi.mocked(getToken).mockResolvedValue(makeExpiringToken());
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'refreshed-token',
      expiresIn: 3600,
    });
    vi.mocked(updateAccessToken).mockResolvedValue(undefined);

    const token = await getValidToken(OAUTH_CONFIG, 'user@example.com');
    expect(token).toBe('refreshed-token');
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(updateAccessToken).toHaveBeenCalledOnce();
  });

  it('throws TokenExpiredError when refresh fails', async () => {
    vi.mocked(getToken).mockResolvedValue(makeExpiringToken());
    vi.mocked(refreshAccessToken).mockRejectedValue(new Error('Token revoked'));

    await expect(
      getValidToken(OAUTH_CONFIG, 'user@example.com'),
    ).rejects.toThrow(TokenExpiredError);
  });

  it('passes correct provider and email to getToken', async () => {
    vi.mocked(getToken).mockResolvedValue(makeFreshToken());

    await getValidToken(OAUTH_CONFIG, 'test@example.com');
    expect(getToken).toHaveBeenCalledWith('google', 'test@example.com');
  });

  it('updates token store with new expiry after refresh', async () => {
    vi.mocked(getToken).mockResolvedValue(makeExpiringToken());
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'new-token',
      expiresIn: 3600,
    });
    vi.mocked(updateAccessToken).mockResolvedValue(undefined);

    await getValidToken(OAUTH_CONFIG, 'user@example.com');

    const [provider, email, newToken, expiresAt] = vi.mocked(updateAccessToken).mock.calls[0];
    expect(provider).toBe('google');
    expect(email).toBe('user@example.com');
    expect(newToken).toBe('new-token');
    // expiresAt should be approximately now + 3600 seconds
    const expectedExpiry = Date.now() + 3600 * 1000;
    expect(Math.abs((expiresAt as Date).getTime() - expectedExpiry)).toBeLessThan(2000);
  });
});

// ── getValidTokenByAccountId ──────────────────────────────────────────

describe('getValidTokenByAccountId', () => {
  it('throws NotConnectedError when accountId is not found', async () => {
    vi.mocked(getTokenByAccountId).mockResolvedValue(null);

    await expect(
      getValidTokenByAccountId(OAUTH_CONFIG, 'missing-account'),
    ).rejects.toThrow(NotConnectedError);
  });

  it('returns fresh token without refresh when not near expiry', async () => {
    vi.mocked(getTokenByAccountId).mockResolvedValue(makeFreshToken());

    const token = await getValidTokenByAccountId(OAUTH_CONFIG, 'account-1');
    expect(token).toBe('fresh-access-token');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });
});

// ── getAllValidTokens ─────────────────────────────────────────────────

describe('getAllValidTokens', () => {
  it('returns empty array when no tokens exist for provider', async () => {
    vi.mocked(getAllTokensForProvider).mockResolvedValue([]);

    const results = await getAllValidTokens(OAUTH_CONFIG);
    expect(results).toHaveLength(0);
  });

  it('returns valid tokens for all accounts', async () => {
    vi.mocked(getAllTokensForProvider).mockResolvedValue([
      makeFreshToken({ email: 'a@example.com', accountId: 'acc-a', accessToken: 'token-a' }),
      makeFreshToken({ email: 'b@example.com', accountId: 'acc-b', accessToken: 'token-b' }),
    ]);

    const results = await getAllValidTokens(OAUTH_CONFIG);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.email)).toEqual(
      expect.arrayContaining(['a@example.com', 'b@example.com']),
    );
  });

  it('skips accounts where refresh fails and continues with others', async () => {
    vi.mocked(getAllTokensForProvider).mockResolvedValue([
      makeExpiringToken({ email: 'ok@example.com', accountId: 'acc-ok', accessToken: 'ok' }),
      makeExpiringToken({ email: 'fail@example.com', accountId: 'acc-fail', accessToken: 'fail' }),
    ]);

    vi.mocked(refreshAccessToken)
      .mockResolvedValueOnce({ accessToken: 'refreshed-ok', expiresIn: 3600 })
      .mockRejectedValueOnce(new Error('Revoked'));
    vi.mocked(updateAccessToken).mockResolvedValue(undefined);

    const results = await getAllValidTokens(OAUTH_CONFIG);
    // Only the successful one should be in results
    expect(results).toHaveLength(1);
    expect(results[0].email).toBe('ok@example.com');
  });
});

// ── Concurrent refresh deduplication ─────────────────────────────────

describe('refresh lock (concurrent calls)', () => {
  it('only calls refreshAccessToken once when multiple concurrent calls for same account', async () => {
    const expiringToken = makeExpiringToken();
    vi.mocked(getToken).mockResolvedValue(expiringToken);
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: 'once-refreshed',
      expiresIn: 3600,
    });
    vi.mocked(updateAccessToken).mockResolvedValue(undefined);

    const [r1, r2, r3] = await Promise.all([
      getValidToken(OAUTH_CONFIG, 'user@example.com'),
      getValidToken(OAUTH_CONFIG, 'user@example.com'),
      getValidToken(OAUTH_CONFIG, 'user@example.com'),
    ]);

    expect(r1).toBe('once-refreshed');
    expect(r2).toBe('once-refreshed');
    expect(r3).toBe('once-refreshed');
    // Should have been called exactly once despite 3 concurrent requests
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });
});
