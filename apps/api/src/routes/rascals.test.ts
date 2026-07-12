/**
 * Integration tests — /api/agents/rascals routes.
 *
 * Uses a scratch database created per test run inside the boss_postgres
 * container (exposed at 127.0.0.1:5434). If Postgres is unreachable, the
 * entire suite is skipped.
 *
 * Migrations applied: 014_pipeline_engine.sql (needed for boss_tasks
 * referenced by the DELETE route's open-task guard), 015_pipeline_seeds.sql,
 * and 016_rascals.sql.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { closeDb } from '../db.js';

const { Client } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASS = process.env.TEST_PG_PASSWORD ?? '';
const auth = PG_PASS ? `${PG_USER}:${PG_PASS}` : PG_USER;
const ADMIN_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_rascals_routes_${process.pid}`;
const MIGRATIONS_DIR = resolve(__dirname, '../../../../services/postgres/migrations');
const FOUNDATION_FN = `
  CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;
`;

let server: FastifyInstance | null = null;

const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

async function pgReachable(): Promise<boolean> {
  const c = new Client({ connectionString: ADMIN_URL });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const reachable = await pgReachable();

beforeAll(async () => {
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();
  const scratch = new Client({ connectionString: `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}` });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  // 014 creates boss_tasks (needed by the DELETE route's open-task guard)
  await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, '014_pipeline_engine.sql'), 'utf-8'));
  // 015 seeds pipeline templates (harmless here; keeps the DB consistent with prod)
  await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, '015_pipeline_seeds.sql'), 'utf-8'));
  // 016 creates boss_rascals
  await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, '016_rascals.sql'), 'utf-8'));
  await scratch.end();
  process.env.POSTGRES_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = 'default';
  process.env.BOSS_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  server = await buildServer();
});

afterAll(async () => {
  if (server) await server.close();
  await closeDb();
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SCRATCH_DB]);
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
});

beforeEach(async () => {
  if (!reachable) return;
  await server!.inject({ method: 'POST', url: '/api/agents/rascals/_test_reset', headers: H });
});

describe.skipIf(!reachable)('rascals routes', () => {
  it('GET /api/agents/rascals returns [] on empty tenant', async () => {
    const r = await server!.inject({ method: 'GET', url: '/api/agents/rascals', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ rascals: unknown[] }>().rascals).toEqual([]);
  });

  it('POST /api/agents/rascals creates a rascal and returns 201', async () => {
    const r = await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'darla', displayName: 'Darla Wooldridge', cli: 'claude', client: 'TTC' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ handle: string; enabled: boolean }>();
    expect(body.handle).toBe('darla');
    expect(body.enabled).toBe(false);
  });

  it('POST rejects invalid handle format with 400', async () => {
    const r = await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'BadName', displayName: 'X', cli: 'claude', client: 'y' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('POST rejects duplicate handle with 409', async () => {
    const body = { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' };
    await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: body });
    const r = await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: body });
    expect(r.statusCode).toBe(409);
  });

  it('PATCH /api/agents/rascals/:handle updates fields', async () => {
    await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' },
    });
    const r = await server!.inject({
      method: 'PATCH', url: '/api/agents/rascals/darla', headers: H,
      payload: { enabled: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ enabled: boolean }>().enabled).toBe(true);
  });

  it('PATCH returns 404 for unknown handle', async () => {
    const r = await server!.inject({ method: 'PATCH', url: '/api/agents/rascals/nobody', headers: H, payload: { enabled: true } });
    expect(r.statusCode).toBe(404);
  });

  it('DELETE removes the row and returns 204', async () => {
    await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' },
    });
    const r = await server!.inject({ method: 'DELETE', url: '/api/agents/rascals/darla', headers: H });
    expect(r.statusCode).toBe(204);
  });

  it('POST /import-presets with no body imports all 13', async () => {
    const r = await server!.inject({ method: 'POST', url: '/api/agents/rascals/import-presets', headers: H, payload: {} });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ imported: string[]; skipped: string[] }>();
    expect(body.imported).toHaveLength(13);
    expect(body.skipped).toEqual([]);
  });

  it('POST /import-presets with {handles:["darla"]} imports one', async () => {
    const r = await server!.inject({
      method: 'POST', url: '/api/agents/rascals/import-presets', headers: H,
      payload: { handles: ['darla'] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ imported: string[] }>().imported).toEqual(['darla']);
    const list = await server!.inject({ method: 'GET', url: '/api/agents/rascals', headers: H });
    expect(list.json<{ rascals: unknown[] }>().rascals).toHaveLength(1);
  });

  it('GET ?enabled=true filters to enabled only', async () => {
    await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: { handle: 'aa', displayName: 'A', cli: 'claude', client: 'x' } });
    await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: { handle: 'bb', displayName: 'B', cli: 'claude', client: 'x', enabled: true } });
    const r = await server!.inject({ method: 'GET', url: '/api/agents/rascals?enabled=true', headers: H });
    const body = r.json<{ rascals: Array<{ handle: string }> }>();
    expect(body.rascals.map((x) => x.handle)).toEqual(['bb']);
  });
});
