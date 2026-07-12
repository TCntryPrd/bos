/**
 * Integration tests — health HTTP routes.
 * Mirrors kanban.test.ts / coo/threads.test.ts: scratch DB per run, replays
 * migration 036. Skipped if Postgres is unreachable. Set
 * TEST_PG_PASSWORD=<prod-password> to run against a password-protected
 * instance (the ambient shell typically has no PGPASSWORD/credentials).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../server.js';
import { closeDb } from '../db.js';
import type { FastifyInstance } from 'fastify';

const { Client, Pool } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASS = process.env.TEST_PG_PASSWORD ?? '';
const PG_AUTH = PG_PASS ? `${PG_USER}:${encodeURIComponent(PG_PASS)}` : PG_USER;
const ADMIN_URL = `postgresql://${PG_AUTH}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_health_${process.pid}`;
const SCRATCH_URL = `postgresql://${PG_AUTH}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
const TENANT = 'test-tenant';
const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': TENANT } as const;

const MIGRATIONS_DIR = resolve(__dirname, '../../../../services/postgres/migrations');

let server: FastifyInstance | null = null;
let reachable = false;

async function pgOk(): Promise<boolean> {
  const c = new Client({ connectionString: ADMIN_URL });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

beforeAll(async () => {
  reachable = await pgOk();
  if (!reachable) {
    console.warn(`[health routes.test] Postgres unreachable at ${ADMIN_URL} — suite skipped.`);
    return;
  }
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  const scratch = new Client({ connectionString: SCRATCH_URL });
  await scratch.connect();
  await scratch.query(`
    CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
  `);
  await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, '036_health_data.sql'), 'utf-8'));
  await scratch.end();

  process.env.POSTGRES_URL = SCRATCH_URL;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = TENANT;
  process.env.BOSS_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  // Without an API key the auth middleware fails closed with 503; setting one
  // makes "wrong token" deterministically 403 (device tokens are not JWTs).
  process.env.BOSS_API_KEY = 'test-api-key';
  delete process.env.REDIS_URL; // events are a silent no-op in tests
  server = await buildServer();
});

afterAll(async () => {
  if (server) await server.close();
  await closeDb();
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SCRATCH_DB]);
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
});

beforeEach(async () => {
  if (!reachable) return;
  const pool = new Pool({ connectionString: SCRATCH_URL });
  await pool.query('DELETE FROM health_sync_state');
  await pool.query('DELETE FROM health_daily');
  await pool.query('DELETE FROM health_records');
  await pool.query('DELETE FROM health_pairing_codes');
  await pool.query('DELETE FROM health_devices');
  await pool.end();
});

/** Mint a device + pairing code, pair it, return {deviceId, token}. */
async function pairedDevice(): Promise<{ deviceId: string; token: string }> {
  const mint = await server!.inject({
    method: 'POST', url: '/api/health/devices', headers: H,
    payload: { name: 'Fold6', platform: 'android' },
  });
  expect(mint.statusCode).toBe(201);
  const { device_id, pairing_code } = mint.json();
  const pair = await server!.inject({
    method: 'POST', url: '/api/health/devices/pair',
    payload: { code: pairing_code },
  });
  expect(pair.statusCode).toBe(200);
  const { device_token } = pair.json();
  return { deviceId: device_id, token: device_token };
}

