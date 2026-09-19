/**
 * Managed Agents — BOS's replacement for the n8n delegation path.
 *
 * Anthropic hosts the agent loop and a per-session container; BOS just declares
 * the agent once and opens sessions against it. The Mygentic MCP server is
 * attached the way Managed Agents requires:
 *
 *   • the AGENT declares the server (type/name/url, no auth) + an mcp_toolset
 *   • a VAULT holds the OAuth credential, keyed by the MCP server URL
 *   • each SESSION attaches the vault via vault_ids
 *
 * Anthropic refreshes the OAuth token from the stored refresh_token, so BOS
 * does not run a refresh loop — the browser login happens once.
 *
 * Anthropic resource IDs (environment, vault, agent) are persisted in
 * boss_managed_agent_state so we create each exactly once and reuse it. An
 * agent whose config changes is UPDATED (bumping its version), never recreated.
 */

import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../db.js';
import {
  getConnectionByName,
  isAuthenticated,
  saveVaultCredentialId,
  type McpConnection,
} from './mcp-registry.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL = process.env.BOSS_MANAGED_AGENT_MODEL || 'claude-opus-5';
const ENV_NAME = 'bos-managed-agents';
const VAULT_NAME = 'bos-mcp-credentials';
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_SYSTEM = [
  'You are a BOS Managed Agent operating on behalf of the BOS COO.',
  'You have access to the connected MCP servers listed in your tools, plus a',
  'sandboxed container with bash and file tools for scratch work.',
  '',
  'Rules:',
  '- Use the MCP tools directly. Do not ask for permission mid-task.',
  '- When a task spans several MCP calls, make them and then report once.',
  '- Report exactly what you did, what came back, and anything that failed.',
  '- If a tool errors, say so plainly with the error text. Never invent results.',
].join('\n');

// ── Client ───────────────────────────────────────────────────────────────────

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — Managed Agents require an Anthropic API key (not a Claude CLI session).',
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

export function managedAgentsConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ── State store ──────────────────────────────────────────────────────────────

let stateReady: Promise<void> | null = null;

