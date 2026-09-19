/**
 * Tests for the MCP OAuth PKCE helpers.
 *
 * Discovery and token exchange are exercised against a stubbed fetch so the
 * RFC 9728 / RFC 8414 / RFC 7591 wiring is pinned without touching a network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  discoverOAuth,
  exchangeCode,
  registerClient,
} from './mcp-oauth.js';

const realFetch = globalThis.fetch;

/** Route a stubbed fetch by URL; anything unmatched 404s. */
function stubFetch(routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = routes[url];
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── PKCE ─────────────────────────────────────────────────────────────────────

describe('createPkce', () => {
  it('produces a base64url verifier and S256 challenge', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toBe(challenge);
    // SHA-256 digest is 32 bytes → 43 base64url chars, unpadded.
    expect(challenge).toHaveLength(43);
  });

  it('is different every call', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
    expect(createState()).not.toBe(createState());
  });
});

// ── Discovery ────────────────────────────────────────────────────────────────

describe('discoverOAuth', () => {
  it('follows protected-resource metadata to the authorization server', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      },
      'https://auth.example.com/.well-known/oauth-authorization-server': {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        scopes_supported: ['read', 'write'],
      },
    });

    const result = await discoverOAuth('https://mcp.example.com/mcp');
    expect(result.guessed).toBe(false);
    expect(result.authorizationEndpoint).toBe('https://auth.example.com/authorize');
    expect(result.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(result.registrationEndpoint).toBe('https://auth.example.com/register');
    expect(result.scopesSupported).toEqual(['read', 'write']);
    expect(result.resource).toBe('https://mcp.example.com/mcp');
  });

  it('falls back to the MCP origin as its own issuer', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-authorization-server/mcp': {
        authorization_endpoint: 'https://mcp.example.com/oauth/authorize',
        token_endpoint: 'https://mcp.example.com/oauth/token',
      },
    });

    const result = await discoverOAuth('https://mcp.example.com/mcp');
    expect(result.guessed).toBe(false);
    expect(result.authorizationEndpoint).toBe('https://mcp.example.com/oauth/authorize');
  });

  it('guesses conventional endpoints when nothing is published', async () => {
    stubFetch({});
    const result = await discoverOAuth('https://mcp.example.com/mcp');
    expect(result.guessed).toBe(true);
    expect(result.authorizationEndpoint).toBe('https://mcp.example.com/authorize');
    expect(result.tokenEndpoint).toBe('https://mcp.example.com/token');
  });

  it('ignores metadata that is missing a required endpoint', async () => {
    stubFetch({
      'https://mcp.example.com/.well-known/oauth-authorization-server/mcp': {
        authorization_endpoint: 'https://mcp.example.com/oauth/authorize',
        // token_endpoint missing → unusable, must fall through to the guess
      },
    });
    const result = await discoverOAuth('https://mcp.example.com/mcp');
    expect(result.guessed).toBe(true);
  });
});

// ── Dynamic client registration ──────────────────────────────────────────────

describe('registerClient', () => {
  it('returns the issued client id', async () => {
    stubFetch({
      'https://auth.example.com/register': { client_id: 'client-123', client_secret: 'shh' },
    });
    const result = await registerClient('https://auth.example.com/register', 'https://bos/cb', 'BOS');
    expect(result).toEqual({ clientId: 'client-123', clientSecret: 'shh' });
  });

  it('returns null when the server refuses registration', async () => {
    stubFetch({});
    expect(await registerClient('https://auth.example.com/register', 'https://bos/cb', 'BOS')).toBeNull();
  });
});

// ── Authorize URL ────────────────────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  it('sets the PKCE and RFC 8707 parameters', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: 'https://auth.example.com/authorize',
        clientId: 'client-123',
        redirectUri: 'https://bos.example.com/api/mcp/global/callback',
        state: 'state-abc',
        codeChallenge: 'challenge-xyz',
        scope: 'read write',
        resource: 'https://mcp.example.com/mcp',
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
  });

  it('omits optional parameters that were not supplied', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: 'https://auth.example.com/authorize',
        clientId: 'c',
        redirectUri: 'https://bos/cb',
        state: 's',
        codeChallenge: 'ch',
      }),
    );
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('resource')).toBe(false);
  });
});

// ── Token exchange ───────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  it('posts the verifier and returns an absolute expiry', async () => {
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: input.toString(), body: String(init?.body ?? '') };
      return new Response(
        JSON.stringify({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
          scope: 'read',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const before = Date.now();
    const tokens = await exchangeCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-123',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'https://bos/cb',
      resource: 'https://mcp.example.com/mcp',
    });

    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.scope).toBe('read');

    const expiry = new Date(tokens.expiresAt as string).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 3_600_000 - 5_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);

    const body = new URLSearchParams(captured!.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('resource')).toBe('https://mcp.example.com/mcp');
  });

  it('leaves expiry undefined when the server sends no expires_in', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    const tokens = await exchangeCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'c',
      code: 'code',
      codeVerifier: 'v',
      redirectUri: 'https://bos/cb',
    });
    expect(tokens.expiresAt).toBeUndefined();
  });

  it('surfaces the provider error text on a failed exchange', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    ) as typeof fetch;

    await expect(
      exchangeCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'c',
        code: 'bad',
        codeVerifier: 'v',
        redirectUri: 'https://bos/cb',
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it('throws when the response carries no access_token', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    await expect(
      exchangeCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'c',
        code: 'x',
        codeVerifier: 'v',
        redirectUri: 'https://bos/cb',
      }),
    ).rejects.toThrow(/no access_token/);
  });
});
