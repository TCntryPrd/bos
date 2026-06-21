/**
 * Unit tests — authMiddleware + helper functions
 *
 * Tests cover:
 * - Public paths bypass auth (/health, /health/full)
 * - Missing Authorization header -> 401
 * - Token over 4096 chars -> 401
 * - Valid JWT (HS256) -> attaches auth to request
 * - JWT with expired exp claim -> 403
 * - JWT with future nbf claim -> 403
 * - JWT with wrong issuer -> 403 (when JWT_ISSUER is set)
 * - JWT with tampered signature -> 403
 * - Valid API key -> attaches auth to request with authMethod=apikey
 * - Invalid API key -> 403
 * - No JWT_SECRET and no BOSS_API_KEY -> 503
 * - Auth failure rate limiting -> 429 (returns retryAfterSeconds)
 * - Authenticated users are NOT rate-limited (single-user system)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { authMiddleware, __resetTrustedInternalIpsForTests } from './auth.js';

// ── JWT helpers ──────────────────────────────────────────────────────

function base64url(input: string | Buffer): string {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return b.toString('base64url');
}

function buildJwt(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function validJwt(
  payloadOverrides: Record<string, unknown> = {},
  secret = 'test-secret',
): string {
  return buildJwt(
    {
      sub: 'user-001',
      tenant_id: 'tenant-abc',
      role: 'admin',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      ...payloadOverrides,
    },
    secret,
  );
}

// ── Fastify request/reply mock ────────────────────────────────────────

interface MockRequest {
  url: string;
  ip: string;
  headers: Record<string, string | undefined>;
  auth?: unknown;
}

interface MockReply {
  statusCode: number;
  body: unknown;
  status(code: number): MockReply;
  send(body: unknown): MockReply;
}

let ipCounter = 0;

/**
 * Each test gets a unique IP to avoid cross-test rate limit contamination.
 * The auth middleware tracks rate limits by IP in a module-level Map,
 * so we assign a fresh IP per test to keep tests fully isolated.
 */