describe('device pairing lifecycle', () => {
  it('mints a device with a one-time pairing code and pairs it', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(token).toMatch(/^vhd_[0-9a-f]{64}$/);

    // Code is one-time: pairing again with any code for this device fails
    const list = await server!.inject({ method: 'GET', url: '/api/health/devices', headers: H });
    expect(list.statusCode).toBe(200);
    const devices = list.json().devices;
    expect(devices).toHaveLength(1);
    expect(devices[0].paired_at).toBeTruthy();
    expect(devices[0].token_hash).toBeUndefined(); // never exposed
  });

  it('rejects pairing with a bad or reused code', async () => {
    if (!reachable) return;
    const bad = await server!.inject({
      method: 'POST', url: '/api/health/devices/pair', payload: { code: 'WRONGCOD' },
    });
    expect(bad.statusCode).toBe(401);

    const mint = await server!.inject({
      method: 'POST', url: '/api/health/devices', headers: H,
      payload: { name: 'Fold6', platform: 'android' },
    });
    const { pairing_code } = mint.json();
    await server!.inject({ method: 'POST', url: '/api/health/devices/pair', payload: { code: pairing_code } });
    const reuse = await server!.inject({
      method: 'POST', url: '/api/health/devices/pair', payload: { code: pairing_code },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('revokes a device so its token stops working', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    const del = await server!.inject({
      method: 'DELETE', url: `/api/health/devices/${deviceId}`, headers: H,
    });
    expect(del.statusCode).toBe(200);
    const ingest = await server!.inject({
      method: 'POST', url: '/api/health/ingest',
      headers: { authorization: `Bearer ${token}` },
      payload: { schema: 1, device_id: deviceId, records: [] },
    });
    expect(ingest.statusCode).toBe(401);
  });

  it('rejects device tokens on JWT-protected read endpoints', async () => {
    if (!reachable) return;
    const { token } = await pairedDevice();
    // /devices is JWT-protected (no skipAuth); a device token (vhd_...) is
    // not a valid JWT or API key, so the global auth middleware rejects it
    // with 403 before the route handler ever runs.
    const res = await server!.inject({
      method: 'GET', url: '/api/health/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

function steps(uid: string, day: string, count: number) {
  return {
    uid, type: 'Steps', start: `${day}T08:00:00-04:00`, end: `${day}T09:00:00-04:00`,
    source_app: 'com.sec.android.app.shealth', payload: { count },
  };
}

async function postIngest(token: string, deviceId: string, records: unknown[]) {
  return server!.inject({
    method: 'POST', url: '/api/health/ingest',
    headers: { authorization: `Bearer ${token}` },
    payload: { schema: 1, device_id: deviceId, records },
  });
}

describe('ingest', () => {
  it('accepts a batch and is idempotent on re-send', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    const batch = [steps('s1', '2026-07-01', 4000), steps('s2', '2026-07-01', 7432)];

    const first = await postIngest(token, deviceId, batch);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 2, duplicates: 0, deleted: 0, errors: [] });

    const second = await postIngest(token, deviceId, batch);
    expect(second.json()).toMatchObject({ accepted: 0, duplicates: 2 });
  });

  it('rolls up affected days and updates them when records change', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    await postIngest(token, deviceId, [steps('s1', '2026-07-01', 4000)]);

    const pool = new Pool({ connectionString: SCRATCH_URL });
    let { rows } = await pool.query(
      `SELECT value FROM health_daily WHERE metric = 'steps' AND day = '2026-07-01'`);
    expect(Number(rows[0].value)).toBe(4000);

    // Updated record (same uid, new count) → rollup recomputes
    await postIngest(token, deviceId, [steps('s1', '2026-07-01', 4500)]);
    ({ rows } = await pool.query(
      `SELECT value FROM health_daily WHERE metric = 'steps' AND day = '2026-07-01'`));
    expect(Number(rows[0].value)).toBe(4500);
    await pool.end();
  });

  it('handles deletions by recomputing the day', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    await postIngest(token, deviceId, [steps('s1', '2026-07-01', 4000), steps('s2', '2026-07-01', 1000)]);
    const del = await postIngest(token, deviceId, [
      { uid: 's2', type: 'Steps', start: '2026-07-01T08:00:00-04:00', deleted: true, payload: {} },
    ]);
    expect(del.json()).toMatchObject({ deleted: 1 });

    const pool = new Pool({ connectionString: SCRATCH_URL });
    const { rows } = await pool.query(
      `SELECT value FROM health_daily WHERE metric = 'steps' AND day = '2026-07-01'`);
    expect(Number(rows[0].value)).toBe(4000);
    await pool.end();
  });

  it('recomputes the stored day when a tombstone attributes to a different day', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    // Sleep crossing midnight → attributed to the wake day 2026-07-01.
    await postIngest(token, deviceId, [{
      uid: 'sleep1', type: 'SleepSession',
      start: '2026-06-30T23:00:00-04:00', end: '2026-07-01T06:00:00-04:00',
      payload: { stages: [
        { stage: 'light', start: '2026-06-30T23:00:00-04:00', end: '2026-07-01T06:00:00-04:00' },
      ] },
    }]);

    const pool = new Pool({ connectionString: SCRATCH_URL });
    let { rows } = await pool.query(
      `SELECT value FROM health_daily WHERE metric = 'sleep_minutes' AND day = '2026-07-01'`);
    expect(Number(rows[0].value)).toBe(420);

    // The HC change feed reports deletions by UID: the tombstone omits `end`,
    // so its own timestamps attribute to 2026-06-30 — but the stored row's
    // wake-day rollup (2026-07-01) is what must be recomputed.
    const del = await postIngest(token, deviceId, [
      { uid: 'sleep1', type: 'SleepSession', start: '2026-06-30T23:00:00-04:00', deleted: true },
    ]);
    expect(del.json()).toMatchObject({ deleted: 1 });

    ({ rows } = await pool.query(
      `SELECT value FROM health_daily WHERE metric = 'sleep_minutes' AND day = '2026-07-01'`));
    expect(rows).toHaveLength(0);
    await pool.end();
  });

  it('does not lose contributions when concurrent ingests touch the same day', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    const counts = [1000, 2000, 3000, 4000, 5000];
    const responses = await Promise.all(counts.map(
      (count, i) => postIngest(token, deviceId, [steps(`c${i}`, '2026-07-01', count)])));
    for (const res of responses) expect(res.statusCode).toBe(200);

    // Without per-(user, day) serialization one transaction's stale recompute
    // can clobber another's committed rollup (or trip the unique constraint).
    const pool = new Pool({ connectionString: SCRATCH_URL });
    const { rows } = await pool.query(
      `SELECT value FROM health_daily WHERE metric = 'steps' AND day = '2026-07-01'`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].value)).toBe(15000);
    await pool.end();
  });

  it('reports per-record errors without failing the batch', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    const res = await postIngest(token, deviceId, [
      steps('ok1', '2026-07-01', 100),
      { uid: 'bad1', type: 'NotAType', start: '2026-07-01T08:00:00-04:00', payload: {} },
      { uid: '', type: 'Steps', start: '2026-07-01T08:00:00-04:00', payload: { count: 5 } },
    ]);
    const body = res.json();
    expect(body.accepted).toBe(1);
    expect(body.errors).toHaveLength(2);
  });

  it('updates sync state and device last_seen', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    await postIngest(token, deviceId, [steps('s1', '2026-07-01', 4000)]);
    const pool = new Pool({ connectionString: SCRATCH_URL });
    const state = await pool.query(
      `SELECT records_total FROM health_sync_state WHERE device_id = $1 AND record_type = 'Steps'`,
      [deviceId]);
    expect(Number(state.rows[0].records_total)).toBe(1);
    const dev = await pool.query(
      `SELECT last_seen_at FROM health_devices WHERE id = $1`, [deviceId]);
    expect(dev.rows[0].last_seen_at).toBeTruthy();
    await pool.end();
  });

  it('rejects oversized batches and schema mismatches', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    const tooBig = Array.from({ length: 1001 }, (_, i) => steps(`u${i}`, '2026-07-01', 1));
    expect((await postIngest(token, deviceId, tooBig)).statusCode).toBe(400);
    const wrongSchema = await server!.inject({
      method: 'POST', url: '/api/health/ingest',
      headers: { authorization: `Bearer ${token}` },
      payload: { schema: 2, device_id: deviceId, records: [] },
    });
    expect(wrongSchema.statusCode).toBe(400);
  });
});