function ensureStateSchema(): Promise<void> {
  if (!stateReady) {
    stateReady = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boss_managed_agent_state (
          key        text PRIMARY KEY,
          value      jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boss_managed_agent_runs (
          id          text PRIMARY KEY,
          agent_key   text NOT NULL,
          session_id  text,
          status      text NOT NULL,
          prompt      text,
          result      text,
          error       text,
          cost_usd    numeric,
          started_at  timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz
        )
      `);
    })().catch((err) => {
      stateReady = null;
      throw err;
    });
  }
  return stateReady;
}

async function readState<T>(key: string): Promise<T | null> {
  await ensureStateSchema();
  const { rows } = await getPool().query('SELECT value FROM boss_managed_agent_state WHERE key = $1', [key]);
  return rows.length ? (rows[0].value as T) : null;
}

async function writeState(key: string, value: unknown): Promise<void> {
  await ensureStateSchema();
  await getPool().query(
    `INSERT INTO boss_managed_agent_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ── Environment ──────────────────────────────────────────────────────────────

/**
 * The container the agent's own tools run in. Networking is unrestricted so the
 * sandbox can reach whatever the task needs; MCP traffic does not depend on
 * this (it is proxied Anthropic-side), but bash/curl work does.
 */
export async function ensureEnvironment(): Promise<string> {
  const cached = await readState<{ id: string }>('environment');
  if (cached?.id) return cached.id;

  const env = await getAnthropic().beta.environments.create({
    name: ENV_NAME,
    description: 'BOS managed-agent sandbox',
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
  });
  await writeState('environment', { id: env.id });
  return env.id;
}

// ── Vault + MCP credential ───────────────────────────────────────────────────

async function ensureVault(): Promise<string> {
  const cached = await readState<{ id: string }>('vault');
  if (cached?.id) return cached.id;

  const vault = await getAnthropic().beta.vaults.create({ display_name: VAULT_NAME });
  await writeState('vault', { id: vault.id });
  return vault.id;
}

/**
 * Push a connection's OAuth tokens into the vault as an `mcp_oauth` credential.
 *
 * The credential key is the MCP server URL and must be unique per vault, so a
 * re-login archives the previous credential first. The `refresh` block is what
 * lets Anthropic keep the token alive without another browser round-trip.
 */
export async function syncMcpCredential(conn: McpConnection): Promise<string> {
  if (!conn.serverUrl) throw new Error(`MCP connection "${conn.name}" has no server URL`);
  if (!conn.accessToken) throw new Error(`MCP connection "${conn.name}" is not authenticated yet`);

  const anthropic = getAnthropic();
  const vaultId = await ensureVault();

  // Keys are immutable — replace by archiving the old credential.
  if (conn.vaultCredentialId) {
    try {
      await anthropic.beta.vaults.credentials.archive(conn.vaultCredentialId, { vault_id: vaultId });
    } catch {
      /* already archived or gone — creating the replacement is what matters */
    }
  }

  const refresh =
    conn.refreshToken && conn.oauthTokenEndpoint && conn.oauthClientId
      ? {
          refresh_token: conn.refreshToken,
          client_id: conn.oauthClientId,
          token_endpoint: conn.oauthTokenEndpoint,
          token_endpoint_auth: conn.oauthClientSecret
            ? { type: 'client_secret_post' as const, client_secret: conn.oauthClientSecret }
            : { type: 'none' as const },
          ...(conn.oauthScope ? { scope: conn.oauthScope } : {}),
          ...(conn.oauthResource ? { resource: conn.oauthResource } : {}),
        }
      : undefined;

  const credential = await anthropic.beta.vaults.credentials.create(vaultId, {
    display_name: `${conn.name} (MCP OAuth)`,
    auth: {
      type: 'mcp_oauth',
      mcp_server_url: conn.serverUrl,
      access_token: conn.accessToken,
      ...(conn.tokenExpiresAt ? { expires_at: conn.tokenExpiresAt.toISOString() } : {}),
      ...(refresh ? { refresh } : {}),
    },
  });

  await saveVaultCredentialId(conn.id, credential.id);
  return credential.id;
}

// ── Agent ────────────────────────────────────────────────────────────────────

export interface AgentSpec {
  /** Stable key BOS uses to look the agent up, e.g. "mygentic". */
  key: string;
  name: string;
  system?: string;
  /** MCP connections to attach, by registry name. */
  mcpConnectionNames: string[];
}

interface StoredAgent {
  id: string;
  version: number;
  configHash: string;
}

function hashConfig(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/** MCP server names must match `mcp_toolset.mcp_server_name`, so normalise once. */
function toolsetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

/**
 * Create the agent on first use; update it (new version) when its config drifts.
 * Never recreate — sessions pin versions, and recreating orphans them.
 */
export async function ensureAgent(spec: AgentSpec): Promise<StoredAgent> {
  const anthropic = getAnthropic();

  const connections: McpConnection[] = [];
  for (const name of spec.mcpConnectionNames) {
    const conn = await getConnectionByName(name);
    if (!conn) throw new Error(`MCP connection "${name}" is not registered — add it in Settings → Global MCP.`);
    if (!conn.serverUrl) throw new Error(`MCP connection "${name}" has no server URL (stdio is not supported by Managed Agents).`);
    if (!conn.enabled) throw new Error(`MCP connection "${name}" is disabled.`);
    connections.push(conn);
  }

  const mcpServers = connections.map((conn) => ({
    type: 'url' as const,
    name: toolsetName(conn.name),
    url: conn.serverUrl as string,
  }));

  const config = {
    model: MODEL,
    name: spec.name,
    system: spec.system ?? DEFAULT_SYSTEM,
    mcp_servers: mcpServers,
    tools: [
      { type: 'agent_toolset_20260401' as const, default_config: { enabled: true } },
      ...mcpServers.map((server) => ({
        type: 'mcp_toolset' as const,
        mcp_server_name: server.name,
      })),
    ],
  };
  const configHash = hashConfig(config);

  const stateKey = `agent:${spec.key}`;
  const stored = await readState<StoredAgent>(stateKey);

  if (stored?.id && stored.configHash === configHash) return stored;

  if (stored?.id) {
    const updated = await anthropic.beta.agents.update(stored.id, config);
    const next: StoredAgent = { id: updated.id, version: updated.version, configHash };
    await writeState(stateKey, next);
    return next;
  }

  const created = await anthropic.beta.agents.create(config);
  const next: StoredAgent = { id: created.id, version: created.version, configHash };
  await writeState(stateKey, next);
  return next;
}

// ── Running a task ───────────────────────────────────────────────────────────

export interface RunOptions {
  prompt: string;
  agentKey?: string;
  agentName?: string;
  system?: string;
  mcpConnectionNames?: string[];
  timeoutMs?: number;
  title?: string;
}

export interface RunResult {
  runId: string;
  sessionId: string;
  status: 'completed' | 'timeout' | 'terminated';
  text: string;
  errors: string[];
  costUsd: number | null;
}

/** Not every event in the stream union carries an id (start/delta/usage don't). */
function eventId(event: unknown): string | undefined {
  const id = (event as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : undefined;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        Boolean(block) &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

/**
 * Run one task to completion and return what the agent said.
 *
 * The prompt rides along as an `initial_events` entry on session create, which
 * removes the stream-open-before-send race. The SSE stream has no replay, so
 * after it closes we re-read the event list and rebuild the transcript from
 * event IDs — that way a dropped connection costs us nothing.
 */
export async function runManagedAgentTask(options: RunOptions): Promise<RunResult> {
  const anthropic = getAnthropic();
  const agentKey = options.agentKey || 'mygentic';
  const connectionNames = options.mcpConnectionNames?.length
    ? options.mcpConnectionNames
    : [agentKey];

  const agent = await ensureAgent({
    key: agentKey,
    name: options.agentName || `BOS ${agentKey} agent`,
    system: options.system,
    mcpConnectionNames: connectionNames,
  });

  // Make sure every attached MCP server has a live credential in the vault.
  const vaultId = await ensureVault();
  for (const name of connectionNames) {
    const conn = await getConnectionByName(name);
    if (!conn) continue;
    if (!isAuthenticated(conn)) {
      throw new Error(
        `MCP connection "${name}" is not logged in. Open Settings → Global MCP and click Login, then retry.`,
      );
    }
    if (!conn.vaultCredentialId) await syncMcpCredential(conn);
  }

  const environmentId = await ensureEnvironment();
  const runId = `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await ensureStateSchema();
  await getPool().query(
    'INSERT INTO boss_managed_agent_runs (id, agent_key, status, prompt) VALUES ($1,$2,$3,$4)',
    [runId, agentKey, 'running', options.prompt],
  );

  let session;
  try {
    session = await anthropic.beta.sessions.create({
      agent: { type: 'agent', id: agent.id, version: agent.version },
      environment_id: environmentId,
      vault_ids: [vaultId],
      title: options.title || `BOS ${agentKey} run`,
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: options.prompt }] }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await getPool().query(
      `UPDATE boss_managed_agent_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [runId, message],
    );
    throw err;
  }

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const seen = new Set<string>();
  const chunks: string[] = [];
  const errors: string[] = [];
  let status: RunResult['status'] = 'timeout';

  try {
    // The deadline has to live on the request, not the loop body: a session that
    // emits nothing would otherwise park in `for await` indefinitely.
    const stream = await anthropic.beta.sessions.events.stream(session.id, undefined, {
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    for await (const event of stream) {
      const id = eventId(event);
      if (id) seen.add(id);
      if (event.type === 'agent.message') {
        chunks.push(textFromContent((event as { content?: unknown }).content));
      } else if (event.type === 'session.error') {
        const message = (event as { message?: unknown }).message;
        errors.push(typeof message === 'string' ? message : JSON.stringify(event));
      } else if (event.type === 'session.status_idle') {
        status = 'completed';
        break;
      } else if (event.type === 'session.status_terminated') {
        status = 'terminated';
        break;
      }
      if (Date.now() > deadline) break;
    }
  } catch (err) {
    // Hitting the deadline aborts the request; `status` already says 'timeout',
    // so don't also report it as a failure.
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    if (!aborted) errors.push(err instanceof Error ? err.message : String(err));
  }

  // Consolidate: the stream has no replay, so anything we missed is recovered here.
  try {
    const page = await anthropic.beta.sessions.events.list(session.id);
    for await (const event of page) {
      const id = eventId(event);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      if (event.type === 'agent.message') {
        chunks.push(textFromContent((event as { content?: unknown }).content));
      } else if (event.type === 'session.error') {
        const message = (event as { message?: unknown }).message;
        errors.push(typeof message === 'string' ? message : JSON.stringify(event));
      }
    }
  } catch (err) {
    errors.push(`event consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let costUsd: number | null = null;
  try {
    const refreshed = await anthropic.beta.sessions.retrieve(session.id);
    const amount = (refreshed.usage as { list_cost?: { amount?: unknown } } | undefined)?.list_cost?.amount;
    if (typeof amount === 'number') costUsd = amount;
    else if (typeof amount === 'string') costUsd = Number(amount) || null;
  } catch {
    /* cost is best-effort */
  }

  const text = chunks.join('').trim();
  await getPool().query(
    `UPDATE boss_managed_agent_runs
        SET status = $2, session_id = $3, result = $4, error = $5, cost_usd = $6, finished_at = now()
      WHERE id = $1`,
    [runId, status, session.id, text, errors.length ? errors.join('\n') : null, costUsd],
  );

  return { runId, sessionId: session.id, status, text, errors, costUsd };
}

// ── Run history ──────────────────────────────────────────────────────────────

export interface RunRecord {
  id: string;
  agentKey: string;
  sessionId: string | null;
  status: string;
  prompt: string | null;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export async function listRuns(limit = 10): Promise<RunRecord[]> {
  await ensureStateSchema();
  const capped = Math.min(Math.max(1, limit), 50);
  const { rows } = await getPool().query(
    'SELECT * FROM boss_managed_agent_runs ORDER BY started_at DESC LIMIT $1',
    [capped],
  );
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return rows.map((row: any) => ({
    id: row.id,
    agentKey: row.agent_key,
    sessionId: row.session_id,
    status: row.status,
    prompt: row.prompt,
    result: row.result,
    error: row.error,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
