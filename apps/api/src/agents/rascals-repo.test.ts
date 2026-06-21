/**
 * Integration tests — rascals-repo DB access layer.
 *
 * Uses a scratch database created per test run inside the boss_postgres
 * container (exposed at 127.0.0.1:5434). If Postgres is unreachable, the
 * entire suite is skipped.
 *
 * Apply migration 016 fresh into the scratch DB — the live DB may not have it yet.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initDb, closeDb } from '../db.js';
import {
  createRascal,
  getRascal,
  listRascals,
  enableRascal,
  disableRascal,
  deleteRascal,
  updateRascal,
  importPresets,
} from './rascals-repo.js';
import { RASCAL_PRESETS } from './rascals-presets.js';

const { Client } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASSWORD = process.env.TEST_PG_PASSWORD ?? '';
const ADMIN_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_rascals_${process.pid}`;
const SCRATCH_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;

const MIGRATIONS_DIR = resolve(
  __dirname,
  '../../../../services/postgres/migrations',
);

const FOUNDATION_FN = `
  CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;
`;

const TENANT = 'default';

async function pgReachable(): Promise<boolean> {
  const client = new Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const reachable = await pgReachable();

beforeAll(async () => {
  if (!reachable) {
    console.warn(
      `[rascals-repo.test] Postgres at ${ADMIN_URL} is unreachable — skipping integration tests. ` +
        'Start boss_postgres or set TEST_PG_HOST / TEST_PG_PORT / TEST_PG_PASSWORD.',
    );
    return;
  }

  // Create scratch DB
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  // Apply foundation fn + migration 016
  const scratch = new Client({ connectionString: SCRATCH_URL });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  await scratch.query(
    readFileSync(resolve(MIGRATIONS_DIR, '016_rascals.sql'), 'utf-8'),
  );
  await scratch.end();

  // Point shared pool at scratch DB
  initDb(SCRATCH_URL);
});

afterAll(async () => {
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe.skipIf(!reachable)('rascals-repo', () => {
  it('createRascal inserts a rascal from a preset', async () => {
    const darla = RASCAL_PRESETS[0]; // handle = 'darla'
    const row = await createRascal(TENANT, darla);
    expect(row.handle).toBe('darla');
    expect(row.displayName).toBe('Darla Wooldridge');
    expect(row.enabled).toBe(false);
    expect(row.tenantId).toBe(TENANT);
  });

  it('createRascal rejects a handle that violates ^[a-z]{2,24}$', async () => {
    const badPreset = { ...RASCAL_PRESETS[1], handle: 'BAD_HANDLE' };
    await expect(createRascal(TENANT, badPreset)).rejects.toThrow(/invalid handle/i);
  });

  it('createRascal rejects a duplicate (tenant_id, handle) with DuplicateRascalError', async () => {
    // darla was already inserted in the first test
    await expect(createRascal(TENANT, RASCAL_PRESETS[0])).rejects.toThrow(/duplicate/i);
  });

  it('getRascal returns the inserted rascal', async () => {
    const row = await getRascal(TENANT, 'darla');
    expect(row).not.toBeNull();
    expect(row!.handle).toBe('darla');
    expect(row!.cli).toBe('claude');
  });

  it('getRascal returns null for an unknown handle', async () => {
    const row = await getRascal(TENANT, 'nobody');
    expect(row).toBeNull();
  });

  it('listRascals returns all rascals for the tenant', async () => {
    // Insert a second rascal so we have 2
    await createRascal(TENANT, RASCAL_PRESETS[1]); // spanky
    const rows = await listRascals(TENANT);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const handles = rows.map((r) => r.handle);
    expect(handles).toContain('darla');
    expect(handles).toContain('spanky');
  });

  it('listRascals returns only enabled rascals when enabledOnly=true', async () => {
    const before = await listRascals(TENANT, { enabledOnly: true });
    // None enabled yet
    expect(before.every((r) => r.enabled)).toBe(true);
  });

  it('enableRascal flips enabled to true', async () => {
    await enableRascal(TENANT, 'darla');
    const row = await getRascal(TENANT, 'darla');
    expect(row!.enabled).toBe(true);
  });

  it('listRascals with enabledOnly=true returns only darla after enabling her', async () => {
    const rows = await listRascals(TENANT, { enabledOnly: true });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(rows.some((r) => r.handle === 'darla')).toBe(true);
    expect(rows.some((r) => r.handle === 'spanky')).toBe(false);
  });

  it('disableRascal flips enabled back to false', async () => {
    await disableRascal(TENANT, 'darla');
    const row = await getRascal(TENANT, 'darla');
    expect(row!.enabled).toBe(false);
  });

  it('deleteRascal removes the row', async () => {
    await deleteRascal(TENANT, 'spanky');
    const row = await getRascal(TENANT, 'spanky');
    expect(row).toBeNull();
  });

  it('deleteRascal is a no-op for a non-existent handle (no error)', async () => {
    await expect(deleteRascal(TENANT, 'nobody')).resolves.toBe(false);
  });

  // ── updateRascal ──────────────────────────────────────────────────────────

  it('updateRascal patches arbitrary fields', async () => {
    // darla already exists from the earlier createRascal test; no re-insert needed
    const updated = await updateRascal('default', 'darla', { client: 'TTC — Debbie', enabled: true });
    expect(updated).not.toBeNull();
    expect(updated!.client).toBe('TTC — Debbie');
    expect(updated!.enabled).toBe(true);
    expect(updated!.displayName).toBe('Darla Wooldridge'); // untouched
  });

  it('updateRascal returns null for unknown handle', async () => {
    expect(await updateRascal('default', 'nobody', { enabled: true })).toBeNull();
  });

  it('updateRascal with empty patch returns the current row', async () => {
    // darla already exists; empty patch returns it unchanged
    const r = await updateRascal('default', 'darla', {});
    expect(r).not.toBeNull();
    expect(r!.handle).toBe('darla');
  });

  // ── importPresets ──────────────────────────────────────────────────────────

  it('importPresets seeds all 13 on an empty tenant', async () => {
    // Use a fresh tenant key so this test is not affected by accumulated state
    const result = await importPresets('import-test-all');
    expect(result.imported).toHaveLength(13);
    expect(result.skipped).toEqual([]);
    expect(await listRascals('import-test-all')).toHaveLength(13);
  });

  it('importPresets with {handles:["darla"]} imports only darla', async () => {
    const result = await importPresets('import-test-single', ['darla']);
    expect(result.imported).toEqual(['darla']);
    expect(result.skipped).toEqual([]);
    const list = await listRascals('import-test-single');
    expect(list).toHaveLength(1);
    expect(list[0].handle).toBe('darla');
  });

  it('importPresets is idempotent — re-import skips existing', async () => {
    await importPresets('import-test-idem', ['darla']);
    const second = await importPresets('import-test-idem');
    expect(second.imported).toHaveLength(12);
    expect(second.skipped).toEqual(['darla']);
    expect(await listRascals('import-test-idem')).toHaveLength(13);
  });

  it('importPresets rejects unknown handles in the filter', async () => {
    await expect(importPresets('default', ['nobody'])).rejects.toThrow(/unknown preset/i);
  });
});
