/**
 * Kanban routes — /api/kanban/*
 * Powers the Kanban board surface (v1.7.11+). Reads/writes boss_tasks.
 * SSE fan-out via emitTaskChanged.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import {
  PROJECT_STAGES,
  CLIENT_COLUMNS,
  CLIENT_COLUMN_LABELS,
  isClientColumn,
  isProjectStage,
} from '../constants/kanban.js';
import {
  emitTaskChanged,
  subscribeTaskChanged,
  type KanbanTaskRow,
} from '../lib/emitTaskChanged.js';

function getTenantId(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

interface BoardQuery {
  scope?: string;
  handle?: string;
  view?: string;
  include_archived?: string;
}

function buildScopeFilter(
  scope: string | undefined,
  handle: string | undefined,
): { where: string; params: unknown[] } | { error: string } {
  switch (scope) {
    case 'global':
    case undefined:
      return { where: '', params: [] };
    case 'rascal':
    case 'outsider':
      if (!handle) return { error: `scope=${scope} requires handle` };
      return { where: 'AND assigned_agent = $H', params: [handle] };
    case 'coo':
      return { where: "AND assigned_agent = 'coo'", params: [] };
    case 'coe':
      return { where: "AND assigned_agent = 'coe'", params: [] };
    default:
      return { error: `unknown scope: ${scope}` };
  }
}

export default async function kanbanRoutes(app: FastifyInstance): Promise<void> {
  // -------- GET /api/kanban/board --------
  app.get('/kanban/board', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const q = req.query as BoardQuery;
    const view = q.view ?? 'client';
    if (view !== 'client' && view !== 'project' && view !== 'in-house') {
      return reply.code(400).send({ error: `view must be 'client', 'project', or 'in-house', got '${view}'` });
    }

    const scope = buildScopeFilter(q.scope, q.handle);
    if ('error' in scope) return reply.code(400).send({ error: scope.error });

    const includeArchived = q.include_archived === '1';
    const archivedClause = includeArchived ? '' : 'AND archived_at IS NULL';

    let scopeWhere = scope.where;
    const params: unknown[] = [tenantId, ...scope.params];
    if (scopeWhere.includes('$H')) {
      scopeWhere = scopeWhere.replace('$H', `$${params.length}`);
    }

    // Filter by work type (in-house vs client)
    let workTypeClause = '';
    if (view === 'in-house') {
      // In-house: assigned to Outsiders (employees) from any tenant OR no assigned_agent
      workTypeClause = `AND (
        assigned_agent IN (SELECT handle FROM boss_outsiders)
        OR assigned_agent IS NULL
      )`;
    } else if (view === 'client') {
      // Client: assigned to Rascals (client managers) from any tenant
      workTypeClause = `AND assigned_agent IN (
        SELECT handle FROM boss_rascals
      )`;
    }
    // project view: no filter, show all

    const sql = `
      SELECT * FROM boss_tasks
       WHERE tenant_id = $1
         ${scopeWhere}
         ${archivedClause}
         ${workTypeClause}
       ORDER BY priority DESC, due_at ASC NULLS LAST, updated_at DESC
    `;
    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(sql, params);

    const columns = view === 'project'
      ? PROJECT_STAGES.map((key) => ({
          key,
          label: key,
          count: 0,
          tasks: [] as KanbanTaskRow[],
        }))
      : CLIENT_COLUMNS.map((key) => ({
          key,
          label: CLIENT_COLUMN_LABELS[key],
          count: 0,
          tasks: [] as KanbanTaskRow[],
        }));

    for (const row of r.rows) {
      const colKey = view === 'client' ? row.view_column : row.current_stage;
      const col = columns.find((c) => c.key === colKey);
      if (col) {
        col.tasks.push(row);
        col.count += 1;
      }
    }

    return reply.send({
      view,
      scope: { kind: q.scope ?? 'global', handle: q.handle },
      columns,
    });
  });

  // -------- POST /api/kanban/tasks --------
  interface CreateTaskBody {
    title?: string;
    pipeline_id?: string | null;
    current_stage?: string;
    view_column?: string;
    status?: string;
    assigned_agent?: string | null;
    assigned_client?: string | null;
    priority?: number;
    due_at?: string | null;
    context?: Record<string, unknown>;
  }
  app.post('/kanban/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const body = (req.body ?? {}) as CreateTaskBody;
    const title = (body.title ?? '').trim();
    if (!title) return reply.code(400).send({ error: 'title is required' });

    const view_column = body.view_column ?? 'inbox';
    if (!isClientColumn(view_column)) {
      return reply.code(400).send({ error: `view_column must be one of ${CLIENT_COLUMNS.join(',')}` });
    }
    const current_stage = body.current_stage ?? 'Initiated';
    if (!isProjectStage(current_stage)) {
      return reply.code(400).send({ error: `current_stage must be one of ${PROJECT_STAGES.join(', ')}` });
    }

    const status = body.status ?? 'pending';
    const priority = body.priority ?? 5;
    if (priority < 1 || priority > 10) {
      return reply.code(400).send({ error: 'priority must be 1..10' });
    }

    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `INSERT INTO boss_tasks
        (tenant_id, pipeline_id, title, current_stage, status, assigned_agent,
         assigned_client, priority, view_column, due_at, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        tenantId,
        body.pipeline_id ?? null,
        title,
        current_stage,
        status,
        body.assigned_agent ?? null,
        body.assigned_client ?? null,
        priority,
        view_column,
        body.due_at ?? null,
        body.context ?? {},
      ],
    );
    const task = r.rows[0];
    emitTaskChanged({ id: task.id, tenantId, task });
    return reply.code(201).send({ task });
  });

  // -------- PATCH /api/kanban/tasks/:id --------
  interface PatchTaskBody {
    title?: string;
    priority?: number;
    assigned_agent?: string | null;
    assigned_client?: string | null;
    status?: string;
    due_at?: string | null;
  }
  const PATCHABLE_FIELDS: ReadonlyArray<keyof PatchTaskBody> = [
    'title', 'priority', 'assigned_agent', 'assigned_client', 'status', 'due_at',
  ];
  app.patch('/kanban/tasks/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as PatchTaskBody;

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const field of PATCHABLE_FIELDS) {
      if (body[field] !== undefined) {
        params.push(body[field]);
        sets.push(`${field} = $${params.length}`);
      }
    }
    if (sets.length === 0) {
      return reply.code(400).send({ error: 'no updatable fields supplied' });
    }
    params.push(id, tenantId);
    const sql = `
      UPDATE boss_tasks SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING *
    `;
    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(sql, params);
    if (r.rowCount === 0) return reply.code(404).send({ error: 'task not found' });
    const task = r.rows[0];
    emitTaskChanged({ id, tenantId, task });
    return reply.send({ task });
  });

  // -------- POST /api/kanban/tasks/:id/move --------
  interface MoveBody { view?: string; to?: string }
  app.post('/kanban/tasks/:id/move', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as MoveBody;

    if (body.view === 'client') {
      if (!isClientColumn(body.to)) {
        return reply.code(400).send({ error: `to must be one of ${CLIENT_COLUMNS.join(',')}` });
      }
      const pool = getPool();
      const r = await pool.query<KanbanTaskRow>(
        `UPDATE boss_tasks SET view_column = $1
          WHERE id = $2 AND tenant_id = $3 RETURNING *`,
        [body.to, id, tenantId],
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'task not found' });
      const task = r.rows[0];
      emitTaskChanged({ id, tenantId, task });
      return reply.send({ task });
    }

    if (body.view === 'project') {
      if (!isProjectStage(body.to)) {
        return reply.code(400).send({ error: `to must be one of ${PROJECT_STAGES.join(', ')}` });
      }
      const pool = getPool();
      const r = await pool.query<KanbanTaskRow>(
        `UPDATE boss_tasks
            SET current_stage = $1,
                stage_history = stage_history ||
                  jsonb_build_array(
                    jsonb_build_object(
                      'from', current_stage,
                      'to', $1::text,
                      'at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                      'by', 'kevin'
                    )
                  )
          WHERE id = $2 AND tenant_id = $3 RETURNING *`,
        [body.to, id, tenantId],
      );
      if (r.rowCount === 0) return reply.code(404).send({ error: 'task not found' });
      const task = r.rows[0];
      emitTaskChanged({ id, tenantId, task });
      return reply.send({ task });
    }

    return reply.code(400).send({ error: "view must be 'client' or 'project'" });
  });

  // -------- POST /api/kanban/tasks/:id/approve --------
  app.post('/kanban/tasks/:id/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `UPDATE boss_tasks SET status = 'active'
        WHERE id = $1 AND tenant_id = $2 AND status = 'blocked' RETURNING *`,
      [id, tenantId],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'task not found or not blocked' });
    const task = r.rows[0];
    emitTaskChanged({ id, tenantId, task });
    return reply.send({ task });
  });

  // -------- POST /api/kanban/tasks/:id/final-approve --------
  // Kevin's "yes, this is done" on a pending-final-review item.
  // Only valid when view_column='to_close'. Moves to done.
  app.post('/kanban/tasks/:id/final-approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `UPDATE boss_tasks
          SET view_column = 'done',
              context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
                'final_approved_at', to_char(now() AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              )
        WHERE id = $1 AND tenant_id = $2
              AND view_column = 'to_close'
              AND archived_at IS NULL
        RETURNING *`,
      [id, tenantId],
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({
        error: 'task not found or not in pending-final-review',
      });
    }
    const task = r.rows[0];
    emitTaskChanged({ id, tenantId, task });
    return reply.send({ task });
  });

  // -------- POST /api/kanban/tasks/:id/reopen --------
  // Kevin sends a pending-review item back to the rascal for more work.
  // Resets status=active, view_column=in_progress.
  app.post('/kanban/tasks/:id/reopen', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { note?: string };
    const note = typeof body.note === 'string' ? body.note : '';
    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `UPDATE boss_tasks
          SET status = 'active',
              view_column = 'in_progress',
              context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
                'reopened_at', to_char(now() AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'reopen_note', $3::text
              )
        WHERE id = $1 AND tenant_id = $2
              AND view_column = 'to_close'
              AND archived_at IS NULL
        RETURNING *`,
      [id, tenantId, note],
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({
        error: 'task not found or not in pending-final-review',
      });
    }
    const task = r.rows[0];
    emitTaskChanged({ id, tenantId, task });
    return reply.send({ task });
  });

  // -------- POST /api/kanban/tasks/:id/archive --------
  app.post('/kanban/tasks/:id/archive', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `UPDATE boss_tasks SET archived_at = now()
        WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL RETURNING *`,
      [id, tenantId],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'task not found or already archived' });
    const task = r.rows[0];
    emitTaskChanged({ id, tenantId, task });
    return reply.send({ task });
  });

  // -------- DELETE /api/kanban/tasks/:id (only when view_column='done') --------
  app.delete('/kanban/tasks/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const pool = getPool();
    const guard = await pool.query<{ view_column: string }>(
      `SELECT view_column FROM boss_tasks WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (guard.rowCount === 0) return reply.code(404).send({ error: 'task not found' });
    if (guard.rows[0].view_column !== 'done') {
      return reply.code(403).send({ error: 'hard delete only allowed on Done column' });
    }
    await pool.query(
      `DELETE FROM boss_tasks WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    emitTaskChanged({ id, tenantId, task: null });
    return reply.code(204).send();
  });

  // -------- GET /api/kanban/stream --------
  app.get('/kanban/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);

    const unsubscribe = subscribeTaskChanged((payload) => {
      if (payload.tenantId !== tenantId) return;
      reply.raw.write(`event: task.changed\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    return new Promise<void>(() => { /* held open until client disconnects */ });
  });
}
