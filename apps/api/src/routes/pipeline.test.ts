/**
 * Integration tests — Pipeline Engine HTTP routes.
 *
 * Uses a scratch database created per test run inside the boss_postgres
 * container (exposed at 127.0.0.1:5434). If Postgres is unreachable, the
 * entire suite is skipped — the unit tests in pipeline-engine.test.ts
 * cover the state-machine logic independently.
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
const SCRATCH_DB = `boss_test_pipeline_${process.pid}`;

const MIGRATIONS_DIR = resolve(
  __dirname,
  '../../../../services/postgres/migrations',
);
const FOUNDATION_FN = `
  CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;
`;

let server: FastifyInstance | null = null;
let scratchReachable = false;

async function postgresIsReachable(): Promise<boolean> {
  const client = new Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  scratchReachable = await postgresIsReachable();
  if (!scratchReachable) {
    console.warn(
      `[pipeline.test] Postgres at ${ADMIN_URL} is unreachable — skipping integration tests. ` +
        'Start boss_postgres or set TEST_PG_HOST / TEST_PG_PORT.',
    );
    return;
  }

  // Create scratch DB
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  // Apply foundation fn + 014 + 015 migrations
  const scratch = new Client({
    connectionString: `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
  });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  await scratch.query(
    readFileSync(
      resolve(MIGRATIONS_DIR, '014_pipeline_engine.sql'),
      'utf-8',
    ),
  );
  await scratch.query(
    readFileSync(
      resolve(MIGRATIONS_DIR, '015_pipeline_seeds.sql'),
      'utf-8',
    ),
  );
  await scratch.end();

  // Boot Fastify against scratch DB
  process.env.POSTGRES_URL = `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = 'default';
  server = await buildServer();
});

afterAll(async () => {
  if (server) await server.close();
  // Release the shared Pool singleton before DROP DATABASE — Postgres refuses
  // to drop a database with active connections (error 55006).
  await closeDb();
  if (!scratchReachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // Belt-and-suspenders: terminate any leftover backends on the scratch DB
  // before dropping, in case a pooled connection escaped close.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
    [SCRATCH_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
});

beforeEach(async () => {
  if (!scratchReachable) return;
  // Clean tasks between tests — keep pipelines (seeded) intact.
  const pool = new Pool({
    connectionString: `postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`,
  });
  await pool.query(`DELETE FROM boss_stage_log`);
  await pool.query(`DELETE FROM boss_tasks`);
  await pool.end();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('Pipeline Engine integration', () => {
  it('lists the 5 seeded pipelines', async () => {
    if (!scratchReachable) return;
    const res = await server!.inject({ method: 'GET', url: '/api/pipeline' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pipelines: { name: string }[] }>();
    expect(body.pipelines).toHaveLength(5);
    const names = body.pipelines.map((p) => p.name).sort();
    expect(names).toEqual([
      'Client Meeting Followup',
      'Client Onboarding',
      'Content Publishing',
      'Lead Qualification',
      'Proposal / SOW',
    ]);
  });

  it('walks a task through Client Meeting Followup end-to-end', async () => {
    if (!scratchReachable) return;

    // Look up the pipeline
    const listRes = await server!.inject({ method: 'GET', url: '/api/pipeline' });
    const pipelines = listRes.json<{ pipelines: { id: string; name: string }[] }>();
    const meeting = pipelines.pipelines.find(
      (p) => p.name === 'Client Meeting Followup',
    );
    expect(meeting).toBeDefined();

    // Create a task
    const createRes = await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        pipeline_id: meeting!.id,
        title: 'Debbie Wooldridge meeting summary',
        assigned_agent: 'darla',
        assigned_client: '06-debbie-wooldridge',
        priority: 3,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const task = createRes.json<{ id: string; status: string; current_stage: string }>();
    expect(task.status).toBe('pending');
    expect(task.current_stage).toBe('calendar_detect');

    // Start
    const startRes = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/start`,
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json<{ task: { status: string } }>().task.status).toBe('active');

    // Advance: calendar_detect → transcript_pull
    let adv = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'meeting detected at 2026-04-22 14:00' },
    });
    expect(adv.statusCode).toBe(200);
    expect(adv.json<{ task: { current_stage: string } }>().task.current_stage).toBe(
      'transcript_pull',
    );

    // Advance: transcript_pull → summary_draft
    adv = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'transcript text, 1200 words' },
    });
    expect(adv.json<{ task: { current_stage: string } }>().task.current_stage).toBe(
      'summary_draft',
    );

    // Advance: summary_draft → review (blocks for approval)
    adv = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'summary + 3 next steps' },
    });
    expect(adv.json<{ task: { status: string } }>().task.status).toBe('blocked');
    expect(adv.json<{ task: { current_stage: string } }>().task.current_stage).toBe(
      'review',
    );

    // Approve (no-agent approval gate → advance to deliver)
    const approveRes = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/approve`,
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json<{ task: { current_stage: string } }>().task.current_stage).toBe(
      'deliver',
    );
    expect(approveRes.json<{ task: { status: string } }>().task.status).toBe('active');

    // Final advance: deliver → done
    const finalRes = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'uploaded to Drive, emailed Debbie' },
    });
    expect(finalRes.json<{ complete: boolean }>().complete).toBe(true);
    expect(finalRes.json<{ task: { status: string } }>().task.status).toBe('done');
  });

  it('filters tasks by agent for Little Rascal wake prompts', async () => {
    if (!scratchReachable) return;

    const listRes = await server!.inject({ method: 'GET', url: '/api/pipeline' });
    const pipelines = listRes.json<{ pipelines: { id: string; name: string }[] }>();
    const proposal = pipelines.pipelines.find((p) => p.name === 'Proposal / SOW')!;

    // Create 2 tasks for darla, 1 for spanky
    await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        pipeline_id: proposal.id,
        title: 'T1',
        assigned_agent: 'darla',
        priority: 5,
      },
    });
    await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        pipeline_id: proposal.id,
        title: 'T2',
        assigned_agent: 'darla',
        priority: 2,
      },
    });
    await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        pipeline_id: proposal.id,
        title: 'T3',
        assigned_agent: 'spanky',
        priority: 5,
      },
    });

    const res = await server!.inject({
      method: 'GET',
      url: '/api/tasks/agent/darla',
    });
    const body = res.json<{ agent: string; tasks: { title: string }[] }>();
    expect(body.agent).toBe('darla');
    expect(body.tasks).toHaveLength(2);
    // Priority 2 (T2) should sort before priority 5 (T1)
    expect(body.tasks[0].title).toBe('T2');
  });

  it('task.assigned_agent is preserved across stage advances (agent inheritance)', async () => {
    if (!scratchReachable) return;

    const listRes = await server!.inject({ method: 'GET', url: '/api/pipeline' });
    const pipelines = listRes.json<{ pipelines: { id: string; name: string }[] }>();
    const meeting = pipelines.pipelines.find(
      (p) => p.name === 'Client Meeting Followup',
    )!;

    // Create task with darla assigned
    const createRes = await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        pipeline_id: meeting.id,
        title: 'Agent-inheritance check',
        assigned_agent: 'darla',
      },
    });
    const task = createRes.json<{ id: string }>();

    // Walk through — stages have agent:null (seeded after review fix), so
    // assigned_agent must stick as 'darla' through every advance.
    await server!.inject({ method: 'POST', url: `/api/tasks/${task.id}/start` });
    let after = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'detected' },
    });
    expect(after.json<{ task: { assigned_agent: string } }>().task.assigned_agent).toBe(
      'darla',
    );

    after = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'pulled' },
    });
    expect(after.json<{ task: { assigned_agent: string } }>().task.assigned_agent).toBe(
      'darla',
    );
  });

  it('returns 409 on invalid transition (advance a done task)', async () => {
    if (!scratchReachable) return;

    const listRes = await server!.inject({ method: 'GET', url: '/api/pipeline' });
    const pipelines = listRes.json<{ pipelines: { id: string; name: string }[] }>();
    const lead = pipelines.pipelines.find((p) => p.name === 'Lead Qualification')!;

    const createRes = await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { pipeline_id: lead.id, title: 'Test lead', assigned_agent: 'butch' },
    });
    const task = createRes.json<{ id: string }>();

    // Walk it to done
    await server!.inject({ method: 'POST', url: `/api/tasks/${task.id}/start` });
    await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'thread pulled' },
    });
    await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'classified warm' },
    });
    await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'draft' },
    });
    // blocks on review
    await server!.inject({ method: 'POST', url: `/api/tasks/${task.id}/approve` });
    await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'sent' },
    });
    // Now done — further advance should 409
    const extra = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      payload: { output: 'oops' },
    });
    expect(extra.statusCode).toBe(409);
    expect(extra.json<{ error: string }>().error).toBe('invalid_transition');
  });

  it('/start accepts empty body with Content-Type: application/json', async () => {
    if (!scratchReachable) return;

    const internal = { 'x-boss-internal': 'true' };

    const listRes = await server!.inject({
      method: 'GET',
      url: '/api/pipeline',
      headers: internal,
    });
    const pipelines = listRes.json<{ pipelines: { id: string; name: string }[] }>();
    const meeting = pipelines.pipelines.find(
      (p) => p.name === 'Client Meeting Followup',
    )!;

    const createRes = await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: internal,
      payload: {
        pipeline_id: meeting.id,
        title: 'Empty-body /start',
        assigned_agent: 'darla',
      },
    });
    const task = createRes.json<{ id: string }>();

    const startRes = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/start`,
      headers: { ...internal, 'content-type': 'application/json' },
      payload: '',
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json<{ task: { status: string } }>().task.status).toBe('active');
  });

  it('/advance accepts empty body with Content-Type: application/json', async () => {
    if (!scratchReachable) return;

    const internal = { 'x-boss-internal': 'true' };

    const listRes = await server!.inject({
      method: 'GET',
      url: '/api/pipeline',
      headers: internal,
    });
    const pipelines = listRes.json<{ pipelines: { id: string; name: string }[] }>();
    const meeting = pipelines.pipelines.find(
      (p) => p.name === 'Client Meeting Followup',
    )!;

    const createRes = await server!.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: internal,
      payload: {
        pipeline_id: meeting.id,
        title: 'Empty-body /advance',
        assigned_agent: 'darla',
      },
    });
    const task = createRes.json<{ id: string }>();
    await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/start`,
      headers: internal,
    });

    const advRes = await server!.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/advance`,
      headers: { ...internal, 'content-type': 'application/json' },
      payload: '',
    });
    expect(advRes.statusCode).toBe(200);
    expect(advRes.json<{ task: { current_stage: string } }>().task.current_stage).toBe(
      'transcript_pull',
    );
  });
});
