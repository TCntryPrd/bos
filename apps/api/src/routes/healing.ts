/**
 * Healing routes — /api/healing/*
 *
 *   GET  /status            — current health of all services (mirrors /health/full with healing context)
 *   GET  /incidents         — list recent incidents tracked by the healing engine
 *   GET  /incidents/:id     — get a single incident with full timeline
 *   POST /incidents/:id/resolve — manually mark an incident resolved
 *   GET  /playbooks         — list known remediation playbooks
 *   GET  /playbooks/:id     — get playbook detail
 *
 * Phase 6: @boss/healing is a stub.  Routes return meaningful in-memory
 * state to unblock client development.  Replace with real engine in Phase 6.
 *
 * Incident lifecycle: detected → triaging → mitigating → resolved | escalated
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceName =
  | 'brain'
  | 'postgres'
  | 'redis'
  | 'weaviate'
  | 'connector-microsoft'
  | 'connector-google'
  | 'voice'
  | 'backup';

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
type IncidentStatus = 'detected' | 'triaging' | 'mitigating' | 'resolved' | 'escalated';
type PlaybookSeverity = 'low' | 'medium' | 'high' | 'critical';

interface HealingIncident {
  id: string;
  service: ServiceName;
  status: IncidentStatus;
  severity: PlaybookSeverity;
  description: string;
  detectedAt: Date;
  resolvedAt?: Date;
  playbookId?: string;
  timeline: Array<{ timestamp: Date; event: string }>;
}

interface HealingPlaybook {
  id: string;
  service: ServiceName;
  severity: PlaybookSeverity;
  failureSignature: string;
  diagnosisSteps: string[];
  fixSteps: string[];
  verification: string;
  successCount: number;
  lastUsed?: Date;
}

// ---------------------------------------------------------------------------
// In-memory stores (Phase 6: replace with Postgres)
// ---------------------------------------------------------------------------

const incidents = new Map<string, HealingIncident>();
const playbooks = new Map<string, HealingPlaybook>();

// ── Playbook Library ──────────────────────────────────────────────────────────
// Known failure patterns with tested remediation steps.

const INITIAL_PLAYBOOKS: HealingPlaybook[] = [
  // ── Redis ──────────────────────────────────────────────────────────────────
  {
    id: 'pb-redis-oom',
    service: 'redis',
    severity: 'high',
    failureSignature: 'OOM command not allowed when used memory > maxmemory',
    diagnosisSteps: [
      'Run `docker exec boss_redis redis-cli INFO memory` — check used_memory vs maxmemory',
      'Check for large keys: `docker exec boss_redis redis-cli --bigkeys`',
      'Review connected clients: `docker exec boss_redis redis-cli CLIENT LIST`',
    ],
    fixSteps: [
      'Set eviction policy: `docker exec boss_redis redis-cli CONFIG SET maxmemory-policy allkeys-lru`',
      'Increase maxmemory if hardware allows',
      'Flush stale data if safe: `docker exec boss_redis redis-cli FLUSHDB`',
    ],
    verification: 'Run `docker exec boss_redis redis-cli INFO memory` — used_memory should drop below maxmemory',
    successCount: 0,
  },
  {
    id: 'pb-redis-connection-refused',
    service: 'redis',
    severity: 'critical',
    failureSignature: 'ECONNREFUSED 127.0.0.1:6379',
    diagnosisSteps: [
      'Check container: `docker ps -f name=boss_redis`',
      'Check logs: `docker logs boss_redis --tail 20`',
      'Check port binding: `docker exec boss_redis redis-cli PING`',
    ],
    fixSteps: [
      'Restart container: `docker restart boss_redis`',
      'If persistent: `docker rm -f boss_redis && docker compose up -d redis`',
      'Check disk space: `df -h /var/lib/docker`',
    ],
    verification: '`docker exec boss_redis redis-cli PING` returns PONG',
    successCount: 0,
  },

  // ── Postgres ───────────────────────────────────────────────────────────────
  {
    id: 'pb-postgres-connection-limit',
    service: 'postgres',
    severity: 'high',
    failureSignature: 'too many connections for role',
    diagnosisSteps: [
      'Check active connections: `docker exec boss_postgres psql -U boss -d boss_db -c "SELECT count(*) FROM pg_stat_activity;"`',
      'Find idle connections: `docker exec boss_postgres psql -U boss -d boss_db -c "SELECT pid, state, query_start FROM pg_stat_activity WHERE state = \'idle\';"`',
    ],
    fixSteps: [
      'Terminate idle connections: `docker exec boss_postgres psql -U boss -d boss_db -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = \'idle\' AND query_start < now() - interval \'10 minutes\';"`',
      'Increase max_connections in postgresql.conf if needed',
      'Restart API to reset pool: `docker restart boss_api`',
    ],
    verification: 'Connection count should be < 80% of max_connections',
    successCount: 0,
  },
  {
    id: 'pb-postgres-disk-full',
    service: 'postgres',
    severity: 'critical',
    failureSignature: 'could not extend file|No space left on device',
    diagnosisSteps: [
      'Check disk: `df -h /var/lib/docker`',
      'Check Postgres data size: `docker exec boss_postgres du -sh /var/lib/postgresql/data/`',
      'Check WAL size: `docker exec boss_postgres psql -U boss -d boss_db -c "SELECT pg_size_pretty(sum(size)) FROM pg_ls_waldir();"`',
    ],
    fixSteps: [
      'Clean WAL: `docker exec boss_postgres psql -U boss -d boss_db -c "CHECKPOINT;"`',
      'Vacuum: `docker exec boss_postgres psql -U boss -d boss_db -c "VACUUM FULL;"`',
      'Clean Docker: `docker system prune -f`',
      'If still full: expand disk or move Docker data directory',
    ],
    verification: '`df -h /var/lib/docker` shows > 20% free',
    successCount: 0,
  },

  // ── Brain / Anthropic API ──────────────────────────────────────────────────
  {
    id: 'pb-brain-auth-expired',
    service: 'brain',
    severity: 'high',
    failureSignature: 'Authentication not configured|401 Unauthorized',
    diagnosisSteps: [
      'Check if CLAUDE_API_KEY is set: `docker exec boss_api node -e "console.log(!!process.env.CLAUDE_API_KEY)"`',
      'Check runtime_config: `docker exec boss_postgres psql -U boss -d boss_db -c "SELECT key FROM runtime_config WHERE key = \'CLAUDE_API_KEY\'";`',
      'Test token directly: `curl -s https://api.anthropic.com/v1/messages -H "Authorization: Bearer <token>" -H "anthropic-version: 2023-06-01" -d \'{"model":"claude-haiku-4-5","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}\' | head -1`',
    ],
    fixSteps: [
      'Re-generate token: run `claude setup-token` on the server',
      'Save to runtime_config: INSERT INTO runtime_config (key, value, tenant_id) VALUES (\'CLAUDE_API_KEY\', \'<new-token>\', \'default\') ON CONFLICT (key, tenant_id) DO UPDATE SET value = EXCLUDED.value',
      'Restart API: `docker restart boss_api`',
    ],
    verification: 'Brain chat returns a response: `curl -s localhost:8005/api/brain/chat -X POST -H "Content-Type: application/json" -H "Authorization: Bearer <jwt>" -d \'{"message":"ping"}\' | python3 -c "import sys,json; print(json.load(sys.stdin).get(\'response\',\'FAIL\'))"',
    successCount: 0,
  },
  {
    id: 'pb-brain-rate-limited',
    service: 'brain',
    severity: 'medium',
    failureSignature: '429 Too Many Requests|rate_limit_error',
    diagnosisSteps: [
      'Check API logs for 429s: `docker logs boss_api --tail 50 | grep 429`',
      'Check if multiple users/sessions are hitting the brain simultaneously',
    ],
    fixSteps: [
      'Wait 60 seconds — Anthropic rate limits reset per minute',
      'Switch to a lower-traffic model (haiku-4-5 has higher limits)',
      'Add request queuing to the brain route if persistent',
    ],
    verification: 'Brain chat responds successfully after cool-down',
    successCount: 0,
  },

  // ── JWT / Auth ─────────────────────────────────────────────────────────────
  {
    id: 'pb-jwt-stale-token',
    service: 'brain',
    severity: 'medium',
    failureSignature: 'Missing or invalid Authorization header|jwt expired|invalid signature',
    diagnosisSteps: [
      'Check if BOSS_JWT_SECRET matches between container and .env',
      'Verify token expiry: decode JWT at jwt.io and check exp claim',
      'Check if container was rebuilt (new container = new secret if not in .env)',
    ],
    fixSteps: [
      'Client-side: clear localStorage (boss_token), re-login',
      'If secret changed: ensure BOSS_JWT_SECRET is in .env and matches runtime_config',
      'Restart API to reload config: `docker restart boss_api`',
    ],
    verification: 'Login returns a valid token and brain chat responds',
    successCount: 0,
  },

  // ── Google OAuth ───────────────────────────────────────────────────────────
  {
    id: 'pb-google-token-refresh-failed',
    service: 'connector-google',
    severity: 'high',
    failureSignature: 'invalid_grant|Token has been expired or revoked',
    diagnosisSteps: [
      'Check if refresh_token exists: `docker exec boss_postgres psql -U boss -d boss_db -c "SELECT email, refresh_token IS NOT NULL as has_refresh FROM boss_oauth_tokens WHERE provider = \'google\'";`',
      'Check token age — Google refresh tokens expire if unused for 6 months',
      'Check if the Google Cloud project is in testing mode (tokens expire after 7 days)',
    ],
    fixSteps: [
      'Re-authenticate: trigger OAuth flow from dashboard Connections panel',
      'If project is in testing mode: publish the OAuth consent screen in Google Cloud Console',
      'Delete stale token: `docker exec boss_postgres psql -U boss -d boss_db -c "DELETE FROM boss_oauth_tokens WHERE email = \'<email>\' AND provider = \'google\'";`',
    ],
    verification: 'Calendar tool returns events: ask BOS "What is on my calendar today?"',
    successCount: 0,
  },
  {
    id: 'pb-google-missing-scopes',
    service: 'connector-google',
    severity: 'medium',
    failureSignature: 'Insufficient Permission|403 Forbidden|Request had insufficient authentication scopes',
    diagnosisSteps: [
      'Check granted scopes: `docker exec boss_postgres psql -U boss -d boss_db -c "SELECT email, scopes FROM boss_oauth_tokens WHERE provider = \'google\'";`',
      'Compare with required scopes for the failing API (gmail.readonly for email, calendar for calendar, etc.)',
    ],
    fixSteps: [
      'Re-connect the Google account through the dashboard to request missing scopes',
      'Ensure the OAuth start request includes all needed services: mail, calendar, tasks, drive, contacts',
    ],
    verification: 'The previously failing API call succeeds through the brain tool',
    successCount: 0,
  },

  // ── Docker / Container ─────────────────────────────────────────────────────
  {
    id: 'pb-container-restart-loop',
    service: 'brain',
    severity: 'critical',
    failureSignature: 'container is restarting|Restarting (1)|Exit code 137',
    diagnosisSteps: [
      'Check container status: `docker ps -a --format "table {{.Names}}\t{{.Status}}" | grep boss`',
      'Check last logs before crash: `docker logs boss_api --tail 30`',
      'Exit 137 = OOM killed. Check: `dmesg | tail -20 | grep -i oom`',
    ],
    fixSteps: [
      'If OOM: increase container memory limit in docker-compose.yml',
      'If crash: fix the error in logs, rebuild, redeploy',
      'Nuclear: `docker compose down && docker compose up -d`',
    ],
    verification: '`docker ps -f name=boss_api` shows status "Up" with no restarts',
    successCount: 0,
  },

  // ── Weaviate ───────────────────────────────────────────────────────────────
  {
    id: 'pb-weaviate-unresponsive',
    service: 'weaviate',
    severity: 'high',
    failureSignature: 'ECONNREFUSED 8080|weaviate health check failed',
    diagnosisSteps: [
      'Check container: `docker ps -f name=boss_weaviate`',
      'Check health: `curl -s http://localhost:8080/v1/.well-known/ready`',
      'Check logs: `docker logs boss_weaviate --tail 20`',
    ],
    fixSteps: [
      'Restart: `docker restart boss_weaviate`',
      'If persistent: check disk space and memory',
      'Recreate: `docker rm -f boss_weaviate && docker compose up -d weaviate`',
    ],
    verification: '`curl -s http://localhost:8080/v1/.well-known/ready` returns 200',
    successCount: 0,
  },

  // ── BOS Gateway ─────────────────────────────────────────────────────────
  {
    id: 'pb-gateway-down',
    service: 'brain',
    severity: 'high',
    failureSignature: 'ECONNREFUSED 127.0.0.1:65138',
    diagnosisSteps: [
      'Check service: `systemctl --user status boss-gateway`',
      'Check port: `ss -tlnp | grep 65138`',
      'Check logs: `journalctl --user -u boss-gateway --since "5 min ago"`',
    ],
    fixSteps: [
      'Restart: `systemctl --user restart boss-gateway`',
      'If not found: `systemctl --user daemon-reload && systemctl --user start boss-gateway`',
      'Check env vars in service file: `systemctl --user cat boss-gateway`',
    ],
    verification: '`curl -s http://127.0.0.1:65138/health` returns {"status":"ok"}',
    successCount: 0,
  },

  // ── n8n ────────────────────────────────────────────────────────────────────
  {
    id: 'pb-n8n-unreachable',
    service: 'brain',
    severity: 'medium',
    failureSignature: 'ECONNREFUSED.*7749|n8n API returned non-2xx',
    diagnosisSteps: [
      'Check n8n container: `docker ps -f name=n8n`',
      'Test API: `curl -s http://localhost:7749/api/v1/workflows -H "X-N8N-API-KEY: $N8N_API_KEY" | head -1`',
      'Check logs: `docker logs n8n --tail 20`',
    ],
    fixSteps: [
      'Restart: `docker restart n8n`',
      'Verify API key is correct in runtime_config',
      'Check if n8n is in execution mode (busy processing) — wait and retry',
    ],
    verification: 'n8n workflow list returns successfully',
    successCount: 0,
  },

  // ── Voice/STT ──────────────────────────────────────────────────────────────
  {
    id: 'pb-stt-unhealthy',
    service: 'voice',
    severity: 'low',
    failureSignature: 'STT service health check failed|faster-whisper error',
    diagnosisSteps: [
      'Check container: `docker ps -f name=boss_stt`',
      'Check health: `docker exec boss_stt curl -s http://localhost:8000/health`',
      'Check GPU/CPU usage if model is loading',
    ],
    fixSteps: [
      'Restart: `docker restart boss_stt`',
      'If model download failed: remove and re-pull container image',
    ],
    verification: 'STT health endpoint returns 200',
    successCount: 0,
  },
];

for (const pb of INITIAL_PLAYBOOKS) {
  playbooks.set(pb.id, pb);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const incidentResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    service: { type: 'string' },
    status: { type: 'string' },
    severity: { type: 'string' },
    description: { type: 'string' },
    detectedAt: { type: 'string' },
    resolvedAt: { type: 'string' },
    playbookId: { type: 'string' },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          timestamp: { type: 'string' },
          event: { type: 'string' },
        },
      },
    },
  },
} as const;

const playbookResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    service: { type: 'string' },
    severity: { type: 'string' },
    failureSignature: { type: 'string' },
    diagnosisSteps: { type: 'array', items: { type: 'string' } },
    fixSteps: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
    successCount: { type: 'number' },
    lastUsed: { type: 'string' },
  },
} as const;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function healingRoutes(server: FastifyInstance) {
  /**
   * GET /api/healing/status
   * Summarised health status of all monitored services plus active incident count.
   *
   * Example response:
   *   { "overall": "healthy", "activeIncidents": 0, "services": [...] }
   */
  server.get(
    '/status',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              overall: { type: 'string' },
              activeIncidents: { type: 'number' },
              services: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    service: { type: 'string' },
                    status: { type: 'string' },
                    checkedAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const serviceNames: ServiceName[] = [
        'brain', 'postgres', 'redis', 'weaviate',
        'connector-microsoft', 'connector-google', 'voice', 'backup',
      ];

      const activeIncidents = Array.from(incidents.values()).filter(
        (i) => i.status !== 'resolved',
      );

      const serviceStatuses = serviceNames.map((name) => {
        const incident = activeIncidents.find((i) => i.service === name);
        const status: HealthStatus = incident
          ? incident.severity === 'critical' || incident.severity === 'high'
            ? 'unhealthy'
            : 'degraded'
          : 'unknown'; // unknown until real health checks are wired
        return { service: name, status, checkedAt: new Date().toISOString() };
      });

      const overall: HealthStatus =
        activeIncidents.some((i) => i.severity === 'critical' || i.severity === 'high')
          ? 'unhealthy'
          : activeIncidents.length > 0
          ? 'degraded'
          : 'unknown';

      return reply.status(200).send({
        overall,
        activeIncidents: activeIncidents.length,
        services: serviceStatuses,
      });
    },
  );

  /**
   * GET /api/healing/incidents
   * List incidents, newest first.
   *
   * Query params: service, status, limit (default 50)
   */
  server.get(
    '/incidents',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            service: { type: 'string' },
            status: { type: 'string', enum: ['detected', 'triaging', 'mitigating', 'resolved', 'escalated'] },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: {
          200: {
            type: 'array',
            items: incidentResponseSchema,
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as { service?: string; status?: string; limit?: number };
      let list = Array.from(incidents.values());

      if (qs.service) list = list.filter((i) => i.service === qs.service);
      if (qs.status) list = list.filter((i) => i.status === qs.status);

      list.sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
      list = list.slice(0, qs.limit ?? 50);

      return reply.status(200).send(
        list.map((i) => ({
          ...i,
          detectedAt: i.detectedAt.toISOString(),
          resolvedAt: i.resolvedAt?.toISOString(),
          timeline: i.timeline.map((t) => ({
            timestamp: t.timestamp.toISOString(),
            event: t.event,
          })),
        })),
      );
    },
  );

  /**
   * GET /api/healing/incidents/:id
   * Get a single incident with full timeline.
   */
  server.get<{ Params: { id: string } }>(
    '/incidents/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: incidentResponseSchema },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const incident = incidents.get(request.params.id);
      if (!incident) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Incident '${request.params.id}' not found`,
        });
      }
      return reply.status(200).send({
        ...incident,
        detectedAt: incident.detectedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString(),
        timeline: incident.timeline.map((t) => ({
          timestamp: t.timestamp.toISOString(),
          event: t.event,
        })),
      });
    },
  );

  /**
   * POST /api/healing/incidents/:id/resolve
   * Manually mark an incident as resolved with an optional note.
   *
   * Example request:
   *   POST /api/healing/incidents/inc-xxx/resolve
   *   { "note": "Manually restarted Redis pod" }
   */
  server.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/incidents/:id/resolve',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: { note: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { note?: string } }>,
      reply: FastifyReply,
    ) => {
      const incident = incidents.get(request.params.id);
      if (!incident) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Incident '${request.params.id}' not found`,
        });
      }

      if (incident.status === 'resolved') {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Incident is already resolved',
        });
      }

      incident.status = 'resolved';
      incident.resolvedAt = new Date();
      incident.timeline.push({
        timestamp: new Date(),
        event: `Manually resolved by ${request.auth?.userId ?? 'unknown'}${request.body.note ? `: ${request.body.note}` : ''}`,
      });

      request.log.info({ incidentId: incident.id, userId: request.auth?.userId }, 'Incident resolved');
      return reply.status(200).send({
        ...incident,
        detectedAt: incident.detectedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString(),
        timeline: incident.timeline.map((t) => ({
          timestamp: t.timestamp.toISOString(),
          event: t.event,
        })),
      });
    },
  );

  /**
   * GET /api/healing/playbooks
   * List all known remediation playbooks.
   *
   * Example response:
   *   [{ "id": "pb-redis-oom", "service": "redis", "severity": "high", "failureSignature": "..." }]
   */
  server.get(
    '/playbooks',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: playbookResponseSchema,
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const list = Array.from(playbooks.values()).map((p) => ({
        ...p,
        lastUsed: p.lastUsed?.toISOString(),
      }));
      return reply.status(200).send(list);
    },
  );

  /**
   * GET /api/healing/playbooks/:id
   * Get a playbook's full step-by-step remediation guide.
   */
  server.get<{ Params: { id: string } }>(
    '/playbooks/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: playbookResponseSchema },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const playbook = playbooks.get(request.params.id);
      if (!playbook) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Playbook '${request.params.id}' not found`,
        });
      }
      return reply.status(200).send({ ...playbook, lastUsed: playbook.lastUsed?.toISOString() });
    },
  );
}

// Export factory for test injection
export { incidents as _incidentStore, playbooks as _playbookStore };
