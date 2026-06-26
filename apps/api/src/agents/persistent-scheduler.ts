/**
 * Persistent Agent Scheduler
 *
 * Loads agents from boss_persistent_agents table and runs them on their
 * cron schedules. Each agent is a mini-BOS with its own instructions
 * and tool access. They persist across restarts and can be created,
 * updated, paused, and stopped through BOS's tools.
 *
 * This is NOT fire-and-forget. Agents stay alive and run on schedule
 * until explicitly stopped.
 */

import { Cron } from 'croner';
import { getPool } from '../db.js';
import { hasNewDriveFiles } from '../tools/executor.js';
import { detectAndRecordSpikes, getOpenIncidents } from '../lib/cost-ledger.js';
import { resolveModel, isHardOverBudget } from '../lib/model-routes.js';
import { currentTenantId } from '../lib/tenant.js';

const SCHEDULER_CHECK_INTERVAL_MS = 60_000; // Check every minute
let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let lastSpikeCheck = 0; // hourly cost-spike scan watermark

interface PersistentAgent {
  id: string;
  name: string;
  instructions: string;
  cron_expression: string;
  status: string;
  model: string;
  tools: string[];
  last_run_at: Date | null;
  run_count: number;
}

// Track when each agent should next run
const nextRunTimes = new Map<string, number>();

// Guard against overlapping runs of the SAME agent. last_run_at is written only
// after a run completes (which can be minutes later), so without this an agent
// on a short cron would re-fire on every 60s tick while a run is still in flight.
const inFlight = new Set<string>();

// ── Cron matching (WS-4: croner) ─────────────────────────────────────────────
// The old hand-rolled parser only understood "*/N min", "*/N hour" and
// "0 H * * *"; EVERY other shape (lists/ranges/step-lists like "0 9,17 * * *",
// "0 9-17 * * *") hit a "fail-safe → never run" branch, so those agents were
// silently dead. croner parses all standard 5-field crons correctly. Schedules
// are interpreted in UTC to preserve the previous behaviour (the old code used
// getUTCHours). If a schedule should follow a business timezone, set it per-agent
// later — but it now FIRES either way instead of silently skipping.
function shouldRunNow(cronExpr: string, lastRun: Date | null): boolean {
  let cron: Cron;
  try {
    cron = new Cron(cronExpr.trim(), { timezone: 'UTC' });
  } catch (err) {
    console.warn(`[scheduler] invalid cron "${cronExpr}": ${(err as Error).message} — skipping`);
    return false;
  }
  if (!lastRun) return true; // never run before → start on this tick
  // Due if a scheduled firing has occurred at or before now since the last run.
  const prev = cron.previousRun();
  return prev != null && lastRun.getTime() < prev.getTime();
}

// Human-readable summary of a schedule for the loud startup log.
function describeSchedule(cronExpr: string): string {
  try {
    const next = new Cron(cronExpr.trim(), { timezone: 'UTC' }).nextRun();
    return next ? `next ${next.toISOString()}` : 'no upcoming run';
  } catch (err) {
    return `INVALID (${(err as Error).message})`;
  }
}

// ── Cost model + run metrics ──────────────────────────────────────────────────
// $ per 1M tokens (input, output). Rough rates for budgeting/observability — the
// COO uses these to spot expensive agents, not for billing. Fallback covers
// unknown models. Update as pricing changes.
const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-fable-5': { in: 1.0, out: 5.0 },
  'anthropic/claude-3.7-sonnet': { in: 3.0, out: 15.0 },
  'anthropic/claude-3.5-sonnet': { in: 3.0, out: 15.0 },
  'google/gemini-2.5-flash': { in: 0.30, out: 2.5 },
  'openai/gpt-4.1-mini': { in: 0.40, out: 1.6 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
};

function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  // Native models (no provider namespace, e.g. "claude-sonnet-4-6") run on the
  // Claude Max SUBSCRIPTION via the ClaudeCode adapter — no API-credit cost.
  // Only namespaced/OpenRouter models ("anthropic/...", "google/...") cost $.
  if (!model.includes('/')) return 0;
  // Normalize provider/version suffixes (e.g. "...:beta") before lookup.
  const key = (model || '').split(':')[0];
  // Deliberately HIGH fallback so an unmodeled model surfaces as expensive (a COO
  // signal to investigate), never silently cheap.
  const rate = MODEL_RATES[key] ?? { in: 3.0, out: 15.0 };
  return Number(((tokensIn / 1_000_000) * rate.in + (tokensOut / 1_000_000) * rate.out).toFixed(6));
}

