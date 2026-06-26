/**
 * Backup routes — /api/backup/*
 *
 *   GET  /status          — current backup status (last run, next scheduled, size)
 *   POST /trigger         — initiate an immediate backup
 *   GET  /config          — retrieve backup configuration
 *   PUT  /config          — update backup configuration
 *
 * Phase 8: @boss/backup is a stub.  These routes track backup job state
 * in-memory.  Replace with the encrypted backup engine in Phase 8.
 *
 * Backup types: full | incremental
 * Backup status: idle | running | completed | failed
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BackupJobStatus = 'idle' | 'running' | 'completed' | 'failed';
type BackupType = 'full' | 'incremental';

interface BackupJob {
  id: string;
  tenantId: string;
  type: BackupType;
  status: BackupJobStatus;
  startedAt?: Date;
  completedAt?: Date;
  sizeBytes?: number;
  error?: string;
}

interface BackupConfig {
  tenantId: string;
  enabled: boolean;
  intervalMinutes: number;
  retentionDays: number;
  destination: 's3' | 'gcs' | 'local';
  destinationPath: string;
  encryptionEnabled: boolean;
  includeVoiceData: boolean;
  nextScheduledAt?: Date;
}

// ---------------------------------------------------------------------------
// In-memory state (Phase 8: replace with Postgres + S3/GCS)
// ---------------------------------------------------------------------------

const jobRegistry = new Map<string, BackupJob>();
const configRegistry = new Map<string, BackupConfig>();

function getOrCreateConfig(tenantId: string): BackupConfig {
  const existing = configRegistry.get(tenantId);
  if (existing) return existing;
  const config: BackupConfig = {
    tenantId,
    enabled: true,
    intervalMinutes: parseInt(process.env.BOSS_BACKUP_INTERVAL_MINUTES ?? '60', 10),
    retentionDays: parseInt(process.env.BOSS_BACKUP_RETENTION_DAYS ?? '30', 10),
    destination: 'local',
    destinationPath: process.env.BOSS_BACKUP_PATH ?? '/var/boss/backups',
    encryptionEnabled: true,
    includeVoiceData: false,
  };
  configRegistry.set(tenantId, config);
  return config;
}

function computeNextScheduled(config: BackupConfig): Date {
  const lastJob = Array.from(jobRegistry.values())
    .filter((j) => j.tenantId === config.tenantId && j.status === 'completed')
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];

  const base = lastJob?.completedAt ?? new Date();
  return new Date(base.getTime() + config.intervalMinutes * 60_000);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const backupJobResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string' },
    type: { type: 'string' },
    status: { type: 'string' },
    startedAt: { type: 'string' },
    completedAt: { type: 'string' },
    sizeBytes: { type: 'number' },
    error: { type: 'string' },
  },
} as const;

const backupConfigSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    intervalMinutes: { type: 'number' },
    retentionDays: { type: 'number' },
    destination: { type: 'string' },
    destinationPath: { type: 'string' },
    encryptionEnabled: { type: 'boolean' },
    includeVoiceData: { type: 'boolean' },
    nextScheduledAt: { type: 'string' },
  },
} as const;

const updateConfigBodySchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    intervalMinutes: { type: 'integer', minimum: 15, maximum: 10080 },
    retentionDays: { type: 'integer', minimum: 1, maximum: 365 },
    destination: { type: 'string', enum: ['s3', 'gcs', 'local'] },
    destinationPath: { type: 'string', minLength: 1 },
    encryptionEnabled: { type: 'boolean' },
    includeVoiceData: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

const triggerBodySchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['full', 'incremental'], default: 'incremental' },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Types for route generics
// ---------------------------------------------------------------------------

interface UpdateConfigBody {
  enabled?: boolean;
  intervalMinutes?: number;
  retentionDays?: number;
  destination?: 's3' | 'gcs' | 'local';
  destinationPath?: string;
  encryptionEnabled?: boolean;
  includeVoiceData?: boolean;
}

interface TriggerBody {
  type?: BackupType;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function backupRoutes(server: FastifyInstance) {
  /**
   * GET /api/backup/status
   * Return the current backup status for this tenant: last completed job,
   * any running job, and the next scheduled backup time.
   *
   * Example response:
   *   {
   *     "lastJob": { "id": "bkp-xxx", "type": "incremental", "status": "completed", ... },
   *     "runningJob": null,
   *     "nextScheduledAt": "2026-03-29T10:00:00.000Z"
   *   }
   */
  server.get(
    '/status',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              lastJob: { oneOf: [backupJobResponseSchema, { type: 'null' }] },
              runningJob: { oneOf: [backupJobResponseSchema, { type: 'null' }] },
              nextScheduledAt: { type: 'string' },
              totalJobs: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const tenantJobs = Array.from(jobRegistry.values())
        .filter((j) => j.tenantId === tenantId)
        .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));

      const runningJob = tenantJobs.find((j) => j.status === 'running') ?? null;
      const lastJob = tenantJobs.find((j) => j.status === 'completed' || j.status === 'failed') ?? null;

      const config = getOrCreateConfig(tenantId);
      const nextScheduledAt = config.enabled ? computeNextScheduled(config) : null;

      function serializeJob(job: BackupJob | null) {
        if (!job) return null;
        return {
          ...job,
          startedAt: job.startedAt?.toISOString(),
          completedAt: job.completedAt?.toISOString(),
        };
      }

      return reply.status(200).send({
        lastJob: serializeJob(lastJob),
        runningJob: serializeJob(runningJob),
        nextScheduledAt: nextScheduledAt?.toISOString() ?? null,
        totalJobs: tenantJobs.length,
      });
    },
  );

  /**
   * POST /api/backup/trigger
   * Trigger an immediate backup.  Returns the new job record.
   * Only one backup per tenant can run at a time.
   *
   * Body: { type: "full" | "incremental" }  (default: incremental)
   *
   * Example response:
   *   { "id": "bkp-xxx", "type": "incremental", "status": "running", "startedAt": "..." }
   */
  server.post<{ Body: TriggerBody }>(
    '/trigger',
    { schema: { body: triggerBodySchema } },
    async (request: FastifyRequest<{ Body: TriggerBody }>, reply: FastifyReply) => {
      const tenantId = request.tenant?.tenantId ?? 'default';

      // Prevent concurrent backups per tenant
      const running = Array.from(jobRegistry.values()).find(
        (j) => j.tenantId === tenantId && j.status === 'running',
      );
      if (running) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'A backup is already running for this tenant',
          runningJobId: running.id,
        });
      }

      const type: BackupType = request.body.type ?? 'incremental';
      const jobId = `bkp-${Date.now().toString(36)}`;
      const job: BackupJob = {
        id: jobId,
        tenantId,
        type,
        status: 'running',
        startedAt: new Date(),
      };
      jobRegistry.set(jobId, job);

      // Phase 8 stub: simulate async completion after 2 seconds
      setTimeout(() => {
        const j = jobRegistry.get(jobId);
        if (!j) return;
        j.status = 'completed';
        j.completedAt = new Date();
        j.sizeBytes = Math.floor(Math.random() * 50_000_000) + 1_000_000; // 1–50 MB stub
      }, 2_000);

      request.log.info({ tenantId, jobId, type }, 'Backup triggered');

      return reply.status(202).send({
        ...job,
        startedAt: job.startedAt?.toISOString(),
      });
    },
  );

  /**
   * GET /api/backup/config
   * Retrieve current backup configuration for this tenant.
   *
   * Example response:
   *   { "enabled": true, "intervalMinutes": 60, "retentionDays": 30, ... }
   */
  server.get(
    '/config',
    {
      schema: {
        response: { 200: backupConfigSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const config = getOrCreateConfig(tenantId);
      const nextScheduledAt = config.enabled ? computeNextScheduled(config) : undefined;

      return reply.status(200).send({
        ...config,
        nextScheduledAt: nextScheduledAt?.toISOString(),
      });
    },
  );

  /**
   * PUT /api/backup/config
   * Update backup configuration for this tenant.
   *
   * Example request:
   *   PUT /api/backup/config
   *   { "intervalMinutes": 120, "retentionDays": 90 }
   */
  server.put<{ Body: UpdateConfigBody }>(
    '/config',
    {
      schema: {
        body: updateConfigBodySchema,
        response: { 200: backupConfigSchema },
      },
    },
    async (request: FastifyRequest<{ Body: UpdateConfigBody }>, reply: FastifyReply) => {
      const tenantId = request.tenant?.tenantId ?? 'default';
      const existing = getOrCreateConfig(tenantId);
      const updated: BackupConfig = { ...existing, ...request.body };
      configRegistry.set(tenantId, updated);

      const nextScheduledAt = updated.enabled ? computeNextScheduled(updated) : undefined;

      request.log.info({ tenantId, userId: request.auth?.userId }, 'Backup config updated');

      return reply.status(200).send({
        ...updated,
        nextScheduledAt: nextScheduledAt?.toISOString(),
      });
    },
  );

  /**
   * GET /api/backup/state — vD.1.1
   * Live backup health from /var/lib/boss-backups/status.json.
   * Transforms the raw status into the BackupState shape the UI expects.
   */
  server.get(
    '/state',
    async (_request, reply) => {
      const fs = await import('node:fs/promises');
      const statusFile = process.env.BACKUP_STATUS_FILE ?? '/var/lib/boss-backups/status.json';

      let raw: Record<string, { last_attempt?: string; last_success?: string; size_bytes?: number; last_error?: string }>;
      try {
        const content = await fs.readFile(statusFile, 'utf-8');
        raw = JSON.parse(content);
      } catch {
        return reply.status(200).send({
          status: 'unknown',
          lastBackupAt: null,
          lastBackupSize: 0,
          nextScheduledAt: new Date(Date.now() + 3600_000).toISOString(),
          intervalMinutes: 1440,
          retentionDays: 15,
          destination: 'git',
          destinationStatus: { git: { healthy: false }, s3: { healthy: false } },
          history: [],
        });
      }

      // Find most recent successful backup across all assets
      const assets = Object.entries(raw).filter(([k, v]) => k !== '_written_at' && typeof v === 'object');
      let latestSuccess: string | null = null;
      let totalSize = 0;
      const history = [];

      for (const [name, data] of assets) {
        if (!data || typeof data !== 'object') continue;
        const d = data as { last_attempt?: string; last_success?: string; size_bytes?: number; last_error?: string };
        if (d.last_success && (!latestSuccess || d.last_success > latestSuccess)) {
          latestSuccess = d.last_success;
        }
        totalSize += d.size_bytes ?? 0;
        history.push({
          id: `${name}-latest`,
          status: d.last_error ? 'failed' : 'success',
          startedAt: d.last_attempt ?? new Date().toISOString(),
          completedAt: d.last_success ?? undefined,
          sizeBytes: d.size_bytes ?? 0,
          destination: 'git',
          asset: name,
          error: d.last_error || undefined,
        });
      }

      const allHealthy = assets.every(([, d]) => {
        const dd = d as { last_success?: string };
        return dd.last_success && (Date.now() - Date.parse(dd.last_success)) < 25 * 3600_000;
      });

      return reply.status(200).send({
        status: allHealthy ? 'idle' : 'degraded',
        lastBackupAt: latestSuccess,
        lastBackupSize: totalSize,
        nextScheduledAt: new Date(Date.now() + 3600_000).toISOString(), // next hourly
        intervalMinutes: 1440,
        retentionDays: 15,
        destination: 'git',
        destinationStatus: {
          git: { healthy: allHealthy, lastPushAt: latestSuccess },
          s3: { healthy: false },
        },
        history,
      });
    },
  );
}
