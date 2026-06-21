/**
 * Apps routes — /api/apps/*
 *
 *   GET  /android   — Android app download metadata (URL, QR code, version)
 *   GET  /windows   — Windows app download metadata (URL, version)
 *   GET  /status    — Registered app installation flags for the current user
 *   POST /register  — Register an app installation (platform + deviceId)
 *
 * Phase 5: in-memory store keyed by userId + tenantId.
 * Replace with Postgres-backed storage in Phase 5.
 *
 * The `legacyKnowledgeEnabled` flag on /status is true when at least one
 * app (Android or Windows) has been registered.  This gate controls whether
 * the Learning Engine's device-ingest and file-cleanup agent features are
 * available to the tenant.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppPlatform = 'android' | 'windows';

interface AppInstallation {
  platform: AppPlatform;
  deviceId: string;
  registeredAt: Date;
}

interface AppStatusRecord {
  androidInstalled: boolean;
  windowsInstalled: boolean;
}

// ---------------------------------------------------------------------------
// In-memory store (Phase 5: replace with Postgres)
// ---------------------------------------------------------------------------

const installationStore = new Map<string, AppInstallation[]>();

function getUserKey(userId: string, tenantId: string): string {
  return `${tenantId}:${userId}`;
}

function getInstallations(userId: string, tenantId: string): AppInstallation[] {
  return installationStore.get(getUserKey(userId, tenantId)) ?? [];
}

function getAppStatus(userId: string, tenantId: string): AppStatusRecord {
  const installations = getInstallations(userId, tenantId);
  return {
    androidInstalled: installations.some((i) => i.platform === 'android'),
    windowsInstalled: installations.some((i) => i.platform === 'windows'),
  };
}

// ---------------------------------------------------------------------------
// Static app metadata (placeholder until apps are published)
// ---------------------------------------------------------------------------

const ANDROID_META = {
  downloadUrl: 'https://play.google.com/store/apps/details?id=com.boss.aios',
  qrCodeUrl: 'https://static.boss.ai/qr/android.png',
  version: '0.0.0-placeholder',
  description: 'BOS for Android — available soon on Google Play',
};

const WINDOWS_META = {
  downloadUrl: 'https://apps.microsoft.com/store/detail/boss',
  version: '0.0.0-placeholder',
  description: 'BOS for Windows — available soon on the Microsoft Store',
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const registerBodySchema = {
  type: 'object',
  required: ['platform', 'deviceId'],
  properties: {
    platform: { type: 'string', enum: ['android', 'windows'] },
    deviceId: { type: 'string', minLength: 1, maxLength: 256 },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Route handler interfaces
// ---------------------------------------------------------------------------

interface RegisterBody {
  platform: AppPlatform;
  deviceId: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function appsRoutes(server: FastifyInstance) {
  /**
   * GET /api/apps/android
   * Return Android app download metadata.
   *
   * Example response:
   *   {
   *     "downloadUrl": "https://play.google.com/...",
   *     "qrCodeUrl": "https://static.boss.ai/qr/android.png",
   *     "version": "0.0.0-placeholder",
   *     "description": "..."
   *   }
   */
  server.get(
    '/android',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              downloadUrl: { type: 'string' },
              qrCodeUrl: { type: 'string' },
              version: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send(ANDROID_META);
    },
  );

  /**
   * GET /api/apps/windows
   * Return Windows app download metadata.
   *
   * Example response:
   *   {
   *     "downloadUrl": "https://apps.microsoft.com/...",
   *     "version": "0.0.0-placeholder",
   *     "description": "..."
   *   }
   */
  server.get(
    '/windows',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              downloadUrl: { type: 'string' },
              version: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send(WINDOWS_META);
    },
  );

  /**
   * GET /api/apps/status
   * Return app installation flags for the current user.
   *
   * `legacyKnowledgeEnabled` is true when at least one app is registered.
   * The Learning Engine checks this flag before enabling device-ingest and
   * file-cleanup agent features.
   *
   * Example response:
   *   { "androidInstalled": false, "windowsInstalled": true, "legacyKnowledgeEnabled": true }
   */
  server.get(
    '/status',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              androidInstalled: { type: 'boolean' },
              windowsInstalled: { type: 'boolean' },
              legacyKnowledgeEnabled: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const status = getAppStatus(userId, tenantId);

      return reply.status(200).send({
        ...status,
        legacyKnowledgeEnabled: status.androidInstalled || status.windowsInstalled,
      });
    },
  );

  /**
   * POST /api/apps/register
   * Register an app installation for the current user.
   * Idempotent — registering the same deviceId + platform twice is a no-op.
   *
   * Example request:
   *   POST /api/apps/register
   *   { "platform": "android", "deviceId": "a1b2c3d4" }
   *
   * Example response:
   *   { "platform": "android", "deviceId": "a1b2c3d4", "registeredAt": "2026-03-30T..." }
   */
  server.post<{ Body: RegisterBody }>(
    '/register',
    {
      schema: {
        body: registerBodySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              platform: { type: 'string' },
              deviceId: { type: 'string' },
              registeredAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterBody }>,
      reply: FastifyReply,
    ) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const storeKey = getUserKey(userId, tenantId);
      const { platform, deviceId } = request.body;

      if (!installationStore.has(storeKey)) {
        installationStore.set(storeKey, []);
      }

      const installations = installationStore.get(storeKey)!;
      const existing = installations.find(
        (i) => i.platform === platform && i.deviceId === deviceId,
      );

      if (existing) {
        request.log.info({ userId, platform, deviceId }, 'App registration already exists');
        return reply.status(200).send({
          ...existing,
          registeredAt: existing.registeredAt.toISOString(),
        });
      }

      const installation: AppInstallation = {
        platform,
        deviceId,
        registeredAt: new Date(),
      };
      installations.push(installation);

      request.log.info({ userId, platform, deviceId }, 'App installation registered');
      return reply.status(200).send({
        ...installation,
        registeredAt: installation.registeredAt.toISOString(),
      });
    },
  );
}
