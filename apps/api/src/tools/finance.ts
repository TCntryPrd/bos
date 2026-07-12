/**
 * Finance snapshot tool — lets the CFO agent persist a structured financial
 * snapshot each run so the dashboard can visualize it (cash, revenue, AR, flags)
 * and the COO can read the latest position. Stored in boss_finance_snapshot
 * (jsonb), newest row wins. Read by GET /api/finance/snapshot.
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

export const financeSnapshotSaveTool: BrainTool = {
  name: 'boss_finance_snapshot_save',
  description:
    'Save the latest financial snapshot for the dashboard + COO. Call this once at the end of your run with the figures you computed from Stripe + ERA. ' +
    'Only include fields you actually have; omit unknowns. The dashboard renders cash, revenue, AR, and your flags.',
  parameters: {
    type: 'object',
    properties: {
      cash_available: { type: 'number', description: 'Total available cash across bank accounts (USD).' },
      net_worth: { type: 'number', description: 'Net worth (USD).' },
      month_net: { type: 'number', description: 'This month: income minus spending (USD; negative = burn).' },
      revenue_mtd: { type: 'number', description: 'Revenue collected month-to-date via Stripe (USD).' },
      stripe_available: { type: 'number', description: 'Stripe available balance (USD).' },
      stripe_pending: { type: 'number', description: 'Stripe pending balance (USD).' },
      ar_open_count: { type: 'number', description: 'Number of open (unpaid) Stripe invoices.' },
      ar_open_total: { type: 'number', description: 'Total open AR (USD).' },
      bounced_payments: { type: 'number', description: 'Count of bounced payments detected.' },
      flags: { type: 'array', items: { type: 'string' }, description: 'Short alert strings, e.g. "2 bounced payments since Jun 10".' },
      bottom_line: { type: 'string', description: 'One-line executive summary the COO can act on.' },
    },
    required: ['bottom_line'],
  },
};

export async function executeFinanceTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name !== 'boss_finance_snapshot_save') return `Unknown finance tool: ${name}`;
  try {
    const pool = getPool();
    const snapshot = {
      cash_available: args.cash_available ?? null,
      net_worth: args.net_worth ?? null,
      month_net: args.month_net ?? null,
      revenue_mtd: args.revenue_mtd ?? null,
      stripe_available: args.stripe_available ?? null,
      stripe_pending: args.stripe_pending ?? null,
      ar_open_count: args.ar_open_count ?? null,
      ar_open_total: args.ar_open_total ?? null,
      bounced_payments: args.bounced_payments ?? null,
      flags: Array.isArray(args.flags) ? args.flags : [],
      bottom_line: String(args.bottom_line ?? ''),
    };
    await pool.query(
      `INSERT INTO boss_finance_snapshot (tenant_id, snapshot, created_at) VALUES ('default', $1::jsonb, now())`,
      [JSON.stringify(snapshot)],
    );
    return `Financial snapshot saved. Bottom line: ${snapshot.bottom_line}`;
  } catch (err) {
    return `Finance snapshot error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const ALL_FINANCE_TOOLS: BrainTool[] = [financeSnapshotSaveTool];
