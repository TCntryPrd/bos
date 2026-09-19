/**
 * Managed Agent tools — the delegation path that replaces boss_n8n_delegate.
 *
 * Instead of asking n8n to fan out to an MCP server, BOS opens a session on an
 * Anthropic-hosted Managed Agent that has the MCP server attached as a toolset.
 * The agent runs the whole loop server-side and returns its report.
 *
 * Registered only when ANTHROPIC_API_KEY is present (see tools/index.ts).
 */

import type { BrainTool } from '@boss/brain';
import {
  listRuns,
  managedAgentsConfigured,
  runManagedAgentTask,
} from '../lib/managed-agent.js';
import { listConnections, isAuthenticated } from '../lib/mcp-registry.js';

// ── Tool definitions ─────────────────────────────────────────────────────────

export const managedAgentRunTool: BrainTool = {
  name: 'boss_managed_agent_run',
  description:
    'Delegate a task to a Managed Agent that has your MCP servers (e.g. Mygentic) attached. ' +
    'Anthropic hosts the agent loop and a sandboxed container, so the agent can make many MCP ' +
    'calls, do scratch work, and come back with one report. ' +
    'PREFER this over boss_n8n_delegate for anything that needs MCP tools — it does not depend on n8n. ' +
    'Runs synchronously and can take minutes; use it for real work, not quick lookups.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'The full task for the agent. Be specific about what to fetch, what to do with it, and what to report back.',
      },
      agent_key: {
        type: 'string',
        description:
          'Which agent config to use. Defaults to "mygentic". Also selects the MCP connection of the same name unless mcp_connections is given.',
      },
      mcp_connections: {
        type: 'array',
        description:
          'MCP connection names to attach for this run (from boss_mcp_list_connections). Defaults to the connection matching agent_key.',
        items: { type: 'string' },
      },
      timeout_minutes: {
        type: 'number',
        description: 'How long to let the agent run before giving up. Default 10, max 30.',
      },
    },
    required: ['prompt'],
  },
};

export const mcpListConnectionsTool: BrainTool = {
  name: 'boss_mcp_list_connections',
  description:
    'List the MCP servers registered with BOS and whether each one is authenticated. ' +
    'Use this before boss_managed_agent_run to check the server you need is connected. ' +
    'A connection that is not authenticated needs a one-time browser login in Settings → Global MCP.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const managedAgentRunsTool: BrainTool = {
  name: 'boss_managed_agent_runs',
  description:
    'Get recent Managed Agent runs with status, cost, and the result text. ' +
    'Use this to check what a delegated task returned or why one failed.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many runs to return (1–50). Defaults to 10.' },
    },
    required: [],
  },
};

export const ALL_MANAGED_AGENT_TOOLS: BrainTool[] = [
  managedAgentRunTool,
  mcpListConnectionsTool,
  managedAgentRunsTool,
];

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleRun(args: Record<string, unknown>): Promise<string> {
  if (!managedAgentsConfigured()) {
    return 'Managed Agents are unavailable: ANTHROPIC_API_KEY is not set on the API container.';
  }
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return 'boss_managed_agent_run requires a "prompt".';

  const timeoutMinutes =
    typeof args.timeout_minutes === 'number' && Number.isFinite(args.timeout_minutes)
      ? Math.min(Math.max(1, args.timeout_minutes), 30)
      : 10;

  const connections = Array.isArray(args.mcp_connections)
    ? (args.mcp_connections as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;

  const result = await runManagedAgentTask({
    prompt,
    agentKey: typeof args.agent_key === 'string' ? args.agent_key : undefined,
    mcpConnectionNames: connections,
    timeoutMs: timeoutMinutes * 60_000,
  });

  const lines = [
    `Managed agent run ${result.runId} — ${result.status}`,
    `Session: ${result.sessionId}`,
  ];
  if (result.costUsd !== null) lines.push(`Cost: $${result.costUsd.toFixed(4)}`);
  if (result.errors.length) lines.push(`Errors:\n${result.errors.join('\n')}`);
  lines.push('', result.text || '(the agent returned no text)');
  return lines.join('\n');
}

async function handleListConnections(): Promise<string> {
  const connections = await listConnections();
  if (!connections.length) {
    return 'No MCP connections registered. Add one in Settings → Global MCP (or set MYGENTIC_MCP_URL and reload).';
  }
  return connections
    .map((conn) => {
      const auth = conn.transport === 'stdio'
        ? 'n/a (stdio)'
        : isAuthenticated(conn)
          ? 'authenticated'
          : 'NOT LOGGED IN — needs a browser login in Settings → Global MCP';
      const target = conn.serverUrl ?? conn.command ?? '(none)';
      return `• ${conn.name} [${conn.transport}] ${conn.enabled ? '' : '(disabled) '}→ ${target} — ${auth}`;
    })
    .join('\n');
}

async function handleRuns(args: Record<string, unknown>): Promise<string> {
  const limit = typeof args.limit === 'number' ? args.limit : 10;
  const runs = await listRuns(limit);
  if (!runs.length) return 'No managed agent runs recorded yet.';
  return runs
    .map((run) => {
      const cost = run.costUsd === null ? '' : ` $${run.costUsd.toFixed(4)}`;
      const when = run.startedAt instanceof Date ? run.startedAt.toISOString() : String(run.startedAt);
      const summary = (run.result ?? run.error ?? '').slice(0, 300);
      return `• ${when} [${run.status}]${cost} ${run.agentKey}\n  ${summary}`;
    })
    .join('\n');
}

export const MANAGED_AGENT_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_managed_agent_run: handleRun,
  boss_mcp_list_connections: handleListConnections,
  boss_managed_agent_runs: handleRuns,
};
