/**
 * Health data routes — /api/health/*  (spec 2026-07-01-health-connect-bridge-design)
 * HTTP layer ONLY: parsing, auth glue, status codes. Logic lives in service.ts.
 * /devices/pair and /ingest use device tokens (skipAuth); everything else uses JWT.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';
import type { DeviceRow } from './types.js';
import { RECORD_TYPES } from './types.js';
import {
  authenticateDevice, briefText, healthToday, ingest, mintDevice, overview, pairDevice, summary,
} from './service.js';
import { dailyRange, listDevicesWithSync, recordsRange, revokeDevice } from './repo.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_SET = new Set<string>(RECORD_TYPES);

function tenantOf(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

const OWNER_ROLES = new Set(['admin', 'owner']);

/** Health data is personal: JWT holders below admin/owner (e.g. guest tokens) get 403. */
function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (OWNER_ROLES.has(req.auth?.role ?? '')) return true;
  void reply.code(403).send({ error: 'health data is owner-only' });
  return false;
}

/**
 * True for a well-formed, calendar-valid YYYY-MM-DD string.
 * Date.parse silently normalizes overflow (e.g. '2026-02-30' -> Mar 2), so we
 * round-trip the parsed UTC components back to strings and compare — this
 * rejects anything Postgres's ::date cast would also reject.
 */
function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  const roundTripped = `${d.getUTCFullYear().toString().padStart(4, '0')}-${
    (d.getUTCMonth() + 1).toString().padStart(2, '0')}-${
    d.getUTCDate().toString().padStart(2, '0')}`;
  return roundTripped === s;
}

/** Parses a positive integer query param, clamped to [1, max]. Returns null if malformed. */
function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined) return Math.min(fallback, max);
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, max);
}

async function deviceFromAuthHeader(req: FastifyRequest): Promise<DeviceRow | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return authenticateDevice(getPool(), header.slice(7));
}

export default async function healthDataRoutes(app: FastifyInstance): Promise<void> {
  // -------- POST /api/health/devices — mint device + pairing code (JWT) --------
  app.post('/devices', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    const body = req.body as { name?: string; platform?: string };
    if (!body?.name || !['android', 'ios'].includes(body.platform ?? '')) {
      return reply.code(400).send({ error: "name and platform ('android'|'ios') are required" });
    }
    const minted = await mintDevice(getPool(), {
      tenantId: tenantOf(req),
      userId: req.auth?.userId ?? 'unknown',
      name: body.name,
      platform: body.platform as string,
    });
    return reply.code(201).send(minted);
  });

  // -------- GET /api/health/devices (JWT) --------
  app.get('/devices', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    const devices = await listDevicesWithSync(getPool(), tenantOf(req));
    return { devices };
  });

  // -------- DELETE /api/health/devices/:id — revoke (JWT) --------
  app.delete('/devices/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const ok = await revokeDevice(getPool(), tenantOf(req), id);
    if (!ok) return reply.code(404).send({ error: 'device not found or already revoked' });
    return { ok: true };
  });

  // -------- POST /api/health/devices/pair — code → token (no JWT) --------
  app.post('/devices/pair', { config: { skipAuth: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { code?: string };
      if (!body?.code) return reply.code(400).send({ error: 'code is required' });
      const paired = await pairDevice(getPool(), body.code);
      if (!paired) return reply.code(401).send({ error: 'invalid or expired pairing code' });
      return paired;
    });

  // -------- POST /api/health/ingest — device-token auth (no JWT) --------
  app.post('/ingest', { config: { skipAuth: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const device = await deviceFromAuthHeader(req);
      if (!device) return reply.code(401).send({ error: 'invalid device token' });
      try {
        return await ingest(getPool(), device, req.body);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 400) return reply.code(400).send({ error: (err as Error).message });
        throw err;
      }
    });

  // -------- Read endpoints (JWT) --------
  app.get('/overview', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    return overview(getPool(), tenantOf(req));
  });

  app.get('/daily', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    const q = req.query as { metrics?: string; from?: string; to?: string };
    if (!q.from || !q.to) return reply.code(400).send({ error: 'from and to are required (YYYY-MM-DD)' });
    if (!isValidDate(q.from) || !isValidDate(q.to)) {
      return reply.code(400).send({ error: 'from and to must be valid dates (YYYY-MM-DD)' });
    }
    const metrics = q.metrics ? q.metrics.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const days = await dailyRange(getPool(), tenantOf(req), { from: q.from, to: q.to, metrics });
    return { days };
  });

  app.get('/records', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    const q = req.query as { type?: string; from?: string; to?: string; limit?: string };
    if (!q.type || !q.from || !q.to) {
      return reply.code(400).send({ error: 'type, from, and to are required' });
    }
    if (!TYPE_SET.has(q.type)) {
      return reply.code(400).send({ error: `unknown type '${q.type}'` });
    }
    if (!isValidDate(q.from) || !isValidDate(q.to)) {
      return reply.code(400).send({ error: 'from and to must be valid dates (YYYY-MM-DD)' });
    }
    const limit = parsePositiveInt(q.limit, 100, 1000);
    if (limit === null) {
      return reply.code(400).send({ error: 'limit must be a positive integer' });
    }
    const records = await recordsRange(getPool(), tenantOf(req), {
      type: q.type, from: q.from, to: q.to, limit,
    });
    return { records };
  });

  app.get('/summary', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    const q = req.query as { date?: string };
    if (q.date !== undefined && !isValidDate(q.date)) {
      return reply.code(400).send({ error: 'date must be a valid date (YYYY-MM-DD)' });
    }
    return summary(getPool(), tenantOf(req), q.date || healthToday());
  });

  app.get('/brief', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireOwner(req, reply)) return reply;
    const q = req.query as { days?: string };
    const windowDays = Math.min(Math.max(Number(q.days ?? 7) || 7, 1), 90);
    return briefText(getPool(), tenantOf(req), windowDays);
  });
}
