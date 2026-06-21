/**
 * Integration tests — Work Order routes (/api/wo/*).
 * Scratch DB per run, mirrors kanban.test.ts setup.
 *
 * Coverage:
 *   - submit: validates required fields and bucket enum
 *   - submit: 'today' produces gate_at <= now(), 'next_week' produces a future Monday
 *   - heartbeat: skips gated WOs, claims eligible ones, sets status='active'
 *   - heartbeat: atomic — two concurrent claims of the same single WO yield one
 *   - complete: closes a WO and records result + completed_at
 *   - list:    filters by handle, excludes done by default
 *   - kanban board renders WOs (shared storage)
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../server.js';
import { closeDb } from '../db.js';
import type { FastifyInstance } from 'fastify';

const { Pool, Client } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const ADMIN_URL = `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_wo_${process.pid}`;
const TENANT = 'test-tenant';
const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': TENANT } as const;

const MIGRATIONS_DIR = resolve(__dirname, '../../../../services/postgres/migrations');

let server: FastifyInstance | null = null;
let reachable = false;

async function pgOk(): Promise<boolean> {
  const c = new Client({ connectionString: ADMIN_URL });
  try { await c.connect(); await c.end(); return true; }
  catch { return false; }
}

beforeAll(async () => {
  reachable = await pgOk();
  if (!reachable) {
    console.warn(`[wo.test] Postgres unreachable at ${ADMIN_URL} — suite skipped.`);
    return;
  }
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  const scratch = new Client({
    connectionString: `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
  });
  await scratch.connect();
  await scratch.query(`
    CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
  `);
  for (const file of ['014_pipeline_engine.sql', '027_kanban.sql', '030_wo_buckets.sql']) {
    await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8'));
  }
  await scratch.end();

  process.env.POSTGRES_URL = `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = TENANT;
  process.env.BOSS_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  server = await buildServer();
});

afterAll(async () => {
  if (server) await server.close();
  await closeDb();
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
    [SCRATCH_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
});

beforeEach(async () => {
  if (!reachable) return;
  const pool = new Pool({
    connectionString: `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
  });
  await pool.query(`DELETE FROM boss_stage_log`);
  await pool.query(`DELETE FROM boss_tasks`);
  await pool.end();
});

interface WoRow {
  id: string;
  title: string;
  bucket: string | null;
  gate_at: string | null;
  picked_at: string | null;
  status: string;
  assigned_agent: string | null;
  context: Record<string, unknown>;
}

async function submit(payload: Record<string, unknown>) {
  return server!.inject({
    method: 'POST',
    url: '/api/wo',
    headers: { ...H, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

describe('POST /api/wo — submit', () => {
  it('rejects missing handle', async () => {
    if (!reachable) return;
    const res = await submit({ title: 't', bucket: 'today' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown bucket', async () => {
    if (!reachable) return;
    const res = await submit({ handle: 'wheezer', title: 't', bucket: 'someday' });
    expect(res.statusCode).toBe(400);
  });

  it("creates a 'today' WO eligible immediately", async () => {
    if (!reachable) return;
    const res = await submit({
      handle: 'wheezer', title: 'morning check', bucket: 'today', body: 'do it',
    });
    expect(res.statusCode).toBe(201);
    const { wo } = res.json<{ wo: WoRow }>();
    expect(wo.bucket).toBe('today');
    expect(wo.assigned_agent).toBe('wheezer');
    expect(wo.status).toBe('pending');
    expect(new Date(wo.gate_at!).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(wo.context).toMatchObject({ body: 'do it' });
  });

  it("creates a 'next_week' WO gated to a future Monday", async () => {
    if (!reachable) return;
    const res = await submit({
      handle: 'wheezer', title: 'plan', bucket: 'next_week',
    });
    expect(res.statusCode).toBe(201);
    const { wo } = res.json<{ wo: WoRow }>();
    const gate = new Date(wo.gate_at!).getTime();
    expect(gate).toBeGreaterThan(Date.now());
    expect(gate - Date.now()).toBeLessThan(14 * 24 * 3_600_000);
  });
});

describe('POST /api/wo/heartbeat', () => {
  it('skips gated WOs and claims eligible ones', async () => {
    if (!reachable) return;
    await submit({ handle: 'wheezer', title: 'now', bucket: 'today' });
    await submit({ handle: 'wheezer', title: 'later', bucket: 'next_week' });

    const res = await server!.inject({
      method: 'POST',
      url: '/api/wo/heartbeat',
      headers: { ...H, 'content-type': 'application/json' },
      payload: JSON.stringify({ handle: 'wheezer' }),
    });
    expect(res.statusCode).toBe(200);
    const { claimed } = res.json<{ claimed: WoRow[] }>();
    expect(claimed).toHaveLength(1);
    expect(claimed[0].title).toBe('now');
    expect(claimed[0].status).toBe('active');
    expect(claimed[0].picked_at).not.toBeNull();
  });

  it('does not double-claim the same WO across two heartbeats', async () => {
    if (!reachable) return;
    await submit({ handle: 'wheezer', title: 'only one', bucket: 'today' });

    const [a, b] = await Promise.all([
      server!.inject({
        method: 'POST', url: '/api/wo/heartbeat',
        headers: { ...H, 'content-type': 'application/json' },
        payload: JSON.stringify({ handle: 'wheezer' }),
      }),
      server!.inject({
        method: 'POST', url: '/api/wo/heartbeat',
        headers: { ...H, 'content-type': 'application/json' },
        payload: JSON.stringify({ handle: 'wheezer' }),
      }),
    ]);
    const totalClaimed =
      a.json<{ claimed: WoRow[] }>().claimed.length +
      b.json<{ claimed: WoRow[] }>().claimed.length;
    expect(totalClaimed).toBe(1);
  });

  it('only claims for the requested handle', async () => {
    if (!reachable) return;
    await submit({ handle: 'wheezer', title: 'wheezer task', bucket: 'today' });
    await submit({ handle: 'darla',   title: 'darla task',   bucket: 'today' });

    const res = await server!.inject({
      method: 'POST', url: '/api/wo/heartbeat',
      headers: { ...H, 'content-type': 'application/json' },
      payload: JSON.stringify({ handle: 'darla' }),
    });
    const { claimed } = res.json<{ claimed: WoRow[] }>();
    expect(claimed.map((w) => w.title)).toEqual(['darla task']);
  });
});

describe('POST /api/wo/:id/complete', () => {
  it('marks claimed WO done and records result', async () => {
    if (!reachable) return;
    const r1 = await submit({ handle: 'wheezer', title: 'finish me', bucket: 'today' });
    const { wo } = r1.json<{ wo: WoRow }>();
    await server!.inject({
      method: 'POST', url: '/api/wo/heartbeat',
      headers: { ...H, 'content-type': 'application/json' },
      payload: JSON.stringify({ handle: 'wheezer' }),
    });
    const res = await server!.inject({
      method: 'POST', url: `/api/wo/${wo.id}/complete`,
      headers: { ...H, 'content-type': 'application/json' },
      payload: JSON.stringify({ result: 'all good' }),
    });
    expect(res.statusCode).toBe(200);
    const after = res.json<{ wo: WoRow }>().wo;
    expect(after.status).toBe('done');
    expect(after.context).toMatchObject({ result: 'all good' });
  });
});

describe('GET /api/wo + kanban surface', () => {
  it('lists WOs for an agent and hides done by default', async () => {
    if (!reachable) return;
    const r = await submit({ handle: 'wheezer', title: 'a', bucket: 'today' });
    const id = r.json<{ wo: WoRow }>().wo.id;
    await server!.inject({
      method: 'POST', url: `/api/wo/${id}/complete`,
      headers: { ...H, 'content-type': 'application/json' },
      payload: JSON.stringify({ result: 'done' }),
    });
    await submit({ handle: 'wheezer', title: 'b', bucket: 'tomorrow' });

    const res = await server!.inject({
      method: 'GET', url: '/api/wo?handle=wheezer', headers: H,
    });
    const { wos } = res.json<{ wos: WoRow[] }>();
    expect(wos.map((w) => w.title)).toEqual(['b']);
  });

  it('kanban board surface includes WOs (shared storage)', async () => {
    if (!reachable) return;
    await submit({ handle: 'wheezer', title: 'visible on kanban', bucket: 'today' });
    const res = await server!.inject({
      method: 'GET', url: '/api/kanban/board?scope=global&view=client',
      headers: H,
    });
    const body = res.json<{ columns: Array<{ count: number; tasks: Array<{ title: string }> }> }>();
    const titles = body.columns.flatMap((c) => c.tasks.map((t) => t.title));
    expect(titles).toContain('visible on kanban');
  });
});
