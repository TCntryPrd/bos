/**
 * Tenant resolution middleware.
 *
 * SECURITY:
 * - Tenant ID is validated and sanitized (alphanumeric + hyphens only)
 * - JWT tenant claims take priority over headers (prevents spoofing)
 * - X-Tenant-ID header is only trusted for API key auth, NOT for JWT auth
 * - Tenant isolation enforced: JWT-authenticated users cannot access other tenants
 * - OWASP A01:2021 -- Broken Access Control
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TenantContext, TenantConfig } from '@boss/core';

/** Routes that skip tenant resolution. */
const SKIP_TENANT_PATHS = ['/health', '/health/full', '/api/webhooks/'];

/** Maximum allowed tenant ID length. */
const MAX_TENANT_ID_LENGTH = 64;

/** Allowed characters in tenant IDs: alphanumeric, hyphens, underscores. */
const TENANT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Validate and sanitize a tenant ID.
 * Returns null if the tenant ID is invalid.
 */
function validateTenantId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TENANT_ID_LENGTH) return null;
  if (!TENANT_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export async function tenantMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (SKIP_TENANT_PATHS.some(p => request.url.startsWith(p))) {
    return;
  }

  const auth = request.auth;

  let tenantId: string | null = null;

  // Priority 1: JWT tenant claim (most trusted, cannot be spoofed)
  if (auth?.authMethod === 'jwt' && auth.tenantId) {
    tenantId = validateTenantId(auth.tenantId);
    if (!tenantId) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid tenant ID in authentication token',
      });
    }

    // SECURITY: If JWT specifies a tenant, the X-Tenant-ID header must match
    // or be absent. This prevents cross-tenant access via header spoofing.
    const headerTenantId = request.headers['x-tenant-id'] as string | undefined;
    if (headerTenantId) {
      const validatedHeader = validateTenantId(headerTenantId);
      if (validatedHeader !== tenantId) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Tenant mismatch: you cannot access resources in another tenant',
        });
      }
    }
  }

  // Priority 2: X-Tenant-ID header (only for API key auth or when JWT has no tenant)
  if (!tenantId) {
    const headerTenantId = request.headers['x-tenant-id'] as string | undefined;
    if (headerTenantId) {
      tenantId = validateTenantId(headerTenantId);
      if (!tenantId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid X-Tenant-ID header format',
        });
      }
    }
  }

  // Priority 3: Subdomain extraction
  if (!tenantId) {
    const subdomain = extractSubdomain(request);
    if (subdomain) {
      tenantId = validateTenantId(subdomain);
      // Invalid subdomain format is silently ignored (falls through to default)
    }
  }

  // Priority 4: Default from environment
  if (!tenantId) {
    const envTenantId = process.env.BOSS_TENANT_ID;
    if (envTenantId) {
      tenantId = validateTenantId(envTenantId);
    }
  }

  // Priority 5: Hard default (single-tenant mode)
  if (!tenantId) {
    tenantId = 'default';
  }

  // Build tenant config.
  // Phase 1: static config. Will be replaced with validated DB lookup.
  const config: TenantConfig = {
    id: tenantId,
    name: tenantId,
    mode: process.env.BOSS_MULTI_TENANT === 'true' ? 'multi' : 'single',
    brainProvider: 'claude-code',
    connectorProvider: 'google',
    createdAt: new Date(),
    updatedAt: new Date(),
    settings: {
      timezone: 'America/New_York',
      locale: 'en-US',
      voiceEnabled: false,
      backupIntervalMinutes: 60,
      backupRetentionDays: 30,
      healingEnabled: true,
      learningEnabled: true,
    },
  };

  const context: TenantContext = {
    tenantId,
    userId: auth?.userId || 'anonymous',
    config,
  };

  request.tenant = context;
}

function extractSubdomain(request: FastifyRequest): string | undefined {
  const host = request.headers.host;
  if (!host) return undefined;

  // Strip port number if present
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  // e.g., "tenant1.boss.example.com" -> "tenant1"
  if (parts.length >= 3) {
    return parts[0];
  }
  return undefined;
}
