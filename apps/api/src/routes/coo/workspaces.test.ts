/**
 * Tests for GET /api/coo/workspaces — returns the dropdown source for
 * the new-thread modal. Reads the host filesystem (rascal + outsider
 * dirs); we stub via BOSS_HOME_OVERRIDE for determinism.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server.js';
import { closeDb } from '../../db.js';

const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

let server: FastifyInstance | null = null;
let scratchHome: string;

beforeAll(async () => {
  scratchHome = mkdtempSync(join(tmpdir(), 'coo-ws-'));
  mkdirSync(join(scratchHome, 'boss-dev'), { recursive: true });
  mkdirSync(join(scratchHome, 'rascals/darla'), { recursive: true });
  mkdirSync(join(scratchHome, 'rascals/spanky'), { recursive: true });
  mkdirSync(join(scratchHome, 'outsiders/ponyboy'), { recursive: true });
  process.env.BOSS_HOME_OVERRIDE = scratchHome;
  server = await buildServer();
});

afterAll(async () => {
  if (server) await server.close();
  await closeDb();
  rmSync(scratchHome, { recursive: true, force: true });
  delete process.env.BOSS_HOME_OVERRIDE;
});

describe('GET /api/coo/workspaces', () => {
  it('returns boss-dev + rascal dirs + outsider dirs', async () => {
    const res = await server!.inject({
      method: 'GET',
      url: '/api/coo/workspaces',
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ label: string; path: string; kind: string }>;
    expect(body).toContainEqual(expect.objectContaining({ kind: 'boss-dev' }));
    expect(body.filter((w) => w.kind === 'rascal').map((w) => w.label).sort()).toEqual(['darla', 'spanky']);
    expect(body.filter((w) => w.kind === 'outsider').map((w) => w.label)).toEqual(['ponyboy']);
  });

  it('returns 401 without auth header', async () => {
    const res = await server!.inject({ method: 'GET', url: '/api/coo/workspaces' });
    expect(res.statusCode).toBe(401);
  });
});
