/**
 * Unit tests — Pipeline Engine pure state machine.
 *
 * Covers the transitions a task can make through a pipeline:
 *   pending → active → (active | blocked)* → done
 *   any → failed
 */

import { describe, it, expect } from 'vitest';
import {
  advance,
  approve,
  fail,
  start,
  PipelineTransitionError,
  type Pipeline,
  type Task,
} from './pipeline-engine.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const meetingFollowup: Pipeline = {
  id: 'pipe-meeting',
  name: 'Client Meeting Followup',
  stages: [
    {
      name: 'research',
      agent: 'darla',
      prompt_template: 'Research {title}',
      requires_approval: false,
      timeout_minutes: 30,
    },
    {
      name: 'draft',
      agent: 'darla',
      prompt_template: 'Draft {title}',
      requires_approval: false,
      timeout_minutes: 45,
    },
    {
      name: 'review',
      agent: null,
      prompt_template: null,
      requires_approval: true,
      timeout_minutes: null,
    },
    {
      name: 'deliver',
      agent: 'darla',
      prompt_template: 'Upload {output_file}',
      requires_approval: false,
      timeout_minutes: 15,
    },
  ],
};

function makePendingTask(): Task {
  return {
    id: 'task-1',
    pipeline_id: 'pipe-meeting',
    title: 'Debbie meeting summary',
    current_stage: 'research',
    status: 'pending',
    assigned_agent: null,
    stage_history: [],
  };
}

// ── start ─────────────────────────────────────────────────────────────

describe('start', () => {
  it('transitions pending → active on a normal first stage', () => {
    const t = makePendingTask();
    const r = start(t, meetingFollowup);

    expect(r.task.status).toBe('active');
    expect(r.task.current_stage).toBe('research');
    expect(r.task.assigned_agent).toBe('darla');
    expect(r.nextAgent).toBe('darla');
    expect(r.complete).toBe(false);
    expect(r.task.stage_history).toHaveLength(1);
    expect(r.task.stage_history[0].stage).toBe('research');
  });

  it('transitions pending → blocked if first stage requires_approval', () => {
    const approvalFirst: Pipeline = {
      ...meetingFollowup,
      stages: [
        {
          name: 'intake',
          agent: null,
          prompt_template: null,
          requires_approval: true,
          timeout_minutes: null,
        },
        ...meetingFollowup.stages,
      ],
    };
    const t = makePendingTask();
    t.current_stage = 'intake';
    const r = start(t, approvalFirst);

    expect(r.task.status).toBe('blocked');
    expect(r.nextAgent).toBeNull();
  });

  it('throws if task is not pending', () => {
    const t = { ...makePendingTask(), status: 'active' as const };
    expect(() => start(t, meetingFollowup)).toThrow(PipelineTransitionError);
  });
});

// ── advance ──────────────────────────────────────────────────────────

