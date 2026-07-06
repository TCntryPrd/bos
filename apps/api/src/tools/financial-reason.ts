/**
 * boss_financial_reason — the CFO's analysis engine.
 *
 * Lesson learned the hard way: a free reasoning model doing ARITHMETIC is unreliable
 * (it mixed current/available balances, miscounted revenue run-to-run, and counted
 * refunds as income). So the NUMBERS are now computed in deterministic CODE:
 *   - cash_available = sum of each account's CURRENT balance (consistent).
 *   - revenue_mtd = sum of inbound deposits classified as real income, with refunds,
 *     transfers, and rebates excluded, and Kevin's tile labels (boss_txn_overrides)
 *     honored as hard truth.
 *   - refunds are detected by matching a positive credit to a recent same-merchant debit.
 * The reasoning model (NIM Nemotron) is used ONLY to classify the small set of genuinely
 * AMBIGUOUS deposits and to phrase the bottom line — never to do the math.
 *
 * Returns a JSON snapshot the CFO agent saves with boss_finance_snapshot_save.
 */
import type { BrainTool } from '@boss/brain';
import { executeEraTool } from './era.js';
import { getTxnOverrideMap, type TxnOverride } from '../lib/txn-overrides.js';
import { getPool } from '../db.js';

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const STRIPE_API = 'https://api.stripe.com/v1';

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function r2(n: number): number { return Math.round(n * 100) / 100; }
function norm(s: string): string { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }

function safeParse<T = any>(raw: string): T | null {
  try { const p = JSON.parse(raw); return p as T; } catch { return null; }
}