function uniqueIp(): string {
  ipCounter++;
  return `10.${Math.floor(ipCounter / 65536) % 256}.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

function makeRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  return {
    url: '/api/v1/brain/chat',
    ip: uniqueIp(),
    headers: {},
    ...overrides,
  };
}

function makeReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  return reply;
}

// ── Environment management ────────────────────────────────────────────

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  setEnv({
    JWT_SECRET: undefined,
    JWT_ISSUER: undefined,
    BOSS_API_KEY: undefined,
    TRUST_PROXY: undefined,
  });
});

// ── Public paths ──────────────────────────────────────────────────────

describe('authMiddleware — public paths', () => {
  it('skips auth for /health', async () => {
    const req = makeRequest({ url: '/health' });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(200); // no modification
    expect(reply.body).toBeUndefined();
  });

  it('skips auth for /health/full', async () => {
    const req = makeRequest({ url: '/health/full' });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(200);
  });

  it('skips auth for paths that start with /health', async () => {
    const req = makeRequest({ url: '/health/services/postgres' });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(200);
  });
});

// ── Missing / malformed Authorization header ──────────────────────────

describe('authMiddleware — missing or malformed Authorization', () => {
  it('returns 401 when Authorization header is missing', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'valid-api-key' });
    const req = makeRequest({ headers: {} });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(401);
    expect((reply.body as Record<string, string>).error).toBe('Unauthorized');
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'valid-api-key' });
    const req = makeRequest({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('returns 401 when Bearer token is empty', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'valid-api-key' });
    const req = makeRequest({ headers: { authorization: 'Bearer ' } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('returns 401 when Bearer token exceeds 4096 chars', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'valid-api-key' });
    const req = makeRequest({ headers: { authorization: `Bearer ${'x'.repeat(4097)}` } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });
});

// ── JWT validation ────────────────────────────────────────────────────

describe('authMiddleware — JWT validation', () => {
  it('accepts a valid JWT and attaches auth to request', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: undefined });
    const req = makeRequest({
      headers: { authorization: `Bearer ${validJwt()}` },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect((req as unknown as { auth: { userId: string } }).auth?.userId).toBe('user-001');
    expect((req as unknown as { auth: { authMethod: string } }).auth?.authMethod).toBe('jwt');
  });

  it('extracts tenantId from JWT payload (camelCase — current tokens)', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });
    const req = makeRequest({
      headers: { authorization: `Bearer ${validJwt({ tenantId: 'my-tenant', tenant_id: undefined })}` },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect((req as unknown as { auth: { tenantId: string } }).auth?.tenantId).toBe('my-tenant');
  });

  it('extracts tenantId from JWT payload (snake_case — legacy tokens)', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });
    const req = makeRequest({
      headers: { authorization: `Bearer ${validJwt({ tenant_id: 'legacy-tenant' })}` },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect((req as unknown as { auth: { tenantId: string } }).auth?.tenantId).toBe('legacy-tenant');
  });

  it('prefers camelCase tenantId over snake_case tenant_id when both are present', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });
    const req = makeRequest({
      headers: { authorization: `Bearer ${validJwt({ tenantId: 'preferred', tenant_id: 'legacy' })}` },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect((req as unknown as { auth: { tenantId: string } }).auth?.tenantId).toBe('preferred');
  });

  it('extracts role from JWT payload', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });
    const req = makeRequest({
      headers: { authorization: `Bearer ${validJwt({ role: 'viewer' })}` },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect((req as unknown as { auth: { role: string } }).auth?.role).toBe('viewer');
  });

  it('returns 403 when JWT signature is tampered (falls back to no API key = 503)', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: undefined });
    const jwt = validJwt();
    const parts = jwt.split('.');
    const tampered = `${parts[0]}.${parts[1]}.invalidsig`;
    const req = makeRequest({ headers: { authorization: `Bearer ${tampered}` } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    // JWT fails, no API key set -> 503
    expect(reply.statusCode).toBe(503);
  });

  it('returns 403 when JWT signature is tampered but API key fallback exists', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'fallback-key' });
    const jwt = validJwt();
    const parts = jwt.split('.');
    const tampered = `${parts[0]}.${parts[1]}.invalidsig`;
    const req = makeRequest({ headers: { authorization: `Bearer ${tampered}` } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    // JWT fails, token doesn't match API key -> 403
    expect(reply.statusCode).toBe(403);
  });

  it('returns 403 when JWT has expired exp claim', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'fallback-key' });
    const expiredJwt = validJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const req = makeRequest({ headers: { authorization: `Bearer ${expiredJwt}` } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('returns 403 when JWT has future nbf claim', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'fallback-key' });
    const notYetValid = validJwt({ nbf: Math.floor(Date.now() / 1000) + 3600 });
    const req = makeRequest({ headers: { authorization: `Bearer ${notYetValid}` } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('returns 403 when JWT issuer does not match JWT_ISSUER', async () => {
    setEnv({
      JWT_SECRET: 'test-secret',
      JWT_ISSUER: 'expected-issuer',
      BOSS_API_KEY: 'fallback-key',
    });
    const wrongIssuer = validJwt({ iss: 'wrong-issuer' });
    const req = makeRequest({ headers: { authorization: `Bearer ${wrongIssuer}` } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('accepts JWT when issuer matches JWT_ISSUER', async () => {
    setEnv({ JWT_SECRET: 'test-secret', JWT_ISSUER: 'boss-v2' });
    const correctIssuer = validJwt({ iss: 'boss-v2' });
    const req = makeRequest({ headers: { authorization: `Bearer ${correctIssuer}` } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(200);
  });

  it('returns 503 when JWT_SECRET is not set and no API key configured', async () => {
    setEnv({ JWT_SECRET: undefined, BOSS_API_KEY: undefined });
    const req = makeRequest({ headers: { authorization: 'Bearer some.jwt.token' } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(503);
    expect((reply.body as Record<string, string>).error).toBe('Service Unavailable');
  });

  it('returns 403 when JWT has wrong format (not 3 parts)', async () => {
    setEnv({ JWT_SECRET: 'test-secret', BOSS_API_KEY: 'fallback-key' });
    const req = makeRequest({ headers: { authorization: 'Bearer notajwt' } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(403);
  });
});

// ── API key validation ────────────────────────────────────────────────

describe('authMiddleware — API key fallback', () => {
  it('accepts valid API key and sets authMethod=apikey', async () => {
    setEnv({ JWT_SECRET: undefined, BOSS_API_KEY: 'secret-api-key-1234' });
    const req = makeRequest({
      headers: { authorization: 'Bearer secret-api-key-1234' },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect((req as unknown as { auth: { authMethod: string } }).auth?.authMethod).toBe('apikey');
    expect((req as unknown as { auth: { userId: string } }).auth?.userId).toBe('api-key-user');
  });

  it('returns 403 for an invalid API key', async () => {
    setEnv({ JWT_SECRET: undefined, BOSS_API_KEY: 'correct-key' });
    const req = makeRequest({ headers: { authorization: 'Bearer wrong-api-key' } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(403);
    expect((reply.body as Record<string, string>).error).toBe('Forbidden');
  });

  it('returns 503 when BOSS_API_KEY is not set and JWT_SECRET not set', async () => {
    setEnv({ JWT_SECRET: undefined, BOSS_API_KEY: undefined });
    const req = makeRequest({ headers: { authorization: 'Bearer some-key' } });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(503);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────

describe('authMiddleware — rate limiting', () => {
  // Per-IP request-volume limiting was intentionally removed — this is a
  // single-user system and valid auth shouldn't get throttled. Only auth
  // *failures* are rate-limited (RATE_LIMIT_AUTH_FAILURES_MAX = 1000 over
  // RATE_LIMIT_WINDOW_MS = 60_000ms).
  //
  // The entry gate uses isRateLimited() (peek only); only the failure paths
  // call checkRateLimit() which increments. So each missing-auth request
  // increments the counter exactly once — a 1000-strike limit fires on the
  // 1001st failed request. The assertions detect the transition rather
  // than asserting a fixed iteration to survive small refactors.

  it('returns 429 once auth-failure threshold is exceeded', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });

    // Random IP so test runs don't collide via the module-level store
    const sharedIp = `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;

    let firstBlockIter: number | null = null;
    let first429Reply: MockReply | undefined;

    // Walk up to 1500 failed-auth requests; detect when the 429 first lands
    for (let i = 0; i < 1500; i++) {
      const req: MockRequest = {
        url: '/api/v1/brain',
        ip: sharedIp,
        headers: {}, // no Authorization → auth failure branch
      };
      const reply = makeReply();
      await authMiddleware(req as never, reply as never);
      if (reply.statusCode === 429 && firstBlockIter === null) {
        firstBlockIter = i;
        first429Reply = reply;
        break;
      }
    }

    expect(firstBlockIter).not.toBeNull();
    // Pin the transition to a reasonable range around the 1000 threshold
    // (single-count — peek gate, increment on failure). Window catches drift
    // but fails loudly if someone silently halves or doubles the limit.
    expect(firstBlockIter).toBeGreaterThan(900);
    expect(firstBlockIter).toBeLessThan(1100);
    expect((first429Reply!.body as Record<string, string>).error).toBe(
      'Too Many Requests',
    );
  });

  it('returns retryAfterSeconds in the 429 response body', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });

    const singleIp = `172.16.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
    let first429Reply: MockReply | undefined;

    for (let i = 0; i < 1500; i++) {
      const req: MockRequest = {
        url: '/api/v1/brain',
        ip: singleIp,
        headers: {}, // auth failure
      };
      const reply = makeReply();
      await authMiddleware(req as never, reply as never);
      if (reply.statusCode === 429) {
        first429Reply = reply;
        break;
      }
    }

    const body = first429Reply!.body as Record<string, unknown>;
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does NOT rate-limit authenticated users (single-user system)', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });

    const sharedIp = `10.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
    let lastReply: MockReply | undefined;

    // 2500 valid requests — bumped from 200 to specifically catch
    // regressions that re-introduce the deleted RATE_LIMIT_MAX_REQUESTS=2000
    // limiter. Loops fast since each call is in-memory.
    for (let i = 0; i < 2500; i++) {
      const req: MockRequest = {
        url: '/api/v1/brain',
        ip: sharedIp,
        headers: { authorization: `Bearer ${validJwt()}` },
      };
      lastReply = makeReply();
      await authMiddleware(req as never, lastReply as never);
    }

    // Valid auth: middleware returns undefined (doesn't call reply.send)
    expect(lastReply!.statusCode).not.toBe(429);
  });
});