describe('read endpoints', () => {
  async function seedWeek(token: string, deviceId: string) {
    const days = ['2026-06-25', '2026-06-26', '2026-06-27', '2026-06-28',
                  '2026-06-29', '2026-06-30', '2026-07-01'];
    const records = days.flatMap((day, i) => ([
      steps(`st-${day}`, day, 8000 + i * 500),
      { uid: `rhr-${day}`, type: 'RestingHeartRate',
        start: `${day}T06:00:00-04:00`, payload: { bpm: 60 - i } },
    ]));
    records.push({
      uid: 'sleep-0701', type: 'SleepSession',
      start: '2026-06-30T23:38:00-04:00', end: '2026-07-01T06:32:00-04:00',
      payload: { stages: [
        { stage: 'light', start: '2026-06-30T23:38:00-04:00', end: '2026-07-01T05:00:00-04:00' },
        { stage: 'deep', start: '2026-07-01T05:00:00-04:00', end: '2026-07-01T06:32:00-04:00' },
      ] },
    } as never);
    await postIngest(token, deviceId, records);
  }

  it('overview returns today metrics and 7-day sparklines', async () => {
    if (!reachable) return;
    process.env.VASARI_HEALTH_TODAY_OVERRIDE = '2026-07-01';
    const { deviceId, token } = await pairedDevice();
    await seedWeek(token, deviceId);
    const res = await server!.inject({ method: 'GET', url: '/api/health/overview', headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paired).toBe(true);
    expect(body.today.steps).toBe(11000);
    expect(body.spark.steps).toHaveLength(7);
    expect(body.spark.steps[6]).toBe(11000);
    expect(body.today.sleep_minutes).toBeGreaterThan(300);
    delete process.env.VASARI_HEALTH_TODAY_OVERRIDE;
  });

  it('daily returns a filtered metric range', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    await seedWeek(token, deviceId);
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/daily?metrics=steps&from=2026-06-29&to=2026-07-01', headers: H,
    });
    const days = res.json().days;
    expect(days).toHaveLength(3);
    expect(days.every((d: { metric: string }) => d.metric === 'steps')).toBe(true);
  });

  it('records returns raw drill-down rows', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    await seedWeek(token, deviceId);
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/records?type=SleepSession&from=2026-07-01&to=2026-07-01', headers: H,
    });
    expect(res.json().records).toHaveLength(1);
  });

  it('summary and brief work on a seeded day', async () => {
    if (!reachable) return;
    process.env.VASARI_HEALTH_TODAY_OVERRIDE = '2026-07-01';
    const { deviceId, token } = await pairedDevice();
    await seedWeek(token, deviceId);
    const sum = await server!.inject({
      method: 'GET', url: '/api/health/summary?date=2026-07-01', headers: H,
    });
    expect(sum.json().metrics.steps.value).toBe(11000);
    const brief = await server!.inject({
      method: 'GET', url: '/api/health/brief?days=7', headers: H,
    });
    expect(brief.json().brief).toContain('steps');
    delete process.env.VASARI_HEALTH_TODAY_OVERRIDE;
  });

  it('overview reports unpaired state when no devices exist', async () => {
    if (!reachable) return;
    const res = await server!.inject({ method: 'GET', url: '/api/health/overview', headers: H });
    expect(res.json().paired).toBe(false);
  });

  it('records rejects a negative limit with a 400 instead of a raw SQL error', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/records?type=Steps&from=2026-07-01&to=2026-07-01&limit=-5',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('records rejects a non-numeric limit with a 400', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/records?type=Steps&from=2026-07-01&to=2026-07-01&limit=abc',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('records rejects an unknown record type with a 400', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/records?type=NotAType&from=2026-07-01&to=2026-07-01',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('records rejects a malformed date with a 400 instead of a raw SQL error', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/records?type=Steps&from=not-a-date&to=2026-07-01',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('daily rejects a malformed date with a 400 instead of a raw SQL error', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/daily?from=not-a-date&to=2026-07-01',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('daily rejects a calendar-invalid date (e.g. Feb 30) with a 400 instead of a raw SQL error', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/daily?from=2026-02-30&to=2026-02-30',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('records rejects a calendar-invalid date (e.g. Apr 31) with a 400 instead of a raw SQL error', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/health/records?type=Steps&from=2026-04-31&to=2026-04-31',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('summary rejects an empty-string date with a 400', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET', url: '/api/health/summary?date=', headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('summary rejects a malformed date with a 400 instead of a raw SQL error', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET', url: '/api/health/summary?date=not-a-date', headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('summary rejects a calendar-invalid date (e.g. Feb 30) with a 400 instead of a raw SQL error', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET', url: '/api/health/summary?date=2026-02-30', headers: H,
    });
    expect(res.statusCode).toBe(400);
  });
});

