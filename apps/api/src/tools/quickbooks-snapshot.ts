/**
 * QuickBooks financial snapshot — structured numbers for machine consumers.
 *
 * The brain tools in executor.ts render human-readable strings; this module
 * returns typed JSON for boss_financial_reason (the CFO agent's engine, which
 * imports getQboFinancialSnapshot directly) and for the REST surface
 * (GET /api/connectors/quickbooks/financial-snapshot). The BOS API is the
 * ONLY holder of the rotating Intuit refresh token — never wire another
 * stack directly to Intuit (two independent refreshers invalidate each other).
 *
 * Numbers are computed deterministically from the books:
 *   - cash_available   = sum of active Bank account CurrentBalance
 *   - credit_cards     = sum of active Credit Card account CurrentBalance
 *   - P&L month-to-date (Cash basis) with income lines + section totals
 *   - open invoices (AR) count + total balance due
 */

import { getQboConnection, forceQboRefresh } from './quickbooks-auth.js';

const MINOR_VERSION = '75';

async function snapshotFetch(
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<unknown> {
  let conn = await getQboConnection();
  const doFetch = (token: string, base: string, realmId: string) => {
    const search = new URLSearchParams({ minorversion: MINOR_VERSION });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) search.set(k, v);
    }
    return fetch(`${base}/v3/company/${realmId}${path}?${search.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  };

  let res = await doFetch(conn.accessToken, conn.base, conn.realmId);
  if (res.status === 401) {
    conn = await forceQboRefresh();
    res = await doFetch(conn.accessToken, conn.base, conn.realmId);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuickBooks API error (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function companyToday(): string {
  const tz = process.env.QB_COMPANY_TIMEZONE || 'America/New_York';
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

interface ReportCol {
  value?: string;
}
interface ReportRow {
  group?: string;
  ColData?: ReportCol[];
  Header?: { ColData?: ReportCol[] };
  Summary?: { ColData?: ReportCol[] };
  Rows?: { Row?: ReportRow[] };
}

function rowAmount(cols: ReportCol[] | undefined): number {
  const raw = cols?.[cols.length - 1]?.value ?? '';
  const n = parseFloat(raw);
  return Number.isNaN(n) ? 0 : n;
}

export interface QboFinancialSnapshot {
  as_of: string;
  environment: 'sandbox' | 'production';
  realm_id: string;
  cash_available: number;
  credit_cards_balance: number;
  bank_accounts: Array<{ name: string; subtype?: string; balance: number }>;
  credit_card_accounts: Array<{ name: string; balance: number }>;
  pnl_mtd: {
    start_date: string;
    end_date: string;
    accounting_method: string;
    total_income: number;
    total_expenses: number;
    net_income: number;
    income_lines: Array<{ name: string; amount: number }>;
  };
  open_invoices: { count: number; total_balance: number };
}

export async function getQboFinancialSnapshot(): Promise<QboFinancialSnapshot> {
  const conn = await getQboConnection();
  const today = companyToday();
  const monthStart = `${today.slice(0, 8)}01`;

  interface QboAccountRow {
    Name?: string;
    AccountType?: string;
    AccountSubType?: string;
    CurrentBalance?: number;
  }
  interface QboInvoiceRow {
    Balance?: number;
  }

  const [accountsData, pnlData, invoicesData] = await Promise.all([
    snapshotFetch('/query', { query: 'SELECT * FROM Account WHERE Active = true MAXRESULTS 1000' }),
    snapshotFetch('/reports/ProfitAndLoss', {
      start_date: monthStart,
      end_date: today,
      accounting_method: 'Cash',
    }),
    snapshotFetch('/query', { query: `SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 1000` }),
  ]);

  // ── Accounts ───────────────────────────────────────────────────────────────
  const accountRows =
    ((accountsData as { QueryResponse?: { Account?: QboAccountRow[] } }).QueryResponse?.Account) ?? [];
  const banks = accountRows.filter((a) => a.AccountType === 'Bank');
  const cards = accountRows.filter((a) => a.AccountType === 'Credit Card');
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const cash = r2(banks.reduce((s, a) => s + (a.CurrentBalance ?? 0), 0));
  const cardTotal = r2(cards.reduce((s, a) => s + (a.CurrentBalance ?? 0), 0));

  // ── P&L MTD ────────────────────────────────────────────────────────────────
  // Report sections carry a `group` marker: Income, Expenses, NetIncome, etc.
  const topRows = (pnlData as { Rows?: { Row?: ReportRow[] } }).Rows?.Row ?? [];
  let totalIncome = 0;
  let totalExpenses = 0;
  let netIncome = 0;
  const incomeLines: Array<{ name: string; amount: number }> = [];
  for (const row of topRows) {
    if (row.group === 'Income') {
      totalIncome = rowAmount(row.Summary?.ColData);
      for (const line of row.Rows?.Row ?? []) {
        const name = line.ColData?.[0]?.value ?? line.Header?.ColData?.[0]?.value ?? '';
        const amount = rowAmount(line.ColData ?? line.Summary?.ColData);
        if (name) incomeLines.push({ name, amount: r2(amount) });
      }
    } else if (row.group === 'Expenses') {
      totalExpenses = rowAmount(row.Summary?.ColData);
    } else if (row.group === 'NetIncome') {
      netIncome = rowAmount(row.Summary?.ColData ?? row.ColData);
    }
  }

  // ── Open invoices (AR) ─────────────────────────────────────────────────────
  const invoiceRows =
    ((invoicesData as { QueryResponse?: { Invoice?: QboInvoiceRow[] } }).QueryResponse?.Invoice) ?? [];
  const arTotal = r2(invoiceRows.reduce((s, i) => s + (i.Balance ?? 0), 0));

  return {
    as_of: new Date().toISOString(),
    environment: process.env.QB_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    realm_id: conn.realmId,
    cash_available: cash,
    credit_cards_balance: cardTotal,
    bank_accounts: banks.map((a) => ({
      name: a.Name ?? '(unnamed)',
      ...(a.AccountSubType ? { subtype: a.AccountSubType } : {}),
      balance: r2(a.CurrentBalance ?? 0),
    })),
    credit_card_accounts: cards.map((a) => ({
      name: a.Name ?? '(unnamed)',
      balance: r2(a.CurrentBalance ?? 0),
    })),
    pnl_mtd: {
      start_date: monthStart,
      end_date: today,
      accounting_method: 'Cash',
      total_income: r2(totalIncome),
      total_expenses: r2(totalExpenses),
      net_income: r2(netIncome),
      income_lines: incomeLines,
    },
    open_invoices: { count: invoiceRows.length, total_balance: arTotal },
  };
}
