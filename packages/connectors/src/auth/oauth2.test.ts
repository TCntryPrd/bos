/**
 * Unit tests — oauth2.ts
 *
 * Tests cover:
 * - generatePKCE: verifier format, challenge derivation, uniqueness
 * - getScopesForServices: scope aggregation per provider
 * - buildAuthUrl: URL structure, PKCE params, state generation
 * - exchangeCode: happy path, error handling, TOKEN_EXCHANGE_FAILED
 * - refreshAccessToken: happy path, invalid_grant -> TOKEN_REVOKED
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generatePKCE,
  getScopesForServices,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
} from './oauth2.js';
import { ConnectorError } from '../types.js';
import type { OAuthConfig } from '../types.js';

const GOOGLE_CONFIG: OAuthConfig = {
  provider: 'google',
  clientId: 'google-client-id',
  clientSecret: 'google-secret',
  redirectUri: 'https://boss.example.com/oauth/callback',
  scopes: [],
};

const MICROSOFT_CONFIG: OAuthConfig = {
  provider: 'microsoft',
  clientId: 'ms-client-id',
  clientSecret: 'ms-secret',
  redirectUri: 'https://boss.example.com/oauth/callback',
  scopes: [],
};

// ── generatePKCE ──────────────────────────────────────────────────────

describe('generatePKCE', () => {
  it('returns a codeVerifier of max 128 chars with only unreserved chars', () => {
    const { codeVerifier } = generatePKCE();
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)).toBe(true);
  });

  it('returns a codeChallenge that is the S256 hash of the verifier', () => {
    const { codeVerifier, codeChallenge } = generatePKCE();
    // Derive the challenge manually and compare
    const { createHash } = require('node:crypto');
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('generates a unique pair on every call', () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

// ── getScopesForServices ──────────────────────────────────────────────

describe('getScopesForServices', () => {
  it('always includes profile scopes for Google', () => {
    const scopes = getScopesForServices('google', []);
    expect(scopes).toContain('https://www.googleapis.com/auth/userinfo.email');
    expect(scopes).toContain('https://www.googleapis.com/auth/userinfo.profile');
  });

  it('includes Gmail scopes when gmail service is requested', () => {
    const scopes = getScopesForServices('google', ['gmail']);
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.send');
  });

  it('includes Calendar scopes when calendar service is requested', () => {
    const scopes = getScopesForServices('google', ['calendar']);
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar');
  });

  it('deduplicates scopes when multiple services share them', () => {
    const scopes = getScopesForServices('google', ['gmail', 'gmail']);
    const gmail = 'https://www.googleapis.com/auth/gmail.readonly';
    const occurrences = scopes.filter(s => s === gmail).length;
    expect(occurrences).toBe(1);
  });

  it('includes Microsoft-specific scopes for mail', () => {
    const scopes = getScopesForServices('microsoft', ['mail']);
    expect(scopes).toContain('Mail.ReadWrite');
    expect(scopes).toContain('Mail.Send');
  });

  it('always adds offline_access for Microsoft', () => {
    const scopes = getScopesForServices('microsoft', []);
    expect(scopes).toContain('offline_access');
  });

  it('does not add offline_access for Google', () => {
    const scopes = getScopesForServices('google', ['gmail']);
    expect(scopes).not.toContain('offline_access');
  });

  it('returns unique set across multiple services', () => {
    const scopes = getScopesForServices('google', ['gmail', 'calendar', 'tasks']);
    const unique = new Set(scopes);
    expect(scopes.length).toBe(unique.size);
  });

  it('silently ignores unknown service names', () => {
    expect(() => getScopesForServices('google', ['unknown-service'])).not.toThrow();
  });
});

// ── buildAuthUrl ──────────────────────────────────────────────────────

describe('buildAuthUrl', () => {
  it('returns a URL for the Google OAuth endpoint', () => {
    const { url } = buildAuthUrl(GOOGLE_CONFIG, ['gmail']);
    expect(url).toContain('accounts.google.com');
  });

  it('returns a URL for the Microsoft OAuth endpoint', () => {
    const { url } = buildAuthUrl(MICROSOFT_CONFIG, ['mail']);
    expect(url).toContain('login.microsoftonline.com');
  });

  it('includes PKCE code_challenge and method in the URL', () => {
    const { url } = buildAuthUrl(GOOGLE_CONFIG, ['gmail']);
    expect(url).toContain('code_challenge=');
    expect(url).toContain('code_challenge_method=S256');
  });

  it('includes response_type=code', () => {
    const { url } = buildAuthUrl(GOOGLE_CONFIG, ['gmail']);
    expect(url).toContain('response_type=code');
  });

  it('includes client_id in the URL', () => {
    const { url } = buildAuthUrl(GOOGLE_CONFIG, ['gmail']);
    expect(url).toContain('google-client-id');
  });

  it('includes redirect_uri in the URL', () => {
    const { url } = buildAuthUrl(GOOGLE_CONFIG, []);
    expect(url).toContain(encodeURIComponent(GOOGLE_CONFIG.redirectUri));
  });

  it('includes state parameter in the URL', () => {
    const { url, state } = buildAuthUrl(GOOGLE_CONFIG, []);
    expect(url).toContain(`state=${state.state}`);
  });

  it('returns unique state on every call', () => {
    const a = buildAuthUrl(GOOGLE_CONFIG, []);
    const b = buildAuthUrl(GOOGLE_CONFIG, []);
    expect(a.state.state).not.toBe(b.state.state);
  });

  it('includes access_type=offline and prompt=consent for Google', () => {
    const { url } = buildAuthUrl(GOOGLE_CONFIG, []);
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
  });

  it('includes prompt=select_account for Microsoft', () => {
    const { url } = buildAuthUrl(MICROSOFT_CONFIG, []);
    expect(url).toContain('prompt=select_account');
  });

  it('returns the PKCE code_verifier in the state object', () => {
    const { state } = buildAuthUrl(GOOGLE_CONFIG, []);
    expect(state.codeVerifier).toBeDefined();
    expect(state.codeVerifier.length).toBeGreaterThan(0);
  });
});

// ── exchangeCode ──────────────────────────────────────────────────────

describe('exchangeCode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the Google token endpoint for google provider', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: 'ya29.new',
        refresh_token: '1//new-refresh',
        expires_in: 3600,
        scope: 'email',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await exchangeCode(GOOGLE_CONFIG, 'auth-code', 'verifier');
    const [url] = mockFetch.mock.calls[0];
    expect(url as string).toContain('oauth2.googleapis.com');
  });

  it('calls the Microsoft token endpoint for microsoft provider', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: 'eyJ.ms-token',
        refresh_token: 'ms-refresh',
        expires_in: 3600,
        scope: 'Mail.Read',
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await exchangeCode(MICROSOFT_CONFIG, 'ms-code', 'ms-verifier');
    const [url] = mockFetch.mock.calls[0];
    expect(url as string).toContain('microsoftonline.com');
  });

  it('returns a TokenResponse with correct fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: 'ya29.acc',
        refresh_token: '1//ref',
        expires_in: 3600,
        scope: 'email',
        token_type: 'Bearer',
      }),
    }));

    const result = await exchangeCode(GOOGLE_CONFIG, 'code', 'verifier');
    expect(result.accessToken).toBe('ya29.acc');
    expect(result.refreshToken).toBe('1//ref');
    expect(result.expiresIn).toBe(3600);
  });

  it('throws ConnectorError with TOKEN_EXCHANGE_FAILED on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: 'invalid_grant' }),
    }));

    await expect(
      exchangeCode(GOOGLE_CONFIG, 'bad-code', 'verifier'),
    ).rejects.toThrow(ConnectorError);

    try {
      await exchangeCode(GOOGLE_CONFIG, 'bad-code', 'verifier');
    } catch (err) {
      expect((err as ConnectorError).code).toBe('TOKEN_EXCHANGE_FAILED');
      expect((err as ConnectorError).provider).toBe('google');
    }
  });

  it('includes code_verifier in the POST body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: 'tok', refresh_token: 'ref',
        expires_in: 3600, scope: 'email', token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await exchangeCode(GOOGLE_CONFIG, 'code123', 'my-verifier');
    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain('code_verifier=my-verifier');
    expect(body).toContain('code=code123');
  });
});

// ── refreshAccessToken ────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns new accessToken and expiresIn on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: 'ya29.refreshed',
        expires_in: 3600,
      }),
    }));

    const result = await refreshAccessToken(GOOGLE_CONFIG, 'old-refresh-token');
    expect(result.accessToken).toBe('ya29.refreshed');
    expect(result.expiresIn).toBe(3600);
  });

  it('throws ConnectorError with TOKEN_REVOKED code on 400 invalid_grant', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: 'invalid_grant' }),
    }));

    try {
      await refreshAccessToken(GOOGLE_CONFIG, 'revoked-token');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe('TOKEN_REVOKED');
    }
  });

  it('throws ConnectorError with TOKEN_REFRESH_FAILED on other errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({ error: 'service_unavailable' }),
    }));

    try {
      await refreshAccessToken(GOOGLE_CONFIG, 'token');
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as ConnectorError).code).toBe('TOKEN_REFRESH_FAILED');
    }
  });

  it('includes grant_type=refresh_token in the request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ access_token: 'new', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await refreshAccessToken(GOOGLE_CONFIG, 'my-refresh');
    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=my-refresh');
  });
});