describe('advance', () => {
  it('moves research → draft, both agent stages, stays active', () => {
    const t = start(makePendingTask(), meetingFollowup).task;
    const r = advance(t, meetingFollowup, 'research notes here');

    expect(r.task.status).toBe('active');
    expect(r.task.current_stage).toBe('draft');
    expect(r.task.assigned_agent).toBe('darla');
    expect(r.nextAgent).toBe('darla');
    expect(r.complete).toBe(false);

    const completed = r.task.stage_history.find(
      (h) => h.stage === 'research',
    );
    expect(completed?.status).toBe('completed');
    expect(completed?.output).toBe('research notes here');
  });

  it('advancing into requires_approval stage sets status=blocked', () => {
    let t = start(makePendingTask(), meetingFollowup).task;
    t = advance(t, meetingFollowup, 'research').task;
    const r = advance(t, meetingFollowup, 'draft body');

    expect(r.task.status).toBe('blocked');
    expect(r.task.current_stage).toBe('review');
    // Stage "review" has agent:null → inherits task.assigned_agent = 'darla'.
    // assigned_agent stays as the inherited handle; nextAgent is null
    // because a blocked stage has no one to wake.
    expect(r.task.assigned_agent).toBe('darla');
    expect(r.nextAgent).toBeNull();
  });

  it('advancing past the last stage sets status=done', () => {
    let t = start(makePendingTask(), meetingFollowup).task;
    t = advance(t, meetingFollowup, 'research').task;
    t = advance(t, meetingFollowup, 'draft').task;
    t = approve(t, meetingFollowup).task; // blocked → active on deliver
    const r = advance(t, meetingFollowup, 'delivered to drive');

    expect(r.task.status).toBe('done');
    expect(r.task.assigned_agent).toBeNull();
    expect(r.nextAgent).toBeNull();
    expect(r.complete).toBe(true);
  });

  it('throws if task status is done', () => {
    const t: Task = { ...makePendingTask(), status: 'done' };
    expect(() => advance(t, meetingFollowup, 'x')).toThrow(
      PipelineTransitionError,
    );
  });

  it('throws if task status is failed', () => {
    const t: Task = { ...makePendingTask(), status: 'failed' };
    expect(() => advance(t, meetingFollowup, 'x')).toThrow(
      PipelineTransitionError,
    );
  });

  it('throws if task is blocked (must approve first)', () => {
    const t: Task = { ...makePendingTask(), status: 'blocked' };
    expect(() => advance(t, meetingFollowup, 'x')).toThrow(
      PipelineTransitionError,
    );
  });
});

// ── approve ──────────────────────────────────────────────────────────

describe('approve', () => {
  it('blocked on no-agent approval stage advances to next stage', () => {
    let t = start(makePendingTask(), meetingFollowup).task;
    t = advance(t, meetingFollowup, 'research').task;
    t = advance(t, meetingFollowup, 'draft').task; // blocked on review
    expect(t.status).toBe('blocked');

    const r = approve(t, meetingFollowup);
    expect(r.task.status).toBe('active');
    expect(r.task.current_stage).toBe('deliver');
    expect(r.task.assigned_agent).toBe('darla');
    expect(r.nextAgent).toBe('darla');

    const reviewHistory = r.task.stage_history.find(
      (h) => h.stage === 'review',
    );
    expect(reviewHistory?.status).toBe('completed');
    expect(reviewHistory?.notes).toBe('approved');
  });

  it('throws if task is not blocked', () => {
    const t: Task = { ...makePendingTask(), status: 'active' };
    expect(() => approve(t, meetingFollowup)).toThrow(
      PipelineTransitionError,
    );
  });

  it('unblocks an agent-present stage (same stage, active, stale completed_at cleared)', () => {
    // A pipeline where the approval gate has an agent (human reviewer) —
    // approve must flip blocked → active, stay on the same stage, and clear
    // any stale completed_at from the spread.
    const agentApproval: Pipeline = {
      id: 'pipe-agent-approve',
      name: 'Agent-present approval',
      stages: [
        {
          name: 'draft',
          agent: 'pulse',
          prompt_template: 'Draft {title}',
          requires_approval: false,
          timeout_minutes: 30,
        },
        {
          name: 'self_review',
          agent: 'pulse',
          prompt_template: 'Self-review draft',
          requires_approval: true,
          timeout_minutes: null,
        },
      ],
    };

    let t: Task = {
      id: 'task-approve-agent',
      pipeline_id: agentApproval.id,
      title: 'Agent-approve flow',
      current_stage: 'draft',
      status: 'pending',
      assigned_agent: null,
      stage_history: [],
    };
    t = start(t, agentApproval).task;
    // Force a stale completed_at on the in-progress entry to prove approve() clears it.
    t = advance(t, agentApproval, 'draft body').task;
    expect(t.status).toBe('blocked');
    expect(t.current_stage).toBe('self_review');
    expect(t.assigned_agent).toBe('pulse');

    const r = approve(t, agentApproval);
    expect(r.task.status).toBe('active');
    expect(r.task.current_stage).toBe('self_review');
    expect(r.task.assigned_agent).toBe('pulse');
    expect(r.nextAgent).toBe('pulse');

    const last = r.task.stage_history[r.task.stage_history.length - 1];
    expect(last.stage).toBe('self_review');
    expect(last.status).toBe('active');
    expect(last.notes).toBe('approved');
    expect(last.completed_at).toBeUndefined();
  });
});

