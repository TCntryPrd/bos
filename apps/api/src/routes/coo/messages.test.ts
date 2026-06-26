/**
 * Integration tests for GET /api/coo/threads/:id/messages.
 *
 * Same scratch-DB harness as threads.test.ts; inserts messages
 * directly via SQL after creating a thread via the API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const SCRATCH_DB = `boss_test_coo_msgs_${process.pid}`;
const SCRATCH_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
const MIGRATIONS_DIR = resolve(__dirname, '../../../../../services/postgres/migrations');
const FOUNDATION_FN = `CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;`;
const MIGRATIONS = ['014_pipeline_engine.sql','015_pipeline_seeds.sql','016_rascals.sql','020_chat_sessions.sql','021_chat_session_cc_id.sql','022_outsiders.sql','023_outsiders_seed_backfill.sql','024_chat_sessions_agent_kind.sql','026_coo_chat_sessions.sql'];
const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

let server: FastifyInstance | null = null;
let scratchHome: string;
let threadId: string;

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
  for (const m of MIGRATIONS) await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, m), 'utf-8'));
  await scratch.end();

  scratchHome = mkdtempSync(join(tmpdir(), 'coo-msg-'));
  mkdirSync(join(scratchHome, 'boss-dev/docs'), { recursive: true });
  writeFileSync(join(scratchHome, 'boss-dev/docs/COO.md'), '# brief\n');
  process.env.POSTGRES_URL = SCRATCH_URL;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = 'default';
  process.env.BOSS_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.BOSS_HOME_OVERRIDE = scratchHome;
  server = await buildServer();

  const created = await server.inject({
    method: 'POST', url: '/api/coo/threads',
    headers: { ...H, 'content-type': 'application/json' },
    payload: { name: 'msgs', workspace_dir: join(scratchHome, 'boss-dev') },
  });
  threadId = (created.json() as { id: string }).id;

  const c = new Client({ connectionString: SCRATCH_URL });
  await c.connect();
  for (let i = 0; i < 5; i += 1) {
    await c.query(
      `INSERT INTO boss_chat_messages (session_id, role, content) VALUES ($1, $2, $3)`,
      [threadId, i % 2 === 0 ? 'user' : 'assistant', `m${i}`],
    );
    await c.query(`SELECT pg_sleep(0.01)`);
  }
  await c.end();
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

describe.skipIf(!reachable)('GET /api/coo/threads/:id/messages', () => {
  it('returns messages oldest-first', async () => {
    const res = await server!.inject({ method: 'GET', url: `/api/coo/threads/${threadId}/messages`, headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ role: string; content: string }>;
    expect(body.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('404s for unknown thread', async () => {
    const res = await server!.inject({
      method: 'GET',
      url: '/api/coo/threads/00000000-0000-0000-0000-000000000000/messages',
      headers: H,
    });
    expect(res.statusCode).toBe(404);
  });
});
