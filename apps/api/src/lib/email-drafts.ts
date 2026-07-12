/**
 * Email draft rating + learning store. The Email Agent records each reply draft
 * it creates; Kevin rates them (👍/👎 + note) from the dashboard; the agent reads
 * recent ratings back each run to improve (a closed feedback loop on tone, brand
 * voice, and usefulness). Backs the "Email Drafts" tile + the two brain tools.
 */
import { getPool } from '../db.js';

export interface EmailDraftRow {
  id: string; account: string; to_addr: string | null; subject: string | null;
  reply_subject: string | null; body: string; rating: number | null;
  rating_note: string | null; created_at: string; rated_at: string | null;
  verdict: string | null;                  // 'pass' | 'needs_human' | 'block' | null (unvalidated)
  verdict_issues: DraftIssue[] | null;      // structured findings from the validator
  flags: string[] | null;                   // short labels e.g. ['needs-kevin','unauthorized-commitment']
  validated_at: string | null;
}

/** One finding the Validator agent recorded against a draft. */
export interface DraftIssue { severity: 'HIGH' | 'MEDIUM' | 'LOW'; detail: string; }

export async function ensureEmailDraftsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS boss_email_drafts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     TEXT NOT NULL DEFAULT 'default',
      account       TEXT NOT NULL,
      to_addr       TEXT,
      subject       TEXT,
      reply_subject TEXT,
      body          TEXT NOT NULL,
      rating        INT,            -- 1 = thumbs up, -1 = thumbs down, NULL = unrated
      rating_note   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      rated_at      TIMESTAMPTZ
    )`);
  await getPool().query(`CREATE INDEX IF NOT EXISTS idx_email_drafts_created ON boss_email_drafts (created_at DESC)`).catch(() => {});
  // Validator columns (idempotent; safe to run on every boot).
  await getPool().query(`ALTER TABLE boss_email_drafts ADD COLUMN IF NOT EXISTS verdict        TEXT`).catch(() => {});
  await getPool().query(`ALTER TABLE boss_email_drafts ADD COLUMN IF NOT EXISTS verdict_issues JSONB`).catch(() => {});
  await getPool().query(`ALTER TABLE boss_email_drafts ADD COLUMN IF NOT EXISTS flags          TEXT[]`).catch(() => {});
  await getPool().query(`ALTER TABLE boss_email_drafts ADD COLUMN IF NOT EXISTS validated_at   TIMESTAMPTZ`).catch(() => {});
  // Pull-queue index: validator scans WHERE verdict IS NULL ORDER BY created_at ASC.
  await getPool().query(`CREATE INDEX IF NOT EXISTS idx_email_drafts_pending ON boss_email_drafts (created_at ASC) WHERE verdict IS NULL`).catch(() => {});
}

export async function recordEmailDraft(d: {
  account: string; toAddr?: string; subject?: string; replySubject?: string; body: string; tenantId?: string;
}): Promise<string> {
  await ensureEmailDraftsTable();
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO boss_email_drafts (tenant_id, account, to_addr, subject, reply_subject, body)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [d.tenantId ?? 'default', d.account, d.toAddr ?? null, d.subject ?? null, d.replySubject ?? null, d.body],
  );
  return rows[0].id;
}

export async function listEmailDrafts(opts: { limit?: number; unratedFirst?: boolean; tenantId?: string } = {}): Promise<EmailDraftRow[]> {
  await ensureEmailDraftsTable();
  const order = opts.unratedFirst ? `(rating IS NOT NULL), created_at DESC` : `created_at DESC`;
  const { rows } = await getPool().query<EmailDraftRow>(
    `SELECT id, account, to_addr, subject, reply_subject, body, rating, rating_note, created_at, rated_at,
            verdict, verdict_issues, flags, validated_at
     FROM boss_email_drafts WHERE tenant_id = $1 ORDER BY ${order} LIMIT $2`,
    [opts.tenantId ?? 'default', Math.min(opts.limit ?? 25, 100)],
  );
  return rows;
}

export async function rateEmailDraft(id: string, rating: number, note?: string, tenantId = 'default'): Promise<void> {
  await ensureEmailDraftsTable();
  await getPool().query(
    `UPDATE boss_email_drafts SET rating = $2, rating_note = $3, rated_at = now() WHERE id = $1 AND tenant_id = $4`,
    [id, rating, note ?? null, tenantId],
  );
}

/** Recent RATED drafts for the agent to learn from — thumbs-down weighted first. */
export async function recentDraftFeedback(limit = 12, tenantId = 'default'): Promise<EmailDraftRow[]> {
  await ensureEmailDraftsTable();
  const { rows } = await getPool().query<EmailDraftRow>(
    `SELECT id, account, to_addr, subject, reply_subject, body, rating, rating_note, created_at, rated_at,
            verdict, verdict_issues, flags, validated_at
     FROM boss_email_drafts WHERE tenant_id = $1 AND rating IS NOT NULL
     ORDER BY (rating < 0) DESC, rated_at DESC LIMIT $2`,
    [tenantId, Math.min(limit, 50)],
  );
  return rows;
}

/** Drafts that the Validator has NOT yet judged (verdict IS NULL), oldest first. */
export async function pendingValidationDrafts(limit = 10, tenantId = 'default'): Promise<EmailDraftRow[]> {
  await ensureEmailDraftsTable();
  const { rows } = await getPool().query<EmailDraftRow>(
    `SELECT id, account, to_addr, subject, reply_subject, body, rating, rating_note, created_at, rated_at,
            verdict, verdict_issues, flags, validated_at
     FROM boss_email_drafts
     WHERE tenant_id = $1 AND verdict IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [tenantId, Math.min(Math.max(limit, 1), 50)],
  );
  return rows;
}

/**
 * Record the Validator's judgement on a draft. Idempotent-safe to call again
 * (overwrites the prior verdict). `verdict` must be 'pass' | 'needs_human' | 'block'.
 */
export async function validateEmailDraft(
  id: string,
  verdict: 'pass' | 'needs_human' | 'block',
  issues: DraftIssue[] = [],
  flags: string[] = [],
  tenantId = 'default',
): Promise<boolean> {
  await ensureEmailDraftsTable();
  if (verdict !== 'pass' && verdict !== 'needs_human' && verdict !== 'block') {
    throw new Error("verdict must be 'pass', 'needs_human', or 'block'");
  }
  const { rowCount } = await getPool().query(
    `UPDATE boss_email_drafts
        SET verdict = $2, verdict_issues = $3::jsonb, flags = $4, validated_at = now()
      WHERE id = $1 AND tenant_id = $5`,
    [id, verdict, JSON.stringify(issues ?? []), flags ?? [], tenantId],
  );
  return (rowCount ?? 0) > 0;
}
