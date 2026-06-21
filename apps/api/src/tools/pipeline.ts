/**
 * Pipeline Engine brain tools.
 *
 * Three tools the brain can call to drive the Little Rascals via the
 * BOS pipeline backbone:
 *
 *   boss_task_list     — list tasks, filter by agent / client / status
 *   boss_task_create   — create a task in a named pipeline template
 *   boss_task_advance  — complete the current stage, move the task forward
 *
 * Direct DB access via getPool() + pipeline-engine.ts pure functions — no
 * HTTP self-call. Results return as human-readable strings for the brain.
 *
 * TODO(multi-tenant): handlers currently read `tenant_id` from brain-provided
 * args and fall back to 'default'. When BOS goes multi-tenant, the
 * authenticated tenantId (passed as the 3rd arg to executeTool) must be
 * plumbed through the ToolHandler signature instead. Same gap exists across
 * every other tool in this directory — tracked as a system-wide refactor.
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';
import {
  advance,
  PipelineTransitionError,
  type Pipeline,
  type PipelineStage,
  type Task,
  type TaskStatus,
} from '../lib/pipeline-engine.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

async function loadPipelineByName(
  tenantId: string,
  name: string,
): Promise<Pipeline | null> {
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    stages: PipelineStage[];
  }>(
    `SELECT id, name, stages FROM boss_pipelines
       WHERE tenant_id = $1 AND name = $2`,
    [tenantId, name],
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

async function loadPipelineById(
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

// ── boss_task_list ───────────────────────────────────────────────────────

interface TaskListRow {
  id: string;
  title: string;
  current_stage: string;
  status: string;
  assigned_agent: string | null;
  assigned_client: string | null;
  priority: number;
  view_column: string;
}

export async function handleTaskList(
  args: Record<string, unknown>,
): Promise<string> {
  const tenantId = str(args.tenant_id, 'default');
  const agent = typeof args.agent === 'string' ? args.agent : null;
  const client = typeof args.client === 'string' ? args.client : null;
  const status = typeof args.status === 'string' ? args.status : null;
  const limit = num(args.limit, 25);

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
  params.push(limit);

  const { rows } = await getPool().query<TaskListRow>(
    `SELECT id, title, current_stage, status, assigned_agent,
            assigned_client, priority, view_column
       FROM boss_tasks
       WHERE ${clauses.join(' AND ')}
       ORDER BY priority ASC, created_at DESC
       LIMIT $${params.length}`,
    params,
  );

  if (rows.length === 0) {
    const filter = [
      agent && `agent=${agent}`,
      client && `client=${client}`,
      status && `status=${status}`,
    ]
      .filter(Boolean)
      .join(', ');
    return filter
      ? `No tasks matching ${filter}.`
      : 'No tasks in the pipeline right now.';
  }

  const lines = rows.map((r) => {
    const meta = [
      r.assigned_agent && `@${r.assigned_agent}`,
      r.assigned_client && r.assigned_client,
      `p${r.priority}`,
      r.current_stage,
    ]
      .filter(Boolean)
      .join(' · ');
    return `• [${r.status.toUpperCase()}] ${r.title}  (${meta})  id=${r.id}`;
  });
  return `${rows.length} task${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

// ── boss_task_create ─────────────────────────────────────────────────────

export async function handleTaskCreate(
  args: Record<string, unknown>,
): Promise<string> {
  const tenantId = str(args.tenant_id, 'default');
  const pipelineName = str(args.pipeline);
  const title = str(args.title);
  const agent = typeof args.agent === 'string' ? args.agent : null;
  const client = typeof args.client === 'string' ? args.client : null;
  const priority = num(args.priority, 5);
  const viewColumn = str(args.view_column, 'inbox');
  const contextObj =
    typeof args.context === 'object' && args.context !== null
      ? (args.context as Record<string, unknown>)
      : {};

  if (!title) {
    return 'ERROR: title is required.';
  }

  // If no pipeline specified, create a standalone task
  if (!pipelineName) {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO boss_tasks
         (tenant_id, pipeline_id, title, current_stage, status,
          assigned_agent, assigned_client, priority, view_column, context)
       VALUES ($1, NULL, $2, 'Initiated', 'pending', $3, $4, $5, $6, $7::jsonb)
       RETURNING id`,
      [
        tenantId,
        title,
        agent,
        client,
        priority,
        viewColumn,
        JSON.stringify(contextObj),
      ],
    );
    const id = rows[0].id;
    return `Task created: "${title}"\n  id=${id}  pipeline=none  stage=Initiated  status=pending\n  assigned_agent=${agent ?? '(unassigned)'}  client=${client ?? '(none)'}`;
  }

  const pipeline = await loadPipelineByName(tenantId, pipelineName);
  if (!pipeline) {
    const { rows } = await getPool().query<{ name: string }>(
      `SELECT name FROM boss_pipelines WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    );
    const names = rows.map((r) => r.name).join(', ');
    return `ERROR: pipeline "${pipelineName}" not found. Available: ${names || '(none — seed migrations may be missing)'}`;
  }
  if (pipeline.stages.length === 0) {
    return `ERROR: pipeline "${pipelineName}" has no stages defined.`;
  }

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO boss_tasks
       (tenant_id, pipeline_id, title, current_stage, status,
        assigned_agent, assigned_client, priority, view_column, context)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      tenantId,
      pipeline.id,
      title,
      pipeline.stages[0].name,
      agent,
      client,
      priority,
      viewColumn,
      JSON.stringify(contextObj),
    ],
  );

  const id = rows[0].id;
  return `Task created: "${title}"\n  id=${id}  pipeline="${pipeline.name}"  first_stage=${pipeline.stages[0].name}  status=pending\n  assigned_agent=${agent ?? '(unassigned)'}  client=${client ?? '(none)'}`;
}

// ── boss_task_advance ────────────────────────────────────────────────────

export async function handleTaskAdvance(
  args: Record<string, unknown>,
): Promise<string> {
  const tenantId = str(args.tenant_id, 'default');
  const taskId = str(args.task_id);
  const output = str(args.output);

  if (!taskId) {
    return 'ERROR: task_id is required.';
  }
  const task = await loadTask(tenantId, taskId);
  if (!task) return `ERROR: task ${taskId} not found.`;
  if (!task.pipeline_id) return `ERROR: task ${taskId} has no pipeline.`;
  const pipeline = await loadPipelineById(tenantId, task.pipeline_id);
  if (!pipeline) return `ERROR: pipeline ${task.pipeline_id} not found.`;

  try {
    const result = advance(task, pipeline, output);

    await getPool().query(
      `UPDATE boss_tasks
          SET current_stage = $3,
              status = $4,
              assigned_agent = $5,
              stage_history = $6::jsonb
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        taskId,
        result.task.current_stage,
        result.task.status,
        result.task.assigned_agent,
        JSON.stringify(result.task.stage_history),
      ],
    );
    await getPool().query(
      `INSERT INTO boss_stage_log
         (tenant_id, task_id, stage, agent, started_at, completed_at, output, notes, status)
       VALUES ($1, $2, $3, $4, now(), now(), $5, $6, $7)`,
      [
        tenantId,
        taskId,
        result.task.current_stage,
        result.task.assigned_agent,
        output || null,
        result.complete ? 'pipeline complete' : 'advanced',
        result.task.status,
      ],
    );

    if (result.complete) {
      return `Task ${taskId} → DONE (final stage delivered).`;
    }
    if (result.task.status === 'blocked') {
      return `Task ${taskId} advanced to "${result.task.current_stage}" — BLOCKED for approval.`;
    }
    return `Task ${taskId} advanced to "${result.task.current_stage}" → wake agent "${result.nextAgent ?? '(none)'}".`;
  } catch (err) {
    if (err instanceof PipelineTransitionError) {
      return `ERROR: invalid transition — ${err.message}`;
    }
    throw err;
  }
}

// ── BrainTool schemas ──────────────────────────────────────────────────────

export const taskListTool: BrainTool = {
  name: 'boss_task_list',
  description:
    'List Pipeline Engine tasks. Filter by agent handle (darla, spanky, maryann, etc.), ' +
    'client directory (e.g. "06-debbie-wooldridge"), or status (pending|active|blocked|done|failed). ' +
    'Use when the user asks what a Little Rascal is working on, what is blocked, or what is in flight.',
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description:
          'Little Rascal handle — one of: darla, spanky, alfalfa, buckwheat, froggy, stymie, porky, waldo, petey, wheezer, butch, woim, maryann.',
      },
      client: {
        type: 'string',
        description: 'Client directory identifier (e.g. "06-debbie-wooldridge").',
      },
      status: {
        type: 'string',
        enum: ['pending', 'active', 'blocked', 'done', 'failed'],
        description: 'Filter by task status.',
      },
      limit: {
        type: 'integer',
        description: 'Max rows to return. Default 25.',
      },
    },
    required: [],
  },
};

export const taskCreateTool: BrainTool = {
  name: 'boss_task_create',
  description:
    'Create a new task, optionally in a named pipeline template. If no pipeline is specified, creates a standalone task. ' +
    'The task starts in status=pending. ' +
    'Use when the user asks to queue work for a Rascal (e.g. "have Darla draft the Wooldridge meeting summary"). ' +
    'Available pipelines: "Client Meeting Followup", "Proposal / SOW", "Lead Qualification", "Content Publishing", "Client Onboarding".',
  parameters: {
    type: 'object',
    properties: {
      pipeline: {
        type: 'string',
        description: 'Exact pipeline template name (case-sensitive). Optional - omit to create standalone task.',
      },
      title: {
        type: 'string',
        description: 'Human-readable task title shown in the Kanban board.',
      },
      agent: {
        type: 'string',
        description: 'Little Rascal handle to assign to (optional).',
      },
      client: {
        type: 'string',
        description: 'Client directory identifier (optional).',
      },
      priority: {
        type: 'integer',
        description: '1 = urgent, 10 = backlog. Default 5.',
      },
      view_column: {
        type: 'string',
        enum: ['inbox', 'today', 'in_progress', 'to_close', 'done'],
        description: 'Kanban Client Status column. Default "inbox".',
      },
    },
    required: ['title'],
  },
};

export const taskAdvanceTool: BrainTool = {
  name: 'boss_task_advance',
  description:
    'Complete the current stage of a task with its output and move to the next stage. ' +
    'If the next stage requires approval, status becomes blocked. If past the last stage, status becomes done. ' +
    'Agents call this when they finish work; the engine wakes the next agent if needed.',
  parameters: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'UUID of the task to advance.',
      },
      output: {
        type: 'string',
        description: 'Text output produced by the current stage. Stored on stage_log.',
      },
    },
    required: ['task_id'],
  },
};

export const ALL_PIPELINE_TOOLS: BrainTool[] = [
  taskListTool,
  taskCreateTool,
  taskAdvanceTool,
];
