/**
 * Agent-evaluation brain tools. The Agent Evaluator drains un-evaluated runs from
 * boss_agent_runs and records a quality verdict per run; a twice-weekly synthesizer reads
 * the summary. See lib/agent-evals.ts.
 */
import type { BrainTool } from '@boss/brain';
import { pendingRunsForEval, recordAgentEval, evalSummaryText } from '../lib/agent-evals.js';

export const agentRunsPendingTool: BrainTool = {
  name: 'boss_agent_runs_pending',
  description:
    'List recent persistent-agent runs that have NOT been evaluated yet. Returns run_id, agent_name, status, model, cost, and the run summary. Call at the start of each evaluation pass to get the work queue, then judge each and call boss_agent_eval_record.',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'How many unevaluated runs to pull (default 15, max 50). Newest first.' } },
  },
};

export const agentEvalRecordTool: BrainTool = {
  name: 'boss_agent_eval_record',
  description:
    'Record your quality verdict for ONE agent run. verdict: "good" (did its job cleanly), "concern" (worked but something is off — verbose, partial, odd), or "bad" (failed, errored, looped, fabricated, or claimed work it did not do). Provide a one-line issue for concern/bad (leave empty for good).',
  parameters: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'The run_id from boss_agent_runs_pending.' },
      verdict: { type: 'string', enum: ['good', 'concern', 'bad'], description: 'good | concern | bad' },
      score: { type: 'number', description: 'Optional quality score 0..1.' },
      issue: { type: 'string', description: 'One-line note on what was wrong (for concern/bad).' },
    },
    required: ['runId', 'verdict'],
  },
};

export const agentEvalsSummaryTool: BrainTool = {
  name: 'boss_agent_evals_summary',
  description:
    'Get an aggregated summary of the recent agent evaluations (counts of good/concern/bad per agent + the flagged runs). Use this for the twice-weekly quality report.',
  parameters: {
    type: 'object',
    properties: { days: { type: 'number', description: 'Look back this many days (default 4 — covers the gap between Wed and Sun reports).' } },
  },
};

export const ALL_AGENT_EVAL_TOOLS: BrainTool[] = [agentRunsPendingTool, agentEvalRecordTool, agentEvalsSummaryTool];

async function handlePending(args: Record<string, unknown>): Promise<string> {
  const limit = typeof args.limit === 'number' ? args.limit : 15;
  const rows = await pendingRunsForEval(limit);
  if (!rows.length) return 'No un-evaluated agent runs. Nothing to do this pass — respond done and exit.';
  const lines = rows.map((r) =>
    `run_id=${r.run_id} | agent=${r.agent_name} | status=${r.status} | model=${r.model} | cost=$${r.cost_usd ?? 0}\n   summary: ${r.summary || '(none)'}`);
  return `Un-evaluated runs (${rows.length}) — judge each, then boss_agent_eval_record per run:\n${lines.join('\n\n')}`;
}

async function handleRecord(args: Record<string, unknown>): Promise<string> {
  const runId = String(args.runId ?? '').trim();
  const verdict = String(args.verdict ?? '').trim() as 'good' | 'concern' | 'bad';
  if (!runId) throw new Error('runId is required');
  if (verdict !== 'good' && verdict !== 'concern' && verdict !== 'bad') throw new Error("verdict must be 'good', 'concern', or 'bad'");
  const ok = await recordAgentEval({
    runId, verdict,
    score: typeof args.score === 'number' ? args.score : undefined,
    issue: args.issue ? String(args.issue) : undefined,
  });
  return ok ? `Recorded ${verdict} for run ${runId}.` : `Run ${runId} not recorded.`;
}

async function handleSummary(args: Record<string, unknown>): Promise<string> {
  const days = typeof args.days === 'number' ? args.days : 4;
  return evalSummaryText(days);
}

export const AGENT_EVAL_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_agent_runs_pending: handlePending,
  boss_agent_eval_record: handleRecord,
  boss_agent_evals_summary: handleSummary,
};
