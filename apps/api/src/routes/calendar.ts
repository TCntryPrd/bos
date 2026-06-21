/**
 * Calendar routes — /api/calendar/*
 *
 * Aggregated Google Calendar events across all connected accounts.
 *
 *   GET /api/calendar/events    — Fetch events from connected Google accounts
 *   GET /api/calendar/accounts  — List connected accounts with their calendars
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import crypto from 'node:crypto';

// ── Token helpers (same pattern as sheets.ts / email-agent.ts) ───────────────

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

// ── Types ────────────────────────────────────────────────────────────────────

interface GoogleTokenRow {
  account_id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

interface GoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  htmlLink?: string;
  colorId?: string;
  status?: string;
}

interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  account: string;
  calendarName: string;
  calendarId: string;
  htmlLink: string | null;
  colorId: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function _getAllGoogleAccounts(): Promise<Array<{
  accountId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}>> {
  const pool = getPool();
  const result = await pool.query<GoogleTokenRow>(
    `SELECT account_id, email, access_token, refresh_token, expires_at
       FROM boss_oauth_tokens
      WHERE provider = 'google' AND email != ''`,
  );
  return result.rows.map((row) => ({
    accountId: row.account_id,
    email: row.email,
    accessToken: _decryptToken(row.access_token),
    refreshToken: _decryptToken(row.refresh_token),
  }));
}

async function _refreshGoogleToken(accountId: string, refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
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
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const newAccessToken = data.access_token;
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);
  const pool = getPool();
  await pool.query(
    `UPDATE boss_oauth_tokens SET access_token = $1, expires_at = $2, updated_at = now() WHERE account_id = $3`,
    [_encryptToken(newAccessToken), expiresAt.toISOString(), accountId],
  );
  return newAccessToken;
}

async function _googleFetch(
  url: string,
  account: { accountId: string; accessToken: string; refreshToken: string },
): Promise<Response> {
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
  if (res.status === 401) {
    account.accessToken = await _refreshGoogleToken(account.accountId, account.refreshToken);
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
  }
  return res;
}

async function _getCalendarsForAccount(
  account: { accountId: string; email: string; accessToken: string; refreshToken: string },
): Promise<GoogleCalendar[]> {
  const res = await _googleFetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    account,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: GoogleCalendar[] };
  return data.items ?? [];
}

async function _getEventsForCalendar(
  account: { accountId: string; email: string; accessToken: string; refreshToken: string },
  calendarId: string,
  calendarName: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const res = await _googleFetch(url, account);
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: GoogleEvent[] };
  return (data.items ?? [])
    .filter((e) => e.status !== 'cancelled')
    .map((e) => ({
      id: e.id ?? '',
      summary: e.summary ?? '(No title)',
      description: e.description ?? null,
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      allDay: !e.start?.dateTime,
      location: e.location ?? null,
      account: account.email,
      calendarName,
      calendarId,
      htmlLink: e.htmlLink ?? null,
      colorId: e.colorId ?? null,
    }));
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function calendarRoutes(server: FastifyInstance) {
  /**
   * GET /api/calendar/events
   * Fetch events from all connected Google accounts in a time range.
   *
   * Query params:
   *   start    — ISO date/datetime for range start (required)
   *   end      — ISO date/datetime for range end (required)
   *   accounts — comma-separated emails to filter (optional, default all)
   */
  server.get<{
    Querystring: { start: string; end: string; accounts?: string };
  }>(
    '/events',
    {
      config: { skipAuth: true },
      schema: {
        querystring: {
          type: 'object',
          required: ['start', 'end'],
          properties: {
            start: { type: 'string', minLength: 1 },
            end: { type: 'string', minLength: 1 },
            accounts: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { start: string; end: string; accounts?: string } }>,
      reply: FastifyReply,
    ) => {
      const { start, end, accounts: accountsFilter } = request.query;

      let allAccounts: Awaited<ReturnType<typeof _getAllGoogleAccounts>>;
      try {
        allAccounts = await _getAllGoogleAccounts();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: 'Failed to load Google accounts', message: msg });
      }

      if (allAccounts.length === 0) {
        return reply.status(200).send({ events: [], accounts: [] });
      }

      // Filter to specific accounts if requested
      if (accountsFilter) {
        const filterSet = new Set(accountsFilter.split(',').map((e) => e.trim().toLowerCase()));
        allAccounts = allAccounts.filter((a) => filterSet.has(a.email.toLowerCase()));
      }

      // Ensure ISO format with timezone
      const timeMin = start.includes('T') ? start : `${start}T00:00:00Z`;
      const timeMax = end.includes('T') ? end : `${end}T23:59:59Z`;

      const allEvents: CalendarEvent[] = [];
      const accountEmails: string[] = [];

      // Fetch events for each account in parallel
      const results = await Promise.allSettled(
        allAccounts.map(async (account) => {
          accountEmails.push(account.email);
          const calendars = await _getCalendarsForAccount(account);
          const calendarEvents = await Promise.allSettled(
            calendars.map((cal) =>
              _getEventsForCalendar(account, cal.id, cal.summary ?? cal.id, timeMin, timeMax),
            ),
          );
          for (const result of calendarEvents) {
            if (result.status === 'fulfilled') {
              allEvents.push(...result.value);
            }
          }
        }),
      );

      // Log any account-level failures
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const reason = (results[i] as PromiseRejectedResult).reason;
          request.log.warn({ email: allAccounts[i]?.email, error: String(reason) }, 'calendar: failed to fetch events for account');
        }
      }

      // Dedupe the SAME event appearing across many calendars/accounts (a shared
      // meeting on 15 calendars should show once, not 15×). Key on summary+start+end;
      // keep the first copy (preserves an account/calendar attribution).
      const seenKeys = new Set<string>();
      const dedupedEvents = allEvents.filter((e) => {
        const key = `${(e.summary || '').trim().toLowerCase()}|${e.start}|${e.end}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      // Sort by start time
      dedupedEvents.sort((a, b) => {
        const aTime = new Date(a.start).getTime();
        const bTime = new Date(b.start).getTime();
        return aTime - bTime;
      });

      return reply.status(200).send({
        events: dedupedEvents,
        accounts: accountEmails,
      });
    },
  );

  /**
   * GET /api/calendar/accounts
   * List connected Google accounts with their calendar lists.
   */
  server.get('/accounts', { config: { skipAuth: true } }, async (request, reply) => {
    let allAccounts: Awaited<ReturnType<typeof _getAllGoogleAccounts>>;
    try {
      allAccounts = await _getAllGoogleAccounts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(503).send({ error: 'Failed to load Google accounts', message: msg });
    }

    const accountList = await Promise.allSettled(
      allAccounts.map(async (account) => {
        const calendars = await _getCalendarsForAccount(account);
        return {
          email: account.email,
          calendars: calendars.map((c) => ({
            id: c.id,
            summary: c.summary,
            primary: c.primary ?? false,
          })),
        };
      }),
    );

    const results = accountList
      .filter((r): r is PromiseFulfilledResult<{ email: string; calendars: { id: string; summary: string; primary: boolean }[] }> => r.status === 'fulfilled')
      .map((r) => r.value);

    return reply.status(200).send({ accounts: results });
  });
}
