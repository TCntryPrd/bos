/**
 * /threads — COO thread CRUD (list, create, rename).
 *
 * Threads are stored in boss_chat_sessions with agent_kind='coo'.
 * rascal_handle holds a kebab-case slug; workspace_dir is the cwd for
 * Claude Code spawns; system_prompt snapshots boss-dev/docs/COO.md
 * (or the built-in fallback) at create-time.
 *
 * Registered under the /api/coo prefix in server.ts via cooRoutes.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db.js';

const DEFAULT_HOME = '/home/boss';
const HOME = (): string => process.env.BOSS_HOME_OVERRIDE ?? DEFAULT_HOME;
const COO_MD_PATH = (): string => join(HOME(), 'boss-dev/docs/COO.md');

const FALLBACK_PERSONA = `You are BOS, Kevin Starr's Chief Operating Officer.

You operate inside whatever workspace the current thread points at.
Read CLAUDE.md in that workspace for project-specific context — but
your identity is BOS, not the workspace's resident agent.

You have full read/write access to the active workspace via Claude
Code's standard tool belt. Bypass mode is on. Don't ask before
reasonable actions; do them.

Be terse. Kevin reads diffs.`;

function readPersona(): string {
  try {
    if (existsSync(COO_MD_PATH())) {
      return readFileSync(COO_MD_PATH(), 'utf-8');
    }
  } catch { /* fall through */ }
  return FALLBACK_PERSONA;
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'thread';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

function listSubdirs(parent: string): string[] {
  try {
    return readdirSync(parent)
      .filter((name) => {
        try { return statSync(join(parent, name)).isDirectory(); }
        catch { return false; }
      });
  } catch {
    return [];
  }
}

function isAllowedWorkspace(dir: string): boolean {
  const home = HOME();
  const allowed = new Set<string>();
  allowed.add(join(home, 'boss-dev'));
  for (const sub of ['rascals', 'outsiders']) {
    for (const handle of listSubdirs(join(home, sub))) {
      allowed.add(join(home, sub, handle));
    }
  }
  return allowed.has(dir);
}

interface CreateBody { name: string; workspace_dir: string; }
interface RenameBody { name: string; }

// Hard cap on active (non-archived) COO threads per tenant.
// Soft-delete (archive) frees a slot. Increase if Kevin asks.
const MAX_ACTIVE_THREADS = 5;

export async function threadsRoutes(server: FastifyInstance) {
  // GET /threads
  server.get('/threads', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
    const { rows } = await getPool().query(
      `SELECT s.id, s.name, s.workspace_dir, s.created_at, s.updated_at,
              (SELECT content FROM boss_chat_messages
                 WHERE session_id = s.id
                 ORDER BY created_at DESC LIMIT 1) AS last_message_preview
         FROM boss_chat_sessions s
        WHERE s.tenant_id = $1
          AND s.agent_kind = 'coo'
          AND s.archived = FALSE
        ORDER BY s.updated_at DESC`,
      [tenantId],
    );
    return reply.status(200).send(rows);
  });

  // POST /threads
  server.post<{ Body: CreateBody }>('/threads', async (req, reply) => {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
    const body = (req.body ?? {}) as CreateBody;
    const { name, workspace_dir } = body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ error: 'name required' });
    }
    if (!workspace_dir || typeof workspace_dir !== 'string') {
      return reply.status(400).send({ error: 'workspace_dir required' });
    }
    if (!isAllowedWorkspace(workspace_dir)) {
      return reply.status(400).send({ error: 'workspace_dir not in allowlist' });
    }
    const cnt = await getPool().query(
      `SELECT count(*)::int AS n FROM boss_chat_sessions
        WHERE tenant_id = $1 AND agent_kind = 'coo' AND archived = FALSE`,
      [tenantId],
    );
    if (cnt.rows[0].n >= MAX_ACTIVE_THREADS) {
      return reply.status(400).send({
        error: `max ${MAX_ACTIVE_THREADS} active threads — delete one first`,
        max: MAX_ACTIVE_THREADS,
      });
    }
    const slug = slugify(name);
    const persona = readPersona();
    const { rows } = await getPool().query(
      `INSERT INTO boss_chat_sessions
         (tenant_id, agent_kind, rascal_handle, name, workspace_dir, system_prompt)
       VALUES ($1, 'coo', $2, $3, $4, $5)
       RETURNING id, name, workspace_dir, system_prompt, created_at, updated_at`,
      [tenantId, slug, name.trim(), workspace_dir, persona],
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /threads/:id
  server.patch<{ Params: { id: string }; Body: RenameBody }>('/threads/:id', async (req, reply) => {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
    const { id } = req.params;
    const body = (req.body ?? {}) as RenameBody;
    const { name } = body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ error: 'name required' });
    }
    const { rows } = await getPool().query(
      `UPDATE boss_chat_sessions
          SET name = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND agent_kind = 'coo'
        RETURNING id, name, workspace_dir, created_at, updated_at`,
      [id, tenantId, name.trim()],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'thread not found' });
    return reply.status(200).send(rows[0]);
  });

  // DELETE /threads/:id — soft delete (sets archived=true, hides from list).
  // The CC JSONL session in ~/.claude/projects/<workspace>/<uuid>.jsonl
  // is intentionally left on disk so the thread could be unarchived later.
  server.delete<{ Params: { id: string } }>('/threads/:id', async (req, reply) => {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
    const { id } = req.params;
    const { rows } = await getPool().query(
      `UPDATE boss_chat_sessions
          SET archived = TRUE, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND agent_kind = 'coo' AND archived = FALSE
        RETURNING id`,
      [id, tenantId],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'thread not found' });
    return reply.status(204).send();
  });
}
