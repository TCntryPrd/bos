/**
 * QuickBooks Online tool definitions for BOS brain tool calling.
 *
 * These BrainTool descriptors let the brain read accounting data —
 * company info, P&L, transactions, invoices, customers, expenses, and
 * the chart of accounts (business AND personal bank accounts live
 * there). QuickBooks is the financial source of truth alongside Stripe
 * (which handles payment collection).
 *
 * Execution logic lives in executor.ts. Token lifecycle (OAuth2 with
 * rotating refresh tokens) lives in quickbooks-auth.ts.
 *
 * Tools are only registered when QuickBooks is configured (QB_CLIENT_ID
 * + QB_CLIENT_SECRET) and a company is connected (refresh token + realm
 * ID in runtime_config) — see index.ts.
 *
 * v1 is deliberately read-only: QuickBooks is the book of record, and
 * writes (invoices, expense categorization) should go through an
 * explicit approval flow before being added here.
 *
 * API base: https://{sandbox-}quickbooks.api.intuit.com/v3/company/{realmId}
 * All requests carry minorversion=75 (mandatory floor since Aug 2025).
 */

import type { BrainTool } from '@boss/brain';

// ── QuickBooks tools ──────────────────────────────────────────────────────────

export const qboCompanyInfoTool: BrainTool = {
  name: 'boss_qbo_company_info',
  description:
    'Get QuickBooks company profile: legal name, address, fiscal year start, company type, and subscription details. Use this to confirm which QuickBooks company is connected and its basic setup.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const qboProfitAndLossTool: BrainTool = {
  name: 'boss_qbo_profit_and_loss',
  description:
    'Run the QuickBooks Profit & Loss report: income, cost of goods sold, expenses, and net income for a date range. The authoritative picture of business performance. Defaults to this fiscal year-to-date if no dates are given.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Report start date, YYYY-MM-DD. Omit (with end_date) to default to this fiscal year-to-date.',
      },
      end_date: {
        type: 'string',
        description: 'Report end date, YYYY-MM-DD.',
      },
      accounting_method: {
        type: 'string',
        enum: ['Cash', 'Accrual'],
        description: 'Accounting method for the report. Defaults to the company preference.',
      },
      summarize_by: {
        type: 'string',
        enum: ['Total', 'Month', 'Quarter', 'Year', 'Customers', 'Vendors'],
        description: 'Column breakdown. "Month" gives a monthly P&L; defaults to "Total".',
      },
    },
    required: [],
  },
};

export const qboListTransactionsTool: BrainTool = {
  name: 'boss_qbo_list_transactions',
  description:
    'Run the QuickBooks Transaction List report: all posted transactions (invoices, payments, expenses, deposits, transfers) in a date range with date, type, name, memo, account, and amount. Use for "what happened in the accounts recently".',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date, YYYY-MM-DD. Omit (with end_date) to default to this month-to-date.',
      },
      end_date: {
        type: 'string',
        description: 'End date, YYYY-MM-DD.',
      },
    },
    required: [],
  },
};

export const qboListInvoicesTool: BrainTool = {
  name: 'boss_qbo_list_invoices',
  description:
    'List QuickBooks invoices with number, customer, amount, balance due, due date, and status (paid/open/overdue). Use to check outstanding receivables or invoice history. These are the accounting-side invoices; Stripe invoices are the payment-collection side.',
  parameters: {
    type: 'object',
    properties: {
      unpaid_only: {
        type: 'boolean',
        description: 'When true, only invoices with a balance due. Defaults to false (all recent invoices).',
      },
      since: {
        type: 'string',
        description: 'Only invoices dated on/after this date, YYYY-MM-DD.',
      },
      limit: {
        type: 'number',
        description: 'Max invoices to return (1–100). Defaults to 25.',
      },
    },
    required: [],
  },
};

export const qboListCustomersTool: BrainTool = {
  name: 'boss_qbo_list_customers',
  description:
    'List QuickBooks customers with display name, company, email, and open balance. QuickBooks mirrors the CRM customer list — use this to cross-reference CRM contacts with their accounting status.',
  parameters: {
    type: 'object',
    properties: {
      name_contains: {
        type: 'string',
        description: 'Filter to customers whose display name contains this text (case-insensitive).',
      },
      limit: {
        type: 'number',
        description: 'Max customers to return (1–100). Defaults to 25.',
      },
    },
    required: [],
  },
};

export const qboListExpensesTool: BrainTool = {
  name: 'boss_qbo_list_expenses',
  description:
    'List QuickBooks expense transactions (Purchases: cash, check, and credit-card spends) with date, payee, payment account, category, and amount. Covers spending from both business and personal bank accounts connected to QuickBooks.',
  parameters: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'Only expenses dated on/after this date, YYYY-MM-DD. Defaults to the last 30 days.',
      },
      limit: {
        type: 'number',
        description: 'Max expenses to return (1–100). Defaults to 25.',
      },
    },
    required: [],
  },
};

export const qboListAccountsTool: BrainTool = {
  name: 'boss_qbo_list_accounts',
  description:
    'List the QuickBooks chart of accounts with name, type (Bank, Credit Card, Income, Expense, etc.), and current balance. Bank and credit-card rows show live balances for both business and personal accounts. Use for "how much is in the accounts".',
  parameters: {
    type: 'object',
    properties: {
      account_type: {
        type: 'string',
        description: 'Filter by account type, e.g. "Bank", "Credit Card", "Expense", "Income". Omit for all.',
      },
    },
    required: [],
  },
};

export const qboQueryTool: BrainTool = {
  name: 'boss_qbo_query',
  description:
    'Run a read-only QuickBooks query in Intuit\'s SQL-like query language, e.g. "SELECT * FROM Payment WHERE TxnDate >= \'2026-01-01\' MAXRESULTS 50". Entities include Invoice, Payment, Customer, Vendor, Bill, Purchase, Deposit, Account, Item, Estimate, JournalEntry. Use when the dedicated tools don\'t cover what you need. SELECT statements only.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A single SELECT statement in QuickBooks query language (no semicolons, no joins).',
      },
    },
    required: ['query'],
  },
};

// ── Grouped exports ───────────────────────────────────────────────────────────

// Read-only QuickBooks tools — safe for autonomous use
export const READONLY_QBO_TOOLS: BrainTool[] = [
  qboCompanyInfoTool,
  qboProfitAndLossTool,
  qboListTransactionsTool,
  qboListInvoicesTool,
  qboListCustomersTool,
  qboListExpensesTool,
  qboListAccountsTool,
  qboQueryTool,
];

// Write tools — none in v1. QuickBooks is the book of record; add writes
// (create invoice, categorize expense) behind explicit approval when needed.
export const WRITE_QBO_TOOLS: BrainTool[] = [];

// All QuickBooks tools — gated in index.ts on config + connection
export const ALL_QBO_TOOLS: BrainTool[] = [
  ...READONLY_QBO_TOOLS,
  ...WRITE_QBO_TOOLS,
];
