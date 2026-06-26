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
}

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
    `SELECT id, account, to_addr, subject, reply_subject, body, rating, rating_note, created_at, rated_at
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
    `SELECT id, account, to_addr, subject, reply_subject, body, rating, rating_note, created_at, rated_at
     FROM boss_email_drafts WHERE tenant_id = $1 AND rating IS NOT NULL
     ORDER BY (rating < 0) DESC, rated_at DESC LIMIT $2`,
    [tenantId, Math.min(limit, 50)],
  );
  return rows;
}
