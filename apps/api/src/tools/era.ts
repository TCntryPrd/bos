/**
 * ERA Context tools — agent-native personal-finance data for the CFO agent.
 *
 * ERA Context (https://context.era.app) is an MCP-first finance platform that
 * aggregates the user's connected bank/credit/investment accounts (MX under the
 * hood). We talk to it as an MCP-over-HTTP client: a single JSON-RPC POST per
 * tool call carrying the Bearer key. Transport is effectively stateless — no
 * Mcp-Session-Id is required (verified against the live server); the optional
 * _forge_did cookie is device tracking we don't need.
 *
 * Tools are READ-ONLY by design: the CFO agent reports and reconciles, it does
 * not move money or mutate ERA categories/billing. Execution lives here (mirrors
 * the self-contained executeWeaviateTool pattern), dispatched from executor.ts.
 *
 * Gated in index.ts on the ERA key being present (ERA_MCP_API_KEY in
 * runtime_config → process.env at boot; falls back to a runtime_config lookup).
 */

import type { BrainTool } from '@boss/brain';

const ERA_MCP_URL = process.env.ERA_MCP_URL ?? 'https://context.era.app';

async function getEraKey(): Promise<string> {
  if (process.env.ERA_MCP_API_KEY) return process.env.ERA_MCP_API_KEY;
  try {
    const { getRuntimeConfig } = await import('../config-store.js');
    return (await getRuntimeConfig('ERA_MCP_API_KEY', 'default')) || '';
  } catch {
    return '';
  }
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/**
 * Parse an ERA response body that may be either plain JSON or an SSE stream
 * ("data: {...}" lines). Returns the first JSON-RPC object found.
 */
function parseRpcBody(body: string): JsonRpcResponse | null {
  const trimmed = body.trim();
  // Plain JSON
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) as JsonRpcResponse; } catch { /* fall through */ }
  }
  // SSE: scan data: lines
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as JsonRpcResponse;
      if (obj && (obj.result || obj.error)) return obj;
    } catch { /* keep scanning */ }
  }
  return null;
}

/** Low-level: call a single ERA MCP tool and return its decoded text payload. */
async function callEraTool(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<string> {
  const key = await getEraKey();
  if (!key) throw new Error('ERA_MCP_API_KEY not configured');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(ERA_MCP_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: ctl.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ERA ${toolName} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const rpc = parseRpcBody(text);
    if (!rpc) throw new Error(`ERA ${toolName}: unparseable response: ${text.slice(0, 200)}`);
    if (rpc.error) throw new Error(`ERA ${toolName}: ${rpc.error.message}`);

    // ERA returns result.content[].text where text is itself a JSON string.
    const parts = rpc.result?.content ?? [];
    const merged = parts.map((p) => p.text ?? '').join('').trim();
    return merged || '(empty response)';
  } finally {
    clearTimeout(timer);
  }
}

// ── Tool definitions (read-only) ───────────────────────────────────────────────

export const eraAccountsTool: BrainTool = {
  name: 'boss_era_accounts',
  description:
    'List the connected bank, credit-card, and investment accounts from ERA Context, with current and available balances and last-synced time. Use this for "what are my balances", net-worth snapshots, or to get an account_group_key before pulling transactions.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const eraOverviewTool: BrainTool = {
  name: 'boss_era_financial_overview',
  description:
    'Get a one-call financial snapshot from ERA Context: all account balances, net worth, this-month vs last-month income/spending/net, top spending categories, and detected patterns (recurring charges, anomalies, bounced payments). Best first call for a financial report or daily summary.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const eraTransactionsTool: BrainTool = {
  name: 'boss_era_transactions',
  description:
    'List posted transactions from ERA Context, optionally filtered by account and date range. Returns merchant, amount, category, and date. Use for reconciliation against booked expenses or to review recent activity.',
  parameters: {
    type: 'object',
    properties: {
      account_group_key: { type: 'string', description: 'Optional ERA account key (uagr_...) to filter to one account. Omit for all accounts.' },
      from_date: { type: 'string', description: 'Start date YYYY-MM-DD. Omit for full history.' },
      to_date: { type: 'string', description: 'End date YYYY-MM-DD. Omit for today.' },
      page_size: { type: 'number', description: 'Transactions per page (1–100). Defaults to 50.' },
    },
    required: [],
  },
};

export const eraSearchTransactionsTool: BrainTool = {
  name: 'boss_era_search_transactions',
  description:
    'Search ERA Context transactions by merchant/keyword (e.g. "Amazon", "stripe payout"). Returns matching transactions with amount, category, and date. Prefer this for targeted lookups over listing everything.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Merchant name or keyword to search for.' },
      from_date: { type: 'string', description: 'Optional start date YYYY-MM-DD.' },
      to_date: { type: 'string', description: 'Optional end date YYYY-MM-DD.' },
    },
    required: ['query'],
  },
};

export const eraCashFlowTool: BrainTool = {
  name: 'boss_era_cash_flow',
  description:
    'Get cash-flow analysis from ERA Context (money in vs money out over a period). Use for runway, burn, and trend reporting.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const eraRecurringTool: BrainTool = {
  name: 'boss_era_recurring_charges',
  description:
    'List detected recurring charges/subscriptions from ERA Context, with cadence and amount. Use to audit subscriptions or spot unexpected recurring spend.',
  parameters: { type: 'object', properties: {}, required: [] },
};

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeEraTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'boss_era_accounts':
        return await callEraTool('accounts__list_financial_accounts', {});
      case 'boss_era_financial_overview':
        return await callEraTool('knowledge__get_financial_context_and_overview', {});
      case 'boss_era_transactions': {
        const a: Record<string, unknown> = {};
        if (args.account_group_key) a.account_group_key = String(args.account_group_key);
        if (args.from_date) a.from_date = String(args.from_date);
        if (args.to_date) a.to_date = String(args.to_date);
        a.page_size = Math.min(Math.max(Number(args.page_size) || 50, 1), 100);
        return await callEraTool('transactions__list_transactions', a);
      }
      case 'boss_era_search_transactions': {
        const a: Record<string, unknown> = { query: String(args.query || '') };
        if (args.from_date) a.from_date = String(args.from_date);
        if (args.to_date) a.to_date = String(args.to_date);
        return await callEraTool('transactions__search_transactions', a);
      }
      case 'boss_era_cash_flow':
        return await callEraTool('insights__get_cash_flow', {});
      case 'boss_era_recurring_charges':
        return await callEraTool('transactions__list_recurring_charges', {});
      default:
        return `Unknown ERA tool: ${name}`;
    }
  } catch (err) {
    return `ERA error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const ALL_ERA_TOOLS: BrainTool[] = [
  eraAccountsTool,
  eraOverviewTool,
  eraTransactionsTool,
  eraSearchTransactionsTool,
  eraCashFlowTool,
  eraRecurringTool,
];
