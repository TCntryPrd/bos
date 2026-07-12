# QuickBooks Online Operations

QuickBooks Online is the **accounting source of truth** for D. Caine Solutions
(connected 2026-07-10, production, company "D Caine Solutions", realm
9341456422536176). It mirrors the CRM customer list and carries both the
business and personal bank accounts. Stripe is the payment-collection side
only — when Stripe and QuickBooks disagree, reconcile toward QuickBooks.

## Available tools (all read-only in v1)

- `boss_qbo_company_info` — company profile; confirms which company is connected
- `boss_qbo_profit_and_loss` — P&L report (defaults to fiscal YTD; supports start_date/end_date, Cash/Accrual, summarize_by Month/Quarter/etc.)
- `boss_qbo_list_transactions` — TransactionList report (all posted transactions in a range)
- `boss_qbo_list_invoices` — invoices with balance/status (unpaid_only, since filters)
- `boss_qbo_list_customers` — customers with open balances (name_contains filter)
- `boss_qbo_list_expenses` — Purchase transactions (money out of bank/credit accounts)
- `boss_qbo_list_accounts` — chart of accounts with LIVE bank/credit-card balances
- `boss_qbo_query` — raw SELECT in Intuit's query language (entities: Invoice, Payment, Customer, Vendor, Bill, Purchase, Deposit, Account, Item, Estimate, JournalEntry). SELECT COUNT(*) works.

There are NO write tools yet by design — QuickBooks is the book of record;
writes (create invoice, categorize) need an explicit approval flow first.

## Which tool for which question

- "How much money do we have?" → `boss_qbo_list_accounts` (Bank rows = cash, Credit Card rows = owed)
- "How's the business doing?" / revenue / profit → `boss_qbo_profit_and_loss`
- "Who owes us?" / AR → `boss_qbo_list_invoices` with unpaid_only=true
- "What did we spend?" → `boss_qbo_list_expenses`
- Anything else → `boss_qbo_query`

## Lessons / gotchas

- Personal-account transactions live in the same company file — keep them out
  of business P&L summaries unless asked, and flag business expenses paid from
  personal accounts.
- QBO query language: values single-quoted (`Balance > '0'`), `%` is the only
  LIKE wildcard, no JOINs, MAXRESULTS caps at 1000.
- Balances are as fresh as QBO's bank feeds — usually same-day but not real-time.
- Auth: OAuth tokens auto-refresh (Intuit rotates the refresh token ~daily). If
  tools fail with "not connected", an admin reconnects via
  GET /api/connectors/quickbooks/connect (returns the authorize URL).
- REST surface: GET /api/connectors/quickbooks/financial-snapshot returns
  structured cash/P&L/AR JSON; boss_financial_reason (the CFO agent's engine)
  imports the same snapshot function directly. The BOS API is the ONLY holder
  of the QuickBooks tokens; never wire another stack directly to Intuit.
- Webhooks: entity-change events land at /api/webhooks/quickbooks (signed with
  QB_WEBHOOK_VERIFIER_TOKEN). Payloads are metadata only — re-query for data.