// ── Agent inheritance (stage.agent === null inherits task.assigned_agent) ─

describe('agent inheritance', () => {
  const nullAgentPipeline: Pipeline = {
    id: 'pipe-inherit',
    name: 'All-inherit',
    stages: [
      {
        name: 's1',
        agent: null,
        prompt_template: 'step 1',
        requires_approval: false,
        timeout_minutes: 10,
      },
      {
        name: 's2',
        agent: null,
        prompt_template: 'step 2',
        requires_approval: false,
        timeout_minutes: 10,
      },
    ],
  };

  it('assigned_agent is preserved when every stage has agent:null', () => {
    let t: Task = {
      id: 'task-inherit',
      pipeline_id: nullAgentPipeline.id,
      title: 'Inherit',
      current_stage: 's1',
      status: 'pending',
      assigned_agent: 'darla',
      stage_history: [],
    };
    t = start(t, nullAgentPipeline).task;
    expect(t.assigned_agent).toBe('darla');
    t = advance(t, nullAgentPipeline, 'done s1').task;
    expect(t.assigned_agent).toBe('darla');
    expect(t.current_stage).toBe('s2');
  });

  it('explicit stage.agent overrides inheritance', () => {
    const mixed: Pipeline = {
      ...nullAgentPipeline,
      stages: [
        { ...nullAgentPipeline.stages[0] },
        { ...nullAgentPipeline.stages[1], agent: 'maryann' },
      ],
    };
    let t: Task = {
      id: 'task-mixed',
      pipeline_id: mixed.id,
      title: 'Mixed',
      current_stage: 's1',
      status: 'pending',
      assigned_agent: 'darla',
      stage_history: [],
    };
    t = start(t, mixed).task;
    expect(t.assigned_agent).toBe('darla');
    t = advance(t, mixed, 'done s1').task;
    expect(t.assigned_agent).toBe('maryann');
  });
});

// ── fail ──────────────────────────────────────────────────────────

describe('fail', () => {
  it('sets status=failed with reason in last stage_history entry', () => {
    const t = start(makePendingTask(), meetingFollowup).task;
    const failed = fail(t, 'weaviate unavailable');

    expect(failed.status).toBe('failed');
    expect(failed.assigned_agent).toBeNull();
    const last = failed.stage_history[failed.stage_history.length - 1];
    expect(last.status).toBe('failed');
    expect(last.notes).toBe('weaviate unavailable');
    expect(last.completed_at).toBeDefined();
  });

  it('is idempotent if already failed', () => {
    const t: Task = {
      ...makePendingTask(),
      status: 'failed',
      stage_history: [
        {
          stage: 'research',
          agent: 'darla',
          started_at: '2026-04-23T00:00:00Z',
          status: 'failed',
        },
      ],
    };
    const again = fail(t, 'second reason');
    expect(again).toEqual(t);
  });
});

// ── Integration-shaped end-to-end run ─────────────────────────────────

describe('end-to-end', () => {
  it('walks Client Meeting Followup research → deliver with one approval', () => {
    let t = makePendingTask();
    t = start(t, meetingFollowup).task;
    expect(t.current_stage).toBe('research');
    t = advance(t, meetingFollowup, 'interview recap').task;
    expect(t.current_stage).toBe('draft');
    t = advance(t, meetingFollowup, 'summary v1').task;
    expect(t.status).toBe('blocked');
    t = approve(t, meetingFollowup).task;
    expect(t.current_stage).toBe('deliver');
    const final = advance(t, meetingFollowup, 'sent to debbie');
    expect(final.task.status).toBe('done');
    expect(final.complete).toBe(true);
    // 4 stages → 4 history entries
    expect(final.task.stage_history).toHaveLength(4);
    expect(final.task.stage_history.every((h) => h.status === 'completed')).toBe(true);
  });
});
