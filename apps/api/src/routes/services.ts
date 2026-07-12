/**
 * Services routes — /api/services/*
 *
 * Unified CRUD layer over mail, calendar, tasks, and files.
 * All operations fan out to the appropriate connector based on the
 * account's provider (google | microsoft) resolved from the accountId.
 *
 * Endpoints:
 *   Mail:
 *     GET    /mail/attention       — unread mail needing human attention (dashboard tile)
 *     GET    /mail                 — list messages (supports query params)
 *     GET    /mail/:messageId      — get a single message
 *     POST   /mail                 — send a message
 *     PATCH  /mail/:messageId/read — mark as read
 *     DELETE /mail/:messageId      — trash a message
 *
 *   Calendar:
 *     GET    /calendar             — list events in a time range
 *     GET    /calendar/:eventId    — get a single event
 *     POST   /calendar             — create an event
 *     PUT    /calendar/:eventId    — update an event
 *     DELETE /calendar/:eventId    — delete an event
 *
 *   Tasks:
 *     GET    /tasks/pending        — pending tasks with priority (dashboard tile)
 *     GET    /tasks/lists          — list task lists
 *     GET    /tasks                — list tasks
 *     POST   /tasks                — create a task
 *     PUT    /tasks/:taskId        — update a task
 *     PATCH  /tasks/:taskId/complete — mark complete
 *     DELETE /tasks/:taskId        — delete a task
 *
 *   Files:
 *     GET    /files                — list / search files
 *     GET    /files/:fileId        — get file metadata
 *     DELETE /files/:fileId        — delete a file
 *
 * Phase 1: connector instances are not yet wired to live OAuth tokens.
 * All handlers return 501 Not Implemented until the unified service layer
 * is connected in Phase 3.
 *
 * Dashboard tile endpoints (/mail/attention, /tasks/pending) are live and
 * read real data via the Google connectors.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  GoogleClient,
  GmailConnector,
  GoogleTasksConnector,
  NotConnectedError,
  ConnectorError,
} from '@boss/connectors';
import type { OAuthConfig } from '@boss/connectors';
import { oauthClientConfigs } from './connectors.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Get a Google access token directly from Postgres — bypasses the connector
 * package which has wiring issues with the token store. Same approach used by
 * the brain tool executor.
 */
async function getDirectGoogleToken(): Promise<string | null> {
  const r = await getDirectGoogleAccount();
  return r?.token ?? null;
}

/**
 * Returns the most recently updated Google OAuth token along with the
 * email address it belongs to. Used by tile endpoints that want to
 * surface "which inbox am I showing" on the dashboard.
 */