function jwtFor(role: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = enc({ alg: 'HS256', typ: 'JWT' });
  const p = enc({ sub: `${role}-user`, role, tenantId: TENANT,
    exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac('sha256', 'test-jwt-secret').update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

describe('owner-role guard', () => {
  const READS = ['/api/health/overview', '/api/health/daily?from=2026-07-01&to=2026-07-01',
    '/api/health/records?type=Steps&from=2026-07-01&to=2026-07-01',
    '/api/health/summary', '/api/health/brief', '/api/health/devices'];

  it('rejects guest JWTs on every read/devices endpoint', async () => {
    if (!reachable) return;
    for (const url of READS) {
      const res = await server!.inject({
        method: 'GET', url, headers: { authorization: `Bearer ${jwtFor('guest')}` },
      });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toBe('health data is owner-only');
    }
  });

  it('allows owner JWTs and internal calls', async () => {
    if (!reachable) return;
    const owner = await server!.inject({
      method: 'GET', url: '/api/health/overview',
      headers: { authorization: `Bearer ${jwtFor('owner')}` },
    });
    expect(owner.statusCode).toBe(200);
    const internal = await server!.inject({
      method: 'GET', url: '/api/health/overview', headers: H,
    });
    expect(internal.statusCode).toBe(200);
  });

  it('still pairs and ingests with device tokens (no role involved)', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    const res = await postIngest(token, deviceId, [steps('g1', '2026-07-01', 10)]);
    expect(res.statusCode).toBe(200);
  });
});

describe('devices sync state', () => {
  it('returns per-type sync freshness for each device', async () => {
    if (!reachable) return;
    const { deviceId, token } = await pairedDevice();
    await postIngest(token, deviceId, [steps('ss1', '2026-07-01', 500)]);
    const res = await server!.inject({ method: 'GET', url: '/api/health/devices', headers: H });
    const dev = res.json().devices.find((d: { id: string }) => d.id === deviceId);
    expect(dev.sync_state).toHaveLength(1);
    expect(dev.sync_state[0]).toMatchObject({ record_type: 'Steps', records_total: 1 });
    expect(dev.sync_state[0].last_record_ts).toBeTruthy();
  });
});
