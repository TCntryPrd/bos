/**
 * Email Agent routes — /api/email/*
 *
 * HTTP interface for the autonomous email processing system.
 * The n8n workflow calls POST /api/email/process for each email it handles.
 * The dashboard tile reads from GET /api/email/attention and GET /api/email/digest.
 * The brain calls GET /api/email/attention via the boss_email_attention tool.
 *
 *   GET  /api/email/attention         — 5 most recent emails needing Kevin's review
 *   GET  /api/email/digest            — daily summary: counts, invoices due, nuggets
 *   POST /api/email/process           — n8n logs a processed email
 *   POST /api/email/draft             — brain attaches a draft reply to an email log entry
 *   POST /api/email/resolve           — mark an attention item handled
 *   POST /api/email/send              — send an email via Gmail using a stored OAuth token
 *   POST /api/email/search            — search Gmail inbox using a stored OAuth token
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { getEmailTriageStatus } from '../agents/email-triage.js';

// ── Gmail send helpers (mirrors executor.ts token handling) ───────────────────

const _ALGORITHM = 'aes-256-gcm';
const _IV_LENGTH = 16;
const _AUTH_TAG_LENGTH = 16;

function _getEncryptionKey(): Buffer {
  const key = process.env.BOSS_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be set');
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}

function _decryptToken(encryptedText: string): string {
  const key = _getEncryptionKey();
  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(_ALGORITHM, key, iv, { authTagLength: _AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  let out = decipher.update(ciphertext, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

function _encryptToken(plaintext: string): string {
  const key = _getEncryptionKey();
  const iv = crypto.randomBytes(_IV_LENGTH);
  const cipher = crypto.createCipheriv(_ALGORITHM, key, iv, { authTagLength: _AUTH_TAG_LENGTH });
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

interface GmailTokenRow {
  account_id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

async function _getGmailToken(fromEmail: string): Promise<{ accessToken: string; accountId: string; email: string; refreshToken: string }> {
  const pool = getPool();
  const result = await pool.query<GmailTokenRow>(
    `SELECT account_id, email, access_token, refresh_token, expires_at
       FROM boss_oauth_tokens
      WHERE provider = 'google' AND email = $1`,
    [fromEmail],
  );
  if (result.rows.length === 0) {
    throw new Error(`No Gmail OAuth token found for ${fromEmail}. Connect the account via Settings first.`);
  }
  const row = result.rows[0];
  return {
    accountId: row.account_id,
    email: row.email,
    accessToken: _decryptToken(row.access_token),
    refreshToken: _decryptToken(row.refresh_token),
  };
}

async function _refreshGmailToken(accountId: string, refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  const newAccessToken = data.access_token;
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);
  const pool = getPool();
  await pool.query(
    `UPDATE boss_oauth_tokens SET access_token = $1, expires_at = $2, updated_at = now() WHERE account_id = $3`,
    [_encryptToken(newAccessToken), expiresAt.toISOString(), accountId],
  );
  return newAccessToken;
}

async function _sendViaGmail(accessToken: string, accountId: string, refreshToken: string, params: {
  to: string[];
  from: string;
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}): Promise<{ messageId: string }> {
  const lines: string[] = [];
  lines.push(`From: ${params.from}`);
  lines.push(`To: ${params.to.join(', ')}`);
  if (params.cc && params.cc.length > 0) lines.push(`Cc: ${params.cc.join(', ')}`);
  if (params.bcc && params.bcc.length > 0) lines.push(`Bcc: ${params.bcc.join(', ')}`);
  lines.push(`Subject: ${params.subject}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('');
  lines.push(params.body);
  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  const doSend = async (token: string) => {
    return fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
  };

  let res = await doSend(accessToken);
  if (res.status === 401) {
    const newToken = await _refreshGmailToken(accountId, refreshToken);
    res = await doSend(newToken);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail send failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { id: string };
  return { messageId: data.id };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type EmailCategory = 'newsletter' | 'invoice' | 'personal' | 'client' | 'marketing' | 'other';
type ActionTaken = 'archived' | 'draft_created' | 'auto_responded' | 'forwarded_to_brain' | 'compiled';

interface ProcessEmailBody {
  messageId: string;
  accountEmail: string;
  sender: string;
  subject: string;
  receivedAt: string;
  category: EmailCategory;
  needsAttention?: boolean;
  actionTaken?: ActionTaken;
  draftContent?: string;
  goldenNugget?: string;
  invoiceAmount?: number;
  invoiceDueDate?: string;
  bossNotes?: string;
}

interface AttachDraftBody {
  emailLogId: string;
  draftContent: string;
}

interface ResolveBody {
  emailLogId: string;
  resolvedBy: 'boss' | 'kevin';
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const attentionItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sender: { type: 'string' },
    subject: { type: 'string' },
    category: { type: 'string' },
    messageId: { type: 'string' },
    accountEmail: { type: 'string' },
    receivedAt: { type: 'string' },
    bossNotes: { type: 'string' },
  },
} as const;

const processBodySchema = {
  type: 'object',
  required: ['messageId', 'accountEmail', 'sender', 'subject', 'receivedAt', 'category'],
  properties: {
    messageId: { type: 'string', minLength: 1 },
    accountEmail: { type: 'string', minLength: 1 },
    sender: { type: 'string', minLength: 1 },
    subject: { type: 'string', minLength: 1 },
    receivedAt: { type: 'string', minLength: 1 },
    category: {
      type: 'string',
      enum: ['newsletter', 'invoice', 'personal', 'client', 'marketing', 'other'],
    },
    needsAttention: { type: 'boolean' },
    actionTaken: {
      type: 'string',
      enum: ['archived', 'draft_created', 'auto_responded', 'forwarded_to_brain', 'compiled'],
    },
    draftContent: { type: 'string' },
    goldenNugget: { type: 'string' },
    invoiceAmount: { type: 'number' },
    invoiceDueDate: { type: 'string' },
    bossNotes: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const attachDraftBodySchema = {
  type: 'object',
  required: ['emailLogId', 'draftContent'],
  properties: {
    emailLogId: { type: 'string', minLength: 1 },
    draftContent: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

const resolveBodySchema = {
  type: 'object',
  required: ['emailLogId', 'resolvedBy'],
  properties: {
    emailLogId: { type: 'string', minLength: 1 },
    resolvedBy: { type: 'string', enum: ['boss', 'kevin'] },
  },
  additionalProperties: false,
} as const;

// ── Routes ────────────────────────────────────────────────────────────────────

export async function emailAgentRoutes(server: FastifyInstance) {
  /**
   * GET /api/email/status
   * Returns the email triage agent's current status.
   */
  server.get('/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send(getEmailTriageStatus());
  });

  /**
   * GET /api/email/attention
   * Returns the 5 most recent emails needing Kevin's attention, oldest first
   * within the unresolved set so the most pressing item surfaces naturally.
   *
   * Used by the dashboard tile and the boss_email_attention brain tool.
   *
   * Example response:
   *   [{ "id": "...", "sender": "jim@bodyshopconnect.com", "subject": "Re: Phase 2 scope",
   *      "category": "client", "receivedAt": "...", "bossNotes": "..." }]
   */
  server.get(
    '/attention',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: attentionItemSchema,
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const pool = getPool();
      const result = await pool.query<{
        id: string;
        message_id: string | null;
        account_email: string | null;
        sender: string;
        subject: string;
        category: string;
        received_at: Date | null;
        boss_notes: string | null;
      }>(
        `SELECT id, message_id, account_email, sender, subject, category, received_at, boss_notes
           FROM boss_email_log
          WHERE needs_attention = true
            AND resolved_at IS NULL
          ORDER BY processed_at DESC
          LIMIT 5`,
      );

      const items = result.rows.map((row) => ({
        id: row.id,
        messageId: row.message_id ?? undefined,
        accountEmail: row.account_email ?? undefined,
        sender: row.sender,
        subject: row.subject,
        category: row.category,
        receivedAt: row.received_at ? row.received_at.toISOString() : '',
        bossNotes: row.boss_notes ?? undefined,
      }));

      return reply.status(200).send(items);
    },
  );

  /**
   * GET /api/email/digest
   * Returns a daily digest: processed counts per category, total processed today,
   * invoices due within 7 days, and golden nuggets from newsletters.
   *
   * "Today" is UTC calendar day. The n8n workflow may call this at EOD to push
   * a summary to Slack/Telegram.
   *
   * Example response:
   *   {
   *     "date": "2026-03-31",
   *     "totalProcessed": 42,
   *     "needsAttention": 3,
   *     "categories": { "newsletter": 12, "invoice": 4, "client": 5, ... },
   *     "invoicesDue": [{ "sender": "...", "amount": 1200.00, "dueDate": "2026-04-05" }],
   *     "goldenNuggets": ["AI adoption in SMBs grew 40% in Q1 2026", ...]
   *   }
   */
  server.get(
    '/digest',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              totalProcessed: { type: 'number' },
              totalAllTime: { type: 'number' },
              draftsCreated: { type: 'number' },
              needsAttention: { type: 'number' },
              categories: {
                type: 'object',
                additionalProperties: { type: 'number' },
              },
              invoicesDue: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    sender: { type: 'string' },
                    subject: { type: 'string' },
                    amount: { type: 'number' },
                    dueDate: { type: 'string' },
                  },
                },
              },
              goldenNuggets: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const pool = getPool();

      // All queries run in parallel — single round-trip cost
      const [countResult, attentionResult, categoryResult, invoiceResult, nuggetResult, allTimeResult, draftsResult] =
        await Promise.all([
          // Total processed today
          pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM boss_email_log
              WHERE processed_at >= CURRENT_DATE`,
          ),
          // Still-open attention items
          pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM boss_email_log
              WHERE needs_attention = true AND resolved_at IS NULL`,
          ),
          // Count per category for today
          pool.query<{ category: string; count: string }>(
            `SELECT category, COUNT(*)::text AS count
               FROM boss_email_log
              WHERE processed_at >= CURRENT_DATE
              GROUP BY category`,
          ),
          // Invoices due within 7 days that are still unresolved
          pool.query<{
            id: string;
            sender: string;
            subject: string;
            invoice_amount: string | null;
            invoice_due_date: Date | null;
          }>(
            `SELECT id, sender, subject, invoice_amount, invoice_due_date
               FROM boss_email_log
              WHERE category = 'invoice'
                AND invoice_due_date IS NOT NULL
                AND invoice_due_date <= (CURRENT_DATE + interval '7 days')
                AND resolved_at IS NULL
              ORDER BY invoice_due_date ASC`,
          ),
          // Golden nuggets from the last 7 days
          pool.query<{ golden_nugget: string }>(
            `SELECT golden_nugget
               FROM boss_email_log
              WHERE golden_nugget IS NOT NULL
                AND processed_at >= (now() - interval '7 days')
              ORDER BY processed_at DESC
              LIMIT 20`,
          ),
          // Total processed since the agent started (all-time — log is fresh after the reset)
          pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM boss_email_log`),
          // Drafts created (all-time)
          pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM boss_email_log WHERE draft_content IS NOT NULL`,
          ),
        ]);

      const categories: Record<string, number> = {};
      for (const row of categoryResult.rows) {
        categories[row.category] = parseInt(row.count, 10);
      }

      const invoicesDue = invoiceResult.rows.map((row) => ({
        id: row.id,
        sender: row.sender,
        subject: row.subject,
        amount: row.invoice_amount != null ? parseFloat(row.invoice_amount) : undefined,
        dueDate: row.invoice_due_date ? row.invoice_due_date.toISOString().slice(0, 10) : undefined,
      }));

      const goldenNuggets = nuggetResult.rows.map((row) => row.golden_nugget);

      const today = new Date().toISOString().slice(0, 10);

      return reply.status(200).send({
        date: today,
        totalProcessed: parseInt(countResult.rows[0]?.count ?? '0', 10),
        totalAllTime: parseInt(allTimeResult.rows[0]?.count ?? '0', 10),
        draftsCreated: parseInt(draftsResult.rows[0]?.count ?? '0', 10),
        needsAttention: parseInt(attentionResult.rows[0]?.count ?? '0', 10),
        categories,
        invoicesDue,
        goldenNuggets,
      });
    },
  );

  /**
   * POST /api/email/process
   * Called by the n8n email processing workflow to log a handled email.
   * Accepts the same BOSS_API_KEY Bearer token used by all other routes.
   *
   * Returns the created log entry ID so the n8n workflow can reference it in
   * subsequent draft or resolve calls.
   *
   * Example request:
   *   { "messageId": "...", "accountEmail": "user@example.com",
   *     "sender": "newsletter@tldr.tech", "subject": "TLDR AI March 31",
   *     "receivedAt": "2026-03-31T08:00:00Z", "category": "newsletter",
   *     "actionTaken": "archived", "goldenNugget": "...", "needsAttention": false }
   */
  server.post<{ Body: ProcessEmailBody }>(
    '/process',
    {
      schema: {
        body: processBodySchema,
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ProcessEmailBody }>, reply: FastifyReply) => {
      const pool = getPool();
      const body = request.body;
      const id = randomUUID();

      await pool.query(
        `INSERT INTO boss_email_log (
           id, message_id, account_email, sender, subject,
           received_at, category, needs_attention, action_taken,
           draft_content, golden_nugget, invoice_amount, invoice_due_date,
           boss_notes
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13,
           $14
         )`,
        [
          id,
          body.messageId,
          body.accountEmail,
          body.sender,
          body.subject,
          body.receivedAt,
          body.category,
          body.needsAttention ?? false,
          body.actionTaken ?? null,
          body.draftContent ?? null,
          body.goldenNugget ?? null,
          body.invoiceAmount ?? null,
          body.invoiceDueDate ?? null,
          body.bossNotes ?? null,
        ],
      );

      request.log.info(
        { id, sender: body.sender, category: body.category, needsAttention: body.needsAttention },
        'email-agent: email logged',
      );

      return reply.status(201).send({ id, message: 'Email logged successfully' });
    },
  );

  /**
   * POST /api/email/draft
   * Attaches a draft reply to an existing email log entry.
   * Called by the brain after it composes a draft for a client or personal email.
   *
   * Sets action_taken = 'draft_created' if not already set.
   *
   * Example request:
   *   { "emailLogId": "...", "draftContent": "Hi Jim, thanks for reaching out..." }
   */
  server.post<{ Body: AttachDraftBody }>(
    '/draft',
    {
      schema: {
        body: attachDraftBodySchema,
        response: {
          200: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: AttachDraftBody }>, reply: FastifyReply) => {
      const pool = getPool();
      const { emailLogId, draftContent } = request.body;

      const result = await pool.query(
        `UPDATE boss_email_log
            SET draft_content = $1,
                action_taken  = COALESCE(action_taken, 'draft_created')
          WHERE id = $2`,
        [draftContent, emailLogId],
      );

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: `Email log entry "${emailLogId}" not found` });
      }

      request.log.info({ emailLogId }, 'email-agent: draft attached');
      return reply.status(200).send({ message: 'Draft attached' });
    },
  );

  /**
   * POST /api/email/resolve
   * Marks an attention item as handled. Called either by the brain (boss)
   * when it auto-handles something, or by the dashboard when Kevin clicks resolve.
   *
   * Example request:
   *   { "emailLogId": "...", "resolvedBy": "kevin" }
   */
    // Clear all — resolve the ENTIRE attention backlog, not just the visible top-N.
  server.post('/resolve-all', async (_request: FastifyRequest, reply: FastifyReply) => {
    const r = await getPool().query(`UPDATE boss_email_log SET resolved_at = now(), resolved_by = 'kevin' WHERE needs_attention = true AND resolved_at IS NULL`);
    return reply.send({ ok: true, resolved: r.rowCount ?? 0 });
  });

  server.post<{ Body: ResolveBody }>(
    '/resolve',
    {
      schema: {
        body: resolveBodySchema,
        response: {
          200: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ResolveBody }>, reply: FastifyReply) => {
      const pool = getPool();
      const { emailLogId, resolvedBy } = request.body;

      const result = await pool.query(
        `UPDATE boss_email_log
            SET resolved_at = now(),
                resolved_by = $1
          WHERE id = $2
            AND resolved_at IS NULL`,
        [resolvedBy, emailLogId],
      );

      if (result.rowCount === 0) {
        // Either not found or already resolved — query to distinguish
        const check = await pool.query<{ id: string; resolved_at: Date | null }>(
          `SELECT id, resolved_at FROM boss_email_log WHERE id = $1`,
          [emailLogId],
        );

        if (check.rows.length === 0) {
          return reply.status(404).send({ error: `Email log entry "${emailLogId}" not found` });
        }

        // Already resolved — idempotent success
        return reply.status(200).send({ message: 'Already resolved' });
      }

      request.log.info({ emailLogId, resolvedBy }, 'email-agent: attention item resolved');
      return reply.status(200).send({ message: 'Resolved' });
    },
  );

  /**
   * POST /api/email/send
   * Send an email via Gmail using the stored OAuth token for the given account.
   * Automatically refreshes expired access tokens using the stored refresh token.
   *
   * Auth: required (internal service calls accepted via x-boss-internal header).
   *
   * Example request:
   *   {
   *     "from": "user@example.com",
   *     "to": ["prospect@example.com"],
   *     "subject": "Quick idea for Example Co",
   *     "body": "Hi Jane,\n\n...",
   *     "cc": [],
   *     "bcc": []
   *   }
   *
   * Example response:
   *   { "messageId": "189abc123...", "status": "sent" }
   */
  server.post<{
    Body: {
      from: string;
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
    };
  }>(
    '/send',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to', 'subject', 'body'],
          properties: {
            from:    { type: 'string', minLength: 1 },
            to:      { type: 'array', items: { type: 'string' }, minItems: 1 },
            subject: { type: 'string', minLength: 1 },
            body:    { type: 'string', minLength: 1 },
            cc:      { type: 'array', items: { type: 'string' } },
            bcc:     { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              messageId: { type: 'string' },
              status:    { type: 'string' },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: {
          from: string;
          to: string[];
          subject: string;
          body: string;
          cc?: string[];
          bcc?: string[];
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { from, to, subject, body: emailBody, cc, bcc } = request.body;

      let token: Awaited<ReturnType<typeof _getGmailToken>>;
      try {
        token = await _getGmailToken(from);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: 'Gmail account not connected', message: msg });
      }

      try {
        const result = await _sendViaGmail(token.accessToken, token.accountId, token.refreshToken, {
          to,
          from,
          subject,
          body: emailBody,
          cc,
          bcc,
        });

        request.log.info(
          { from, to, subject, messageId: result.messageId },
          'email-agent: email sent via Gmail',
        );

        return reply.status(200).send({ messageId: result.messageId, status: 'sent' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err, from, to, subject }, 'email-agent: Gmail send failed');
        return reply.status(502).send({ error: 'Gmail send failed', message: msg });
      }
    },
  );

  /**
   * POST /api/email/search
   * Search Gmail inbox using a stored OAuth token.
   * Used by the outreach-followup agent to check for replies to sent emails.
   *
   * Auth: internal service calls accepted via x-boss-internal header.
   *
   * Example request:
   *   {
   *     "account": "user@example.com",
   *     "query": "subject:\"Quick idea for Example Co\" in:inbox",
   *     "maxResults": 10
   *   }
   *
   * Example response:
   *   {
   *     "messages": [
   *       {
   *         "id": "189abc123",
   *         "threadId": "189abc123",
   *         "snippet": "Thanks for reaching out...",
   *         "from": "jane@example.com",
   *         "subject": "Re: Quick idea for Example Co",
   *         "date": "2026-04-05T14:23:00Z",
   *         "labelIds": ["INBOX", "UNREAD"]
   *       }
   *     ],
   *     "resultSizeEstimate": 1
   *   }
   */
  server.post<{
    Body: {
      account: string;
      query: string;
      maxResults?: number;
    };
  }>(
    '/search',
    {
      schema: {
        body: {
          type: 'object',
          required: ['account', 'query'],
          properties: {
            account:    { type: 'string', minLength: 1 },
            query:      { type: 'string', minLength: 1 },
            maxResults: { type: 'number', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { account: string; query: string; maxResults?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const { account, query, maxResults = 10 } = request.body;

      let token: Awaited<ReturnType<typeof _getGmailToken>>;
      try {
        token = await _getGmailToken(account);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: 'Gmail account not connected', message: msg });
      }

      const doSearch = async (accessToken: string) => {
        return fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
      };

      let searchRes = await doSearch(token.accessToken);
      if (searchRes.status === 401) {
        token.accessToken = await _refreshGmailToken(token.accountId, token.refreshToken);
        searchRes = await doSearch(token.accessToken);
      }
      if (!searchRes.ok) {
        const text = await searchRes.text();
        return reply.status(502).send({ error: 'Gmail search failed', message: text });
      }

      const searchData = await searchRes.json() as {
        messages?: { id: string; threadId: string }[];
        resultSizeEstimate?: number;
      };

      if (!searchData.messages || searchData.messages.length === 0) {
        return reply.status(200).send({ messages: [], resultSizeEstimate: 0 });
      }

      // Fetch metadata for each matched message (in parallel, capped at maxResults)
      const fetchMessage = async (msgId: string) => {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token.accessToken}` } },
        );
        if (!res.ok) return null;
        const msg = await res.json() as {
          id: string;
          threadId: string;
          snippet: string;
          labelIds: string[];
          payload?: { headers?: { name: string; value: string }[] };
          internalDate?: string;
        };
        const headers: Record<string, string> = {};
        for (const h of msg.payload?.headers ?? []) {
          headers[h.name.toLowerCase()] = h.value;
        }
        return {
          id: msg.id,
          threadId: msg.threadId,
          snippet: msg.snippet,
          from: headers['from'] ?? '',
          subject: headers['subject'] ?? '',
          date: headers['date'] ?? (msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : ''),
          labelIds: msg.labelIds ?? [],
        };
      };

      const details = await Promise.all(
        (searchData.messages ?? []).map((m) => fetchMessage(m.id)),
      );

      const messages = details.filter(Boolean);

      request.log.info({ account, query, count: messages.length }, 'email-agent: Gmail search complete');

      return reply.status(200).send({
        messages,
        resultSizeEstimate: searchData.resultSizeEstimate ?? messages.length,
      });
    },
  );
}
