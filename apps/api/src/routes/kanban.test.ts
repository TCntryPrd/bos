/**
 * Integration tests — Kanban HTTP routes.
 * Mirrors pipeline.test.ts: scratch DB per run, full migration replay.
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
const SCRATCH_DB = `boss_test_kanban_${process.pid}`;
const TENANT = 'test-tenant';
const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': TENANT } as const;

const MIGRATIONS_DIR = resolve(
  __dirname,
  '../../../../services/postgres/migrations',
);

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
    console.warn(`[kanban.test] Postgres unreachable at ${ADMIN_URL} — suite skipped.`);
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
  // Apply 014 (creates boss_tasks) + 027 (archived_at) + 030 (WO buckets)
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
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SCRATCH_DB]);
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

async function seedTask(overrides: Record<string, unknown> = {}): Promise<string> {
  const pool = new Pool({
    connectionString: `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
  });
  const fields = {
    tenant_id: TENANT,
    title: 'seed task',
    current_stage: 'Initiated',
    status: 'pending',
    view_column: 'inbox',
    priority: 5,
    ...overrides,
  };
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const r = await pool.query(
    `INSERT INTO boss_tasks (${cols.join(',')}) VALUES (${placeholders}) RETURNING id`,
    vals,
  );
  await pool.end();
  return r.rows[0].id;
}

describe('Kanban approve / archive / delete', () => {
  it('approve: blocked → active', async () => {
    if (!reachable) return;
    const id = await seedTask({ status: 'blocked' });
    const res = await server!.inject({
      method: 'POST',
      url: `/api/kanban/tasks/${id}/approve`,
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ task: { status: string } }>();
    expect(body.task.status).toBe('active');
  });

  it('archive: sets archived_at and removes from default board', async () => {
    if (!reachable) return;
    const id = await seedTask({});
    const res = await server!.inject({
      method: 'POST',
      url: `/api/kanban/tasks/${id}/archive`,
      headers: H,
    });
    expect(res.statusCode).toBe(200);

    const board = await server!.inject({
      method: 'GET',
      url: '/api/kanban/board?scope=global&view=client',
      headers: H,
    });
    const body = board.json<{ columns: { count: number }[] }>();
    expect(body.columns.reduce((s, c) => s + c.count, 0)).toBe(0);
  });

  it('delete: succeeds when view_column=done', async () => {
    if (!reachable) return;
    const id = await seedTask({ view_column: 'done' });
    const res = await server!.inject({
      method: 'DELETE',
      url: `/api/kanban/tasks/${id}`,
      headers: H,
    });
    expect(res.statusCode).toBe(204);
  });

  it('delete: 403 when view_column != done', async () => {
    if (!reachable) return;
    const id = await seedTask({ view_column: 'inbox' });
    const res = await server!.inject({
      method: 'DELETE',
      url: `/api/kanban/tasks/${id}`,
      headers: H,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Kanban POST /api/kanban/tasks/:id/move', () => {
  it('moves view_column when view=client', async () => {
    if (!reachable) return;
    const id = await seedTask({ view_column: 'inbox' });
    const res = await server!.inject({
      method: 'POST',
      url: `/api/kanban/tasks/${id}/move`,
      headers: H,
      payload: { view: 'client', to: 'today' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ task: { view_column: string; stage_history: unknown[] } }>();
    expect(body.task.view_column).toBe('today');
    expect(body.task.stage_history).toHaveLength(0);
  });

  it('moves current_stage and appends to stage_history when view=project', async () => {
    if (!reachable) return;
    const id = await seedTask({ current_stage: 'Initiated' });
    const res = await server!.inject({
      method: 'POST',
      url: `/api/kanban/tasks/${id}/move`,
      headers: H,
      payload: { view: 'project', to: 'Assessment' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ task: { current_stage: string; stage_history: { from: string; to: string }[] } }>();
    expect(body.task.current_stage).toBe('Assessment');
    expect(body.task.stage_history).toHaveLength(1);
    expect(body.task.stage_history[0].from).toBe('Initiated');
    expect(body.task.stage_history[0].to).toBe('Assessment');
  });

  it('rejects unknown to value with 400', async () => {
    if (!reachable) return;
    const id = await seedTask({});
    const res = await server!.inject({
      method: 'POST',
      url: `/api/kanban/tasks/${id}/move`,
      headers: H,
      payload: { view: 'project', to: 'NonExistentStage' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'POST',
      url: '/api/kanban/tasks/00000000-0000-0000-0000-000000000000/move',
      headers: H,
      payload: { view: 'client', to: 'today' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Kanban PATCH /api/kanban/tasks/:id', () => {
  it('updates title and priority', async () => {
    if (!reachable) return;
    const id = await seedTask({ title: 'old', priority: 5 });
    const res = await server!.inject({
      method: 'PATCH',
      url: `/api/kanban/tasks/${id}`,
      headers: H,
      payload: { title: 'new', priority: 8 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ task: { title: string; priority: number } }>();
    expect(body.task.title).toBe('new');
    expect(body.task.priority).toBe(8);
  });

  it('returns 404 for unknown id', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'PATCH',
      url: '/api/kanban/tasks/00000000-0000-0000-0000-000000000000',
      headers: H,
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects PATCH from a different tenant with 404', async () => {
    if (!reachable) return;
    const pool = new Pool({
      connectionString: `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
    });
    const r = await pool.query(
      `INSERT INTO boss_tasks (tenant_id, title, current_stage, status, view_column)
       VALUES ('other-tenant','x','Initiated','pending','inbox') RETURNING id`,
    );
    await pool.end();
    const res = await server!.inject({
      method: 'PATCH',
      url: `/api/kanban/tasks/${r.rows[0].id}`,
      headers: H,
      payload: { title: 'hijack' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Kanban POST /api/kanban/tasks', () => {
  it('creates a task with sane defaults', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'POST',
      url: '/api/kanban/tasks',
      headers: H,
      payload: { title: 'New SOW for Leslie', assigned_agent: 'darla' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ task: { id: string; title: string; current_stage: string; view_column: string } }>();
    expect(body.task.title).toBe('New SOW for Leslie');
    expect(body.task.current_stage).toBe('Initiated');
    expect(body.task.view_column).toBe('inbox');
  });

  it('rejects empty title with 400', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'POST',
      url: '/api/kanban/tasks',
      headers: H,
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid view_column with 400', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'POST',
      url: '/api/kanban/tasks',
      headers: H,
      payload: { title: 'x', view_column: 'wibble' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Kanban GET /api/kanban/board', () => {
  it('returns 5 client-view columns when scope=global', async () => {
    if (!reachable) return;
    await seedTask({ view_column: 'inbox' });
    await seedTask({ view_column: 'today' });
    await seedTask({ view_column: 'today' });

    const res = await server!.inject({
      method: 'GET',
      url: '/api/kanban/board?scope=global&view=client',
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ columns: { key: string; count: number }[] }>();
    expect(body.columns.map((c) => c.key)).toEqual([
      'inbox', 'today', 'in_progress', 'to_close', 'done',
    ]);
    const today = body.columns.find((c) => c.key === 'today');
    expect(today?.count).toBe(2);
  });

  it('returns 9 project-view columns when view=project', async () => {
    if (!reachable) return;
    await seedTask({ current_stage: 'Assessment' });
    await seedTask({ current_stage: 'L1 Implementation' });

    const res = await server!.inject({
      method: 'GET',
      url: '/api/kanban/board?scope=global&view=project',
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ columns: { key: string; count: number }[] }>();
    expect(body.columns).toHaveLength(9);
    expect(body.columns[0].key).toBe('Initiated');
    expect(body.columns[8].key).toBe('Closed');
    expect(body.columns.find((c) => c.key === 'Assessment')?.count).toBe(1);
  });

  it('filters by rascal scope', async () => {
    if (!reachable) return;
    await seedTask({ assigned_agent: 'darla' });
    await seedTask({ assigned_agent: 'spanky' });

    const res = await server!.inject({
      method: 'GET',
      url: '/api/kanban/board?scope=rascal&handle=darla&view=client',
      headers: H,
    });
    const body = res.json<{ columns: { count: number }[] }>();
    const total = body.columns.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(1);
  });

  it('rejects unknown view param with 400', async () => {
    if (!reachable) return;
    const res = await server!.inject({
      method: 'GET',
      url: '/api/kanban/board?scope=global&view=garbage',
      headers: H,
    });
    expect(res.statusCode).toBe(400);
  });

  it('excludes archived rows by default; includes when include_archived=1', async () => {
    if (!reachable) return;
    const id = await seedTask({});
    const pool = new Pool({
      connectionString: `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
    });
    await pool.query(`UPDATE boss_tasks SET archived_at = now() WHERE id = $1`, [id]);
    await pool.end();

    const def = await server!.inject({
      method: 'GET',
      url: '/api/kanban/board?scope=global&view=client',
      headers: H,
    });
    const defBody = def.json<{ columns: { count: number }[] }>();
    expect(defBody.columns.reduce((s, c) => s + c.count, 0)).toBe(0);

    const inc = await server!.inject({
      method: 'GET',
      url: '/api/kanban/board?scope=global&view=client&include_archived=1',
      headers: H,
    });
    const incBody = inc.json<{ columns: { count: number }[] }>();
    expect(incBody.columns.reduce((s, c) => s + c.count, 0)).toBe(1);
  });
});
