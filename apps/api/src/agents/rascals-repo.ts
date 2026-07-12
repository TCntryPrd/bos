/**
 * rascals-repo.ts — Postgres access layer for the boss_rascals table.
 *
 * All functions operate on a single tenant. They use the shared Pool from
 * db.ts (call initDb() before using this module — server.ts does it at boot;
 * tests call it in beforeAll).
 *
 * Kevin's rule (locked 2026-04-24): the live DB starts with zero rascals.
 * These helpers are used by import-presets and onboarding routes — NOT called
 * at startup.
 */

import { getPool } from '../db.js';
import type { RascalPreset, RascalCli } from './rascals-presets.js';
import { RASCAL_PRESETS } from './rascals-presets.js';

export type { RascalCli } from './rascals-presets.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RascalRow {
  tenantId: string;
  handle: string;
  displayName: string;
  cli: 'claude' | 'ollama';
  client: string;
  projectDir: string;
  model: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListRascalsOptions {
  enabledOnly?: boolean;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class InvalidHandleError extends Error {
  constructor(handle: string) {
    super(`invalid handle: "${handle}" — must match ^[a-z]{2,24}$`);
    this.name = 'InvalidHandleError';
  }
}

export class DuplicateRascalError extends Error {
  constructor(tenantId: string, handle: string) {
    super(`duplicate rascal: (${tenantId}, ${handle}) already exists`);
    this.name = 'DuplicateRascalError';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const HANDLE_RE = /^[a-z]{2,24}$/;

function assertValidHandle(handle: string): void {
  if (!HANDLE_RE.test(handle)) {
    throw new InvalidHandleError(handle);
  }
}

function rowToRascal(row: Record<string, unknown>): RascalRow {
  return {
    tenantId:    row.tenant_id    as string,
    handle:      row.handle       as string,
    displayName: row.display_name as string,
    cli:         row.cli          as 'claude' | 'ollama',
    client:      row.client       as string,
    projectDir:  row.project_dir  as string,
    model:       row.model        as string,
    enabled:     row.enabled      as boolean,
    createdAt:   row.created_at   as Date,
    updatedAt:   row.updated_at   as Date,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Insert a new rascal row from a preset (or any compatible object).
 * Enforces handle regex before touching the DB.
 * Throws DuplicateRascalError on 23505 (unique violation).
 */
export async function createRascal(
  tenantId: string,
  preset: RascalPreset,
): Promise<RascalRow> {
  assertValidHandle(preset.handle);

  const pool = getPool();
  try {
    const res = await pool.query(
      `INSERT INTO boss_rascals
         (tenant_id, handle, display_name, cli, client, project_dir)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, preset.handle, preset.displayName, preset.cli, preset.client, preset.projectDir],
    );
    return rowToRascal(res.rows[0]);
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new DuplicateRascalError(tenantId, preset.handle);
    }
    throw err;
  }
}

/**
 * Fetch a single rascal by (tenantId, handle).
 * Returns null if not found.
 */
export async function getRascal(
  tenantId: string,
  handle: string,
): Promise<RascalRow | null> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM boss_rascals WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
  if (res.rows.length === 0) return null;
  return rowToRascal(res.rows[0]);
}

/**
 * List all rascals for a tenant. Pass { enabledOnly: true } to filter to
 * enabled rows only.
 */
export async function listRascals(
  tenantId: string,
  options: ListRascalsOptions = {},
): Promise<RascalRow[]> {
  const pool = getPool();
  const { enabledOnly = false } = options;

  const res = enabledOnly
    ? await pool.query(
        `SELECT * FROM boss_rascals WHERE tenant_id = $1 AND enabled = TRUE ORDER BY handle`,
        [tenantId],
      )
    : await pool.query(
        `SELECT * FROM boss_rascals WHERE tenant_id = $1 ORDER BY handle`,
        [tenantId],
      );

  return res.rows.map(rowToRascal);
}

/**
 * Set enabled = TRUE for the given rascal.
 */
export async function enableRascal(
  tenantId: string,
  handle: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE boss_rascals SET enabled = TRUE WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
}

/**
 * Set enabled = FALSE for the given rascal.
 */
export async function disableRascal(
  tenantId: string,
  handle: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE boss_rascals SET enabled = FALSE WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
}

/**
 * Delete a rascal row. Returns true if a row was deleted, false if no row matched.
 */
export async function deleteRascal(
  tenantId: string,
  handle: string,
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM boss_rascals WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Patch / Update ────────────────────────────────────────────────────────────

export interface UpdateRascalInput {
  displayName?: string;
  cli?: RascalCli;
  client?: string;
  projectDir?: string;
  model?: string;
  enabled?: boolean;
}

/**
 * Patch arbitrary fields on a rascal row.
 * Builds a dynamic SET clause from the non-undefined patch fields.
 * Returns the updated row mapped through rowToRascal(), or null if no row matched.
 * If patch is empty, returns the current row (equivalent to getRascal).
 */
export async function updateRascal(
  tenantId: string,
  handle: string,
  patch: UpdateRascalInput,
): Promise<RascalRow | null> {
  // Map camelCase patch keys to DB column names
  const columnMap: Record<keyof UpdateRascalInput, string> = {
    displayName: 'display_name',
    cli:         'cli',
    client:      'client',
    projectDir:  'project_dir',
    model:       'model',
    enabled:     'enabled',
  };

  // Build pairs of [column, value] for defined fields
  const entries = (Object.keys(patch) as Array<keyof UpdateRascalInput>)
    .filter((k) => patch[k] !== undefined)
    .map((k) => [columnMap[k], patch[k]] as [string, unknown]);

  // If patch is empty, return the current row
  if (entries.length === 0) {
    return getRascal(tenantId, handle);
  }

  const pool = getPool();

  // Build: SET col1 = $3, col2 = $4 ... (tenant_id=$1, handle=$2 are fixed)
  const setClauses = entries.map((entry, i) => `${entry[0]} = $${i + 3}`).join(', ');
  const values = [tenantId, handle, ...entries.map((e) => e[1])];

  const res = await pool.query(
    `UPDATE boss_rascals
     SET ${setClauses}
     WHERE tenant_id = $1 AND handle = $2
     RETURNING *`,
    values,
  );

  if (res.rows.length === 0) return null;
  return rowToRascal(res.rows[0]);
}

// ── Import Presets ────────────────────────────────────────────────────────────

export interface ImportPresetsResult {
  imported: string[];
  skipped: string[];
}

/**
 * Seed rascals from the built-in RASCAL_PRESETS.
 *
 * - If handles is undefined/empty, imports all 13 presets.
 * - If handles is provided, validates every entry exists in RASCAL_PRESETS;
 *   throws Error(`Unknown preset handle(s): ${unknown.join(', ')}`) if any don't.
 * - For each target handle:
 *   * If already in boss_rascals for this tenant → pushed to skipped.
 *   * Else → createRascal() with enabled: false (default) → pushed to imported.
 * - Returns { imported, skipped }.
 */
export async function importPresets(
  tenantId: string,
  handles?: string[],
): Promise<ImportPresetsResult> {
  const presetsMap = new Map<string, RascalPreset>(
    RASCAL_PRESETS.map((p) => [p.handle, p]),
  );

  // Determine which presets to import
  let targets: RascalPreset[];
  if (!handles || handles.length === 0) {
    targets = [...RASCAL_PRESETS];
  } else {
    const unknown = handles.filter((h) => !presetsMap.has(h));
    if (unknown.length > 0) {
      throw new Error(`Unknown preset handle(s): ${unknown.join(', ')}`);
    }
    targets = handles.map((h) => presetsMap.get(h)!);
  }

  // Validate all handles up front — an invalid handle mid-loop would leave
  // the transaction half-applied. Presets already pass this check, but keep
  // it defensive in case RASCAL_PRESETS gains a bad entry later.
  for (const preset of targets) {
    assertValidHandle(preset.handle);
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const preset of targets) {
      const existing = await client.query(
        `SELECT 1 FROM boss_rascals WHERE tenant_id = $1 AND handle = $2`,
        [tenantId, preset.handle],
      );
      if (existing.rows.length > 0) {
        skipped.push(preset.handle);
        continue;
      }
      await client.query(
        `INSERT INTO boss_rascals
           (tenant_id, handle, display_name, cli, client, project_dir)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, preset.handle, preset.displayName, preset.cli, preset.client, preset.projectDir],
      );
      imported.push(preset.handle);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { imported, skipped };
}
