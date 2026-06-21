/**
 * Pipeline Engine routes — /api/pipeline/* and /api/tasks/*
 *
 * Orchestration backbone for the Little Rascals autonomous agent framework.
 * Persistence via Postgres; stage-transition logic delegates to pipeline-engine.ts.
 *
 * See /home/boss/BOSS_V2_MASTER_PLAN.md §Phase 1.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { getPool } from '../db.js';
import {
  advance,
  approve,
  fail,
  start,
  PipelineTransitionError,
  type Pipeline,
  type PipelineStage,
  type StageLogStatus,
  type Task,
  type TaskStatus,
} from '../lib/pipeline-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_VIEW_COLUMNS = [
  'inbox',
  'today',
  'in_progress',
  'to_close',
  'done',
] as const;

const VALID_STATUSES = [
  'pending',
  'active',
  'blocked',
  'done',
  'failed',
] as const;

function getTenantId(request: FastifyRequest): string {
  return request.tenant?.tenantId ?? 'default';
}

async function loadPipeline(
  tenantId: string,
  id: string,
): Promise<Pipeline | null> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    stages: PipelineStage[];
  }>(
    `SELECT id, name, stages FROM boss_pipelines
       WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

async function loadTask(tenantId: string, id: string): Promise<Task | null> {
  const { rows } = await getPool().query(
    `SELECT id, pipeline_id, title, current_stage, status,
            assigned_agent, stage_history
       FROM boss_tasks
       WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    pipeline_id: r.pipeline_id,
    title: r.title,
    current_stage: r.current_stage,
    status: r.status as TaskStatus,
    assigned_agent: r.assigned_agent,
    stage_history: r.stage_history ?? [],
  };
}

async function persistTask(
  client: PoolClient,
  tenantId: string,
  task: Task,
): Promise<void> {
  await client.query(
    `UPDATE boss_tasks
        SET current_stage = $3,
            status        = $4,
            assigned_agent = $5,
            stage_history = $6::jsonb
      WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId,
      task.id,
      task.current_stage,
      task.status,
      task.assigned_agent,
      JSON.stringify(task.stage_history),
    ],
  );
}

// Map task-level status → stage_log.status domain.
// boss_tasks allows 'done'; boss_stage_log's CK does not. Without this
// mapping, the final advance on a completing task violates the CK and rolls
// the whole transaction back.
export function mapStatusForLog(taskStatus: TaskStatus): StageLogStatus {
  if (taskStatus === 'done') return 'completed';
  if (taskStatus === 'pending') return 'active';
  return taskStatus;
}

async function logTransition(
  client: PoolClient,
  tenantId: string,
  taskId: string,
  stage: string,
  agent: string | null,
  status: StageLogStatus,
  output: string | null,
  notes: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO boss_stage_log
       (tenant_id, task_id, stage, agent, started_at, completed_at, output, notes, status)
     VALUES ($1, $2, $3, $4, now(), now(), $5, $6, $7)`,
    [tenantId, taskId, stage, agent, output, notes, status],
  );
}

// Run `work` inside a BEGIN/COMMIT transaction on a dedicated client.
// Any thrown error triggers ROLLBACK — ensuring persistTask + logTransition
// either both land or neither does.
async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function handleTransitionError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PipelineTransitionError) {
    return reply.status(409).send({ error: 'invalid_transition', message: err.message });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function pipelineRoutes(server: FastifyInstance) {
  // ---- Pipelines CRUD ------------------------------------------------------

  server.get('/pipeline', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { rows } = await getPool().query(
      `SELECT id, name, description, stages, created_at, updated_at
         FROM boss_pipelines
         WHERE tenant_id = $1
         ORDER BY name`,
      [tenantId],
    );
    return reply.send({ pipelines: rows });
  });

  server.post<{ Body: { name: string; description?: string; stages: PipelineStage[] } }>(
    '/pipeline',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const { name, description, stages } = request.body;
      if (!name || !Array.isArray(stages) || stages.length === 0) {
        return reply.status(400).send({ error: 'name and non-empty stages[] required' });
      }
      const { rows } = await getPool().query(
        `INSERT INTO boss_pipelines (tenant_id, name, description, stages)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, name, description, stages, created_at`,
        [tenantId, name, description ?? null, JSON.stringify(stages)],
      );
      return reply.status(201).send(rows[0]);
    },
  );

  server.get<{ Params: { id: string } }>('/pipeline/:id', async (request, reply) => {
    const tenantId = getTenantId(request);
    const pipeline = await loadPipeline(tenantId, request.params.id);
    if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' });
    return reply.send(pipeline);
  });

  // ---- Tasks CRUD ----------------------------------------------------------

  server.get<{ Querystring: { agent?: string; client?: string; status?: string } }>(
    '/tasks',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const { agent, client, status } = request.query;
      if (
        status &&
        !VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])
      ) {
        return reply
          .status(400)
          .send({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
      }
      const clauses: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (agent) {
        params.push(agent);
        clauses.push(`assigned_agent = $${params.length}`);
      }
      if (client) {
        params.push(client);
        clauses.push(`assigned_client = $${params.length}`);
      }
      if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
      }
      const { rows } = await getPool().query(
        `SELECT id, pipeline_id, title, current_stage, status,
                assigned_agent, assigned_client, priority, view_column,
                due_at, bucket, gate_at, picked_at, archived_at,
                created_at, updated_at
           FROM boss_tasks
           WHERE ${clauses.join(' AND ')}
             AND archived_at IS NULL
           ORDER BY priority ASC, created_at DESC`,
        params,
      );
      return reply.send({ tasks: rows });
    },
  );

  server.post<{
    Body: {
      pipeline_id: string;
      title: string;
      assigned_agent?: string;
      assigned_client?: string;
      priority?: number;
      view_column?: string;
      due_at?: string;
      context?: Record<string, unknown>;
    };
  }>('/tasks', async (request, reply) => {
    const tenantId = getTenantId(request);
    const {
      pipeline_id,
      title,
      assigned_agent,
      assigned_client,
      priority,
      view_column,
      due_at,
      context,
    } = request.body;

    if (!pipeline_id || !title) {
      return reply.status(400).send({ error: 'pipeline_id and title required' });
    }
    if (
      view_column &&
      !VALID_VIEW_COLUMNS.includes(view_column as (typeof VALID_VIEW_COLUMNS)[number])
    ) {
      return reply
        .status(400)
        .send({ error: `view_column must be one of ${VALID_VIEW_COLUMNS.join(', ')}` });
    }
    if (priority != null && (priority < 1 || priority > 10)) {
      return reply.status(400).send({ error: 'priority must be between 1 and 10' });
    }

    const pipeline = await loadPipeline(tenantId, pipeline_id);
    if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' });
    if (pipeline.stages.length === 0) {
      return reply.status(400).send({ error: 'pipeline has no stages' });
    }
    const firstStage = pipeline.stages[0].name;

    const { rows } = await getPool().query(
      `INSERT INTO boss_tasks
         (tenant_id, pipeline_id, title, current_stage, status,
          assigned_agent, assigned_client, priority, view_column,
          context, due_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING id, pipeline_id, title, current_stage, status,
                 assigned_agent, assigned_client, priority, view_column,
                 context, due_at, created_at`,
      [
        tenantId,
        pipeline_id,
        title,
        firstStage,
        assigned_agent ?? null,
        assigned_client ?? null,
        priority ?? 5,
        view_column ?? 'inbox',
        JSON.stringify(context ?? {}),
        due_at ?? null,
      ],
    );
    return reply.status(201).send(rows[0]);
  });

  server.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { rows } = await getPool().query(
      `SELECT t.id, t.pipeline_id, t.title, t.current_stage, t.status,
              t.assigned_agent, t.assigned_client, t.priority, t.view_column,
              t.context, t.stage_history, t.due_at, t.created_at, t.updated_at,
              l.history_log
         FROM boss_tasks t
         LEFT JOIN LATERAL (
           SELECT json_agg(log ORDER BY started_at) AS history_log
             FROM boss_stage_log log
             WHERE log.task_id = t.id AND log.tenant_id = t.tenant_id
         ) l ON TRUE
         WHERE t.tenant_id = $1 AND t.id = $2`,
      [tenantId, request.params.id],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'task not found' });
    return reply.send(rows[0]);
  });

  server.get<{ Params: { name: string } }>(
    '/tasks/agent/:name',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const { rows } = await getPool().query(
        `SELECT id, pipeline_id, title, current_stage, status,
                assigned_agent, assigned_client, priority, view_column, due_at
           FROM boss_tasks
           WHERE tenant_id = $1 AND assigned_agent = $2
             AND status IN ('pending','active','blocked')
           ORDER BY priority ASC, created_at ASC`,
        [tenantId, request.params.name],
      );
      return reply.send({ agent: request.params.name, tasks: rows });
    },
  );

  // ---- State transitions ---------------------------------------------------

  server.post<{ Params: { id: string } }>(
    '/tasks/:id/start',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const task = await loadTask(tenantId, request.params.id);
      if (!task) return reply.status(404).send({ error: 'task not found' });
      if (!task.pipeline_id) {
        return reply.status(400).send({ error: 'task has no pipeline' });
      }
      const pipeline = await loadPipeline(tenantId, task.pipeline_id);
      if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' });

      try {
        const result = start(task, pipeline);
        await withTransaction(async (client) => {
          await persistTask(client, tenantId, result.task);
          await logTransition(
            client,
            tenantId,
            result.task.id,
            result.task.current_stage,
            result.task.assigned_agent,
            result.task.status === 'blocked' ? 'blocked' : 'active',
            null,
            'task started',
          );
        });
        return reply.send(result);
      } catch (err) {
        return handleTransitionError(reply, err);
      }
    },
  );

  server.post<{ Params: { id: string }; Body: { output: string } }>(
    '/tasks/:id/advance',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const { output } = request.body ?? { output: '' };
      const task = await loadTask(tenantId, request.params.id);
      if (!task) return reply.status(404).send({ error: 'task not found' });
      if (!task.pipeline_id) {
        return reply.status(400).send({ error: 'task has no pipeline' });
      }
      const pipeline = await loadPipeline(tenantId, task.pipeline_id);
      if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' });

      try {
        const result = advance(task, pipeline, output ?? '');
        await withTransaction(async (client) => {
          await persistTask(client, tenantId, result.task);
          await logTransition(
            client,
            tenantId,
            result.task.id,
            result.task.current_stage,
            result.task.assigned_agent,
            mapStatusForLog(result.task.status),
            output ?? null,
            result.complete ? 'pipeline complete' : 'advanced',
          );
        });
        return reply.send(result);
      } catch (err) {
        return handleTransitionError(reply, err);
      }
    },
  );

  server.post<{ Params: { id: string } }>(
    '/tasks/:id/approve',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const task = await loadTask(tenantId, request.params.id);
      if (!task) return reply.status(404).send({ error: 'task not found' });
      if (!task.pipeline_id) {
        return reply.status(400).send({ error: 'task has no pipeline' });
      }
      const pipeline = await loadPipeline(tenantId, task.pipeline_id);
      if (!pipeline) return reply.status(404).send({ error: 'pipeline not found' });

      try {
        const result = approve(task, pipeline);
        await withTransaction(async (client) => {
          await persistTask(client, tenantId, result.task);
          await logTransition(
            client,
            tenantId,
            result.task.id,
            result.task.current_stage,
            result.task.assigned_agent,
            mapStatusForLog(result.task.status),
            null,
            'approved',
          );
        });
        return reply.send(result);
      } catch (err) {
        return handleTransitionError(reply, err);
      }
    },
  );

  server.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/tasks/:id/fail',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const reason = request.body?.reason ?? 'unspecified';
      const task = await loadTask(tenantId, request.params.id);
      if (!task) return reply.status(404).send({ error: 'task not found' });

      const failed = fail(task, reason);
      await withTransaction(async (client) => {
        await persistTask(client, tenantId, failed);
        await logTransition(
          client,
          tenantId,
          failed.id,
          failed.current_stage,
          failed.assigned_agent,
          'failed',
          null,
          reason,
        );
      });
      return reply.send({ task: failed });
    },
  );

  // ---- POST /tasks/:id/complete -------------------------------------------
  // Agent-facing completion. Bypasses the pipeline-engine (which works in
  // stage units) so non-pipeline tasks and ad-hoc work can be closed too.
  //
  // Body:
  //   result               — short summary the agent wants persisted
  //   client_deliverable   — true if Kevin should review before final close
  //                          (default false; non-client work closes immediately)
  //
  // Side-effect: if the completing agent is an Outsider AND context.from is
  // a Rascal handle, auto-create a sibling response card on the Rascal's
  // queue so the Rascal sees their request was answered.
  server.post<{
    Params: { id: string };
    Body: { result?: string; client_deliverable?: boolean };
  }>('/tasks/:id/complete', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params;
    const body = request.body ?? {};
    const result = typeof body.result === 'string' ? body.result : '';
    const clientDeliverable = body.client_deliverable === true;

    const pool = getPool();
    const found = await pool.query(
      `SELECT id, kind, status, view_column, context, assigned_agent
         FROM boss_tasks
         WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (found.rowCount === 0) {
      return reply.status(404).send({ error: 'task not found' });
    }
    const row = found.rows[0];
    if (row.kind === 'response') {
      return reply.status(400).send({
        error: 'response cards cannot be completed; use /ack to dismiss',
      });
    }
    if (row.status === 'done' || row.status === 'failed') {
      return reply.status(409).send({ error: 'task already closed' });
    }

    const targetView = clientDeliverable ? 'to_close' : 'done';
    const nowIso = new Date().toISOString();
    const updated = await pool.query(
      `UPDATE boss_tasks
          SET status = 'done',
              view_column = $3,
              context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
                'result', $4::text,
                'completed_at', $5::text,
                'client_deliverable', $6::boolean
              )
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, id, targetView, result, nowIso, clientDeliverable],
    );
    const task = updated.rows[0];

    // Auto-response: Outsider closed a task that came FROM a Rascal.
    let responseRow: unknown = null;
    const fromHandle =
      task.context && typeof task.context === 'object' && task.context.from
        ? String(task.context.from)
        : null;
    if (fromHandle && task.assigned_agent) {
      const outsiderCheck = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM boss_outsiders
            WHERE tenant_id = $1 AND handle = $2 AND enabled = true
         ) AS exists`,
        [tenantId, task.assigned_agent],
      );
      const fromRascalCheck = await pool.query<{ exists: boolean }>(
        `SELECT NOT EXISTS (
           SELECT 1 FROM boss_outsiders
            WHERE tenant_id = $1 AND handle = $2
         ) AS exists`,
        [tenantId, fromHandle],
      );
      const completedByOutsider = outsiderCheck.rows[0]?.exists === true;
      const requestedByRascal = fromRascalCheck.rows[0]?.exists === true;
      if (completedByOutsider && requestedByRascal) {
        const respIns = await pool.query(
          `INSERT INTO boss_tasks
             (tenant_id, kind, title, current_stage, status,
              assigned_agent, priority, view_column, context)
            VALUES ($1, 'response', $2, 'response', 'pending',
                    $3, 5, 'inbox', $4::jsonb)
            RETURNING *`,
          [
            tenantId,
            `Reply from ${task.assigned_agent}: ${task.title}`.slice(0, 200),
            fromHandle,
            JSON.stringify({
              replies_to: task.id,
              from: task.assigned_agent,
              result,
              original_title: task.title,
            }),
          ],
        );
        responseRow = respIns.rows[0];
      }
    }

    return reply.send({ task, response: responseRow });
  });

  // ---- POST /tasks/:id/ack ------------------------------------------------
  // Rascal dismisses a response card (after reading the result).
  // Sets view_column=done and archives so it stops showing on the board.
  server.post<{ Params: { id: string } }>(
    '/tasks/:id/ack',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const { id } = request.params;
      const pool = getPool();
      const r = await pool.query(
        `UPDATE boss_tasks
            SET view_column = 'done',
                status = 'done',
                archived_at = now(),
                context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
                  'acked_at', to_char(now() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                )
          WHERE tenant_id = $1 AND id = $2 AND kind = 'response'
                AND archived_at IS NULL
          RETURNING *`,
        [tenantId, id],
      );
      if (r.rowCount === 0) {
        return reply
          .status(404)
          .send({ error: 'response card not found or already acked' });
      }
      return reply.send({ task: r.rows[0] });
    },
  );

  // ---- Recent stage-log activity (for Dashboard LiveActivity panel) -------
  // Returns the workspace's most-recent stage transitions, joined to the
  // task title so the UI can render rows like
  //   "{agent} {stage}: {task title} ({status})"
  // without a second roundtrip. Newest first; capped at 20.
  server.get<{ Querystring: { limit?: string } }>(
    '/pipeline/stage-log/recent',
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const requested = Number(request.query.limit ?? '10');
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(20, Math.trunc(requested)))
        : 10;
      const { rows } = await getPool().query(
        `SELECT log.id,
                log.task_id,
                log.stage,
                log.agent,
                log.started_at,
                log.completed_at,
                log.status,
                t.title AS task_title,
                t.status AS task_status,
                t.assigned_client AS task_client
           FROM boss_stage_log log
           LEFT JOIN boss_tasks t ON t.id = log.task_id
          WHERE log.tenant_id = $1
          ORDER BY log.started_at DESC
          LIMIT $2`,
        [tenantId, limit],
      );
      return reply.send({ entries: rows });
    },
  );
}
