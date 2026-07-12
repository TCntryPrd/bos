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

import { spawn } from 'node:child_process';
import { getPool } from '../db.js';
import { hasNewDriveFiles } from '../tools/executor.js';
import { detectAndRecordSpikes, getOpenIncidents } from '../lib/cost-ledger.js';

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

type EmployeeAgentProvider = 'codex-cli';

interface EmployeeAgentRuntime {
  provider: EmployeeAgentProvider;
  model: string;
  logModel: string;
}

interface EmployeeAgentBrainResult {
  response?: string;
  error?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

function defaultCodexModel(): string {
  return process.env.BOSS_EMPLOYEE_AGENT_CODEX_MODEL || process.env.CODEX_MODEL || '';
}

function codexRuntime(model?: string): EmployeeAgentRuntime {
  const selectedModel = (model || defaultCodexModel()).trim();
  return {
    provider: 'codex-cli',
    model: selectedModel,
    logModel: selectedModel ? `codex:${selectedModel}` : 'codex-cli',
  };
}

function resolveEmployeeAgentRuntime(rawModel: string | null | undefined): EmployeeAgentRuntime {
  const raw = (rawModel || '').trim();
  const lower = raw.toLowerCase();

  if (lower.startsWith('codex:')) {
    return codexRuntime(raw.slice(raw.indexOf(':') + 1).trim());
  }

  if (lower === 'codex' || lower === 'codex-cli' || lower === '') {
    return codexRuntime();
  }

  if (/^(gpt-|o[134]-|codex-)/i.test(raw)) {
    return codexRuntime(raw);
  }

  // Employee Agents are Codex-only. Legacy Claude, OpenRouter, NIM, and other
  // provider model IDs are normalized onto Codex CLI subscription auth here,
  // leaving non-Employee-Agent Claude paths untouched.
  return codexRuntime();
}

// ── Cron Parser (simple — supports standard 5-field cron) ────────────────────

// Parse a cron hour field into the set of allowed UTC hours. Returns null for
// "*" (no restriction). Supports lists + ranges, incl. wrap-around past midnight
// ("16-1" → 16..23,0,1). Lets an interval cron carry a business-hours window.
function parseHourSet(hourPart: string): Set<number> | null {
  if (!hourPart || hourPart === '*') return null;
  const set = new Set<number>();
  for (const tok of hourPart.split(',')) {
    if (tok.includes('-')) {
      const [a, b] = tok.split('-').map((x) => parseInt(x, 10));
      if (Number.isNaN(a) || Number.isNaN(b)) return null;
      if (a <= b) { for (let h = a; h <= b; h++) set.add(h % 24); }
      else { for (let h = a; h < 24; h++) set.add(h); for (let h = 0; h <= b; h++) set.add(h); }
    } else {
      const h = parseInt(tok, 10);
      if (Number.isNaN(h)) return null;
      set.add(h % 24);
    }
  }
  return set.size ? set : null;
}

function shouldRunNow(cronExpr: string, lastRun: Date | null): boolean {
  // Simple interval-based parsing for common patterns:
  // "*/15 * * * *" = every 15 minutes
  // "0 */4 * * *" = every 4 hours
  // "0 8 * * *" = daily at 8am
  // "0 */1 * * *" = every hour

  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const now = new Date();
  const [minPart, hourPart] = parts;

  // Calculate interval in ms from cron expression
  let intervalMs = 0;

  if (minPart.startsWith('*/')) {
    // Every N minutes — optionally restricted to a UTC hour window, e.g.
    // "*/15 16-23,0-1 * * *" = every 15 min only during those UTC hours
    // (used for business-hours agents like the Transcript Intelligence Agent).
    intervalMs = parseInt(minPart.slice(2), 10) * 60_000;
    const hourSet = parseHourSet(hourPart);
    if (hourSet && !hourSet.has(now.getUTCHours())) return false;
  } else if (hourPart.startsWith('*/')) {
    // Every N hours
    intervalMs = parseInt(hourPart.slice(2), 10) * 3600_000;
  } else if (minPart === '0' && /^\d+$/.test(hourPart)) {
    // Specific hour — daily
    const targetHour = parseInt(hourPart, 10);
    if (now.getUTCHours() === targetHour && now.getUTCMinutes() < 2) {
      // Within the first 2 minutes of the target hour
      if (!lastRun || now.getTime() - lastRun.getTime() > 3600_000) return true;
    }
    return false;
  } else {
    // Unrecognised cron shape (list/range/step-list, e.g. "0 9,17 * * *").
    // Fail SAFE: do NOT run on a guessed cadence — warn occasionally and skip
    // until the schedule is expressed in a supported form.
    if (Math.random() < 0.02) {
      console.warn(`[scheduler] unsupported cron "${cronExpr}" — skipping (supported: */N min, */N hour, "0 H * * *")`);
    }
    return false;
  }

  if (intervalMs === 0) return false;
  if (!lastRun) return true; // Never run before
  return now.getTime() - lastRun.getTime() >= intervalMs;
}

// ── Run metrics ──────────────────────────────────────────────────────────────
// Employee Agents are Codex CLI subscription runs, so API-token cost is not
// estimated here. Runtime health is tracked through status, duration, and tokens.
function estimateCostUsd(_model: string, _tokensIn: number, _tokensOut: number): number {
  return 0;
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

function buildAgentPrompt(agent: PersistentAgent, triggerContext?: string): string {
  return `[PERSISTENT AGENT: ${agent.name}]

You are running as a persistent Employee Agent on Codex CLI. Do not present yourself as Claude or any other provider.
Follow these instructions:

${agent.instructions}${triggerContext ? `\n\n--- TRIGGER ---\n${triggerContext}` : ''}`;
}

function toolBridgePrompt(agent: PersistentAgent, allowedTools: string[]): string {
  if (allowedTools.length === 0) {
    return 'No BOS tools are granted for this run. Complete the assignment using reasoning only.';
  }
  return [
    'BOS TOOL BRIDGE',
    'You are running inside the BOS API container. The app-specific boss_* tools are available through this local command bridge.',
    'List your granted tools and schemas:',
    '  node /app/apps/api/dist/employee-tool-cli.js list',
    'Run one granted tool:',
    '  node /app/apps/api/dist/employee-tool-cli.js run <tool_name> \'<json_args>\'',
    'Examples:',
    '  node /app/apps/api/dist/employee-tool-cli.js run boss_task_list \'{}\'',
    '  node /app/apps/api/dist/employee-tool-cli.js run boss_gmail_unread \'{"limit":10}\'',
    'Use only this bridge for BOS tools. Do not say boss_* tools are unavailable before checking the bridge.',
    `Granted tool names for ${agent.name}: ${allowedTools.join(', ')}`,
  ].join('\n');
}

function runCodexAgent(
  prompt: string,
  runtime: EmployeeAgentRuntime,
  agent: PersistentAgent,
  allowedTools: string[],
): Promise<EmployeeAgentBrainResult> {
  return new Promise((resolve, reject) => {
    const codexBin = process.env.BOSS_EMPLOYEE_AGENT_CODEX_BIN || process.env.BOSS_GIO_BIN || 'codex';
    const codexHome = process.env.CODEX_HOME || '/home/boss/.codex';
    const workspace = process.env.BOSS_EMPLOYEE_AGENT_WORKSPACE
      || process.env.BOSS_GIO_WORKSPACE
      || '/home/boss/boss-dev';
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '--skip-git-repo-check',
      '--cd',
      workspace,
    ];
    if (runtime.model) args.push('--model', runtime.model);
    args.push('-');

    const codexEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      BOSS_EMPLOYEE_AGENT_NAME: agent.name,
      BOSS_EMPLOYEE_AGENT_ID: agent.id,
      BOSS_EMPLOYEE_AGENT_GRANTED_TOOLS: JSON.stringify(allowedTools),
    };
    // Force Codex CLI to use CODEX_HOME subscription auth, not API-key billing.
    delete codexEnv.OPENAI_API_KEY;

    const child = spawn(codexBin, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexEnv,
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let assistantText = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already closed */ }
      reject(new Error(`Codex CLI timed out after 300000ms: ${stderrBuffer.slice(-1000)}`));
    }, 300_000);
    timer.unref();

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const ev = JSON.parse(trimmed) as {
          type?: string;
          item?: { type?: string; text?: string };
          usage?: { input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
        };
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
          assistantText += ev.item.text;
        }
        if (ev.usage) {
          tokensIn = ev.usage.input_tokens ?? tokensIn;
          tokensOut = ev.usage.output_tokens ?? tokensOut;
        }
      } catch {
        // Codex --json should be JSONL, but ignore any incidental text.
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    });
    child.stderr?.on('data', (chunk: string) => { stderrBuffer += chunk; });
    child.stdin?.end(`${prompt}\n\n---\n${toolBridgePrompt(agent, allowedTools)}\n`);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      if (code !== 0) {
        reject(new Error(`Codex CLI exited ${code}: ${stderrBuffer.slice(-2000)}`));
        return;
      }
      resolve({
        response: assistantText || 'Codex CLI completed without a final message.',
        model: runtime.logModel,
        usage: { inputTokens: tokensIn, outputTokens: tokensOut },
      });
    });
  });
}