/** Stripe open invoices (AR) + balance, best-effort; revenue itself comes from the bank Stripe payouts. */
async function gatherStripeAR(): Promise<{ available: number; pending: number; ar_count: number; ar_total: number; note: string }> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { available: 0, pending: 0, ar_count: 0, ar_total: 0, note: 'Stripe not configured' };
  const headers = { Authorization: `Bearer ${key}` };
  try {
    const [balRes, invRes] = await Promise.all([
      fetch(`${STRIPE_API}/balance`, { headers, signal: AbortSignal.timeout(20_000) }),
      fetch(`${STRIPE_API}/invoices?status=open&limit=100`, { headers, signal: AbortSignal.timeout(20_000) }),
    ]);
    const bal: any = balRes.ok ? await balRes.json() : {};
    const inv: any = invRes.ok ? await invRes.json() : { data: [] };
    const available = (bal.available ?? []).reduce((s: number, b: any) => s + (b.amount ?? 0), 0) / 100;
    const pending = (bal.pending ?? []).reduce((s: number, b: any) => s + (b.amount ?? 0), 0) / 100;
    const arr = inv.data ?? [];
    const ar_total = arr.reduce((s: number, i: any) => s + (i.amount_due ?? 0), 0) / 100;
    return { available: r2(available), pending: r2(pending), ar_count: arr.length, ar_total: r2(ar_total), note: '' };
  } catch (err) {
    return { available: 0, pending: 0, ar_count: 0, ar_total: 0, note: `Stripe error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const financialReasonTool: BrainTool = {
  name: 'boss_financial_reason',
  description:
    'Run the full financial analysis for this period. Gathers ERA bank data + Stripe and computes the numbers deterministically: sums CURRENT account balances for cash, classifies every inbound deposit (honoring Kevin\'s saved tile labels, excluding refunds/transfers/rebates), and sums real revenue. ' +
    'Returns JSON {cash_available, net_worth, month_net, revenue_mtd, revenue_breakdown, stripe_available, stripe_pending, ar_open_count, ar_open_total, bounced_payments, ambiguous_deposits, refunds_excluded, flags, bottom_line, data_freshness}. Call ONCE, then save with boss_finance_snapshot_save.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const ALL_FINANCIAL_TOOLS: BrainTool[] = [financialReasonTool];

interface Classified { tx: any; kind: 'revenue' | 'refund' | 'transfer' | 'rebate' | 'ambiguous'; label: string; }

/** Ask Nemotron to classify ONLY the genuinely ambiguous deposits (small list). Best-effort. */
async function classifyAmbiguous(items: any[]): Promise<Record<string, 'revenue' | 'non-revenue'>> {
  const key = process.env.NVIDIA_NIM_API_KEY;
  if (!key || !items.length) return {};
  const model = process.env.FINANCE_REASONER_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
  const list = items.map((t) => `id=${t.transaction_id} amount=${t.amount} desc="${(t.description || t.merchant_name || '').slice(0, 50)}" date=${t.transaction_date}`).join('\n');
  const sys = `You classify bank DEPOSITS for a small business. For each, decide if it is "revenue" (a payment received for work/services) or "non-revenue" (a transfer between own accounts, a refund, a loan, an owner contribution, interest, a rebate, or a reimbursement). Output ONLY minified JSON mapping each id to "revenue" or "non-revenue", e.g. {"utgr_x":"revenue","utgr_y":"non-revenue"}. No prose.`;
  try {
    const res = await fetch(NIM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: list }], temperature: 0.1, max_tokens: 4000, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return {};
    const data: any = await res.json();
    const m = data.choices?.[0]?.message ?? {};
    const content = ((m.content || '').trim()) || ((m.reasoning_content || '').trim());
    const s = content.indexOf('{'); const e = content.lastIndexOf('}');
    if (s === -1 || e === -1) return {};
    return safeParse(content.slice(s, e + 1)) ?? {};
  } catch {
    return {};
  }
}

async function handleFinancialReason(): Promise<string> {
  const now = new Date();
  // IR pays in [28th of prior month .. 4th of this month]; pull from the 24th of last month to catch it.
  const winStart = new Date(now.getFullYear(), now.getMonth() - 1, 24);

  const [accountsRaw, txnsRaw, overrideMap, stripeAR] = await Promise.all([
    executeEraTool('boss_era_accounts', {}).catch((e) => `err:${e}`),
    executeEraTool('boss_era_transactions', { from_date: ymd(winStart), to_date: ymd(now), page_size: 100 }).catch((e) => `err:${e}`),
    getTxnOverrideMap().catch(() => ({} as Record<string, TxnOverride>)),
    gatherStripeAR(),
  ]);

  // ── Cash: sum CURRENT balances ────────────────────────────────────────────
  const accObj = safeParse<{ accounts?: any[] }>(accountsRaw);
  const accounts = accObj?.accounts ?? [];
  let cash = 0;
  const acctLines: string[] = [];
  let oldestSync: string | null = null;
  for (const a of accounts) {
    const cur = typeof a.balance?.current === 'number' ? a.balance.current : 0;
    cash += cur;
    acctLines.push(`${a.name}: $${r2(cur)}`);
    const sync = a.last_synced ?? null;
    if (sync && (!oldestSync || sync < oldestSync)) oldestSync = sync;
  }
  cash = r2(cash);

  // ── Transactions: classify inbound deposits ───────────────────────────────
  const txObj = safeParse<{ transactions?: any[] }>(txnsRaw);
  const txns = txObj?.transactions ?? [];
  const thisMonth = now.getMonth();
  const inMonth = (t: any) => {
    const d = new Date(t.transaction_date ?? t.posted_date ?? 0);
    return d.getMonth() === thisMonth && d.getFullYear() === now.getFullYear();
  };
  const debits = txns.filter((t) => (t.amount ?? 0) < 0);
  const toks = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length >= 3));
  function looksLikeRefund(t: any): boolean {
    const pt = toks(t.description || t.merchant_name || '');
    if (!pt.size) return false;
    return debits.some((db) => {
      const dt = toks(db.description || db.merchant_name || '');
      let shared = 0;
      for (const w of pt) if (dt.has(w)) shared++;
      // A credit that shares 2+ meaningful words with a debit (e.g. "wien","aut") is a
      // refund of that charge. Or 1 shared word with a near-matching amount.
      if (shared >= 2) return true;
      if (shared >= 1 && Math.abs(Math.abs(db.amount ?? 0) - (t.amount ?? 0)) < Math.max(5, (t.amount ?? 0) * 0.25)) return true;
      return false;
    });
  }

  const inbound = txns.filter((t) => (t.amount ?? 0) > 0);
  const classified: Classified[] = [];
  const ambiguousRaw: any[] = [];

  for (const t of inbound) {
    const desc = String(t.description || t.merchant_name || '');
    const dl = desc.toLowerCase();
    const ov = overrideMap[String(t.transaction_id)];
    if (ov) {
      const lbl = ov.label.toLowerCase();
      const isRev = /(revenue|payment|client|stripe|rockstar|invoice|paid|income|sale)/.test(lbl) && !/(refund|transfer|draw|loan|rebate|reimburse|not revenue|non.?revenue)/.test(lbl);
      classified.push({ tx: t, kind: isRev ? 'revenue' : 'transfer', label: `Kevin: ${ov.label}` });
      continue;
    }
    if (looksLikeRefund(t)) { classified.push({ tx: t, kind: 'refund', label: 'refund (matches a charge)' }); continue; }
    if (/stripe/.test(dl)) { classified.push({ tx: t, kind: 'revenue', label: 'Stripe payout' }); continue; }
    if (/industr|rocksta/.test(dl)) { classified.push({ tx: t, kind: 'revenue', label: 'Industry Rockstar' }); continue; }
    if (/rebate|interest|cashback|dividend/.test(dl)) { classified.push({ tx: t, kind: 'rebate', label: 'rebate/interest' }); continue; }
    if (/kevin starr|transfer|owner|withdrawal reversal|internal/.test(dl)) { classified.push({ tx: t, kind: 'transfer', label: 'transfer/own funds' }); continue; }
    ambiguousRaw.push(t);
  }

  // Reasoning model classifies the ambiguous remainder only (small, focused = reliable).
  const aiVerdicts = await classifyAmbiguous(ambiguousRaw);
  for (const t of ambiguousRaw) {
    const v = aiVerdicts[String(t.transaction_id)];
    if (v === 'revenue') classified.push({ tx: t, kind: 'revenue', label: 'classified revenue (reasoner)' });
    else if (v === 'non-revenue') classified.push({ tx: t, kind: 'transfer', label: 'non-revenue (reasoner)' });
    else classified.push({ tx: t, kind: 'ambiguous', label: 'needs Kevin' });
  }

  // ── Revenue (this month only) ─────────────────────────────────────────────
  const countedIds = new Set(classified.filter((c) => c.kind === 'revenue' && inMonth(c.tx)).map((c) => String(c.tx.transaction_id)));
  const revItems: Array<{ label: string; amount: number; date: string }> = classified
    .filter((c) => c.kind === 'revenue' && inMonth(c.tx))
    .map((c) => ({ label: c.label, amount: c.tx.amount ?? 0, date: c.tx.transaction_date }));

  // Industry Rockstar recognition: IR pays in [28th of prior month .. 4th of this month]
  // and is usually DATED in the prior month (e.g. May 31 for June). Search for it directly
  // so pagination or a truncated description ("Industry Rocksta Inv") can't hide it, and
  // recognize it for THIS month even though the cash posted a few days early.
  try {
    // ERA search_transactions does NOT accept date params (it errors), so search by query
    // only and filter the window in code. The deposit's date field is `date`.
    const irWinStart = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 28));
    const irWinEnd = ymd(new Date(now.getFullYear(), now.getMonth(), 5));
    const irRaw = await executeEraTool('boss_era_search_transactions', { query: 'Industry Rockstar' });
    const irTxns = safeParse<{ transactions?: any[] }>(irRaw)?.transactions ?? [];
    const ir = irTxns.find((t) => {
      const id = String(t.transaction_id);
      const d = String(t.date ?? t.transaction_date ?? '').slice(0, 10);
      if ((t.amount ?? 0) <= 0 || countedIds.has(id)) return false;
      if (d < irWinStart || d > irWinEnd) return false; // only THIS month's IR payment (28th..4th window)
      const ov = overrideMap[id];
      if (ov && /(refund|transfer|draw|loan|not revenue|non.?revenue)/.test(ov.label.toLowerCase())) return false;
      return true;
    });
    if (ir) {
      revItems.push({ label: 'Industry Rockstar (for this month)', amount: ir.amount ?? 0, date: String(ir.date ?? ir.transaction_date ?? '').slice(0, 10) });
      countedIds.add(String(ir.transaction_id));
    }
  } catch { /* IR search best-effort */ }

  const revenue = r2(revItems.reduce((s, c) => s + (c.amount ?? 0), 0));
  const revenue_breakdown = revItems.length
    ? revItems.map((c) => `${c.label} $${r2(c.amount)} (${c.date})`).join('; ')
    : 'no revenue deposits posted this month';
  const refundsExcluded = classified.filter((c) => c.kind === 'refund' && inMonth(c.tx)).map((c) => `${String(c.tx.description || '').slice(0, 30)} +$${r2(c.tx.amount)}`);
  const ambiguous_deposits = classified.filter((c) => c.kind === 'ambiguous' && inMonth(c.tx)).map((c) => ({ transaction_id: String(c.tx.transaction_id), date: c.tx.transaction_date, amount: r2(c.tx.amount), description: String(c.tx.description || c.tx.merchant_name || '') }));

  // ── Flags ─────────────────────────────────────────────────────────────────
  const flags: string[] = [];
  // IR check: a revenue deposit recognized as Industry Rockstar in the IR window?
  const irFound = revItems.some((c) => /rockstar|industr/i.test(c.label));
  if (!irFound && now.getDate() > 5) flags.push("Industry Rockstar $3,500 not found in ERA for this month's window (28th of last month to the 4th) — verify or tag it");
  if (cash < 1000) flags.push(`Low cash: $${cash} across accounts`);
  if (refundsExcluded.length) flags.push(`${refundsExcluded.length} refund(s) excluded from revenue`);
  if (ambiguous_deposits.length) flags.push(`${ambiguous_deposits.length} deposit(s) need your classification on the tile`);
  if (oldestSync) flags.push(`ERA last synced ${String(oldestSync).slice(0, 10)} — balances may lag your live bank`);

  const bottom_line = `Cash $${cash} (per ERA sync); revenue MTD $${revenue} (${revItems.length} payment(s))${refundsExcluded.length ? `, ${refundsExcluded.length} refund(s) excluded` : ''}${ambiguous_deposits.length ? `; ${ambiguous_deposits.length} deposit(s) need tagging` : ''}.`;

  const snapshot = {
    cash_available: cash,
    net_worth: cash,
    month_net: null,
    revenue_mtd: revenue,
    revenue_breakdown,
    stripe_available: stripeAR.available,
    stripe_pending: stripeAR.pending,
    ar_open_count: stripeAR.ar_count,
    ar_open_total: stripeAR.ar_total,
    bounced_payments: 0,
    ambiguous_deposits,
    refunds_excluded: refundsExcluded,
    flags,
    bottom_line,
    data_freshness: oldestSync ? `ERA synced ${String(oldestSync).slice(0, 16)}` : 'unknown',
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
