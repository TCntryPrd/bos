/**
 * BOS Self-Identity tools — vS.0.4.
 *
 * The canonical "who am I" surface for BOS. Reads from the single-row
 * boss_self_state table (migration 028). The identity card, reflections,
 * and active goals survive restarts, model swaps, and thread resets.
 *
 * Tools:
 *   boss_self_identity — returns the identity card (observer)
 *   boss_self_reflect — adds a reflection note (assistant)
 *   boss_self_goals — manages active goals (assistant)
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

export const selfIdentityTool: BrainTool = {
  name: 'boss_self_identity',
  description:
    'Returns BOS\'s canonical identity card: name, role, persona, current model, ' +
    'trust level, host, recent reflections, and active goals. Use this to ground ' +
    'yourself in who you are across sessions.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const selfReflectTool: BrainTool = {
  name: 'boss_self_reflect',
  description:
    'Add a reflection note to BOS\'s persistent self-state. Reflections capture ' +
    'cross-session learnings, decisions, and observations that survive restarts.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The reflection text' },
    },
    required: ['text'],
  },
};

export const selfGoalsTool: BrainTool = {
  name: 'boss_self_goals',
  description:
    'Manage BOS\'s active goals. Add a new goal or mark an existing one as complete.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'complete', 'list'], description: 'Action to take' },
      goal: { type: 'string', description: 'Goal text (for add) or goal to mark complete' },
    },
    required: ['action'],
  },
};

export const ALL_SELF_IDENTITY_TOOLS: BrainTool[] = [
  selfIdentityTool,
  selfReflectTool,
  selfGoalsTool,
];

// ── Handlers ────────────────────────────────────────────────────────────────

export async function handleSelfIdentity(): Promise<string> {
  const { rows } = await getPool().query(`SELECT * FROM boss_self_state WHERE id = 1`);
  if (rows.length === 0) return JSON.stringify({ error: 'BOS self-state not initialized' });

  const state = rows[0];
  const reflections = (state.reflections as Array<{ text: string; timestamp: string }>) ?? [];
  const goals = (state.active_goals as Array<{ goal: string; status: string; created: string }>) ?? [];

  return JSON.stringify({
    name: state.name,
    role: state.role,
    persona: state.persona_doc,
    current_model: state.current_model,
    trust_level: state.trust_level,
    host: state.host,
    reflections: reflections.slice(-10), // last 10
    active_goals: goals.filter((g: { status: string }) => g.status !== 'complete'),
    updated_at: state.updated_at,
  });
}

export async function handleSelfReflect(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '');
  if (!text) return 'Error: text is required';

  const entry = { text, timestamp: new Date().toISOString() };

  await getPool().query(
    `UPDATE boss_self_state
       SET reflections = reflections || $1::jsonb
       WHERE id = 1`,
    [JSON.stringify(entry)],
  );

  return `Reflection saved: "${text.substring(0, 100)}..."`;
}

export async function handleSelfGoals(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? 'list');
  const goalText = String(args.goal ?? '');

  if (action === 'list') {
    const { rows } = await getPool().query(`SELECT active_goals FROM boss_self_state WHERE id = 1`);
    const goals = (rows[0]?.active_goals as Array<{ goal: string; status: string }>) ?? [];
    if (goals.length === 0) return 'No active goals.';
    return goals.map((g, i) => `${i + 1}. [${g.status}] ${g.goal}`).join('\n');
  }

  if (action === 'add') {
    if (!goalText) return 'Error: goal text is required for add';
    const entry = { goal: goalText, status: 'active', created: new Date().toISOString() };
    await getPool().query(
      `UPDATE boss_self_state
         SET active_goals = active_goals || $1::jsonb
         WHERE id = 1`,
      [JSON.stringify(entry)],
    );
    return `Goal added: "${goalText}"`;
  }

  if (action === 'complete') {
    if (!goalText) return 'Error: goal text is required for complete';
    // Mark matching goal as complete
    await getPool().query(
      `UPDATE boss_self_state
         SET active_goals = (
           SELECT jsonb_agg(
             CASE WHEN elem->>'goal' = $1
               THEN jsonb_set(elem, '{status}', '"complete"')
               ELSE elem
             END
           )
           FROM jsonb_array_elements(active_goals) AS elem
         )
         WHERE id = 1`,
      [goalText],
    );
    return `Goal marked complete: "${goalText}"`;
  }

  return `Unknown action: ${action}. Use add, complete, or list.`;
}