// ── Internal call bypass (trusted-IP list) ──────────────────────────────────

describe('authMiddleware — X-BOSS-Internal bypass', () => {
  beforeEach(() => {
    __resetTrustedInternalIpsForTests();
  });

  afterEach(() => {
    setEnv({ BOSS_INTERNAL_TRUSTED_IPS: undefined });
    __resetTrustedInternalIpsForTests();
  });

  it('bypasses auth for a localhost request with the internal header (default trust list)', async () => {
    setEnv({ JWT_SECRET: 'test-secret' });
    const req = makeRequest({
      ip: '127.0.0.1',
      headers: { 'x-boss-internal': 'true' },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect((req as unknown as { auth: { userId: string } }).auth?.userId).toBe('boss-internal');
  });

  it('bypasses auth for an IP listed in BOSS_INTERNAL_TRUSTED_IPS', async () => {
    setEnv({
      JWT_SECRET: 'test-secret',
      BOSS_INTERNAL_TRUSTED_IPS: '127.0.0.1,::1,172.22.0.1',
    });
    const req = makeRequest({
      ip: '172.22.0.1',
      headers: { 'x-boss-internal': 'true' },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect((req as unknown as { auth: { userId: string } }).auth?.userId).toBe('boss-internal');
  });

  it('rejects (falls through to auth) an IP not in the trust list even with the internal header', async () => {
    setEnv({
      JWT_SECRET: 'test-secret',
      BOSS_INTERNAL_TRUSTED_IPS: '127.0.0.1,::1',
    });
    const req = makeRequest({
      ip: '10.0.0.5',
      headers: { 'x-boss-internal': 'true' },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
  });

  it('rejects a trusted IP without the X-BOSS-Internal header', async () => {
    setEnv({
      JWT_SECRET: 'test-secret',
      BOSS_INTERNAL_TRUSTED_IPS: '127.0.0.1,::1,172.22.0.1',
    });
    const req = makeRequest({
      ip: '172.22.0.1',
      headers: {},
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
  });

  it('tolerates whitespace in BOSS_INTERNAL_TRUSTED_IPS', async () => {
    setEnv({
      JWT_SECRET: 'test-secret',
      BOSS_INTERNAL_TRUSTED_IPS: ' 127.0.0.1 , ::1 , 172.22.0.1 ',
    });
    const req = makeRequest({
      ip: '172.22.0.1',
      headers: { 'x-boss-internal': 'true' },
    });
    const reply = makeReply();
    await authMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
  });
});