/** Per-run analytics + cost table feeding the Employee Agents surface + COO. */
async function ensureRunsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boss_agent_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id text NOT NULL,
      agent_name text,
      started_at timestamptz,
      finished_at timestamptz DEFAULT now(),
      status text,
      model text,
      provider text,
      tokens_in integer DEFAULT 0,
      tokens_out integer DEFAULT 0,
      cost_usd numeric(12,6) DEFAULT 0,
      duration_ms integer,
      summary text
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_boss_agent_runs_agent ON boss_agent_runs(agent_id, finished_at DESC)`,
  );
}

// ── Agent Execution ──────────────────────────────────────────────────────────

async function executeAgent(agent: PersistentAgent, triggerContext?: string): Promise<void> {
  const pool = getPool();
  const startedAt = Date.now();
  console.log(`[scheduler] Running agent: ${agent.name} (${agent.id})`);

  // Derive provider from the model id: OpenRouter model ids are namespaced
  // (contain a '/', e.g. "anthropic/claude-3.7-sonnet"); bare ids run on the
  // global brain provider. The brain honours provider/model/allowedTools only
  // for internal (X-BOSS-Internal) calls — which this is.
  // Resolve a model-route LABEL (e.g. 'reasoning') to a concrete model, else pass through.
  const resolved = await resolveModel(currentTenantId(), agent.model || '');
  const model = resolved.model;
  const provider = resolved.provider;
  const allowedTools = Array.isArray(agent.tools) ? agent.tools : [];

  // Budget hard-stop: once over a cap (with hard_stop on), skip costly (paid) agents.
  if (model.includes('/') && (await isHardOverBudget(currentTenantId()))) {
    console.warn(`[scheduler] over budget — skipping paid agent ${agent.name}`);
    await pool.query(
      `INSERT INTO boss_agent_runs (agent_id, agent_name, started_at, finished_at, status, model, provider, summary)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), now(), 'skipped', $4, $5, $6)`,
      [agent.id, agent.name, startedAt, model, provider ?? 'global', 'Skipped: budget cap reached'],
    ).catch(() => {});
    return;
  }

  let status = 'ok';
  let result = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let usedModel = model;

  try {
    const port = process.env.PORT || '8010';
    const res = await fetch(`http://127.0.0.1:${port}/api/brain/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BOSS-Internal': 'true',
      },
      body: JSON.stringify({
        message: `[PERSISTENT AGENT: ${agent.name}]\n\nYou are running as a persistent agent. Follow these instructions:\n\n${agent.instructions}${triggerContext ? `\n\n--- TRIGGER ---\n${triggerContext}` : ''}`,
        // Fresh conversation each run — prevents unbounded context accumulation
        conversationId: `agent-${agent.id}-run-${Date.now()}`,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        // Always send the grant — the brain fails CLOSED on an empty grant.
        // Use ['*'] in the agent's tools column to mean full access.
        allowedTools,
      }),
      signal: AbortSignal.timeout(300_000), // 5 min max per run
    });

    const data = await res.json() as {
      response?: string;
      error?: string;
      model?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    result = data.response || data.error || 'No response';
    if (data.error) status = 'error';
    tokensIn = data.usage?.inputTokens ?? 0;
    tokensOut = data.usage?.outputTokens ?? 0;
    usedModel = data.model || model;

    await pool.query(
      `UPDATE boss_persistent_agents
       SET last_run_at = now(), last_result = $1, run_count = run_count + 1, updated_at = now()
       WHERE id = $2`,
      [result.slice(0, 5000), agent.id],
    );

    console.log(`[scheduler] Agent ${agent.name} completed: ${result.slice(0, 100)}`);
  } catch (err) {
    status = 'error';
    const msg = err instanceof Error ? err.message : String(err);
    result = `Error: ${msg}`;
    console.error(`[scheduler] Agent ${agent.name} failed: ${msg}`);

    await pool.query(
      `UPDATE boss_persistent_agents
       SET last_run_at = now(), last_result = $1, error_count = error_count + 1, updated_at = now()
       WHERE id = $2`,
      [result, agent.id],
    );
  }

  // Record per-run metrics (analytics + cost) for the Employee Agents surface + COO.
  try {
    const durationMs = Date.now() - startedAt;
    const costUsd = estimateCostUsd(usedModel, tokensIn, tokensOut);
    await pool.query(
      `INSERT INTO boss_agent_runs
         (agent_id, agent_name, started_at, finished_at, status, model, provider, tokens_in, tokens_out, cost_usd, duration_ms, summary)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), now(), $4, $5, $6, $7, $8, $9, $10, $11)`,
      [agent.id, agent.name, startedAt, status, usedModel, provider ?? 'global', tokensIn, tokensOut, costUsd, durationMs, result.slice(0, 2000)],
    );
  } catch (err) {
    if (Math.random() < 0.1) console.error('[scheduler] metrics insert failed:', err);
  }
}

