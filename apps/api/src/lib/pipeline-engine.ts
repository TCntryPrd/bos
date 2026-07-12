/**
 * Pipeline Engine — pure state machine for task orchestration.
 *
 * No DB I/O, no Fastify deps, no side effects. Accepts current task + pipeline
 * definition, returns the next state. Callers persist the result.
 *
 * See /home/tcntryprd/BOSS_V2_MASTER_PLAN.md §Phase 1.
 */

export type TaskStatus = 'pending' | 'active' | 'blocked' | 'done' | 'failed';

export type StageLogStatus =
  | 'active'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'blocked';

export interface PipelineStage {
  name: string;
  agent: string | null;
  prompt_template: string | null;
  requires_approval: boolean;
  timeout_minutes: number | null;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
}

export interface StageHistoryEntry {
  stage: string;
  agent: string | null;
  started_at: string;
  completed_at?: string;
  output?: string;
  notes?: string;
  status: StageLogStatus;
}

export interface Task {
  id: string;
  pipeline_id: string | null;
  title: string;
  current_stage: string;
  status: TaskStatus;
  assigned_agent: string | null;
  stage_history: StageHistoryEntry[];
}

export interface AdvanceResult {
  task: Task;
  /** Agent to wake for the newly-active stage (null if done/blocked/no agent). */
  nextAgent: string | null;
  /** True when the pipeline has reached its final stage. */
  complete: boolean;
}

export class PipelineTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineTransitionError';
  }
}

function findStageIndex(pipeline: Pipeline, stageName: string): number {
  const idx = pipeline.stages.findIndex((s) => s.name === stageName);
  if (idx < 0) {
    throw new PipelineTransitionError(
      `Stage "${stageName}" not found in pipeline "${pipeline.name}"`,
    );
  }
  return idx;
}

/**
 * Resolve a stage's assigned agent. A stage with `agent: null` inherits from
 * the task's currently-assigned agent (common case: multi-stage pipelines
 * where every substantive stage runs on the same Rascal). An explicit agent
 * handle on the stage overrides.
 */
function resolveStageAgent(stage: PipelineStage, task: Task): string | null {
  return stage.agent ?? task.assigned_agent;
}

/**
 * Complete the current stage with `output`, move to the next stage.
 * - If the next stage has requires_approval=true → status=blocked
 * - If there is no next stage → status=done
 * - Otherwise → status=active, assigned_agent=next stage's agent
 */
export function advance(
  task: Task,
  pipeline: Pipeline,
  output: string,
): AdvanceResult {
  if (task.status === 'done' || task.status === 'failed') {
    throw new PipelineTransitionError(
      `Cannot advance task in terminal status "${task.status}"`,
    );
  }
  if (task.status === 'blocked') {
    throw new PipelineTransitionError(
      'Cannot advance a blocked task — call approve() first',
    );
  }

  const currentIdx = findStageIndex(pipeline, task.current_stage);
  const now = new Date().toISOString();

  const completedHistory: StageHistoryEntry = {
    stage: task.current_stage,
    agent: task.assigned_agent,
    started_at:
      task.stage_history[task.stage_history.length - 1]?.started_at ?? now,
    completed_at: now,
    output,
    status: 'completed',
  };

  const history = [...task.stage_history.slice(0, -1), completedHistory];

  const nextIdx = currentIdx + 1;
  if (nextIdx >= pipeline.stages.length) {
    return {
      task: {
        ...task,
        status: 'done',
        assigned_agent: null,
        stage_history: history,
      },
      nextAgent: null,
      complete: true,
    };
  }

  const nextStage = pipeline.stages[nextIdx];
  const nextAgent = resolveStageAgent(nextStage, task);
  const nextStatus: TaskStatus = nextStage.requires_approval
    ? 'blocked'
    : 'active';

  const nextHistory: StageHistoryEntry = {
    stage: nextStage.name,
    agent: nextAgent,
    started_at: now,
    status: nextStage.requires_approval ? 'blocked' : 'active',
  };

  return {
    task: {
      ...task,
      current_stage: nextStage.name,
      status: nextStatus,
      assigned_agent: nextAgent,
      stage_history: [...history, nextHistory],
    },
    nextAgent: nextStage.requires_approval ? null : nextAgent,
    complete: false,
  };
}

/**
 * Unblock a task that was sitting on a requires_approval stage.
 * Transition: blocked → active (stays on the same stage).
 * Assumes the approver has reviewed and accepted the prior stage's output.
 */