async function executeAgent(agent: PersistentAgent, triggerContext?: string): Promise<void> {
  const pool = getPool();
  const startedAt = Date.now();
  console.log(`[scheduler] Running agent: ${agent.name} (${agent.id})`);

  const runtime = resolveEmployeeAgentRuntime(agent.model);
  const allowedTools = Array.isArray(agent.tools) ? agent.tools : [];
  const prompt = buildAgentPrompt(agent, triggerContext);

  let status = 'ok';
  let result = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let usedModel = runtime.logModel;
  let usedProvider = runtime.provider;

  try {
    const data = await runCodexAgent(prompt, runtime, agent, allowedTools);

    result = data.response || data.error || 'No response';
    if (data.error) status = 'error';
    tokensIn = data.usage?.inputTokens ?? 0;
    tokensOut = data.usage?.outputTokens ?? 0;
    usedModel = data.model || runtime.logModel;

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
      [agent.id, agent.name, startedAt, status, usedModel, usedProvider, tokensIn, tokensOut, costUsd, durationMs, result.slice(0, 2000)],
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
      params.model || 'codex',
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
  schedulerHandle = setInterval(() => void checkSchedule(), SCHEDULER_CHECK_INTERVAL_MS);
  // First check after 30 seconds
  setTimeout(() => void checkSchedule(), 30_000);
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    console.log('[scheduler] Stopped');
  }
}