// ── Trigger-gated agents ─────────────────────────────────────────────────────
// Some agents have no work most heartbeats — they only act when a watched Drive
// folder gets a new file. A cheap (free) Drive check runs first; the costly brain
// is only woken when something new actually arrived. Otherwise the heartbeat just
// advances and goes back to sleep.
interface TriggerGate { account: string; folderId: string }
const TRIGGER_GATES: Record<string, TriggerGate> = {
  // Transcript Intelligence Agent → My Drive / D. Caine Solutions / Meetings / Transcript
  transcript: { account: 'd.caine@dcaine.com', folderId: '1z84HIkWwkTJFokwjkLiZUnCoM-s0N51o' },
};
function gateKeyFor(agent: PersistentAgent): string | null {
  if (/transcript/i.test(agent.name)) return 'transcript';
  if (/chief engineer|\bcto\b/i.test(agent.name)) return 'cto';
  return null;
}

async function maybeRunAgent(agent: PersistentAgent): Promise<void> {
  const key = gateKeyFor(agent);

  // CTO: only wake the brain when there are open incidents to work.
  if (key === 'cto') {
    const pool = getPool();
    try {
      const open = await getOpenIncidents();
      if (open.length === 0) {
        await pool.query(`UPDATE boss_persistent_agents SET last_run_at = now() WHERE id = $1`, [agent.id]);
        return;
      }
      const ctx = `${open.length} OPEN incident(s) — work each and CLOSE it (resolved or escalated) this run:\n` +
        open.map((it) => `- [${it.id}] ${it.severity} · ${it.title}`).join('\n');
      await executeAgent(agent, ctx);
    } catch (err) {
      if (Math.random() < 0.2) console.error('[scheduler] CTO gate error:', err);
      await pool.query(`UPDATE boss_persistent_agents SET last_run_at = now() WHERE id = $1`, [agent.id]).catch(() => {});
    }
    return;
  }

  const gate = key ? TRIGGER_GATES[key] : null;
  if (!gate) { await executeAgent(agent); return; }

  const pool = getPool();
  try {
    const since = agent.last_run_at ? new Date(agent.last_run_at).toISOString() : null;
    const fresh = await hasNewDriveFiles(gate.folderId, since, gate.account);
    if (fresh.length === 0) {
      // No new work — advance the heartbeat watermark, do NOT wake the brain (free).
      await pool.query(`UPDATE boss_persistent_agents SET last_run_at = now() WHERE id = $1`, [agent.id]);
      return;
    }
    const list = fresh.slice(0, 10)
      .map((f) => `- ${f.name} (file_id: ${f.id}, modified ${f.modifiedTime})`)
      .join('\n');
    const ctx = `${fresh.length} NEW file(s) appeared in the watched Drive folder since your last run. ` +
      `Process each now — read with boss_drive_read_doc using google_account "${gate.account}":\n${list}`;
    await executeAgent(agent, ctx);
  } catch (err) {
    if (Math.random() < 0.2) console.error(`[scheduler] trigger gate (${agent.name}) error:`, err);
    // Advance watermark so a transient Drive error doesn't tight-loop the check.
    await pool.query(`UPDATE boss_persistent_agents SET last_run_at = now() WHERE id = $1`, [agent.id]).catch(() => {});
  }
}

// ── Scheduler Loop ───────────────────────────────────────────────────────────

