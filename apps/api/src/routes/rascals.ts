/**
 * rascals.ts — HTTP routes for the boss_rascals registry.
 *
 * CRUD: GET/POST/PATCH/DELETE on /api/agents/rascals[/:handle]
 * Import: POST /api/agents/rascals/import-presets
 * Test helper: POST /api/agents/rascals/_test_reset (NODE_ENV=test only)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  listRascals,
  getRascal,
  createRascal,
  updateRascal,
  deleteRascal,
  importPresets,
  type RascalCli,
} from '../agents/rascals-repo.js';
import { getPool } from '../db.js';

function tenantOf(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

type CreateBody = {
  handle: string;
  displayName: string;
  cli: RascalCli;
  client: string;
  projectDir?: string;
  model?: string;
  enabled?: boolean;
};

type PatchBody = Partial<Omit<CreateBody, 'handle'>>;

type ImportBody = { handles?: string[] };

export async function rascalsRoutes(server: FastifyInstance) {
  server.get<{ Querystring: { enabled?: string; handle?: string } }>(
    '/agents/rascals',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const enabledOnly = request.query.enabled === 'true';
      if (request.query.handle) {
        const one = await getRascal(tenantId, request.query.handle);
        return reply.send({ rascals: one ? [one] : [] });
      }
      const rascals = await listRascals(tenantId, { enabledOnly });
      return reply.send({ rascals });
    },
  );

  /**
   * GET /api/agents/rascals/recent-activity
   * Returns the most recently modified output files across every rascal,
   * formatted as activity entries for the dashboard's Live Activity feed.
   *
   * Each rascal's outputs live at /home/tcntryprd/rascals/<handle>/output.
   * Inferred verb: ".md"/".txt" → "wrote", everything else → "produced".
   */
  server.get<{ Querystring: { limit?: string } }>(
    '/agents/rascals/recent-activity',
    async (request, reply) => {
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '10', 10) || 10, 1), 50);
      const root = '/home/tcntryprd/rascals';
      const entries: Array<{
        agent: string; filename: string; path: string; mtime: string; sizeBytes: number; action: string;
      }> = [];
      try {
        const handles = await fs.readdir(root, { withFileTypes: true });
        for (const dir of handles) {
          if (!dir.isDirectory()) continue;
          if (dir.name.startsWith('.') || dir.name === 'logs') continue;
          const outputDir = path.join(root, dir.name, 'output');
          let files: string[] = [];
          try { files = await fs.readdir(outputDir); } catch { continue; }
          for (const fname of files) {
            if (fname.startsWith('.')) continue;
            const fullPath = path.join(outputDir, fname);
            try {
              const st = await fs.stat(fullPath);
              if (!st.isFile()) continue;
              const ext = path.extname(fname).toLowerCase();
              const action = (ext === '.md' || ext === '.txt' || ext === '.json') ? 'wrote' : 'produced';
              entries.push({
                agent: dir.name,
                filename: fname,
                path: fullPath,
                mtime: st.mtime.toISOString(),
                sizeBytes: st.size,
                action,
              });
            } catch { /* skip unreadable */ }
          }
        }
      } catch (err) {
        request.log.warn({ err }, 'recent-activity: scan failed');
        // Non-fatal — fall through to agent-run activity below.
      }

      // Employee Agent runs (boss_agent_runs) are the real activity signal for
      // the BOS Employee Agents — they don't write to a host output dir. Merge
      // each recent run in as an activity entry so the dashboard reflects them.
      try {
        const { rows } = await getPool().query<{
          id: string; agent_name: string; status: string;
          tokens_in: number; tokens_out: number; summary: string | null; ts: Date;
        }>(
          `SELECT id, agent_name, status, tokens_in, tokens_out, summary,
                  COALESCE(finished_at, started_at) AS ts
             FROM boss_agent_runs
            ORDER BY ts DESC NULLS LAST
            LIMIT $1`,
          [limit],
        );
        for (const r of rows) {
          const done = r.status === 'ok' || r.status === 'completed' || r.status === 'success';
          const what = r.summary && r.summary.trim()
            ? r.summary.trim().split('\n')[0].slice(0, 80)
            : (done ? 'a run' : 'a failed run');
          entries.push({
            agent: r.agent_name || 'agent',
            filename: what,
            path: `run-${r.id}`,
            mtime: new Date(r.ts).toISOString(),
            sizeBytes: (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0),
            action: done ? 'completed' : 'failed',
          });
        }
      } catch (err) {
        request.log.warn({ err }, 'recent-activity: agent_runs query failed');
      }

      if (entries.length === 0) return reply.send({ entries: [] });
      entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
      return reply.send({ entries: entries.slice(0, limit) });
    },
  );

  server.post<{ Body: CreateBody }>(
    '/agents/rascals',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      try {
        const preset = {
          handle: request.body.handle,
          displayName: request.body.displayName,
          cli: request.body.cli,
          client: request.body.client,
          projectDir: request.body.projectDir ?? '',
        };
        let created = await createRascal(tenantId, preset);
        // Apply model + enabled overrides if provided (createRascal uses DB defaults)
        const followUp: { model?: string; enabled?: boolean } = {};
        if (typeof request.body.model === 'string' && request.body.model.length > 0) {
          followUp.model = request.body.model;
        }
        if (request.body.enabled === true) {
          followUp.enabled = true;
        }
        if (Object.keys(followUp).length > 0) {
          created = (await updateRascal(tenantId, preset.handle, followUp)) ?? created;
        }
        return reply.status(201).send(created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(msg)) {
          return reply.status(409).send({ error: 'conflict', message: msg });
        }
        if (/invalid handle/i.test(msg)) {
          return reply.status(400).send({ error: 'bad_request', message: msg });
        }
        throw err;
      }
    },
  );

  server.patch<{ Params: { handle: string }; Body: PatchBody }>(
    '/agents/rascals/:handle',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const updated = await updateRascal(tenantId, request.params.handle, request.body);
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return reply.send(updated);
    },
  );

  server.delete<{ Params: { handle: string } }>(
    '/agents/rascals/:handle',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      // Refuse delete if tasks reference this handle
      const { rows: refs } = await getPool().query(
        `SELECT 1 FROM boss_tasks
          WHERE tenant_id = $1 AND assigned_agent = $2
            AND status IN ('pending','active','blocked') LIMIT 1`,
        [tenantId, request.params.handle],
      );
      if (refs.length > 0) {
        return reply.status(409).send({
          error: 'in_use',
          message: `Rascal "${request.params.handle}" has open tasks; advance or fail them before deleting.`,
        });
      }
      const ok = await deleteRascal(tenantId, request.params.handle);
      if (!ok) return reply.status(404).send({ error: 'not_found' });
      return reply.status(204).send();
    },
  );

  server.post<{ Body: ImportBody }>(
    '/agents/rascals/import-presets',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      try {
        const result = await importPresets(tenantId, request.body?.handles);
        return reply.send(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unknown preset/i.test(msg)) {
          return reply.status(400).send({ error: 'bad_request', message: msg });
        }
        throw err;
      }
    },
  );

  // Test-only helper (NODE_ENV=test only). Simplifies beforeEach in integration tests.
  if (process.env.NODE_ENV === 'test') {
    server.post('/agents/rascals/_test_reset', async (request, reply) => {
      const tenantId = tenantOf(request);
      await getPool().query(`DELETE FROM boss_rascals WHERE tenant_id = $1`, [tenantId]);
      return reply.status(204).send();
    });
  }
}
