/**
 * Kanban brain tools — v1.7.14.
 *
 * Three tools that let BOS (and rascals/outsiders) drive the Kanban board:
 *   boss_tasks_move    — move a task within a view (client column or project stage)
 *   boss_tasks_advance — advance a task to the next project stage
 *   boss_tasks_block   — mark a task as blocked (surfaces with 🔒 in the UI)
 *
 * These wrap the same DB writes that the /api/kanban routes do — direct DB,
 * no HTTP self-call. Tool callers get human-readable result strings.
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

const PROJECT_STAGES = [
  'Initiated',
  'Assessment',
  'Value & Process Mapping',
  'KFR & Roadmap forward',
  'L1 Implementation',
  'L2 Implementation',
  'Delivered',
  'Support',
  'Closed',
] as const;
type ProjectStage = (typeof PROJECT_STAGES)[number];

const CLIENT_COLUMNS = ['inbox', 'today', 'in_progress', 'to_close', 'done'] as const;
type ClientColumn = (typeof CLIENT_COLUMNS)[number];

function isProjectStage(v: unknown): v is ProjectStage {
  return typeof v === 'string' && (PROJECT_STAGES as readonly string[]).includes(v);
}

function isClientColumn(v: unknown): v is ClientColumn {
  return typeof v === 'string' && (CLIENT_COLUMNS as readonly string[]).includes(v);
}

// ── Tool definitions ────────────────────────────────────────────────────────

export const tasksMoveTool: BrainTool = {
  name: 'boss_tasks_move',
  description:
    'Move a Kanban task to a different column or stage. View "client" uses ' +
    'columns: inbox, today, in_progress, to_close, done. View "project" uses ' +
    'stages: Initiated, Assessment, Value & Process Mapping, KFR & Roadmap forward, ' +
    'L1 Implementation, L2 Implementation, Delivered, Support, Closed.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task UUID' },
      view: { type: 'string', enum: ['client', 'project'], description: 'Which view to move within' },
      to: { type: 'string', description: 'Target column (client view) or stage (project view)' },
    },
    required: ['task_id', 'view', 'to'],
  },
};

export const tasksAdvanceTool: BrainTool = {
  name: 'boss_tasks_advance',
  description:
    'Advance a task to the NEXT project stage. Convenience wrapper that auto- ' +
    'computes the next stage from the current one. Returns the new stage.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task UUID' },
    },
    required: ['task_id'],
  },
};

export const tasksBlockTool: BrainTool = {
  name: 'boss_tasks_block',
  description:
    'Mark a task as blocked. Blocked tasks surface in the UI with a 🔒 icon ' +
    'so Kevin can see what needs unblocking. Pass unblock=true to clear.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task UUID' },
      reason: { type: 'string', description: 'Why blocked (stored on the task)' },
      unblock: { type: 'boolean', description: 'Set true to clear the block' },
    },
    required: ['task_id'],
  },
};

export const ALL_KANBAN_TOOLS: BrainTool[] = [
  tasksMoveTool,
  tasksAdvanceTool,
  tasksBlockTool,
];

// ── Handlers ────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  current_stage: string | null;
  view_column: string | null;
  status: string;
  title: string;
}

export async function handleTasksMove(args: Record<string, unknown>): Promise<string> {
  const taskId = String(args.task_id ?? '');
  const view = String(args.view ?? '');
  const to = String(args.to ?? '');
  const tenantId = String(args.tenant_id ?? 'default');

  if (!taskId) return 'Error: task_id is required';

  if (view === 'client') {
    if (!isClientColumn(to)) {
      return `Error: 'to' must be one of ${CLIENT_COLUMNS.join(', ')}`;
    }
    const { rows } = await getPool().query<TaskRow>(
      `UPDATE boss_tasks SET view_column = $1
        WHERE id = $2 AND tenant_id = $3 RETURNING id, title, view_column, current_stage, status`,
      [to, taskId, tenantId],
    );
    if (rows.length === 0) return `Error: task ${taskId} not found in tenant ${tenantId}`;
    return `Moved "${rows[0].title}" to client column "${to}"`;
  }

  if (view === 'project') {
    if (!isProjectStage(to)) {
      return `Error: 'to' must be one of ${PROJECT_STAGES.join(', ')}`;
    }
    const { rows } = await getPool().query<TaskRow>(
      `UPDATE boss_tasks
          SET current_stage = $1,
              stage_history = COALESCE(stage_history, '[]'::jsonb) ||
                jsonb_build_array(
                  jsonb_build_object(
                    'from', current_stage,
                    'to', $1::text,
                    'at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'by', 'boss'
                  )
                )
        WHERE id = $2 AND tenant_id = $3 RETURNING id, title, view_column, current_stage, status`,
      [to, taskId, tenantId],
    );
    if (rows.length === 0) return `Error: task ${taskId} not found in tenant ${tenantId}`;
    return `Advanced "${rows[0].title}" to stage "${to}"`;
  }

  return `Error: view must be 'client' or 'project'`;
}

export async function handleTasksAdvance(args: Record<string, unknown>): Promise<string> {
  const taskId = String(args.task_id ?? '');
  const tenantId = String(args.tenant_id ?? 'default');
  if (!taskId) return 'Error: task_id is required';

  const { rows: current } = await getPool().query<TaskRow>(
    `SELECT id, title, current_stage, view_column, status FROM boss_tasks
       WHERE id = $1 AND tenant_id = $2`,
    [taskId, tenantId],
  );

  if (current.length === 0) return `Error: task ${taskId} not found`;

  const stage = current[0].current_stage as ProjectStage | null;
  if (!stage || !isProjectStage(stage)) {
    return `Error: task has no project stage set (current: ${stage ?? 'null'})`;
  }

  const idx = PROJECT_STAGES.indexOf(stage);
  if (idx >= PROJECT_STAGES.length - 1) {
    return `Task "${current[0].title}" is already at final stage (${stage})`;
  }
  const next = PROJECT_STAGES[idx + 1];

  const { rows } = await getPool().query<TaskRow>(
    `UPDATE boss_tasks
        SET current_stage = $1,
            stage_history = COALESCE(stage_history, '[]'::jsonb) ||
              jsonb_build_array(
                jsonb_build_object(
                  'from', $2::text,
                  'to', $1::text,
                  'at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'by', 'boss'
                )
              )
      WHERE id = $3 AND tenant_id = $4 RETURNING id, title, current_stage, view_column, status`,
    [next, stage, taskId, tenantId],
  );

  return `Advanced "${rows[0].title}" from "${stage}" to "${next}"`;
}

export async function handleTasksBlock(args: Record<string, unknown>): Promise<string> {
  const taskId = String(args.task_id ?? '');
  const tenantId = String(args.tenant_id ?? 'default');
  const reason = String(args.reason ?? '');
  const unblock = args.unblock === true;
  if (!taskId) return 'Error: task_id is required';

  if (unblock) {
    const { rows } = await getPool().query<TaskRow>(
      `UPDATE boss_tasks SET status = 'active'
         WHERE id = $1 AND tenant_id = $2 AND status = 'blocked'
         RETURNING id, title, status`,
      [taskId, tenantId],
    );
    if (rows.length === 0) return `Error: task ${taskId} not found or not blocked`;
    return `Unblocked "${rows[0].title}"`;
  }

  const { rows } = await getPool().query<TaskRow>(
    `UPDATE boss_tasks
        SET status = 'blocked',
            context = COALESCE(context, '{}'::jsonb) ||
              jsonb_build_object('block_reason', $1::text, 'blocked_at', NOW()::text)
      WHERE id = $2 AND tenant_id = $3
      RETURNING id, title, status`,
    [reason || 'no reason given', taskId, tenantId],
  );
  if (rows.length === 0) return `Error: task ${taskId} not found`;
  return `Blocked "${rows[0].title}" — ${reason || 'no reason given'}`;
}
