/**
 * Agent evaluation store. Every persistent-agent run is logged to boss_agent_runs by the
 * scheduler. The Agent Evaluator drains NEW runs continuously and records a quality verdict
 * per run here (good | concern | bad + a one-line issue). Twice a week (Wed + Sun) a
 * synthesizer reads the accumulated evals and produces a report. This is the cross-agent
 * version of the Email Validator's per-draft check.
 */
import { getPool } from '../db.js';

export interface PendingRun {
  run_id: string; agent_id: string; agent_name: string; status: string;
  model: string; cost_usd: number | null; finished_at: string; summary: string;
}

export async function ensureAgentEvalsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS boss_agent_evals (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      run_id       UUID NOT NULL,
      agent_id     TEXT,
      agent_name   TEXT,
      verdict      TEXT NOT NULL,              -- 'good' | 'concern' | 'bad'
      score        NUMERIC,                    -- optional 0..1
      issue        TEXT,                       -- one-line note (empty for clean runs)
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (run_id)
    )`);
  await getPool().query(`CREATE INDEX IF NOT EXISTS idx_agent_evals_when ON boss_agent_evals (evaluated_at DESC)`).catch(() => {});
}

/** Agent runs that have NOT been evaluated yet (newest first). */
export async function pendingRunsForEval(limit = 15, tenantId = 'default'): Promise<PendingRun[]> {
  await ensureAgentEvalsTable();
  const { rows } = await getPool().query<PendingRun>(
    `SELECT r.id AS run_id, r.agent_id, r.agent_name, r.status, r.model, r.cost_usd, r.finished_at,
            left(coalesce(r.summary,''), 1500) AS summary
       FROM boss_agent_runs r
       LEFT JOIN boss_agent_evals e ON e.run_id = r.id
      WHERE e.id IS NULL
      ORDER BY r.finished_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 50)],
  );
  return rows;
}

export async function recordAgentEval(o: {
  runId: string; agentId?: string; agentName?: string; verdict: 'good' | 'concern' | 'bad'; score?: number; issue?: string; tenantId?: string;
}): Promise<boolean> {
  await ensureAgentEvalsTable();
  // Backfill the agent attribution from the run itself so the weekly report can
  // group by agent (the model usually only passes runId + verdict).
  let agentId = o.agentId ?? null;
  let agentName = o.agentName ?? null;
  if (!agentName) {
    const { rows } = await getPool().query<{ agent_id: string; agent_name: string }>(
      `SELECT agent_id, agent_name FROM boss_agent_runs WHERE id = $1`, [o.runId],
    );
    if (rows[0]) { agentId = agentId ?? rows[0].agent_id; agentName = agentName ?? rows[0].agent_name; }
  }
  const { rowCount } = await getPool().query(
    `INSERT INTO boss_agent_evals (tenant_id, run_id, agent_id, agent_name, verdict, score, issue)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (run_id) DO UPDATE SET verdict = EXCLUDED.verdict, score = EXCLUDED.score, issue = EXCLUDED.issue, evaluated_at = now()`,
    [o.tenantId ?? 'default', o.runId, agentId, agentName, o.verdict, o.score ?? null, o.issue ?? null],
  );
  // A failure feeds the self-healing loop: open an incident for the engineer to work
  // (deterministic, not left to the model). The healer cannot heal itself -> escalate.
  if (o.verdict === 'bad') {
    await openAgentFailureIncident(agentId, agentName, o.issue ?? '').catch(() => {});
  }
  return (rowCount ?? 0) > 0;
}

// The self-healing engineer (CTO / Chief Engineer) + COO cannot heal their own failures.
const HEALER_PATTERN = /chief engineer|\bcto\b|\bcoo\b/i;

async function telegramAlert(text: string): Promise<void> {
  try {
    let tok = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!tok) {
      const { getRuntimeConfig } = await import('../config-store.js');
      tok = (await getRuntimeConfig('TELEGRAM_BOT_TOKEN', 'default')) || '';
    }
    if (!tok) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '8558439226', text }),
    });
  } catch { /* best-effort */ }
}

/** Open a deduped agent_failure incident so the CTO/Chief Engineer self-heals it. */
export async function openAgentFailureIncident(agentId: string | null, agentName: string | null, issue: string): Promise<string> {
  const name = agentName ?? agentId ?? 'unknown agent';
  // Cannot self-heal the healer — escalate straight to Kevin.
  if (HEALER_PATTERN.test(name)) {
    await telegramAlert(`BOS self-heal: the engineer "${name}" itself had a failed run (${issue || 'see evaluator'}). It cannot heal itself — needs a look.`);
    return 'escalated (healer failure)';
  }
  const { rowCount } = await getPool().query(
    `INSERT INTO boss_incidents (kind, source, severity, status, title, detail, owner, timeline)
     VALUES ('agent_failure', $1, 'medium', 'open', $2, $3, 'evaluator',
             jsonb_build_array(jsonb_build_object('at', now()::text, 'event', 'opened by Agent Evaluator')))
     ON CONFLICT (kind, source) WHERE status NOT IN ('resolved','escalated') DO NOTHING`,
    [agentId ?? name, `Agent failure: ${name}`, issue || 'a run failed (see Agent Evaluator)'],
  );
  return (rowCount ?? 0) > 0 ? 'incident opened' : 'incident already open (deduped)';
}

/** Aggregate the last N days of evals for the twice-weekly synthesis report. */
export async function evalSummaryText(days = 4, tenantId = 'default'): Promise<string> {
  await ensureAgentEvalsTable();
  const { rows: agg } = await getPool().query<{ agent_name: string; verdict: string; n: string }>(
    `SELECT coalesce(agent_name,'?') agent_name, verdict, count(*)::text n
       FROM boss_agent_evals
      WHERE tenant_id = $1 AND evaluated_at > now() - ($2 || ' days')::interval
      GROUP BY agent_name, verdict ORDER BY agent_name`,
    [tenantId, String(days)],
  );
  const { rows: issues } = await getPool().query<{ agent_name: string; verdict: string; issue: string; evaluated_at: string }>(
    `SELECT coalesce(agent_name,'?') agent_name, verdict, coalesce(issue,'') issue, evaluated_at
       FROM boss_agent_evals
      WHERE tenant_id = $1 AND evaluated_at > now() - ($2 || ' days')::interval AND verdict IN ('concern','bad')
      ORDER BY evaluated_at DESC LIMIT 40`,
    [tenantId, String(days)],
  );
  if (!agg.length) return `No agent evaluations in the last ${days} days.`;
  const byAgent: Record<string, Record<string, number>> = {};
  for (const r of agg) { (byAgent[r.agent_name] ??= {})[r.verdict] = parseInt(r.n, 10); }
  const lines = Object.entries(byAgent).map(([a, v]) =>
    `${a}: ${v.good ?? 0} good, ${v.concern ?? 0} concern, ${v.bad ?? 0} bad`);
  const issueLines = issues.map((i) => `[${i.verdict.toUpperCase()}] ${i.agent_name}: ${i.issue}`.slice(0, 160));
  return `AGENT QUALITY, last ${days} days:\n${lines.join('\n')}\n\nFlagged runs:\n${issueLines.length ? issueLines.join('\n') : '(none)'}`;
}
