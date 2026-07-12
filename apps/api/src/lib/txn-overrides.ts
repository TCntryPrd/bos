/**
 * Transaction classification overrides — Kevin's free-form labels on ERA deposits.
 * The Financial Snapshot tile shows recent transactions; Kevin tags any of them with a
 * free-form label (e.g. "Industry Rockstar June", "client payment - Acme", "owner draw").
 * The CFO's reasoner (boss_financial_reason) reads these back each run and HONORS the exact
 * transaction, and uses them as guidance for similar ones. The human-correction loop that
 * makes the cheaper-model CFO trustworthy.
 */
import { getPool } from '../db.js';

export interface TxnOverride {
  transaction_id: string;
  account: string | null;
  txn_date: string | null;
  amount: number | null;
  description: string | null;
  label: string;
  note: string | null;
  updated_at: string;
}

export async function ensureTxnOverridesTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS boss_txn_overrides (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      TEXT NOT NULL DEFAULT 'default',
      transaction_id TEXT NOT NULL,
      account        TEXT,
      txn_date       DATE,
      amount         NUMERIC,
      description    TEXT,
      label          TEXT NOT NULL,
      note           TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, transaction_id)
    )`);
  await getPool().query(`CREATE INDEX IF NOT EXISTS idx_txn_overrides_updated ON boss_txn_overrides (updated_at DESC)`).catch(() => {});
}

/** Upsert Kevin's label for one transaction (free-form). */
export async function upsertTxnOverride(o: {
  transactionId: string; account?: string; txnDate?: string; amount?: number; description?: string; label: string; note?: string; tenantId?: string;
}): Promise<void> {
  await ensureTxnOverridesTable();
  await getPool().query(
    `INSERT INTO boss_txn_overrides (tenant_id, transaction_id, account, txn_date, amount, description, label, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, transaction_id)
     DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, account = EXCLUDED.account,
                   txn_date = EXCLUDED.txn_date, amount = EXCLUDED.amount, description = EXCLUDED.description,
                   updated_at = now()`,
    [o.tenantId ?? 'default', o.transactionId, o.account ?? null, o.txnDate ?? null,
     o.amount ?? null, o.description ?? null, o.label, o.note ?? null],
  );
}

/** Map of transaction_id -> override, for merging into the tile + the reasoner. */
export async function getTxnOverrideMap(tenantId = 'default'): Promise<Record<string, TxnOverride>> {
  await ensureTxnOverridesTable();
  const { rows } = await getPool().query<TxnOverride>(
    `SELECT transaction_id, account, txn_date, amount, description, label, note, updated_at
     FROM boss_txn_overrides WHERE tenant_id = $1`,
    [tenantId],
  );
  const map: Record<string, TxnOverride> = {};
  for (const r of rows) map[r.transaction_id] = r;
  return map;
}

/** Recent labels as plain text for injecting into the CFO reasoner prompt. */
export async function recentTxnOverridesText(limit = 40, tenantId = 'default'): Promise<string> {
  await ensureTxnOverridesTable();
  const { rows } = await getPool().query<TxnOverride>(
    `SELECT transaction_id, account, txn_date, amount, description, label, note, updated_at
     FROM boss_txn_overrides WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [tenantId, Math.min(limit, 200)],
  );
  if (!rows.length) return '';
  return rows.map((r) =>
    `- txn ${r.transaction_id} (${r.txn_date ?? '?'}, ${r.amount ?? '?'}, "${(r.description ?? '').slice(0, 50)}") => Kevin labeled: "${r.label}"${r.note ? ` (note: ${r.note})` : ''}`,
  ).join('\n');
}
