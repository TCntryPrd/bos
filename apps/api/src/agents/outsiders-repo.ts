/**
 * outsiders-repo.ts — Postgres access layer for the boss_outsiders table.
 *
 * Mirrors rascals-repo.ts shape but without the presets-import layer —
 * the outsiders roster is small enough that seed rows live in migration
 * 022 and growth happens through the create endpoint.
 */

import { getPool } from '../db.js';

export type OutsiderCli = 'claude' | 'ollama';

export interface OutsiderRow {
  tenantId: string;
  handle: string;
  displayName: string;
  cli: OutsiderCli;
  client: string;
  projectDir: string;
  model: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListOutsidersOptions {
  enabledOnly?: boolean;
}

export class InvalidOutsiderHandleError extends Error {
  constructor(handle: string) {
    super(`invalid handle: "${handle}" — must match ^[a-z]{2,24}$`);
    this.name = 'InvalidOutsiderHandleError';
  }
}

export class DuplicateOutsiderError extends Error {
  constructor(tenantId: string, handle: string) {
    super(`duplicate outsider: (${tenantId}, ${handle}) already exists`);
    this.name = 'DuplicateOutsiderError';
  }
}

const HANDLE_RE = /^[a-z]{2,24}$/;

function assertValidHandle(handle: string): void {
  if (!HANDLE_RE.test(handle)) {
    throw new InvalidOutsiderHandleError(handle);
  }
}

function rowToOutsider(row: Record<string, unknown>): OutsiderRow {
  return {
    tenantId:    row.tenant_id    as string,
    handle:      row.handle       as string,
    displayName: row.display_name as string,
    cli:         row.cli          as OutsiderCli,
    client:      row.client       as string,
    projectDir:  row.project_dir  as string,
    model:       row.model        as string,
    enabled:     row.enabled      as boolean,
    createdAt:   row.created_at   as Date,
    updatedAt:   row.updated_at   as Date,
  };
}

export interface CreateOutsiderInput {
  handle: string;
  displayName: string;
  cli: OutsiderCli;
  client: string;
  projectDir: string;
}

export async function createOutsider(
  tenantId: string,
  input: CreateOutsiderInput,
): Promise<OutsiderRow> {
  assertValidHandle(input.handle);

  const pool = getPool();
  try {
    const res = await pool.query(
      `INSERT INTO boss_outsiders
         (tenant_id, handle, display_name, cli, client, project_dir)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tenantId, input.handle, input.displayName, input.cli, input.client, input.projectDir],
    );
    return rowToOutsider(res.rows[0]);
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new DuplicateOutsiderError(tenantId, input.handle);
    }
    throw err;
  }
}

export async function getOutsider(
  tenantId: string,
  handle: string,
): Promise<OutsiderRow | null> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM boss_outsiders WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
  if (res.rows.length === 0) return null;
  return rowToOutsider(res.rows[0]);
}

export async function listOutsiders(
  tenantId: string,
  options: ListOutsidersOptions = {},
): Promise<OutsiderRow[]> {
  const pool = getPool();
  const { enabledOnly = false } = options;

  const res = enabledOnly
    ? await pool.query(
        `SELECT * FROM boss_outsiders WHERE tenant_id = $1 AND enabled = TRUE ORDER BY handle`,
        [tenantId],
      )
    : await pool.query(
        `SELECT * FROM boss_outsiders WHERE tenant_id = $1 ORDER BY handle`,
        [tenantId],
      );

  return res.rows.map(rowToOutsider);
}

export async function deleteOutsider(
  tenantId: string,
  handle: string,
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM boss_outsiders WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface UpdateOutsiderInput {
  displayName?: string;
  cli?: OutsiderCli;
  client?: string;
  projectDir?: string;
  model?: string;
  enabled?: boolean;
}

export async function updateOutsider(
  tenantId: string,
  handle: string,
  patch: UpdateOutsiderInput,
): Promise<OutsiderRow | null> {
  const columnMap: Record<keyof UpdateOutsiderInput, string> = {
    displayName: 'display_name',
    cli:         'cli',
    client:      'client',
    projectDir:  'project_dir',
    model:       'model',
    enabled:     'enabled',
  };

  const entries = (Object.keys(patch) as Array<keyof UpdateOutsiderInput>)
    .filter((k) => patch[k] !== undefined)
    .map((k) => [columnMap[k], patch[k]] as [string, unknown]);

  if (entries.length === 0) {
    return getOutsider(tenantId, handle);
  }

  const pool = getPool();
  const setClauses = entries.map((entry, i) => `${entry[0]} = $${i + 3}`).join(', ');
  const values = [tenantId, handle, ...entries.map((e) => e[1])];

  const res = await pool.query(
    `UPDATE boss_outsiders
     SET ${setClauses}
     WHERE tenant_id = $1 AND handle = $2
     RETURNING *`,
    values,
  );

  if (res.rows.length === 0) return null;
  return rowToOutsider(res.rows[0]);
}
