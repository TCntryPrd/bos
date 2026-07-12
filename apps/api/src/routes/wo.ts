/**
 * Work Order routes — /api/wo/*
 *
 * AIOS v2.1 section 9 #6. Kevin submits work orders from the UI with a
 * time bucket (today / tomorrow / this_week / next_week). Rascals call
 * heartbeat on a cron to claim their next eligible WO. Completion writes
 * status back so the kanban surface and the heartbeat queue stay in sync.
 *
 * WOs are boss_tasks rows with `bucket` set. Plain kanban tasks have
 * NULL bucket and are invisible to the heartbeat. Both surfaces share
 * the same storage so the kanban always reflects WO state.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import {
  WO_BUCKETS,
  type WoBucket,
  isWoBucket,
  woGateAtSql,
} from '../constants/wo.js';
import { emitTaskChanged, type KanbanTaskRow } from '../lib/emitTaskChanged.js';

function getTenantId(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

interface SubmitWoBody {
  handle?: string;
  title?: string;
  body?: string;
  bucket?: WoBucket | string;
  priority?: number;
  client?: string | null;
}

interface HeartbeatBody {
  handle?: string;
  limit?: number;
}

interface ListWoQuery {
  handle?: string;
  include_done?: string;
  include_picked?: string;
}

export default async function woRoutes(app: FastifyInstance): Promise<void> {
  // -------- POST /api/wo --------  submit a new WO
  app.post('/wo', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const body = (req.body ?? {}) as SubmitWoBody;

    const handle = (body.handle ?? '').trim();
    if (!handle) return reply.code(400).send({ error: 'handle is required' });

    const title = (body.title ?? '').trim();
    if (!title) return reply.code(400).send({ error: 'title is required' });

    if (!isWoBucket(body.bucket)) {
      return reply.code(400).send({
        error: `bucket must be one of ${WO_BUCKETS.join(', ')}`,
      });
    }
    const bucket: WoBucket = body.bucket;

    const priority = body.priority ?? 5;
    if (priority < 1 || priority > 10) {
      return reply.code(400).send({ error: 'priority must be 1..10' });
    }

    const context = body.body ? { body: body.body } : {};

    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `INSERT INTO boss_tasks
         (tenant_id, title, current_stage, status, assigned_agent,
          assigned_client, priority, view_column, context,
          bucket, gate_at)
       VALUES ($1, $2, 'Initiated', 'pending', $3,
               $4, $5, 'inbox', $6,
               $7, ${woGateAtSql('$7')})
       RETURNING *`,
      [tenantId, title, handle, body.client ?? null, priority, context, bucket],
    );
    const task = r.rows[0];
    emitTaskChanged({ id: task.id, tenantId, task });
    return reply.code(201).send({ wo: task });
  });

  // -------- GET /api/wo?handle=&include_done= --------  list WOs for an agent
  app.get('/wo', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const q = (req.query ?? {}) as ListWoQuery;
    const handle = (q.handle ?? '').trim();
    if (!handle) return reply.code(400).send({ error: 'handle is required' });

    const includeDone = q.include_done === '1';
    const statusClause = includeDone ? '' : "AND status <> 'done'";

    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `SELECT * FROM boss_tasks
        WHERE tenant_id = $1
          AND assigned_agent = $2
          AND bucket IS NOT NULL
          AND archived_at IS NULL
          ${statusClause}
        ORDER BY status ASC, gate_at ASC NULLS LAST, priority DESC, created_at ASC`,
      [tenantId, handle],
    );
    return reply.send({ wos: r.rows });
  });

  // -------- POST /api/wo/heartbeat --------  rascal claims its next eligible WO
  // Atomic via FOR UPDATE SKIP LOCKED. Concurrent heartbeats cannot double-claim.
  app.post('/wo/heartbeat', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const body = (req.body ?? {}) as HeartbeatBody;
    const handle = (body.handle ?? '').trim();
    if (!handle) return reply.code(400).send({ error: 'handle is required' });

    const limit = Math.max(1, Math.min(10, body.limit ?? 1));

    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `WITH next_wo AS (
         SELECT id FROM boss_tasks
          WHERE tenant_id = $1
            AND assigned_agent = $2
            AND status = 'pending'
            AND bucket IS NOT NULL
            AND picked_at IS NULL
            AND gate_at IS NOT NULL
            AND gate_at <= now()
            AND archived_at IS NULL
          ORDER BY priority DESC, gate_at ASC, created_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       UPDATE boss_tasks SET status = 'active', picked_at = now()
        WHERE id IN (SELECT id FROM next_wo)
        RETURNING *`,
      [tenantId, handle, limit],
    );

    for (const task of r.rows) {
      emitTaskChanged({ id: task.id, tenantId, task });
    }
    return reply.send({ claimed: r.rows });
  });

  // -------- POST /api/wo/:id/complete --------  mark a claimed WO done
  interface CompleteBody { result?: string }
  app.post('/wo/:id/complete', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as CompleteBody;

    const pool = getPool();
    const r = await pool.query<KanbanTaskRow>(
      `UPDATE boss_tasks
          SET status = 'done',
              context = COALESCE(context, '{}'::jsonb)
                || jsonb_build_object('result', $1::text,
                                      'completed_at', to_char(now() AT TIME ZONE 'UTC',
                                                              'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        WHERE id = $2 AND tenant_id = $3 AND bucket IS NOT NULL
        RETURNING *`,
      [body.result ?? null, id, tenantId],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'wo not found' });
    const task = r.rows[0];
    emitTaskChanged({ id, tenantId, task });
    return reply.send({ wo: task });
  });
}
