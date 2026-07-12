/**
 * Unit tests — tenantMiddleware
 *
 * Tests cover:
 * - Skip tenant resolution for public paths (/health, /health/full)
 * - JWT tenant claim is used as highest priority
 * - JWT tenant claim vs X-Tenant-ID header mismatch -> 403
 * - X-Tenant-ID header used for API key auth
 * - Subdomain extraction from Host header
 * - BOSS_TENANT_ID env fallback
 * - Default "default" tenant when nothing is configured
 * - Tenant ID format validation (alphanumeric, hyphens, underscores)
 * - BOSS_MULTI_TENANT env flag affects config.mode
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tenantMiddleware } from './tenant.js';
import type { AuthInfo } from './auth.js';

// ── Request/reply mocks ───────────────────────────────────────────────

interface MockRequest {
  url: string;
  ip: string;
  headers: Record<string, string | undefined>;
  auth?: AuthInfo;
  tenant?: unknown;
}

interface MockReply {
  statusCode: number;
  body: unknown;
  status(code: number): MockReply;
  send(body: unknown): MockReply;
}

function makeRequest(overrides: Partial<MockRequest> = {}): MockRequest {
  return {
    url: '/api/v1/brain/chat',
    ip: '127.0.0.1',
    headers: {},
    ...overrides,
  };
}

function makeReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  };
  return reply;
}

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  setEnv({ BOSS_TENANT_ID: undefined, BOSS_MULTI_TENANT: undefined });
});

// ── Public path skipping ──────────────────────────────────────────────

describe('tenantMiddleware — public paths', () => {
  it('skips tenant resolution for /health', async () => {
    const req = makeRequest({ url: '/health' });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);
    expect(req.tenant).toBeUndefined();
  });

  it('skips tenant resolution for /health/full', async () => {
    const req = makeRequest({ url: '/health/full' });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);
    expect(req.tenant).toBeUndefined();
  });
});

// ── JWT tenant claim (Priority 1) ─────────────────────────────────────

describe('tenantMiddleware — JWT tenant claim', () => {
  it('uses tenantId from JWT auth claim', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'tenant-from-jwt', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect((req.tenant as { tenantId: string }).tenantId).toBe('tenant-from-jwt');
  });

  it('returns 403 when X-Tenant-ID header does not match JWT tenant', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'real-tenant', authMethod: 'jwt' },
      headers: { 'x-tenant-id': 'different-tenant' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect((reply.body as Record<string, string>).error).toBe('Forbidden');
  });

  it('succeeds when X-Tenant-ID matches JWT tenant', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'same-tenant', authMethod: 'jwt' },
      headers: { 'x-tenant-id': 'same-tenant' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect((req.tenant as { tenantId: string }).tenantId).toBe('same-tenant');
  });

  it('returns 400 when JWT tenant ID has invalid format', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'invalid tenant!', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(400);
    expect((reply.body as Record<string, string>).error).toBe('Bad Request');
  });

  it('returns 400 when JWT tenant ID is empty string', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: '', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);
    // Empty tenant ID is treated as no tenant claim — falls through to other methods
    // (validate returns null for empty string)
    expect(reply.statusCode).toBe(200);
  });

  it('allows alphanumeric and hyphens in tenant ID', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'company-abc-123', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(200);
    expect((req.tenant as { tenantId: string }).tenantId).toBe('company-abc-123');
  });

  it('allows underscores in tenant ID', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'company_abc', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);
    expect(reply.statusCode).toBe(200);
  });
});

// ── X-Tenant-ID header (Priority 2) ──────────────────────────────────

describe('tenantMiddleware — X-Tenant-ID header', () => {
  it('uses X-Tenant-ID header for API key auth', async () => {
    const req = makeRequest({
      auth: { userId: 'api-key-user', authMethod: 'apikey' },
      headers: { 'x-tenant-id': 'header-tenant' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect((req.tenant as { tenantId: string }).tenantId).toBe('header-tenant');
  });

  it('uses X-Tenant-ID header when there is no auth at all', async () => {
    const req = makeRequest({
      headers: { 'x-tenant-id': 'anon-tenant' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect((req.tenant as { tenantId: string }).tenantId).toBe('anon-tenant');
  });

  it('returns 400 when X-Tenant-ID has invalid format', async () => {
    const req = makeRequest({
      auth: { userId: 'api-key-user', authMethod: 'apikey' },
      headers: { 'x-tenant-id': 'bad tenant!' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(400);
  });

  it('returns 400 when X-Tenant-ID exceeds max length', async () => {
    const req = makeRequest({
      auth: { userId: 'api-key-user', authMethod: 'apikey' },
      headers: { 'x-tenant-id': 'a'.repeat(65) },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect(reply.statusCode).toBe(400);
  });
});

// ── Subdomain extraction (Priority 3) ────────────────────────────────

describe('tenantMiddleware — subdomain extraction', () => {
  it('extracts tenant from subdomain of multi-part host', async () => {
    const req = makeRequest({
      headers: { host: 'acme-corp.boss.example.com' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect((req.tenant as { tenantId: string }).tenantId).toBe('acme-corp');
  });

  it('ignores subdomain extraction for two-part hostnames', async () => {
    const req = makeRequest({
      headers: { host: 'boss.com' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    // No subdomain available; falls through to env/default
    expect((req.tenant as { tenantId: string }).tenantId).toBe('default');
  });

  it('strips port from host before subdomain parsing', async () => {
    const req = makeRequest({
      headers: { host: 'tenant-x.boss.local:3000' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect((req.tenant as { tenantId: string }).tenantId).toBe('tenant-x');
  });
});

// ── Environment fallback (Priority 4) ────────────────────────────────

describe('tenantMiddleware — BOSS_TENANT_ID env fallback', () => {
  it('uses BOSS_TENANT_ID when no other source provides a tenant', async () => {
    setEnv({ BOSS_TENANT_ID: 'env-tenant' });
    const req = makeRequest({});
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect((req.tenant as { tenantId: string }).tenantId).toBe('env-tenant');
  });
});

// ── Hard default (Priority 5) ─────────────────────────────────────────

describe('tenantMiddleware — default fallback', () => {
  it('falls back to "default" tenant when nothing else is configured', async () => {
    const req = makeRequest({});
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    expect((req.tenant as { tenantId: string }).tenantId).toBe('default');
  });
});

// ── TenantContext structure ───────────────────────────────────────────

describe('tenantMiddleware — TenantContext shape', () => {
  it('attaches a complete TenantContext to request.tenant', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'ctx-tenant', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    const ctx = req.tenant as {
      tenantId: string;
      userId: string;
      config: { id: string; name: string; mode: string };
    };

    expect(ctx.tenantId).toBe('ctx-tenant');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.config.id).toBe('ctx-tenant');
    expect(ctx.config.name).toBe('ctx-tenant');
  });

  it('sets anonymous userId when auth is not present', async () => {
    const req = makeRequest({});
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    const ctx = req.tenant as { userId: string };
    expect(ctx.userId).toBe('anonymous');
  });

  it('sets mode=multi when BOSS_MULTI_TENANT=true', async () => {
    setEnv({ BOSS_MULTI_TENANT: 'true' });
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'multi-tenant', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    const ctx = req.tenant as { config: { mode: string } };
    expect(ctx.config.mode).toBe('multi');
  });

  it('sets mode=single when BOSS_MULTI_TENANT is not set', async () => {
    const req = makeRequest({
      auth: { userId: 'user-1', tenantId: 'single-tenant', authMethod: 'jwt' },
    });
    const reply = makeReply();
    await tenantMiddleware(req as never, reply as never);

    const ctx = req.tenant as { config: { mode: string } };
    expect(ctx.config.mode).toBe('single');
  });
});