export function approve(task: Task, pipeline: Pipeline): AdvanceResult {
  if (task.status !== 'blocked') {
    throw new PipelineTransitionError(
      `Cannot approve task in status "${task.status}" (must be "blocked")`,
    );
  }

  const stageIdx = findStageIndex(pipeline, task.current_stage);
  const stage = pipeline.stages[stageIdx];

  // If the blocked stage itself was the approval gate with no agent, skip it
  // and advance to the next substantive stage.
  if (stage.requires_approval && stage.agent === null) {
    const nextIdx = stageIdx + 1;
    const now = new Date().toISOString();

    // Mark the approval stage as completed.
    const approvalHistory: StageHistoryEntry = {
      stage: stage.name,
      agent: null,
      started_at:
        task.stage_history[task.stage_history.length - 1]?.started_at ?? now,
      completed_at: now,
      status: 'completed',
      notes: 'approved',
    };
    const history = [...task.stage_history.slice(0, -1), approvalHistory];

    if (nextIdx >= pipeline.stages.length) {
      return {
        task: {
          ...task,
          status: 'done',
          assigned_agent: null,
          stage_history: history,
        },
        nextAgent: null,
        complete: true,
      };
    }
    const nextStage = pipeline.stages[nextIdx];
    const nextAgent = resolveStageAgent(nextStage, task);
    const nextStatus: TaskStatus = nextStage.requires_approval
      ? 'blocked'
      : 'active';
    const nextHistory: StageHistoryEntry = {
      stage: nextStage.name,
      agent: nextAgent,
      started_at: now,
      status: nextStage.requires_approval ? 'blocked' : 'active',
    };
    return {
      task: {
        ...task,
        current_stage: nextStage.name,
        status: nextStatus,
        assigned_agent: nextAgent,
        stage_history: [...history, nextHistory],
      },
      nextAgent: nextStage.requires_approval ? null : nextAgent,
      complete: false,
    };
  }

  // Approval for a stage that has an agent — just unblock and let the
  // agent resume. Stage history gets a note, status flips to active.
  const stageAgent = resolveStageAgent(stage, task);
  const lastHistory = task.stage_history[task.stage_history.length - 1];
  const unblockedHistory: StageHistoryEntry = {
    ...(lastHistory ?? {
      stage: stage.name,
      agent: stageAgent,
      started_at: new Date().toISOString(),
      status: 'active',
    }),
    status: 'active',
    notes: 'approved',
    // Clear any stale completed_at from the spread — this stage is now active
    completed_at: undefined,
  };

  return {
    task: {
      ...task,
      status: 'active',
      assigned_agent: stageAgent,
      stage_history: [...task.stage_history.slice(0, -1), unblockedHistory],
    },
    nextAgent: stageAgent,
    complete: false,
  };
}

/**
 * Mark task as terminally failed with a reason. Idempotent once status=failed.
 */
export function fail(task: Task, reason: string): Task {
  if (task.status === 'failed') return task;
  const now = new Date().toISOString();
  const lastHistory = task.stage_history[task.stage_history.length - 1];
  const failedHistory: StageHistoryEntry = {
    ...(lastHistory ?? {
      stage: task.current_stage,
      agent: task.assigned_agent,
      started_at: now,
      status: 'active',
    }),
    status: 'failed',
    completed_at: now,
    notes: reason,
  };
  return {
    ...task,
    status: 'failed',
    assigned_agent: null,
    stage_history: [...task.stage_history.slice(0, -1), failedHistory],
  };
}

/**
 * Activate a pending task — set status to active, seed stage_history with
 * the first stage. If the first stage requires approval, status=blocked instead.
 */
export function start(task: Task, pipeline: Pipeline): AdvanceResult {
  if (task.status !== 'pending') {
    throw new PipelineTransitionError(
      `Cannot start task in status "${task.status}" (must be "pending")`,
    );
  }
  if (pipeline.stages.length === 0) {
    throw new PipelineTransitionError(
      `Pipeline "${pipeline.name}" has no stages`,
    );
  }
  const first = pipeline.stages[0];
  const firstAgent = resolveStageAgent(first, task);
  const now = new Date().toISOString();
  const nextStatus: TaskStatus = first.requires_approval ? 'blocked' : 'active';
  const history: StageHistoryEntry = {
    stage: first.name,
    agent: firstAgent,
    started_at: now,
    status: first.requires_approval ? 'blocked' : 'active',
  };
  return {
    task: {
      ...task,
      current_stage: first.name,
      status: nextStatus,
      assigned_agent: firstAgent,
      stage_history: [...task.stage_history, history],
    },
    nextAgent: first.requires_approval ? null : firstAgent,
    complete: false,
  };
}