async function getDirectGoogleAccount(): Promise<{ token: string; email: string } | null> {
  try {
    const { getPool } = await import('../db.js');
    const crypto = await import('node:crypto');
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT access_token, email FROM boss_oauth_tokens WHERE provider = 'google' ORDER BY updated_at DESC LIMIT 1`,
    );
    if (rows.length === 0) return null;

    const encrypted = rows[0].access_token;
    const email: string = rows[0].email ?? '';
    const key = process.env.BOSS_TOKEN_ENCRYPTION_KEY;
    if (!key) return null;
    const keyBuf = Buffer.from(key, 'hex');
    const parts = encrypted.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, authTagHex, ciphertext] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    let out = decipher.update(ciphertext, 'hex', 'utf8');
    out += decipher.final('utf8');
    return { token: out, email };
  } catch {
    return null;
  }
}

function notImplemented(reply: FastifyReply, operation: string): void {
  reply.status(501).send({
    error: 'Not Implemented',
    message: `${operation} will be available once the connector layer is wired (Phase 3)`,
  });
}

/**
 * Build a Google OAuthConfig from runtime-configured credentials (set via
 * POST /api/connectors/oauth/configure) falling back to env vars.
 * Returns null when neither source has credentials, so callers can return
 * an empty result instead of crashing.
 */
function buildGoogleOAuthConfig(): OAuthConfig | null {
  const cached = oauthClientConfigs.get('google');
  const clientId = cached?.clientId ?? process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = cached?.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'google',
    clientId,
    clientSecret,
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3001/api/connectors/oauth/google/callback',
    scopes: [],
  };
}

// Automated sender patterns to filter out of the attention queue.
const AUTOMATED_SENDER_PATTERNS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notification', 'notifications', 'newsletter', 'newsletters',
  'mailer', 'automated', 'updates@', 'alerts@', 'info@',
  'support@', 'billing@', 'postmaster@', 'bounce',
];

function isAutomatedSender(fromAddress: string): boolean {
  const lower = fromAddress.toLowerCase();
  return AUTOMATED_SENDER_PATTERNS.some((pattern) => lower.includes(pattern));
}

type TaskPriority = 'low' | 'medium' | 'high';

function deriveTaskPriority(dueDate: Date | undefined): TaskPriority {
  if (!dueDate) return 'low';
  const now = Date.now();
  const msUntilDue = dueDate.getTime() - now;
  if (msUntilDue < 0) return 'high';                       // overdue
  if (msUntilDue < 3 * 24 * 60 * 60 * 1000) return 'medium'; // within 3 days
  return 'low';
}

// ---------------------------------------------------------------------------
// Common schemas
// ---------------------------------------------------------------------------

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

const accountQuerySchema = {
  type: 'object',
  properties: { accountId: { type: 'string' } },
} as const;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function servicesRoutes(server: FastifyInstance) {
  // ── Dashboard tiles (live Google data) ───────────────────────────────────
  //
  // These routes use static path segments (/mail/attention, /tasks/pending)
  // and MUST be registered before any parameterised routes (/mail/:id,
  // /tasks/:id) so Fastify's router matches them without ambiguity.

  /**
   * GET /api/services/mail/attention
   * Returns unread Gmail messages that need human attention, filtered of
   * automated / newsletter senders.
   *
   * Response: Array<{ id, sender, subject, timestamp, preview }>
   *
   * Returns [] (not an error) when no Google account is connected.
   */
  server.get('/mail/attention', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Direct Google API call — bypasses connector package which can't find tokens
    try {
      const account = await getDirectGoogleAccount();
      if (!account) return reply.send({ email: null, items: [] });
      const { token, email: accountEmail } = account;

      // Get unread messages
      const listRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+in:inbox&maxResults=10',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (!listRes.ok) {
        server.log.warn({ status: listRes.status }, 'GET /mail/attention: Gmail API error');
        return reply.send({ email: accountEmail, items: [] });
      }
      const listData = await listRes.json() as { messages?: { id: string }[] };
      if (!listData.messages?.length) return reply.send({ email: accountEmail, items: [] });

      // Fetch details for each message
      const result = [];
      for (const msg of listData.messages.slice(0, 10)) {
        try {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
          );
          if (!msgRes.ok) continue;
          const msgData = await msgRes.json() as { id: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
          const headers = msgData.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? '';
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';
          result.push({
            id: msgData.id,
            sender: from,
            subject,
            timestamp: date ? new Date(date).toISOString() : new Date().toISOString(),
            preview: msgData.snippet ?? '',
            account: accountEmail,
          });
        } catch { continue; }
      }
      return reply.send({ email: accountEmail, items: result });
    } catch (err) {
      server.log.warn({ err }, 'GET /mail/attention: error');
      return reply.send({ email: null, items: [] });
    }
  });

  /**
   * GET /api/services/tasks/pending
   * Returns all incomplete Google Tasks across every task list, with priority
   * derived from due date (overdue=high, within 3 days=medium, else=low).
   *
   * Response: Array<{ id, title, dueDate, priority, listName }>
   *
   * Returns [] (not an error) when no Google account is connected.
   */
  server.get('/tasks/pending', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Direct Google API call — bypasses connector package
    try {
      const token = await getDirectGoogleToken();
      if (!token) return reply.send([]);

      // Get task lists
      const listsRes = await fetch(
        'https://tasks.googleapis.com/tasks/v1/users/@me/lists',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (!listsRes.ok) return reply.send([]);
      const listsData = await listsRes.json() as { items?: { id: string; title: string }[] };
      if (!listsData.items?.length) return reply.send([]);

      const result: { id: string; title: string; dueDate: string | null; priority: TaskPriority; listName: string }[] = [];

      for (const list of listsData.items) {
        try {
          const tasksRes = await fetch(
            `https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks?showCompleted=false&maxResults=20`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
          );
          if (!tasksRes.ok) continue;
          const tasksData = await tasksRes.json() as { items?: { id: string; title: string; due?: string; status?: string }[] };
          for (const task of tasksData.items ?? []) {
            if (task.status === 'completed') continue;
            const dueDate = task.due ? new Date(task.due) : null;
            result.push({
              id: task.id,
              title: task.title,
              dueDate: dueDate?.toISOString() ?? null,
              priority: deriveTaskPriority(dueDate ?? undefined),
              listName: list.title,
            });
          }
        } catch { continue; }
      }

      // Sort: high priority first
      const priorityOrder: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
      result.sort((a, b) => {
        const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (pd !== 0) return pd;
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      });
      return reply.send(result);
    } catch (err) {
      server.log.warn({ err }, 'GET /tasks/pending: error');
      return reply.send([]);
    }
  });

  // ── Mail ─────────────────────────────────────────────────────────────────

  /**
   * GET /api/services/mail
   * List mail messages, optionally filtered by query/from/to/isRead/after/before.
   *
   * Query params:
   *   accountId, query, from, to, subject, isRead, after (ISO date), before (ISO date),
   *   maxResults (default 50)
   *
   * Example response:
   *   [{ "id": "msg-xxx", "from": "alice@example.com", "subject": "Hello", "isRead": false, ... }]
   */
  server.get(
    '/mail',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            query: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            subject: { type: 'string' },
            isRead: { type: 'boolean' },
            after: { type: 'string', format: 'date-time' },
            before: { type: 'string', format: 'date-time' },
            maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'List mail');
    },
  );

  /**
   * GET /api/services/mail/:id
   * Retrieve a single mail message by ID.
   */
  server.get<{ Params: { id: string } }>(
    '/mail/:id',
    { schema: { params: idParamSchema } },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Get mail message');
    },
  );

  /**
   * POST /api/services/mail
   * Send a mail message.
   *
   * Body: { accountId?, to, cc?, bcc?, subject, body, bodyHtml?, replyToMessageId? }
   */
  server.post(
    '/mail',
    {
      schema: {
        body: {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            accountId: { type: 'string' },
            to: {
              type: 'array',
              items: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string' },
                },
              },
              minItems: 1,
            },
            cc: { type: 'array', items: { type: 'object' } },
            bcc: { type: 'array', items: { type: 'object' } },
            subject: { type: 'string', minLength: 1 },
            body: { type: 'string' },
            bodyHtml: { type: 'string' },
            replyToMessageId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'Send mail');
    },
  );

  /**
   * PATCH /api/services/mail/:id/read
   * Mark a message as read.
   */
  server.patch<{ Params: { id: string } }>(
    '/mail/:id/read',
    { schema: { params: idParamSchema } },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Mark mail as read');
    },
  );

  /**
   * DELETE /api/services/mail/:id
   * Trash a mail message.
   */
  server.delete<{ Params: { id: string } }>(
    '/mail/:id',
    { schema: { params: idParamSchema } },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Trash mail message');
    },
  );

  // ── Calendar ──────────────────────────────────────────────────────────────

  /**
   * GET /api/services/calendar
   * List calendar events in a time range.
   *
   * Query params: accountId, start (ISO date), end (ISO date)
   *
   * Example response:
   *   [{ "id": "evt-xxx", "title": "Team standup", "start": "...", "end": "...", ... }]
   */
  server.get(
    '/calendar',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['start', 'end'],
          properties: {
            accountId: { type: 'string' },
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'List calendar events');
    },
  );

  /**
   * GET /api/services/calendar/:id
   * Get a single calendar event.
   */
  server.get<{ Params: { id: string } }>(
    '/calendar/:id',
    { schema: { params: idParamSchema } },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Get calendar event');
    },
  );

  /**
   * POST /api/services/calendar
   * Create a new calendar event.
   *
   * Body: { accountId?, title, description?, start, end, attendees?, location?, timeZone? }
   */
  server.post(
    '/calendar',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'start', 'end'],
          properties: {
            accountId: { type: 'string' },
            title: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
            isAllDay: { type: 'boolean', default: false },
            location: { type: 'string' },
            attendees: {
              type: 'array',
              items: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string' },
                },
              },
            },
            timeZone: { type: 'string' },
            recurrence: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'Create calendar event');
    },
  );

  /**
   * PUT /api/services/calendar/:id
   * Update a calendar event.
   */
  server.put<{ Params: { id: string } }>(
    '/calendar/:id',
    {
      schema: {
        params: idParamSchema,
        body: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
            location: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Update calendar event');
    },
  );

  /**
   * DELETE /api/services/calendar/:id
   * Delete a calendar event.
   */
  server.delete<{ Params: { id: string } }>(
    '/calendar/:id',
    {
      schema: {
        params: idParamSchema,
        querystring: accountQuerySchema,
      },
    },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Delete calendar event');
    },
  );

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /**
   * GET /api/services/tasks/lists
   * List all task lists across connected accounts.
   */
  server.get(
    '/tasks/lists',
    { schema: { querystring: accountQuerySchema } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'List task lists');
    },
  );

  /**
   * GET /api/services/tasks
   * List tasks, optionally scoped to a task list.
   *
   * Query params: accountId, listId
   */
  server.get(
    '/tasks',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            listId: { type: 'string' },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'List tasks');
    },
  );

  /**
   * POST /api/services/tasks
   * Create a new task.
   *
   * Body: { accountId?, title, notes?, dueDate?, listId?, priority? }
   */
  server.post(
    '/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title'],
          properties: {
            accountId: { type: 'string' },
            title: { type: 'string', minLength: 1 },
            notes: { type: 'string' },
            dueDate: { type: 'string', format: 'date-time' },
            listId: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'Create task');
    },
  );

  /**
   * PUT /api/services/tasks/:id
   * Update a task.
   */
  server.put<{ Params: { id: string } }>(
    '/tasks/:id',
    {
      schema: {
        params: idParamSchema,
        body: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            title: { type: 'string' },
            notes: { type: 'string' },
            dueDate: { type: 'string', format: 'date-time' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Update task');
    },
  );

  /**
   * PATCH /api/services/tasks/:id/complete
   * Mark a task as complete.
   */
  server.patch<{ Params: { id: string } }>(
    '/tasks/:id/complete',
    { schema: { params: idParamSchema } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const token = await getDirectGoogleToken();
        if (!token) return reply.status(503).send({ error: 'Google not connected' });
        const url = `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${request.params.id}`;
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'completed' }),
        });
        if (!res.ok) return reply.status(res.status).send({ error: 'Failed to complete task' });
        return reply.status(200).send({ status: 'ok' });
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  /**
   * DELETE /api/services/tasks/:id
   * Delete a task.
   */
  server.delete<{ Params: { id: string } }>(
    '/tasks/:id',
    { schema: { params: idParamSchema } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const token = await getDirectGoogleToken();
        if (!token) return reply.status(503).send({ error: 'Google not connected' });
        const url = `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${request.params.id}`;
        const res = await fetch(url, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return reply.status(res.status).send({ error: 'Failed to delete task' });
        return reply.status(200).send({ status: 'ok' });
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // ── Files ─────────────────────────────────────────────────────────────────

  /**
   * GET /api/services/files
   * List or search files in connected drive accounts.
   *
   * Query params: accountId, query, mimeType, parentId, maxResults
   */
  server.get(
    '/files',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            query: { type: 'string' },
            mimeType: { type: 'string' },
            parentId: { type: 'string' },
            maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      notImplemented(reply, 'List files');
    },
  );

  /**
   * GET /api/services/files/:id
   * Get metadata for a single file.
   */
  server.get<{ Params: { id: string } }>(
    '/files/:id',
    { schema: { params: idParamSchema } },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Get file metadata');
    },
  );

  /**
   * DELETE /api/services/files/:id
   * Delete a file from the connected drive.
   */
  server.delete<{ Params: { id: string } }>(
    '/files/:id',
    {
      schema: {
        params: idParamSchema,
        querystring: accountQuerySchema,
      },
    },
    async (_request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      notImplemented(reply, 'Delete file');
    },
  );

  // ── Dashboard tile summaries ─────────────────────────────────────────────

  /**
   * GET /api/services/tiles
   * Returns summary data for all dashboard tiles in one call.
   */
  server.get('/tiles', async (_request: FastifyRequest, reply: FastifyReply) => {
    const tiles: Record<string, unknown> = {};

    // Make.com — org + active scenarios
    if (process.env.MAKE_API_KEY) {
      try {
        const makeRes = await fetch('https://us2.make.com/api/v2/scenarios?organizationId=4658230&pg_limit=200', {
          headers: { Authorization: `Token ${process.env.MAKE_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        });
        if (makeRes.ok) {
          const data = await makeRes.json() as { scenarios?: Array<{ isActive: boolean; name?: string }> };
          const scenarios = data.scenarios ?? [];
          const activeScenarios = scenarios.filter(s => s.isActive);
          tiles.make = {
            org: 'D Caine Solutions LLC',
            total: scenarios.length,
            active: activeScenarios.length,
            activeNames: activeScenarios.map(s => s.name).filter(Boolean),
          };
        }
      } catch { /* non-critical */ }
    }

    // Stripe — balance
    if (process.env.STRIPE_SECRET_KEY) {
      try {
        const stripeRes = await fetch('https://api.stripe.com/v1/balance', {
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
          signal: AbortSignal.timeout(5000),
        });
        if (stripeRes.ok) {
          const data = await stripeRes.json() as { available?: Array<{ amount: number; currency: string }> };
          const avail = data.available?.[0];
          tiles.stripe = {
            balance: avail ? (avail.amount / 100).toFixed(2) : '0.00',
            currency: avail?.currency ?? 'usd',
          };
        }
      } catch { /* non-critical */ }
    }

    // Notion — page count
    if (process.env.NOTION_API_KEY) {
      try {
        const notionRes = await fetch('https://api.notion.com/v1/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ page_size: 1 }),
          signal: AbortSignal.timeout(5000),
        });
        if (notionRes.ok) {
          const data = await notionRes.json() as { results?: unknown[]; has_more?: boolean };
          tiles.notion = {
            hasContent: (data.results?.length ?? 0) > 0,
          };
        }
      } catch { /* non-critical */ }
    }

    // Airtable — base count
    if (process.env.AIRTABLE_API_KEY) {
      try {
        const atRes = await fetch('https://api.airtable.com/v0/meta/bases', {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        });
        if (atRes.ok) {
          const data = await atRes.json() as { bases?: Array<{ id: string; name: string }> };
          tiles.airtable = {
            bases: (data.bases ?? []).length,
            baseNames: (data.bases ?? []).slice(0, 5).map(b => b.name),
          };
        }
      } catch { /* non-critical */ }
    }

    // Slack — channel count + recent messages
    if (process.env.SLACK_BOT_TOKEN) {
      try {
        const slackToken = process.env.SLACK_BOT_TOKEN;
        const chanRes = await fetch('https://slack.com/api/conversations.list?limit=50&exclude_archived=true', {
          headers: { Authorization: `Bearer ${slackToken}` },
          signal: AbortSignal.timeout(5000),
        });
        if (chanRes.ok) {
          const chanData = await chanRes.json() as { ok: boolean; channels?: Array<{ id: string; name: string }> };
          if (chanData.ok) {
            const channels = chanData.channels ?? [];
            const messages: Array<{ channel: string; user: string; text: string; ts: string }> = [];
            // Get latest message from first 3 channels
            for (const ch of channels.slice(0, 3)) {
              try {
                const histRes = await fetch(`https://slack.com/api/conversations.history?channel=${ch.id}&limit=1`, {
                  headers: { Authorization: `Bearer ${slackToken}` },
                  signal: AbortSignal.timeout(3000),
                });
                if (histRes.ok) {
                  const histData = await histRes.json() as { ok: boolean; messages?: Array<{ text: string; user?: string; ts: string }> };
                  if (histData.ok && histData.messages?.[0]) {
                    const m = histData.messages[0];
                    messages.push({ channel: `#${ch.name}`, user: m.user ?? 'bot', text: (m.text ?? '').slice(0, 100), ts: m.ts });
                  }
                }
              } catch { /* skip */ }
            }
            tiles.slack = { channels: channels.length, recentMessages: messages };
          }
        }
      } catch { /* non-critical */ }
    }

    // Telegram — paired user count
    try {
      const { getPool: getDbPool } = await import('../db.js');
      const pool = getDbPool();
      const { rows } = await pool.query('SELECT COUNT(*)::int as count FROM boss_telegram_pairs');
      tiles.telegram = { pairedUsers: rows[0]?.count ?? 0 };
    } catch { /* non-critical */ }

    // YouTube — recent uploads from followed channels
    const ytKey = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_TTS_API_KEY;
    if (ytKey) {
      try {
        // Get followed channels from config, or default set
        let channels: string[] = [];
        try {
          const { getPool: ytPool } = await import('../db.js');
          const { rows } = await ytPool().query<{ value: string }>(
            "SELECT value FROM runtime_config WHERE key = 'YOUTUBE_FOLLOWED_CHANNELS' AND tenant_id = 'default'",
          );
          if (rows.length > 0) channels = JSON.parse(rows[0].value);
        } catch { /* use empty */ }

        if (channels.length > 0) {
          // Fetch latest video from each channel (first 5 channels max)
          const videos: Array<{ title: string; channel: string; videoId: string; publishedAt: string; thumbnail: string }> = [];
          for (const channelQuery of channels.slice(0, 5)) {
            try {
              const searchRes = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(channelQuery)}&type=video&order=date&maxResults=1&key=${ytKey}`,
                { signal: AbortSignal.timeout(5000) },
              );
              if (searchRes.ok) {
                const data = await searchRes.json() as { items?: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string; publishedAt: string; thumbnails: { default: { url: string } } } }> };
                const item = data.items?.[0];
                if (item) {
                  videos.push({
                    title: item.snippet.title,
                    channel: item.snippet.channelTitle,
                    videoId: item.id.videoId,
                    publishedAt: item.snippet.publishedAt,
                    thumbnail: item.snippet.thumbnails.default.url,
                  });
                }
              }
            } catch { /* skip channel */ }
          }
          if (videos.length > 0) tiles.youtube = { videos };
        }
      } catch { /* non-critical */ }
    }

    return reply.status(200).send(tiles);
  });

  /**
   * GET /api/services/youtube/channels
   * Returns the list of followed YouTube channels.
   */
  server.get('/youtube/channels', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { getPool: gp } = await import('../db.js');
      const { rows } = await gp().query<{ value: string }>(
        "SELECT value FROM runtime_config WHERE key = 'YOUTUBE_FOLLOWED_CHANNELS' AND tenant_id = 'default'",
      );
      return reply.status(200).send({ channels: rows.length > 0 ? JSON.parse(rows[0].value) : [] });
    } catch {
      return reply.status(200).send({ channels: [] });
    }
  });

  /**
   * PUT /api/services/youtube/channels
   * Set the list of followed YouTube channels.
   * Pass channel names or search queries.
   */
  server.put<{ Body: { channels: string[] } }>(
    '/youtube/channels',
    {
      schema: {
        body: {
          type: 'object',
          required: ['channels'],
          properties: { channels: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { channels: string[] } }>, reply: FastifyReply) => {
      const { setRuntimeConfig: setRC } = await import('../config-store.js');
      await setRC('YOUTUBE_FOLLOWED_CHANNELS', JSON.stringify(request.body.channels), 'default');
      return reply.status(200).send({ status: 'ok', channels: request.body.channels });
    },
  );

  // ── Notifications ───────────────────────────────────────────────────────────

  /** GET /notifications — unread push notifications for the dashboard */
  server.get('/notifications', async (_request, reply) => {
    try {
      const { getPool: gp } = await import('../db.js');
      const pool = gp();
      const result = await pool.query(
        `SELECT id, title, body, priority, channel, created_at, read
         FROM boss_notifications
         WHERE read = false
         ORDER BY created_at DESC
         LIMIT 50`,
      );
      return reply.send(result.rows);
    } catch {
      return reply.send([]);
    }
  });

  /** PATCH /notifications/:id/read — mark notification as read */
  server.patch<{ Params: { id: string } }>('/notifications/:id/read', async (request, reply) => {
    try {
      const { getPool: gp } = await import('../db.js');
      const pool = gp();
      await pool.query('UPDATE boss_notifications SET read = true WHERE id = $1', [request.params.id]);
      return reply.send({ ok: true });
    } catch {
      return reply.status(500).send({ error: 'Failed to mark read' });
    }
  });

  /** POST /notifications/read-all — mark all as read */
  server.post('/notifications/read-all', async (_request, reply) => {
    try {
      const { getPool: gp } = await import('../db.js');
      const pool = gp();
      await pool.query('UPDATE boss_notifications SET read = true WHERE read = false');
      return reply.send({ ok: true });
    } catch {
      return reply.status(500).send({ error: 'Failed to mark all read' });
    }
  });
}
