/**
 * Settings routes — /api/settings/*
 *
 * Tenant-scoped configuration management.
 *
 *   GET    /         — read all settings for the current tenant
 *   PATCH  /         — partial update: merge provided fields into settings
 *   PUT    /         — full replacement of tenant settings
 *   DELETE /:key     — reset a single setting key to its default value
 *
 * Settings structure mirrors TenantSettings from @boss/core plus
 * extended API-layer fields (notification preferences, UI themes, etc).
 *
 * Settings are stored in-memory in Phase 1; replace with Postgres in Phase 2
 * when the DB layer is wired.
 *
 * All mutations are tenant-scoped and require at least an authenticated user.
 * Write operations that change brainProvider or connectorProvider additionally
 * require the 'admin' role.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BrainProvider = 'claude-code' | 'openai' | 'openrouter' | 'gemini' | 'openclaw' | 'custom';
type ConnectorProvider = 'microsoft' | 'google';
type TenantMode = 'single' | 'multi';

interface TenantSettings {
  // Core (from @boss/core TenantSettings)
  timezone: string;
  locale: string;
  voiceEnabled: boolean;
  backupIntervalMinutes: number;
  backupRetentionDays: number;
  healingEnabled: boolean;
  learningEnabled: boolean;

  // Extended API-layer settings
  mode: TenantMode;
  brainProvider: BrainProvider;
  connectorProvider: ConnectorProvider;
  theme: 'light' | 'dark' | 'system';
  notificationsEnabled: boolean;
  maxConcurrentJobs: number;
  debugLogging: boolean;
  updatedAt: Date;
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Omit<TenantSettings, 'updatedAt' | 'updatedBy'> = {
  timezone: 'America/New_York',
  locale: 'en-US',
  voiceEnabled: false,
  backupIntervalMinutes: 60,
  backupRetentionDays: 30,
  healingEnabled: true,
  learningEnabled: true,
  mode: 'single',
  brainProvider: 'claude-code',
  connectorProvider: 'google',
  theme: 'system',
  notificationsEnabled: true,
  maxConcurrentJobs: 4,
  debugLogging: false,
};

// ---------------------------------------------------------------------------
// In-memory store (Phase 2: replace with Postgres)
// ---------------------------------------------------------------------------

const settingsStore = new Map<string, TenantSettings>();

function getOrCreateSettings(tenantId: string, userId: string): TenantSettings {
  const existing = settingsStore.get(tenantId);
  if (existing) return existing;
  const settings: TenantSettings = {
    ...DEFAULT_SETTINGS,
    updatedAt: new Date(),
    updatedBy: userId,
  };
  settingsStore.set(tenantId, settings);
  return settings;
}

// Keys that require admin role to modify
const ADMIN_ONLY_KEYS = new Set<keyof TenantSettings>([
  'brainProvider',
  'connectorProvider',
  'mode',
  'maxConcurrentJobs',
  'debugLogging',
]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const settingsResponseSchema = {
  type: 'object',
  properties: {
    timezone: { type: 'string' },
    locale: { type: 'string' },
    voiceEnabled: { type: 'boolean' },
    backupIntervalMinutes: { type: 'number' },
    backupRetentionDays: { type: 'number' },
    healingEnabled: { type: 'boolean' },
    learningEnabled: { type: 'boolean' },
    mode: { type: 'string' },
    brainProvider: { type: 'string' },
    connectorProvider: { type: 'string' },
    theme: { type: 'string' },
    notificationsEnabled: { type: 'boolean' },
    maxConcurrentJobs: { type: 'number' },
    debugLogging: { type: 'boolean' },
    updatedAt: { type: 'string' },
    updatedBy: { type: 'string' },
  },
} as const;

const settingsBodySchema = {
  type: 'object',
  properties: {
    timezone: { type: 'string' },
    locale: { type: 'string' },
    voiceEnabled: { type: 'boolean' },
    backupIntervalMinutes: { type: 'integer', minimum: 15, maximum: 10080 },
    backupRetentionDays: { type: 'integer', minimum: 1, maximum: 365 },
    healingEnabled: { type: 'boolean' },
    learningEnabled: { type: 'boolean' },
    mode: { type: 'string', enum: ['single', 'multi'] },
    brainProvider: {
      type: 'string',
      enum: ['claude-code', 'openai', 'gemini', 'openclaw', 'custom'],
    },
    connectorProvider: { type: 'string', enum: ['microsoft', 'google'] },
    theme: { type: 'string', enum: ['light', 'dark', 'system'] },
    notificationsEnabled: { type: 'boolean' },
    maxConcurrentJobs: { type: 'integer', minimum: 1, maximum: 32 },
    debugLogging: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

const deleteKeyParamSchema = {
  type: 'object',
  required: ['key'],
  properties: { key: { type: 'string', minLength: 1 } },
} as const;

// ---------------------------------------------------------------------------
// Type for route body
// ---------------------------------------------------------------------------

type SettingsUpdateBody = Partial<Omit<TenantSettings, 'updatedAt' | 'updatedBy'>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasAdminOnlyKey(body: SettingsUpdateBody): boolean {
  return Object.keys(body).some((k) => ADMIN_ONLY_KEYS.has(k as keyof TenantSettings));
}

function serializeSettings(s: TenantSettings): Record<string, unknown> {
  return { ...s, updatedAt: s.updatedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function settingsRoutes(server: FastifyInstance) {
  /**
   * GET /api/settings
   * Read all settings for the current tenant.
   *
   * Example response:
   *   { "timezone": "America/New_York", "brainProvider": "claude-code", ... }
   */
  server.get(
    '/',
    {
      schema: {
        response: { 200: settingsResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const userId = request.auth?.userId ?? 'anonymous';
      const settings = getOrCreateSettings(tenantId, userId);
      return reply.status(200).send(serializeSettings(settings));
    },
  );

  /**
   * PATCH /api/settings
   * Partial update — merge provided fields into the existing settings.
   * Admin-only fields (brainProvider, connectorProvider, mode, etc.) require
   * the 'admin' role.
   *
   * Example request:
   *   PATCH /api/settings
   *   { "timezone": "America/Chicago", "voiceEnabled": true }
   */
  server.patch<{ Body: SettingsUpdateBody }>(
    '/',
    {
      schema: {
        body: settingsBodySchema,
        response: { 200: settingsResponseSchema },
      },
    },
    async (
      request: FastifyRequest<{ Body: SettingsUpdateBody }>,
      reply: FastifyReply,
    ) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const userId = request.auth?.userId ?? 'anonymous';
      const role = request.auth?.role;

      if (hasAdminOnlyKey(request.body) && role !== 'admin') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Admin role required to modify system-level settings',
        });
      }

      const existing = getOrCreateSettings(tenantId, userId);
      const updated: TenantSettings = {
        ...existing,
        ...request.body,
        updatedAt: new Date(),
        updatedBy: userId,
      };
      settingsStore.set(tenantId, updated);

      request.log.info({ tenantId, userId, keys: Object.keys(request.body) }, 'Settings patched');
      return reply.status(200).send(serializeSettings(updated));
    },
  );

  /**
   * PUT /api/settings
   * Full replacement of tenant settings.
   * All fields are optional; omitted fields revert to defaults.
   * Requires admin role.
   *
   * Example request:
   *   PUT /api/settings
   *   { "timezone": "UTC", "brainProvider": "openai", ... }
   */
  server.put<{ Body: SettingsUpdateBody }>(
    '/',
    {
      schema: {
        body: settingsBodySchema,
        response: { 200: settingsResponseSchema },
      },
    },
    async (
      request: FastifyRequest<{ Body: SettingsUpdateBody }>,
      reply: FastifyReply,
    ) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const userId = request.auth?.userId ?? 'anonymous';
      const role = request.auth?.role;

      if (role !== 'admin') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Admin role required to replace settings',
        });
      }

      const replaced: TenantSettings = {
        ...DEFAULT_SETTINGS,
        ...request.body,
        updatedAt: new Date(),
        updatedBy: userId,
      };
      settingsStore.set(tenantId, replaced);

      request.log.info({ tenantId, userId }, 'Settings replaced (PUT)');
      return reply.status(200).send(serializeSettings(replaced));
    },
  );

  /**
   * DELETE /api/settings/:key
   * Reset a single setting key to its default value.
   * Admin-only keys require the 'admin' role.
   *
   * Example:
   *   DELETE /api/settings/debugLogging
   *
   * Example response:
   *   { "key": "debugLogging", "reset": true, "defaultValue": false }
   */
  server.delete<{ Params: { key: string } }>(
    '/:key',
    {
      schema: {
        params: deleteKeyParamSchema,
        response: {
          200: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              reset: { type: 'boolean' },
              defaultValue: {},
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { key: string } }>,
      reply: FastifyReply,
    ) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const userId = request.auth?.userId ?? 'anonymous';
      const role = request.auth?.role;
      const { key } = request.params;

      if (!(key in DEFAULT_SETTINGS)) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Unknown settings key: '${key}'`,
        });
      }

      const typedKey = key as keyof typeof DEFAULT_SETTINGS;

      if (ADMIN_ONLY_KEYS.has(typedKey as keyof TenantSettings) && role !== 'admin') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: `Admin role required to reset '${key}'`,
        });
      }

      const existing = getOrCreateSettings(tenantId, userId);
      const defaultValue = DEFAULT_SETTINGS[typedKey];
      (existing as any)[key] = defaultValue;
      existing.updatedAt = new Date();
      existing.updatedBy = userId;
      settingsStore.set(tenantId, existing);

      request.log.info({ tenantId, userId, key }, 'Setting reset to default');
      return reply.status(200).send({ key, reset: true, defaultValue });
    },
  );

  /**
   * GET /api/settings/crm
   * Returns the configured CRM URL and provider.
   */
  server.get('/crm', { config: { skipAuth: true } }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const pool = (await import('../db.js')).getPool();
      const { rows } = await pool.query<{ key: string; value: string }>(
        "SELECT key, value FROM runtime_config WHERE key IN ('crm_provider', 'crm_url') AND tenant_id = 'default'",
      );
      const config: Record<string, string> = {};
      for (const row of rows) config[row.key] = row.value;
      return reply.status(200).send({
        provider: config.crm_provider || null,
        url: config.crm_url || null,
      });
    } catch {
      return reply.status(200).send({ provider: null, url: null });
    }
  });
}
