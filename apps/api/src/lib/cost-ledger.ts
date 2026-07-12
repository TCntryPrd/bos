/**
 * Unified cost/usage ledger + spike detection — the observability layer the CTO
 * agent runs on. Aggregates every backend tool/platform's spend (LLM agent runs +
 * Google API usage today; extensible to Stripe/ERA/etc.) and opens a healing
 * incident when a source's 24h cost spikes vs its 7-day daily average.
 */

import { getPool } from '../db.js';

export interface CostRow { source: string; units: number; cost: number; tokens: number }

/** Per-source cost + units + tokens over the last `hours`. Union of LLM runs + Google usage. */
export async function getCostRollup(hours: number): Promise<CostRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ source: string; units: string; cost: string; tokens: string }>(
    `SELECT source, sum(units)::bigint AS units, round(sum(cost)::numeric,4) AS cost, sum(tokens)::bigint AS tokens FROM (
        SELECT 'llm:'||coalesce(model,'unknown') AS source, count(*)::bigint AS units,
               coalesce(sum(cost_usd),0) AS cost, coalesce(sum(tokens_in + tokens_out),0)::bigint AS tokens
          FROM boss_agent_runs WHERE started_at > now() - ($1 || ' hours')::interval GROUP BY model
        UNION ALL
        SELECT 'google:'||api AS source, coalesce(sum(units),0)::bigint AS units,
               coalesce(sum(est_cost_usd),0) AS cost, 0::bigint AS tokens
          FROM boss_google_usage WHERE created_at > now() - ($1 || ' hours')::interval GROUP BY api
      ) x GROUP BY source ORDER BY cost DESC, tokens DESC`,
    [String(hours)],
  );
  return rows.map((r) => ({ source: r.source, units: Number(r.units), cost: Number(r.cost), tokens: Number(r.tokens) }));
}

const SPIKE_MULTIPLIER = 3;        // 24h ≥ N× the 7-day daily average ⇒ spike
const SPIKE_FLOOR_USD = 1.0;       // ignore $ under this in the 24h window (noise)
const TOKEN_FLOOR = 1_000_000;     // ignore subscription token usage under 1M/24h (noise)

/** A subscription (native, non-namespaced) LLM source — billed by tokens, not $. */
function isSubscriptionLlm(source: string): boolean {
  return source.startsWith('llm:') && !source.includes('/');
}

/**
 * Compare each source's last-24h cost to its 7-day daily average; open a
 * 'cost_spike' incident for each spike (deduped — one open incident per source).
 * Returns the spikes found.
 */
export async function detectAndRecordSpikes(): Promise<Array<{ source: string; observed: number; baseline: number }>> {
  const last24 = await getCostRollup(24);
  const last7d = await getCostRollup(24 * 7);
  const dailyAvg = new Map<string, number>();
  for (const r of last7d) dailyAvg.set(r.source, r.cost / 7);

  const pool = getPool();
  const spikes: Array<{ source: string; observed: number; baseline: number }> = [];
  for (const r of last24) {
    if (r.cost < SPIKE_FLOOR_USD) continue;
    const base = dailyAvg.get(r.source) ?? 0;
    const isSpike = base <= 0 ? r.cost >= SPIKE_FLOOR_USD * SPIKE_MULTIPLIER : r.cost >= SPIKE_MULTIPLIER * base;
    if (!isSpike) continue;
    spikes.push({ source: r.source, observed: r.cost, baseline: Number(base.toFixed(4)) });
    await pool.query(
      `INSERT INTO boss_incidents (kind, source, severity, status, title, detail, observed, baseline, owner, timeline)
       VALUES ('cost_spike', $1, $2, 'detected', $3, $4, $5, $6, 'cto',
               jsonb_build_array(jsonb_build_object('at', now()::text, 'event', 'detected by cost-ledger')))
       ON CONFLICT (kind, source) WHERE status NOT IN ('resolved','escalated') DO NOTHING`,
      [
        r.source,
        r.cost >= 10 ? 'high' : 'medium',
        `Cost spike: ${r.source} at $${r.cost.toFixed(2)} / 24h`,
        `${r.source} spent $${r.cost.toFixed(4)} in the last 24h vs a 7-day daily average of $${base.toFixed(4)} (≥${SPIKE_MULTIPLIER}×). CTO: identify cause → fix → verify → ingest → playbook.`,
        r.cost, base,
      ],
    );
  }

  // Token spikes — subscription (native) LLMs cost $0 but consume Max-plan tokens.
  // A runaway subscription agent is invisible to $-detection, so watch token volume
  // and raise an incident before it eats the plan's limits.
  const dailyAvgTokens = new Map<string, number>();
  for (const r of last7d) dailyAvgTokens.set(r.source, r.tokens / 7);
  for (const r of last24) {
    if (!isSubscriptionLlm(r.source) || r.tokens < TOKEN_FLOOR) continue;
    const baseTk = dailyAvgTokens.get(r.source) ?? 0;
    const isSpike = baseTk <= 0 ? r.tokens >= TOKEN_FLOOR * SPIKE_MULTIPLIER : r.tokens >= SPIKE_MULTIPLIER * baseTk;
    if (!isSpike) continue;
    spikes.push({ source: r.source, observed: r.tokens, baseline: Math.round(baseTk) });
    await pool.query(
      `INSERT INTO boss_incidents (kind, source, severity, status, title, detail, observed, baseline, owner, timeline)
       VALUES ('token_spike', $1, $2, 'detected', $3, $4, $5, $6, 'cto',
               jsonb_build_array(jsonb_build_object('at', now()::text, 'event', 'detected by cost-ledger (subscription tokens)')))
       ON CONFLICT (kind, source) WHERE status NOT IN ('resolved','escalated') DO NOTHING`,
      [
        r.source,
        r.tokens >= TOKEN_FLOOR * 5 ? 'high' : 'medium',
        `Token spike: ${r.source} at ${(r.tokens / 1e6).toFixed(2)}M tokens / 24h (subscription)`,
        `${r.source} used ${r.tokens.toLocaleString()} tokens in 24h vs a 7-day daily avg of ${Math.round(baseTk).toLocaleString()} (≥${SPIKE_MULTIPLIER}×). The Max subscription has plan limits — CTO: find the runaway agent and throttle it (pause / set_model / set_cron).`,
        r.tokens, baseTk,
      ],
    );
  }

  return spikes;
}

export interface IncidentRow {
  id: string; kind: string; source: string | null; severity: string; status: string;
  title: string; detail: string | null; observed: string | null; baseline: string | null; opened_at: string;
}
export async function getOpenIncidents(): Promise<IncidentRow[]> {
  const { rows } = await getPool().query<IncidentRow>(
    `SELECT id, kind, source, severity, status, title, detail, observed, baseline, opened_at
       FROM boss_incidents WHERE status NOT IN ('resolved','escalated') ORDER BY opened_at DESC`,
  );
  return rows;
}
