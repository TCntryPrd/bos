/**
 * GET /workspaces — workspace options for the new-thread modal.
 *
 * Source of truth is the bind-mounted host directories visible to
 * boss_api: boss-dev (singleton), ~/rascals/* (one per rascal),
 * ~/outsiders/* (one per outsider). BOSS_HOME_OVERRIDE swaps the
 * root for tests.
 *
 * Registered under the /api/coo prefix in server.ts.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

interface Workspace {
  label: string;
  path: string;
  kind: 'boss-dev' | 'rascal' | 'outsider';
}

const DEFAULT_HOME = '/home/boss';

function listSubdirs(parent: string): string[] {
  try {
    return readdirSync(parent)
      .filter((name) => {
        try { return statSync(join(parent, name)).isDirectory(); }
        catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
}

export async function workspacesRoutes(server: FastifyInstance) {
  server.get('/workspaces', async (_req: FastifyRequest, reply: FastifyReply) => {
    const home = process.env.BOSS_HOME_OVERRIDE ?? DEFAULT_HOME;
    const out: Workspace[] = [];
    out.push({ label: 'boss-dev', path: join(home, 'boss-dev'), kind: 'boss-dev' });
    for (const handle of listSubdirs(join(home, 'rascals'))) {
      out.push({ label: handle, path: join(home, 'rascals', handle), kind: 'rascal' });
    }
    for (const handle of listSubdirs(join(home, 'outsiders'))) {
      out.push({ label: handle, path: join(home, 'outsiders', handle), kind: 'outsider' });
    }
    return reply.status(200).send(out);
  });
}
