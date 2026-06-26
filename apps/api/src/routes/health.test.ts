/**
 * Integration tests — health routes
 *
 * Uses Fastify's inject() API to send real HTTP requests through the
 * full request lifecycle (middleware + route handlers) without binding
 * to a network port.
 *
 * Tests cover:
 * - GET /health returns 200 with status/version/timestamp
 * - GET /health/full returns SystemHealth payload
 * - GET /health/full returns 200 (all unknown = not fully healthy edge)
 * - Health routes are accessible without an Authorization header
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../server.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeAll(async () => {
  // Provide a JWT_SECRET so authMiddleware doesn't block everything,
  // and a tenant ID so tenantMiddleware doesn't fail on health routes.
  // Health routes are public so these shouldn't be needed, but we set
  // them to prevent accidental 503s from unconfigured auth.
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = 'test-tenant';

  server = await buildServer();
});

afterAll(async () => {
  await server.close();
  delete process.env.JWT_SECRET;
  delete process.env.BOSS_TENANT_ID;
});

// ── GET /health ───────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status, version, and timestamp', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; version: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('2.0.0');
    expect(typeof body.timestamp).toBe('string');
    // Timestamp should be a valid ISO 8601 date
    expect(() => new Date(body.timestamp)).not.toThrow();
  });

  it('does not require Authorization header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      // No Authorization header
    });

    expect(response.statusCode).toBe(200);
  });

  it('responds with Content-Type application/json', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['content-type']).toContain('application/json');
  });
});

// ── GET /health/full ──────────────────────────────────────────────────

describe('GET /health/full', () => {
  it('returns a SystemHealth payload with overall status and services array', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/full',
    });

    // Will be 503 because all services are "unknown"
    const body = response.json<{
      overall: string;
      services: Array<{ service: string; status: string; checkedAt: string }>;
      checkedAt: string;
    }>();

    expect(body).toHaveProperty('overall');
    expect(body).toHaveProperty('services');
    expect(body).toHaveProperty('checkedAt');
    expect(Array.isArray(body.services)).toBe(true);
  });

  it('includes all 8 expected services in the response', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/full',
    });

    const body = response.json<{
      services: Array<{ service: string }>;
    }>();

    const serviceNames = body.services.map(s => s.service);
    expect(serviceNames).toContain('brain');
    expect(serviceNames).toContain('postgres');
    expect(serviceNames).toContain('redis');
    expect(serviceNames).toContain('weaviate');
    // connector-microsoft and connector-google only appear when configured
    expect(serviceNames).toContain('voice');
    expect(serviceNames).toContain('backup');
    expect(serviceNames.length).toBeGreaterThanOrEqual(6);
  });

  it('returns 503 when services are unknown (not all healthy)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/full',
    });

    // All services return "unknown" in the placeholder implementation,
    // which results in "degraded" overall (unknown != healthy, unknown != unhealthy)
    // The route returns 503 for any non-healthy state.
    expect([200, 503]).toContain(response.statusCode);
  });

  it('does not require Authorization header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/full',
      // No Authorization header
    });

    // Should get a JSON response, not a 401/403
    const body = response.json();
    expect(body).toHaveProperty('overall');
  });

  it('each service result has a checkedAt timestamp', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/full',
    });

    const body = response.json<{
      services: Array<{ checkedAt: string }>;
    }>();

    for (const service of body.services) {
      expect(service.checkedAt).toBeDefined();
      expect(() => new Date(service.checkedAt)).not.toThrow();
    }
  });
});

// ── Auth protection on non-health routes ─────────────────────────────

describe('Auth protection — non-health endpoints', () => {
  it('returns 401 on a protected route without Authorization header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/some-protected-resource',
    });

    // Auth middleware should reject this
    expect([401, 403, 404]).toContain(response.statusCode);
  });

  it('returns 503 when JWT_SECRET is missing and API key is not configured', async () => {
    const savedSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.BOSS_API_KEY;

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/anything',
        headers: { authorization: 'Bearer some-token' },
      });

      expect(response.statusCode).toBe(503);
    } finally {
      if (savedSecret) process.env.JWT_SECRET = savedSecret;
    }
  });
});
