/**
 * Integration tests for /api/coo/threads — list / create / rename.
 *
 * Uses the rascals.test.ts pattern: scratch DB at 5434, applies the
 * chat-sessions migrations plus the new 026 COO migration. Skipped if
 * Postgres is unreachable. Set TEST_PG_PASSWORD=<prod-password> to run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server.js';
import { closeDb } from '../../db.js';

const { Client } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASS = process.env.TEST_PG_PASSWORD ?? '';
const auth = PG_PASS ? `${PG_USER}:${encodeURIComponent(PG_PASS)}` : PG_USER;
const ADMIN_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_coo_threads_${process.pid}`;
const SCRATCH_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
const MIGRATIONS_DIR = resolve(__dirname, '../../../../../services/postgres/migrations');

const FOUNDATION_FN = `
  CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;
`;

const MIGRATIONS = [
  '014_pipeline_engine.sql',
  '015_pipeline_seeds.sql',
  '016_rascals.sql',
  '020_chat_sessions.sql',
  '021_chat_session_cc_id.sql',
  '022_outsiders.sql',
  '023_outsiders_seed_backfill.sql',
  '024_chat_sessions_agent_kind.sql',
  '026_coo_chat_sessions.sql',
];

const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

let server: FastifyInstance | null = null;
let scratchHome: string;

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
  const scratch = new Client({ connectionString: SCRATCH_URL });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  for (const m of MIGRATIONS) {
    await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, m), 'utf-8'));
  }
  await scratch.end();

  scratchHome = mkdtempSync(join(tmpdir(), 'coo-th-'));
  mkdirSync(join(scratchHome, 'boss-dev/docs'), { recursive: true });
  mkdirSync(join(scratchHome, 'rascals/darla'), { recursive: true });
  writeFileSync(join(scratchHome, 'boss-dev/docs/COO.md'), '# Test COO brief\nshort.\n');

  process.env.POSTGRES_URL = SCRATCH_URL;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = 'default';
  process.env.BOSS_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.BOSS_HOME_OVERRIDE = scratchHome;
  server = await buildServer();
});

afterAll(async () => {
  if (!reachable) return;
  if (server) await server.close();
  await closeDb();
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
  rmSync(scratchHome, { recursive: true, force: true });
  delete process.env.BOSS_HOME_OVERRIDE;
});

beforeEach(async () => {
  if (!reachable) return;
  const c = new Client({ connectionString: SCRATCH_URL });
  await c.connect();
  await c.query("DELETE FROM boss_chat_sessions WHERE agent_kind='coo';");
  await c.end();
});

describe.skipIf(!reachable)('/api/coo/threads', () => {
  it('POST creates a thread with snapshotted persona', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Main', workspace_dir: join(scratchHome, 'boss-dev') },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; workspace_dir: string; system_prompt: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('Main');
    expect(body.system_prompt).toContain('Test COO brief');
  });

  it('POST falls back to built-in persona when COO.md is missing', async () => {
    rmSync(join(scratchHome, 'boss-dev/docs/COO.md'));
    const res = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Fallback', workspace_dir: join(scratchHome, 'boss-dev') },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { system_prompt: string }).system_prompt).toContain('You are BOS');
    writeFileSync(join(scratchHome, 'boss-dev/docs/COO.md'), '# Test COO brief\nshort.\n');
  });

  it('POST rejects workspace_dir not in the allowlist', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Bad', workspace_dir: '/etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET lists threads for the tenant, newest first', async () => {
    const dir = join(scratchHome, 'boss-dev');
    for (const n of ['A', 'B', 'C']) {
      await server!.inject({
        method: 'POST',
        url: '/api/coo/threads',
        headers: { ...H, 'content-type': 'application/json' },
        payload: { name: n, workspace_dir: dir },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const res = await server!.inject({ method: 'GET', url: '/api/coo/threads', headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ name: string }>;
    expect(body.map((t) => t.name)).toEqual(['C', 'B', 'A']);
  });

  it('DELETE archives a thread (removes from list)', async () => {
    const dir = join(scratchHome, 'boss-dev');
    const created = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'doomed', workspace_dir: dir },
    });
    const { id } = created.json() as { id: string };
    const del = await server!.inject({
      method: 'DELETE',
      url: `/api/coo/threads/${id}`,
      headers: H,
    });
    expect(del.statusCode).toBe(204);
    const listed = await server!.inject({ method: 'GET', url: '/api/coo/threads', headers: H });
    const names = (listed.json() as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain('doomed');
  });

  it('POST 400s when 5 active threads already exist', async () => {
    const dir = join(scratchHome, 'boss-dev');
    for (const n of ['t1', 't2', 't3', 't4', 't5']) {
      const r = await server!.inject({
        method: 'POST',
        url: '/api/coo/threads',
        headers: { ...H, 'content-type': 'application/json' },
        payload: { name: n, workspace_dir: dir },
      });
      expect(r.statusCode).toBe(201);
    }
    const sixth = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'overflow', workspace_dir: dir },
    });
    expect(sixth.statusCode).toBe(400);
    expect((sixth.json() as { max: number }).max).toBe(5);
  });

  it('PATCH renames a thread', async () => {
    const dir = join(scratchHome, 'boss-dev');
    const created = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Original', workspace_dir: dir },
    });
    const { id } = created.json() as { id: string };
    const renamed = await server!.inject({
      method: 'PATCH',
      url: `/api/coo/threads/${id}`,
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { name: string }).name).toBe('Renamed');
  });
});
