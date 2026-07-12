/**
 * boss_financial_reason — the CFO's analysis engine.
 *
 * Lesson learned the hard way: a free reasoning model doing ARITHMETIC is unreliable
 * (it mixed current/available balances, miscounted revenue run-to-run, and counted
 * refunds as income). So the NUMBERS are computed in deterministic CODE.
 *
 * Data source (since 2026-07-10): QuickBooks Online — the accounting source of
 * truth (company "D Caine Solutions") — read via getQboFinancialSnapshot()
 * from quickbooks-snapshot.ts in THIS stack (the BOS API owns the Intuit
 * tokens; the QuickBooks integration was ported here from the deprecated
 * vasari stack the same day). The old ERA Context bank feed is retired
 * (it stopped syncing 2026-06-23).
 *
 *   - cash_available = sum of active Bank account balances (from the books)
 *   - revenue_mtd    = Cash-basis P&L Total Income, month to date — bookkeeping
 *     in QuickBooks replaces the old deposit-classification pipeline, so the
 *     ambiguous_deposits / refunds_excluded arrays are now structurally empty.
 *   - AR             = open QuickBooks invoices (count + balance due)
 *   - Stripe balance = direct from Stripe (payment-collection side)
 *
 * Returns a JSON snapshot the CFO agent saves with boss_finance_snapshot_save.
 */
import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';
import { getQboFinancialSnapshot } from './quickbooks-snapshot.js';

const STRIPE_API = 'https://api.stripe.com/v1';

function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Stripe balance, best-effort — Stripe remains the payment-collection side. */
async function gatherStripeBalance(): Promise<{ available: number; pending: number; note: string }> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { available: 0, pending: 0, note: 'Stripe not configured' };
  try {
    const res = await fetch(`${STRIPE_API}/balance`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const bal: any = res.ok ? await res.json() : {};
    const available = (bal.available ?? []).reduce((s: number, b: any) => s + (b.amount ?? 0), 0) / 100;
    const pending = (bal.pending ?? []).reduce((s: number, b: any) => s + (b.amount ?? 0), 0) / 100;
    return { available: r2(available), pending: r2(pending), note: '' };
  } catch (err) {
    return { available: 0, pending: 0, note: `Stripe error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const financialReasonTool: BrainTool = {
  name: 'boss_financial_reason',
  description:
    'Run the full financial analysis for this period. Pulls the QuickBooks Online snapshot (accounting source of truth: bank balances, Cash-basis P&L month-to-date, open AR), plus the Stripe balance, and computes the numbers deterministically. ' +
    'Returns JSON {cash_available, net_worth, month_net, revenue_mtd, revenue_breakdown, stripe_available, stripe_pending, ar_open_count, ar_open_total, bounced_payments, ambiguous_deposits, refunds_excluded, flags, bottom_line, data_freshness}. Call ONCE, then it has already saved the dashboard snapshot.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const ALL_FINANCIAL_TOOLS: BrainTool[] = [financialReasonTool];

async function handleFinancialReason(): Promise<string> {
  const now = new Date();
  const [qbo, stripe] = await Promise.all([getQboFinancialSnapshot(), gatherStripeBalance()]);

  const cash = r2(qbo.cash_available);
  const netWorth = r2(qbo.cash_available - qbo.credit_cards_balance);
  const revenue = r2(qbo.pnl_mtd.total_income);
  const revenue_breakdown = qbo.pnl_mtd.income_lines.length
    ? qbo.pnl_mtd.income_lines.map((l) => `${l.name} $${r2(l.amount)}`).join('; ')
    : 'no income recorded this month in QuickBooks';

  // ── Flags ─────────────────────────────────────────────────────────────────
  const flags: string[] = [];
  // Industry Rockstar recognition: IR pays ~$3,500 in the [28th prior month ..
  // 4th of this month] window. P&L income lines are by ACCOUNT (often a generic
  // "Services"), not by customer — so accept a name match OR the month's income
  // already covering the $3,500. Only flag when it plainly isn't in the books.
  const irFound =
    qbo.pnl_mtd.income_lines.some((l) => /rockstar|industr/i.test(l.name)) || revenue >= 3500;
  if (!irFound && now.getDate() > 5) {
    flags.push("Industry Rockstar $3,500 not reflected in this month's QuickBooks income yet (revenue MTD below $3,500) — verify the payment was recorded");
  }
  if (cash < 1000) flags.push(`Low cash: $${cash} across bank accounts`);
  if (qbo.open_invoices.count > 0) {
    flags.push(`${qbo.open_invoices.count} open invoice(s) totaling $${r2(qbo.open_invoices.total_balance)} in QuickBooks AR`);
  }
  if (stripe.note) flags.push(stripe.note);
  if (qbo.environment !== 'production') flags.push(`QuickBooks is in ${qbo.environment} mode — numbers are not the real books`);

  const bottom_line = `Cash $${cash} across ${qbo.bank_accounts.length} bank account(s) (QuickBooks live); revenue MTD $${revenue} (Cash-basis P&L)${qbo.open_invoices.count ? `; AR $${r2(qbo.open_invoices.total_balance)} open` : ''}.`;

  const snapshot = {
    cash_available: cash,
    net_worth: netWorth,
    month_net: r2(qbo.pnl_mtd.net_income),
    revenue_mtd: revenue,
    revenue_breakdown,
    stripe_available: stripe.available,
    stripe_pending: stripe.pending,
    ar_open_count: qbo.open_invoices.count,
    ar_open_total: r2(qbo.open_invoices.total_balance),
    bounced_payments: 0,
    // Bookkeeping now happens in QuickBooks — no raw-deposit classification.
    ambiguous_deposits: [] as unknown[],
    refunds_excluded: [] as string[],
    flags,
    bottom_line,
    data_freshness: `QuickBooks Online live (as of ${qbo.as_of.slice(0, 16)})`,
  };

  // Persist the FULL snapshot directly (JSONB) so nothing depends on the agent
  // forwarding every field into boss_finance_snapshot_save. This drives the tile.
  try {
    await getPool().query(
      `INSERT INTO boss_finance_snapshot (tenant_id, snapshot) VALUES ('default', $1::jsonb)`,
      [JSON.stringify(snapshot)],
    );
  } catch { /* non-fatal: the agent may also save */ }

  return JSON.stringify(snapshot);
}

export const FINANCIAL_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_financial_reason: handleFinancialReason,
};