async function checkSchedule(): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<PersistentAgent>(
      `SELECT id, name, instructions, cron_expression, status, model, tools, last_run_at, run_count
       FROM boss_persistent_agents
       WHERE status = 'active'`,
    );

    for (const agent of rows) {
      if (shouldRunNow(agent.cron_expression, agent.last_run_at) && !inFlight.has(agent.id)) {
        // Don't await — let agents run in parallel, but never overlap the SAME agent.
        // maybeRunAgent applies any trigger-gate (cheap Drive precheck) before the brain.
        inFlight.add(agent.id);
        void maybeRunAgent(agent).finally(() => inFlight.delete(agent.id));
      }
    }

    // Hourly: scan backend tool/platform cost for spikes → open CTO incidents.
    if (Date.now() - lastSpikeCheck >= 3_600_000) {
      lastSpikeCheck = Date.now();
      void detectAndRecordSpikes().catch((e) => {
        if (Math.random() < 0.2) console.error('[scheduler] cost spike check failed:', e);
      });
    }
  } catch (err) {
    // Don't spam logs
    if (Math.random() < 0.05) {
      console.error('[scheduler] Check error:', err);
    }
  }
}

// ── CRUD for agents (called by tool handlers) ────────────────────────────────

export async function createPersistentAgent(params: {
  name: string;
  instructions: string;
  cronExpression?: string;
  model?: string;
  tools?: string[];
  createdBy?: string;
}): Promise<{ id: string; name: string }> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; name: string }>(
    `INSERT INTO boss_persistent_agents (name, instructions, cron_expression, model, tools, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name`,
    [
      params.name,
      params.instructions,
      params.cronExpression || '0 */4 * * *',
      params.model || 'claude-sonnet-4-6',
      params.tools || [],
      params.createdBy || 'admin',
    ],
  );
  console.log(`[scheduler] Created agent: ${rows[0].name} (${rows[0].id})`);
  return rows[0];
}

export async function listPersistentAgents(): Promise<PersistentAgent[]> {
  const pool = getPool();
  const { rows } = await pool.query<PersistentAgent>(
    `SELECT id, name, instructions, cron_expression, status, model, tools, last_run_at, run_count
     FROM boss_persistent_agents
     ORDER BY created_at DESC`,
  );
  return rows;
}

export async function updatePersistentAgent(id: string, updates: {
  instructions?: string;
  cronExpression?: string;
  status?: string;
  name?: string;
}): Promise<void> {
  const pool = getPool();
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let i = 1;

  if (updates.instructions !== undefined) { sets.push(`instructions = $${i++}`); values.push(updates.instructions); }
  if (updates.cronExpression !== undefined) { sets.push(`cron_expression = $${i++}`); values.push(updates.cronExpression); }
  if (updates.status !== undefined) { sets.push(`status = $${i++}`); values.push(updates.status); }
  if (updates.name !== undefined) { sets.push(`name = $${i++}`); values.push(updates.name); }

  values.push(id);
  await pool.query(`UPDATE boss_persistent_agents SET ${sets.join(', ')} WHERE id = $${i}`, values);
}

export async function deletePersistentAgent(id: string): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM boss_persistent_agents WHERE id = $1', [id]);
  console.log(`[scheduler] Deleted agent: ${id}`);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startScheduler(): void {
  console.log('[scheduler] Starting persistent agent scheduler (checks every 60s)');
  void ensureRunsTable();
  void logLoadedSchedules();
  schedulerHandle = setInterval(() => void checkSchedule(), SCHEDULER_CHECK_INTERVAL_MS);
  // First check after 30 seconds
  setTimeout(() => void checkSchedule(), 30_000);
}

// WS-4: log EVERY active agent's schedule loudly at startup so an invalid /
// never-firing cron is visible immediately (was: silent 2% warning).
async function logLoadedSchedules(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ name: string; cron_expression: string }>(
      `SELECT name, cron_expression FROM boss_persistent_agents WHERE status = 'active' ORDER BY name`,
    );
    if (rows.length === 0) { console.log('[scheduler] no active agents'); return; }
    console.log(`[scheduler] ${rows.length} active agent schedule(s):`);
    for (const a of rows) {
      const desc = describeSchedule(a.cron_expression);
      const flag = desc.startsWith('INVALID') ? '  ⚠️ ' : '  ✓ ';
      console.log(`${flag}${a.name}  [${a.cron_expression}]  ${desc}`);
    }
  } catch (err) {
    console.warn('[scheduler] could not log schedules:', (err as Error).message);
  }
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    console.log('[scheduler] Stopped');
  }
}
