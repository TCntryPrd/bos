/**
 * Tool executor — maps brain tool call names to Google Workspace API calls.
 *
 * Flow:
 *   1. Retrieve the OAuth token for the tenant from boss_oauth_tokens
 *   2. Call the Google REST API using the access token
 *   3. On 401, attempt a token refresh and retry once
 *   4. Return a human-readable formatted string
 *
 * All Google API calls use native fetch directly. The connectors package
 * classes are not used here because they require a GoogleClient abstraction
 * that is not yet wired to the token store at this layer. We call the same
 * Google REST endpoints the connectors use but with tokens retrieved directly
 * from Postgres.
 */

import crypto from 'node:crypto';
import { getPool } from '../db.js';
import { gateToolCall, recordExecuted, type ToolCtx } from './risk.js';
import { getRegistry, getUsageRollup } from '../lib/google-registry.js';
import { executeWeaviateTool } from './weaviate.js';
import { executeEraTool } from './era.js';
import { executeFinanceTool } from './finance.js';
import { executeCtoTool } from './cto.js';
import { executeCrmSnapshotTool } from './crm-snapshot.js';
import { executeCrmSync, executeCrmMetrics } from './crm-sync.js';
import { handleVoiceRouteAgent, handleVoiceListAgents, handleVoiceNavigate, handleUICommand } from './voice-agents.js';
import { handleTaskList, handleTaskCreate, handleTaskAdvance } from './pipeline.js';
import { handleBackupStatus } from './backup-status.js';
import { handleHostStatus } from './host-status.js';
import { handleSelfIdentity, handleSelfReflect, handleSelfGoals } from './self-identity.js';
import { handleHostApt, handleHostSystemctl, handleHostCron, handleAdminAuditLog } from './host-management.js';
import { handleHostFirewall, handleHostPorts, handleHostCerts, handleHostAuthlog, handleHostSshKeys, handleHostFail2ban } from './host-security.js';
import { handleTelemetryAlerts, handleSelfProposeFix, handleTelemetryHistory } from './telemetry.js';
import { handleTasksMove, handleTasksAdvance, handleTasksBlock } from './kanban-tools.js';
import { META_TOOL_HANDLERS } from './meta.js';
import { LINKEDIN_TOOL_HANDLERS } from './linkedin.js';
import { EMAIL_DRAFT_TOOL_HANDLERS } from './email-drafts.js';

// ── Result size limits ────────────────────────────────────────────────────────
// These prevent individual tool results or accumulated results from bloating
// the context window and degrading response quality.

export const MAX_TOOL_RESULT_CHARS = 50_000;       // per individual tool result
export const MAX_AGGREGATE_RESULT_CHARS = 150_000; // total across all tool calls in one turn

// ── Internal types ────────────────────────────────────────────────────────────

interface OAuthTokenRow {
  id: string;
  account_id: string;
  provider: string;
  email: string;
  access_token: string;   // encrypted
  refresh_token: string;  // encrypted
  expires_at: string;
  scopes: string[];
  created_at: string;
}

interface StoredToken {
  accountId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  connectedAt: Date;
}

// ── Encryption (mirrors token-store.ts — keep in sync) ────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.BOSS_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be set');
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}

function decryptToken(encryptedText: string): string {
  const key = getEncryptionKey();
  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  if (iv.length !== IV_LENGTH) throw new Error('Invalid IV length');
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error('Invalid auth tag length');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  let out = decipher.update(ciphertext, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

// ── Token retrieval ───────────────────────────────────────────────────────────

/**
 * Retrieve a Google OAuth token from the token store.
 *
 * If email is provided, the token for that specific account is returned.
 * If email is omitted, the most recently updated token is used (preserves
 * original single-account behaviour).
 *
 * Multi-account usage: pass google_account in tool args to target a specific
 * Google account (e.g. "kevin@starrpartners.ai" vs "d.caine@dcaine.com").
 */
async function getGoogleToken(email?: string): Promise<StoredToken> {
  const pool = getPool();

  const rows = email
    ? (await pool.query<OAuthTokenRow>(
        `SELECT * FROM boss_oauth_tokens WHERE provider = 'google' AND email = $1`,
        [email],
      )).rows
    : (await pool.query<OAuthTokenRow>(
        `SELECT * FROM boss_oauth_tokens WHERE provider = 'google' ORDER BY updated_at DESC LIMIT 1`,
      )).rows;

  if (rows.length === 0) {
    throw new Error(
      email
        ? `Google account "${email}" not connected. Connect it in Settings or use a different account.`
        : 'No Google account connected. Connect your Google account in Settings first.',
    );
  }

  const row = rows[0];
  // Log which account is being used so traces are clear in multi-account scenarios
  console.info(`[executor] Using Google account: ${row.email} (accountId: ${row.account_id})`);
  return {
    accountId: row.account_id,
    email: row.email,
    accessToken: decryptToken(row.access_token),
    refreshToken: decryptToken(row.refresh_token),
    expiresAt: new Date(row.expires_at),
    scopes: row.scopes,
    connectedAt: new Date(row.created_at),
  };
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Updates the encrypted access_token and expires_at in Postgres.
 */
async function refreshGoogleToken(token: StoredToken): Promise<StoredToken> {
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
      refresh_token: token.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const newAccessToken = data.access_token;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  // Persist the refreshed token back to Postgres
  const pool = getPool();
  await pool.query(
    `UPDATE boss_oauth_tokens
       SET access_token = $1, expires_at = $2, updated_at = now()
     WHERE account_id = $3`,
    [encryptToken(newAccessToken), expiresAt.toISOString(), token.accountId],
  );

  return { ...token, accessToken: newAccessToken, expiresAt };
}

// ── Authenticated fetch with auto-refresh ─────────────────────────────────────

interface AuthFetchOptions {
  method?: string;
  body?: unknown;
}

async function googleFetch(
  url: string,
  token: StoredToken,
  options: AuthFetchOptions = {},
): Promise<{ data: unknown; token: StoredToken }> {
  const doFetch = async (t: StoredToken) => {
    const fetchOpts: RequestInit = {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${t.accessToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (options.body !== undefined) {
      (fetchOpts as RequestInit & { body: string }).body = JSON.stringify(options.body);
    }
    return fetch(url, fetchOpts);
  };

  let res = await doFetch(token);

  // 401 = access token expired — refresh once and retry
  if (res.status === 401) {
    const refreshed = await refreshGoogleToken(token);
    res = await doFetch(refreshed);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google API error after token refresh (${res.status}): ${text}`);
    }
    const data = await res.json();
    return { data, token: refreshed };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { data, token };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(date: Date | string, opts?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    ...opts,
  });
}

function fmtDateOnly(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtTimeOnly(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Calendar handlers ─────────────────────────────────────────────────────────

async function handleCalendarToday(args: Record<string, unknown>): Promise<string> {
  const tz = (args.timezone as string | undefined) ?? 'UTC';
  const now = new Date();
  // Start of today in the requested timezone
  const startOfDay = new Date(now.toLocaleDateString('en-US', { timeZone: tz }));
  // End of today
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    new URLSearchParams({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });

  const { data } = await googleFetch(url, token);
  const events = (data as { items?: unknown[] }).items ?? [];

  if (events.length === 0) {
    return `No events on your calendar today (${fmtDateOnly(now)}).`;
  }

  const lines: string[] = [`Today's calendar — ${fmtDateOnly(now)} (${events.length} event${events.length !== 1 ? 's' : ''}):\n`];

  for (const ev of events as Array<Record<string, unknown>>) {
    const start = (ev.start as Record<string, string>);
    const end = (ev.end as Record<string, string>);
    const startStr = start.dateTime ? fmtTimeOnly(start.dateTime) : 'All day';
    const endStr = start.dateTime ? fmtTimeOnly(end.dateTime!) : '';
    const timeRange = endStr ? `${startStr} – ${endStr}` : startStr;
    lines.push(`• ${ev.summary ?? '(No title)'} [${timeRange}]`);
    if (ev.location) lines.push(`  Location: ${ev.location}`);
    if (ev.description) {
      const desc = String(ev.description).slice(0, 120).replace(/\n/g, ' ');
      lines.push(`  Notes: ${desc}${String(ev.description).length > 120 ? '...' : ''}`);
    }
    const attendees = (ev.attendees as Array<{ email: string; displayName?: string; self?: boolean }> | undefined) ?? [];
    const others = attendees.filter((a) => !a.self);
    if (others.length > 0) {
      const names = others.slice(0, 5).map((a) => a.displayName ?? a.email).join(', ');
      lines.push(`  With: ${names}${others.length > 5 ? ` +${others.length - 5} more` : ''}`);
    }
  }

  return lines.join('\n');
}

async function handleCalendarUpcoming(args: Record<string, unknown>): Promise<string> {
  const tz = (args.timezone as string | undefined) ?? 'UTC';
  const days = Math.min(Math.max(Number(args.days ?? 7), 1), 30);
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '100',
    });

  const { data } = await googleFetch(url, token);
  const events = (data as { items?: unknown[] }).items ?? [];

  if (events.length === 0) {
    return `No upcoming events in the next ${days} day${days !== 1 ? 's' : ''}.`;
  }

  // Group by date
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const ev of events as Array<Record<string, unknown>>) {
    const start = (ev.start as Record<string, string>);
    const dateKey = start.dateTime
      ? new Date(start.dateTime).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', weekday: 'short' })
      : start.date ?? 'Unknown';
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey)!.push(ev as Record<string, unknown>);
  }

  const lines: string[] = [`Upcoming events — next ${days} days (${events.length} total):\n`];

  for (const [dateLabel, dayEvents] of grouped) {
    lines.push(`${dateLabel}:`);
    for (const ev of dayEvents) {
      const start = (ev.start as Record<string, string>);
      const end = (ev.end as Record<string, string>);
      const startStr = start.dateTime ? fmtTimeOnly(start.dateTime) : 'All day';
      const endStr = start.dateTime ? fmtTimeOnly(end.dateTime!) : '';
      const timeRange = endStr ? `${startStr} – ${endStr}` : startStr;
      lines.push(`  • ${ev.summary ?? '(No title)'} [${timeRange}]`);
      if (ev.location) lines.push(`    Location: ${ev.location}`);
    }
  }

  return lines.join('\n');
}

async function handleCalendarCreate(args: Record<string, unknown>): Promise<string> {
  const tz = (args.timezone as string | undefined) ?? 'UTC';
  const attendeeEmails = (args.attendees as string[] | undefined) ?? [];

  const body: Record<string, unknown> = {
    summary: args.title,
    description: args.description,
    location: args.location,
    start: { dateTime: args.start, timeZone: tz },
    end: { dateTime: args.end, timeZone: tz },
  };
  if (attendeeEmails.length > 0) {
    body.attendees = attendeeEmails.map((e) => ({ email: e }));
  }

  const token = await getGoogleToken(args.google_account as string | undefined);
  const { data } = await googleFetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    token,
    { method: 'POST', body },
  );

  const ev = data as Record<string, unknown>;
  const start = (ev.start as Record<string, string>);
  const end = (ev.end as Record<string, string>);
  const lines: string[] = [
    `Calendar event created successfully.`,
    `Title: ${ev.summary}`,
    `When: ${fmt(start.dateTime!)} – ${fmtTimeOnly(end.dateTime!)}`,
  ];
  if (ev.location) lines.push(`Location: ${ev.location}`);
  if (attendeeEmails.length > 0) lines.push(`Invited: ${attendeeEmails.join(', ')}`);
  if (ev.htmlLink) lines.push(`Link: ${ev.htmlLink}`);

  return lines.join('\n');
}

// ── Gmail handlers ────────────────────────────────────────────────────────────

interface GmailListItem { id: string }
interface GmailHeader { name: string; value: string }
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload: {
    headers: GmailHeader[];
    mimeType: string;
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: unknown[] }>;
  };
  internalDate: string;
}

function gmailHeader(msg: GmailMessage, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

async function fetchGmailMessage(token: StoredToken, id: string): Promise<GmailMessage> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
  const { data } = await googleFetch(url, token);
  return data as GmailMessage;
}

// Human labels per inbox so the model applies the right per-account rules + never
// conflates the 5 separate mailboxes.
const ACCOUNT_LABELS: Record<string, string> = {
  'kevin@starrpartners.ai': 'Starr & Partners (business)',
  'd.caine@dcaine.com': 'D. Caine Solutions (business)',
  'kevinstarr@industryrockstar.com': 'Industry Rockstar (CLIENT-FACING — caution)',
  'absoluterecoverybureau@gmail.com': 'ARB (personal)',
  'travelcraft.dc@gmail.com': 'TravelCraft (personal)',
};

/** List every connected Google account email (for multi-inbox aggregation). */
async function listGoogleAccountEmails(): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ email: string }>(
    `SELECT email FROM boss_oauth_tokens WHERE provider = 'google' AND email <> '' ORDER BY email`,
  );
  return rows.map((r) => r.email);
}

/** Fetch unread inbox messages for ONE account as formatted, account-tagged lines. */
async function fetchUnreadLinesForAccount(email: string, maxResults: number): Promise<{ lines: string[]; count: number }> {
  const token = await getGoogleToken(email);
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?` +
    new URLSearchParams({ q: 'is:unread in:inbox', maxResults: String(maxResults) });
  const { data: listData } = await googleFetch(listUrl, token);
  const messages = (listData as { messages?: GmailListItem[] }).messages ?? [];
  const lines: string[] = [];
  let count = 0;
  for (const { id } of messages) {
    try {
      const msg = await fetchGmailMessage(token, id);
      const from = gmailHeader(msg, 'From');
      const subject = gmailHeader(msg, 'Subject') || '(No subject)';
      const date = gmailHeader(msg, 'Date');
      const snippet = msg.snippet ? msg.snippet.slice(0, 120) : '';
      lines.push(`• Account: ${email}`);
      lines.push(`  ID: ${id}`);
      lines.push(`  From: ${from}`);
      lines.push(`  Subject: ${subject}`);
      if (date) lines.push(`  Date: ${date}`);
      if (snippet) lines.push(`  Preview: ${snippet}${msg.snippet && msg.snippet.length > 120 ? '...' : ''}`);
      lines.push(`  Thread: ${msg.threadId}`);
      lines.push('');
      count++;
    } catch {
      // Skip messages that fail to fetch individually
    }
  }
  return { lines, count };
}

async function handleGmailUnread(args: Record<string, unknown>): Promise<string> {
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 10), 1), 50);
  const acct = (args.google_account as string | undefined)?.trim() || undefined;

  // Single-account mode (account explicitly named).
  if (acct) {
    const { lines, count } = await fetchUnreadLinesForAccount(acct, maxResults);
    if (count === 0) return `No unread emails in the inbox for ${acct}.`;
    return [`Unread inbox emails for ${acct} — ${count} message${count !== 1 ? 's' : ''}:\n`, ...lines].join('\n').trim();
  }

  // No account → AGGREGATE across every connected inbox. This guarantees no inbox
  // is silently skipped: a weak model that calls this once still sees all mail.
  // Each message is tagged with its `Account:` — that account MUST be passed to
  // every follow-up call (read / mark_read / draft_reply / archive / quick_ack).
  const emails = await listGoogleAccountEmails();
  const perAccount = Math.min(maxResults, 10);
  const sections: string[] = [];
  let total = 0;
  for (const email of emails) {
    const label = ACCOUNT_LABELS[email] ? ` — ${ACCOUNT_LABELS[email]}` : '';
    try {
      const { lines, count } = await fetchUnreadLinesForAccount(email, perAccount);
      total += count;
      const header = `\n═══════════ INBOX: ${email}${label} · ${count} unread ═══════════`;
      sections.push(count > 0 ? `${header}\n${lines.join('\n')}` : `${header}\n  (none)`);
    } catch (err) {
      sections.push(`\n═══════════ INBOX: ${email}${label} · ERROR ═══════════\n  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (total === 0) return 'No unread emails in any connected inbox.';
  return [
    `Unread inbox mail across ${emails.length} SEPARATE inboxes — ${total} total.`,
    `IMPORTANT — these are ${emails.length} DIFFERENT email accounts, NOT one combined inbox. Each email below belongs to the inbox shown in its "═══ INBOX:" header (and its own "Account:" line). For every email you MUST: (1) classify it using THAT inbox's rules (business vs personal vs client-facing), and (2) pass THAT inbox's address as google_account on EVERY follow-up call (read / draft_reply / quick_ack / mark_read / archive). Using the wrong account fails or hits the wrong mailbox.`,
    ...sections,
  ].join('\n').trim();
}

async function handleGmailSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 10), 1), 50);

  const token = await getGoogleToken(args.google_account as string | undefined);
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?` +
    new URLSearchParams({ q: query, maxResults: String(maxResults) });

  const { data: listData } = await googleFetch(listUrl, token);
  const messages = (listData as { messages?: GmailListItem[] }).messages ?? [];

  if (messages.length === 0) {
    return `No emails found matching: "${query}"`;
  }

  const lines: string[] = [`Gmail search results for "${query}" — ${messages.length} message${messages.length !== 1 ? 's' : ''}:\n`];

  for (const { id } of messages) {
    try {
      const msg = await fetchGmailMessage(token, id);
      const from = gmailHeader(msg, 'From');
      const subject = gmailHeader(msg, 'Subject') || '(No subject)';
      const date = gmailHeader(msg, 'Date');
      const snippet = msg.snippet ? msg.snippet.slice(0, 120) : '';
      const isUnread = msg.labelIds?.includes('UNREAD') ? ' [UNREAD]' : '';
      lines.push(`• ID: ${id}${isUnread}`);
      lines.push(`  From: ${from}`);
      lines.push(`  Subject: ${subject}`);
      if (date) lines.push(`  Date: ${date}`);
      if (snippet) lines.push(`  Preview: ${snippet}${msg.snippet && msg.snippet.length > 120 ? '...' : ''}`);
      lines.push(`  Thread: ${msg.threadId}`);
      lines.push('');
    } catch {
      // Skip messages that fail individually
    }
  }

  return lines.join('\n').trim();
}

async function handleGmailSend(args: Record<string, unknown>): Promise<string> {
  const toList = (args.to as string[]).map((e) => e.trim()).filter(Boolean);
  const ccList = ((args.cc as string[] | undefined) ?? []).map((e) => e.trim()).filter(Boolean);
  const subject = String(args.subject ?? '');
  const body = String(args.body ?? '');

  const mimeLines: string[] = [];
  mimeLines.push(`To: ${toList.join(', ')}`);
  if (ccList.length > 0) mimeLines.push(`Cc: ${ccList.join(', ')}`);
  mimeLines.push(`Subject: ${subject}`);
  mimeLines.push('Content-Type: text/plain; charset="UTF-8"');
  mimeLines.push('');
  mimeLines.push(body);

  const raw = Buffer.from(mimeLines.join('\r\n')).toString('base64url');

  const token = await getGoogleToken(args.google_account as string | undefined);
  const { data } = await googleFetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    token,
    { method: 'POST', body: { raw } },
  );

  const sent = data as { id: string; threadId: string };
  const lines = [
    'Email sent successfully.',
    `To: ${toList.join(', ')}`,
    `Subject: ${subject}`,
    `Message ID: ${sent.id}`,
  ];
  if (ccList.length > 0) lines.splice(2, 0, `CC: ${ccList.join(', ')}`);

  return lines.join('\n');
}

// ── Gmail read/modify handlers ───────────────────────────────────────────────

function decodeGmailBody(payload: GmailMessage['payload']): string {
  // Try plain text body first
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  // Check parts for text/plain, then text/html
  if (payload.parts) {
    const plainPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plainPart?.body?.data) {
      return Buffer.from(plainPart.body.data, 'base64url').toString('utf-8');
    }
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      // Strip HTML tags for readable text
      return Buffer.from(htmlPart.body.data, 'base64url')
        .toString('utf-8')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return '(no readable body)';
}

async function fetchGmailMessageFull(token: StoredToken, id: string): Promise<GmailMessage> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const { data } = await googleFetch(url, token);
  return data as GmailMessage;
}

async function handleGmailRead(args: Record<string, unknown>): Promise<string> {
  const messageId = String(args.message_id ?? '');
  if (!messageId) return 'Error: message_id is required';

  const token = await getGoogleToken(args.google_account as string | undefined);
  const msg = await fetchGmailMessageFull(token, messageId);

  const from = gmailHeader(msg, 'From');
  const to = gmailHeader(msg, 'To');
  const subject = gmailHeader(msg, 'Subject') || '(No subject)';
  const date = gmailHeader(msg, 'Date');
  const cc = gmailHeader(msg, 'Cc');
  const body = decodeGmailBody(msg.payload);
  const labels = msg.labelIds?.join(', ') ?? 'none';

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Labels: ${labels}`,
    `Message ID: ${msg.id}`,
    `Thread ID: ${msg.threadId}`,
    '',
    body.slice(0, 15000), // Cap at 15K chars to stay within tool result limits
  ];

  return lines.join('\n');
}

async function handleGmailArchive(args: Record<string, unknown>): Promise<string> {
  const messageId = String(args.message_id ?? '');
  if (!messageId) return 'Error: message_id is required';

  const token = await getGoogleToken(args.google_account as string | undefined);
  await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    token,
    { method: 'POST', body: { removeLabelIds: ['INBOX'] } },
  );

  return `Archived message ${messageId} (removed from inbox)`;
}

async function handleGmailMarkRead(args: Record<string, unknown>): Promise<string> {
  const messageId = String(args.message_id ?? '');
  if (!messageId) return 'Error: message_id is required';

  const token = await getGoogleToken(args.google_account as string | undefined);
  await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    token,
    { method: 'POST', body: { removeLabelIds: ['UNREAD'] } },
  );

  return `Marked message ${messageId} as read`;
}

async function handleGmailLabel(args: Record<string, unknown>): Promise<string> {
  const messageId = String(args.message_id ?? '');
  const addLabels = (args.add_labels as string[] | undefined) ?? [];
  const removeLabels = (args.remove_labels as string[] | undefined) ?? [];
  if (!messageId) return 'Error: message_id is required';
  if (addLabels.length === 0 && removeLabels.length === 0) return 'Error: provide add_labels or remove_labels';

  const token = await getGoogleToken(args.google_account as string | undefined);
  const body: Record<string, string[]> = {};
  if (addLabels.length > 0) body.addLabelIds = addLabels;
  if (removeLabels.length > 0) body.removeLabelIds = removeLabels;

  await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    token,
    { method: 'POST', body },
  );

  const parts: string[] = [];
  if (addLabels.length > 0) parts.push(`Added: ${addLabels.join(', ')}`);
  if (removeLabels.length > 0) parts.push(`Removed: ${removeLabels.join(', ')}`);
  return `Labels updated on ${messageId}. ${parts.join('. ')}`;
}

async function handleGmailReply(args: Record<string, unknown>): Promise<string> {
  const messageId = String(args.message_id ?? '');
  const threadId = String(args.thread_id ?? '');
  const body = String(args.body ?? '');
  if (!messageId || !threadId || !body) return 'Error: message_id, thread_id, and body are required';

  const token = await getGoogleToken(args.google_account as string | undefined);

  // Fetch original to get reply headers
  const original = await fetchGmailMessageFull(token, messageId);
  const origFrom = gmailHeader(original, 'From');
  const origSubject = gmailHeader(original, 'Subject');
  const origMessageId = gmailHeader(original, 'Message-ID') || gmailHeader(original, 'Message-Id');

  const replySubject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

  const mimeLines: string[] = [
    `To: ${origFrom}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${origMessageId}`,
    `References: ${origMessageId}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ];

  const raw = Buffer.from(mimeLines.join('\r\n')).toString('base64url');
  const { data } = await googleFetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    token,
    { method: 'POST', body: { raw, threadId } },
  );

  const sent = data as { id: string };
  return `Reply sent to ${origFrom}. Subject: ${replySubject}. Message ID: ${sent.id}`;
}

// ── Gmail draft + quick-ack handlers (phased-autonomy surface) ────────────────
// Drafts NEVER send — they land in the account's Gmail Drafts for human review.
// quick-ack sends, but is length-capped so only brief acknowledgements go out
// autonomously. The hard gate is the per-agent tool grant: in phase 1 the email
// agent is granted draft + quick_ack but NOT boss_gmail_send / boss_gmail_reply.

const QUICK_ACK_MAX_CHARS = 600;
// Inboxes that must NEVER auto-send (client-facing). quick-ack is refused for
// these accounts — the agent must draft and leave the send to a human. This is
// a hard, code-level backstop to the agent-prompt rule.
const NO_AUTOSEND_DOMAINS = ['@industryrockstar.com'];

async function handleGmailDraft(args: Record<string, unknown>): Promise<string> {
  const toList = ((args.to as string[] | undefined) ?? []).map((e) => e.trim()).filter(Boolean);
  const ccList = ((args.cc as string[] | undefined) ?? []).map((e) => e.trim()).filter(Boolean);
  const subject = String(args.subject ?? '');
  const body = String(args.body ?? '');
  if (toList.length === 0) return 'Error: at least one "to" recipient is required';

  const mimeLines: string[] = [];
  mimeLines.push(`To: ${toList.join(', ')}`);
  if (ccList.length > 0) mimeLines.push(`Cc: ${ccList.join(', ')}`);
  mimeLines.push(`Subject: ${subject}`);
  mimeLines.push('Content-Type: text/plain; charset="UTF-8"');
  mimeLines.push('');
  mimeLines.push(body);
  const raw = Buffer.from(mimeLines.join('\r\n')).toString('base64url');

  const token = await getGoogleToken(args.google_account as string | undefined);
  const { data } = await googleFetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    token,
    { method: 'POST', body: { message: { raw } } },
  );
  const draft = data as { id: string };
  return `Draft created in ${token.email} Drafts (NOT sent). Draft ID: ${draft.id}. To: ${toList.join(', ')}. Subject: ${subject}`;
}

async function handleGmailDraftReply(args: Record<string, unknown>): Promise<string> {
  const messageId = String(args.message_id ?? '');
  const threadId = String(args.thread_id ?? '');
  const body = String(args.body ?? '');
  if (!messageId || !threadId || !body) return 'Error: message_id, thread_id, and body are required';

  const token = await getGoogleToken(args.google_account as string | undefined);
  const original = await fetchGmailMessageFull(token, messageId);
  const origFrom = gmailHeader(original, 'From');
  const origSubject = gmailHeader(original, 'Subject');
  const origMessageId = gmailHeader(original, 'Message-ID') || gmailHeader(original, 'Message-Id');
  const replySubject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

  const mimeLines: string[] = [
    `To: ${origFrom}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${origMessageId}`,
    `References: ${origMessageId}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ];
  const raw = Buffer.from(mimeLines.join('\r\n')).toString('base64url');
  const { data } = await googleFetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    token,
    { method: 'POST', body: { message: { raw, threadId } } },
  );
  const draft = data as { id: string };
  return `Draft reply created in ${token.email} Drafts (NOT sent) to ${origFrom}. Draft ID: ${draft.id}. Subject: ${replySubject}`;
}

async function handleGmailQuickAck(args: Record<string, unknown>): Promise<string> {
  const body = String(args.body ?? '');
  if (body.length > QUICK_ACK_MAX_CHARS) {
    return `Refused: quick-ack body is ${body.length} chars (max ${QUICK_ACK_MAX_CHARS}). ` +
      `Quick acknowledgements must be brief — draft a full reply with boss_gmail_draft_reply instead.`;
  }
  // Hard block: never auto-send from a client-facing inbox, regardless of prompt.
  const token = await getGoogleToken(args.google_account as string | undefined);
  const acct = (token.email || '').toLowerCase();
  if (NO_AUTOSEND_DOMAINS.some((d) => acct.endsWith(d))) {
    return `Refused: ${token.email} is a client-facing inbox — auto-send is disabled. ` +
      `Draft with boss_gmail_draft_reply and leave the send to Kevin.`;
  }
  const result = await handleGmailReply(args);
  return `[QUICK-ACK AUTO-SENT] ${result}`;
}

// ── Tasks handlers ────────────────────────────────────────────────────────────

interface GTask {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: string;
  completed?: string;
}

async function handleTasksPending(args: Record<string, unknown>): Promise<string> {
  const listId = (args.list_id as string | undefined) ?? '@default';

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks?` +
    new URLSearchParams({ showCompleted: 'false', showHidden: 'false' });

  const { data } = await googleFetch(url, token);
  const tasks = (data as { items?: GTask[] }).items ?? [];

  if (tasks.length === 0) {
    return 'No pending tasks.';
  }

  const lines: string[] = [`Pending tasks — ${tasks.length} item${tasks.length !== 1 ? 's' : ''}:\n`];

  for (const task of tasks) {
    lines.push(`• ${task.title}`);
    if (task.notes) {
      const notes = task.notes.slice(0, 100).replace(/\n/g, ' ');
      lines.push(`  Notes: ${notes}${task.notes.length > 100 ? '...' : ''}`);
    }
    if (task.due) {
      lines.push(`  Due: ${fmtDateOnly(task.due)}`);
    }
    lines.push(`  ID: ${task.id}`);
  }

  return lines.join('\n');
}

async function handleTasksCreate(args: Record<string, unknown>): Promise<string> {
  const listId = (args.list_id as string | undefined) ?? '@default';
  const body: Record<string, unknown> = { title: args.title };
  if (args.notes) body.notes = args.notes;
  if (args.due_date) body.due = new Date(String(args.due_date)).toISOString();

  const token = await getGoogleToken(args.google_account as string | undefined);
  const { data } = await googleFetch(
    `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`,
    token,
    { method: 'POST', body },
  );

  const task = data as GTask;
  const lines = [
    'Task created successfully.',
    `Title: ${task.title}`,
    `ID: ${task.id}`,
  ];
  if (task.notes) lines.push(`Notes: ${task.notes}`);
  if (task.due) lines.push(`Due: ${fmtDateOnly(task.due)}`);

  return lines.join('\n');
}

async function handleTasksComplete(args: Record<string, unknown>): Promise<string> {
  const taskId = String(args.task_id ?? '');
  const listId = (args.list_id as string | undefined) ?? '@default';

  if (!taskId) throw new Error('task_id is required to complete a task');

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${taskId}`;

  const { data } = await googleFetch(url, token, {
    method: 'PATCH',
    body: { status: 'completed' },
  });

  const task = data as GTask;
  return `Task "${task.title}" marked as complete.`;
}

async function handleTasksDelete(args: Record<string, unknown>): Promise<string> {
  const taskId = String(args.task_id ?? '');
  const listId = (args.list_id as string | undefined) ?? '@default';

  if (!taskId) throw new Error('task_id is required to delete a task');

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${taskId}`;

  await googleFetch(url, token, { method: 'DELETE' });
  return `Task ${taskId} deleted.`;
}

// ── Drive handlers ────────────────────────────────────────────────────────────

interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

const DRIVE_FIELDS = 'files(id,name,mimeType,size,modifiedTime,webViewLink)';

function fmtMimeType(mime: string): string {
  const map: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.folder': 'Folder',
    'application/pdf': 'PDF',
    'image/jpeg': 'JPEG Image',
    'image/png': 'PNG Image',
    'text/plain': 'Text File',
  };
  return map[mime] ?? mime.split('/').pop() ?? mime;
}

/**
 * List files in a Drive folder modified after `sinceIso` (RFC3339), newest first.
 * Used by the scheduler to gate trigger-driven agents (e.g. the transcript watcher)
 * so the costly brain only wakes when there is genuinely new work in the folder.
 */
export async function hasNewDriveFiles(
  folderId: string,
  sinceIso: string | null,
  account?: string,
): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
  const token = await getGoogleToken(account);
  const clauses = [`'${folderId}' in parents`, 'trashed = false'];
  if (sinceIso) clauses.push(`modifiedTime > '${sinceIso}'`);
  const url = `https://www.googleapis.com/drive/v3/files?` +
    new URLSearchParams({
      q: clauses.join(' and '),
      fields: 'files(id,name,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '25',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
  const { data } = await googleFetch(url, token);
  return (data as { files?: Array<{ id: string; name: string; modifiedTime: string }> }).files ?? [];
}

/** Create a Google Doc (title + text content) in an optional folder, via OAuth drive scope. */
async function handleDriveCreateDoc(args: Record<string, unknown>): Promise<string> {
  const title = String(args.title ?? '').trim();
  const content = String(args.content ?? '');
  const folderId = args.folder_id ? String(args.folder_id) : undefined;
  if (!title) return 'Error: title is required';
  if (!content) return 'Error: content is required';

  const token = await getGoogleToken(args.google_account as string | undefined);
  const metadata: Record<string, unknown> = { name: title, mimeType: 'application/vnd.google-apps.document' };
  if (folderId) metadata.parents = [folderId];

  // Multipart upload: JSON metadata + text/plain body → Google converts to a Doc.
  const boundary = 'bosdoc' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!res.ok) {
    const t = await res.text();
    return `Error creating Google Doc: ${res.status} ${t.slice(0, 200)}`;
  }
  const d = (await res.json()) as { id?: string; name?: string; webViewLink?: string };
  return `Created Google Doc "${d.name}" (id: ${d.id})${d.webViewLink ? ` — ${d.webViewLink}` : ''}`;
}

async function handleGoogleRegistry(): Promise<string> {
  const rows = await getRegistry();
  const lines = ['Google API registry (auth · cost · which key):'];
  for (const r of rows) {
    const cred = r.auth_type === 'api_key' ? ` [${r.credential}${r.project_id ? `, project ${r.project_id}` : ''}]` : '';
    lines.push(`• ${r.api}: ${r.auth_type}${cred} — ${r.cost_model}${r.enabled ? '' : ' (DISABLED)'}${r.notes ? ` — ${r.notes}` : ''}`);
  }
  return lines.join('\n');
}

async function handleGoogleUsage(): Promise<string> {
  const u = await getUsageRollup();
  const fmt = (arr: { api: string; units: number; cost: number }[]) =>
    arr.length ? arr.map((x) => `  ${x.api}: ${x.units} call(s), $${x.cost.toFixed(4)}`).join('\n') : '  (none)';
  return `Google API usage:\nToday:\n${fmt(u.today)}\nLast 30 days (est total $${u.total30.toFixed(4)}):\n${fmt(u.last30)}`;
}

async function handleDriveSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 10), 1), 50);

  const escaped = query.replace(/'/g, "\\'");
  const q = `trashed = false and fullText contains '${escaped}'`;

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://www.googleapis.com/drive/v3/files?` +
    new URLSearchParams({
      q,
      fields: DRIVE_FIELDS,
      pageSize: String(maxResults),
      orderBy: 'modifiedTime desc',
    });

  const { data } = await googleFetch(url, token);
  const files = (data as { files?: GDriveFile[] }).files ?? [];

  if (files.length === 0) {
    return `No files found in Drive matching: "${query}"`;
  }

  const lines: string[] = [`Drive search results for "${query}" — ${files.length} file${files.length !== 1 ? 's' : ''}:\n`];

  for (const file of files) {
    lines.push(`• ${file.name} [${fmtMimeType(file.mimeType)}]`);
    if (file.modifiedTime) lines.push(`  Last modified: ${fmt(file.modifiedTime)}`);
    if (file.webViewLink) lines.push(`  Link: ${file.webViewLink}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleDriveRecent(args: Record<string, unknown>): Promise<string> {
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 10), 1), 25);

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://www.googleapis.com/drive/v3/files?` +
    new URLSearchParams({
      q: 'trashed = false',
      fields: DRIVE_FIELDS,
      pageSize: String(maxResults),
      orderBy: 'modifiedTime desc',
    });

  const { data } = await googleFetch(url, token);
  const files = (data as { files?: GDriveFile[] }).files ?? [];

  if (files.length === 0) {
    return 'No files found in Google Drive.';
  }

  const lines: string[] = [`Recently modified Drive files — ${files.length} item${files.length !== 1 ? 's' : ''}:\n`];

  for (const file of files) {
    lines.push(`• ${file.name} [${fmtMimeType(file.mimeType)}]`);
    if (file.modifiedTime) lines.push(`  Last modified: ${fmt(file.modifiedTime)}`);
    if (file.webViewLink) lines.push(`  Link: ${file.webViewLink}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── Drive Read Doc handler ───────────────────────────────────────────────────

async function handleDriveReadDoc(args: Record<string, unknown>): Promise<string> {
  let fileId = String(args.file_id ?? '');
  // Extract ID from full URL if needed
  const urlMatch = fileId.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) fileId = urlMatch[1];
  if (!fileId) return 'Error: file_id is required';

  const token = await getGoogleToken(args.google_account as string | undefined);

  // Use Google Docs API to export as plain text
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}`,
    { headers: { Authorization: `Bearer ${token.accessToken}` } },
  );

  if (!res.ok) {
    // Fallback: try Drive export API for non-Docs files
    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token.accessToken}` } },
    );
    if (!exportRes.ok) {
      return `Error reading document: ${res.status} ${res.statusText}. The file may not be a Google Doc or you may lack permission.`;
    }
    const text = await exportRes.text();
    return text.length > 150000 ? text.substring(0, 150000) + '\n\n[... truncated — document exceeds 150,000 characters]' : text;
  }

  // Parse the Google Docs JSON to extract text
  const doc = await res.json() as {
    title?: string;
    body?: {
      content?: Array<{
        paragraph?: {
          elements?: Array<{
            textRun?: { content?: string };
          }>;
        };
      }>;
    };
  };

  const lines: string[] = [];
  if (doc.title) lines.push(`# ${doc.title}\n`);

  for (const block of doc.body?.content ?? []) {
    if (block.paragraph?.elements) {
      let paraText = '';
      for (const elem of block.paragraph.elements) {
        if (elem.textRun?.content) paraText += elem.textRun.content;
      }
      lines.push(paraText);
    }
  }

  let text = lines.join('').trim();
  if (text.length > 15000) {
    text = text.substring(0, 15000) + '\n\n[... truncated — document exceeds 15,000 characters]';
  }

  return text || 'Document is empty.';
}

// ── Contacts handler ──────────────────────────────────────────────────────────

interface GPerson {
  resourceName: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value: string; type?: string }>;
  phoneNumbers?: Array<{ value: string; type?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
}

async function handleContactsSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 5), 1), 25);

  const token = await getGoogleToken(args.google_account as string | undefined);
  const url = `https://people.googleapis.com/v1/people:searchContacts?` +
    new URLSearchParams({
      query,
      readMask: 'names,emailAddresses,phoneNumbers,organizations',
      pageSize: String(maxResults),
    });

  const { data } = await googleFetch(url, token);
  const results = (data as { results?: Array<{ person: GPerson }> }).results ?? [];

  if (results.length === 0) {
    return `No contacts found matching: "${query}"`;
  }

  const lines: string[] = [`Contacts matching "${query}" — ${results.length} result${results.length !== 1 ? 's' : ''}:\n`];

  for (const { person } of results) {
    const name = person.names?.[0]?.displayName ?? 'Unknown';
    lines.push(`• ${name}`);
    if (person.emailAddresses?.length) {
      lines.push(`  Email: ${person.emailAddresses.map((e) => e.value).join(', ')}`);
    }
    if (person.phoneNumbers?.length) {
      lines.push(`  Phone: ${person.phoneNumbers.map((p) => p.value).join(', ')}`);
    }
    if (person.organizations?.length) {
      const org = person.organizations[0];
      const orgStr = [org.title, org.name].filter(Boolean).join(' at ');
      if (orgStr) lines.push(`  Org: ${orgStr}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── n8n helpers ───────────────────────────────────────────────────────────────

/**
 * Base URL for n8n REST API.
 *
 * When running inside Docker, n8n on the host is reachable via
 * host.docker.internal. The env var N8N_BASE_URL can override this for
 * bare-metal or custom network setups.
 */
function n8nBaseUrl(): string {
  return (process.env.N8N_BASE_URL ?? 'http://127.0.0.1:7749').replace(/\/$/, '');
}

function n8nApiKey(): string {
  const key = process.env.N8N_API_KEY;
  if (!key) throw new Error('N8N_API_KEY is not set — cannot reach n8n.');
  return key;
}

async function n8nFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const url = `${n8nBaseUrl()}/api/v1${path}`;
  const fetchOpts: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      'X-N8N-API-KEY': n8nApiKey(),
      'Content-Type': 'application/json',
    },
  };
  if (options.body !== undefined) {
    (fetchOpts as RequestInit & { body: string }).body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(url, fetchOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot connect to n8n at ${n8nBaseUrl()} — ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`n8n API error (${res.status}): ${text}`);
  }

  return res.json();
}

// ── n8n type stubs ────────────────────────────────────────────────────────────

interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
  nodes?: Array<{ type: string; name: string }>;
  description?: string;
}

interface N8nExecution {
  id: string;
  workflowId?: string;
  // top-level status on newer n8n versions
  status?: string;
  // older n8n versions nest status under data.resultData
  data?: {
    resultData?: {
      error?: { message: string };
      runData?: Record<string, unknown>;
    };
  };
  startedAt?: string;
  stoppedAt?: string;
  // older field name for workflow label
  workflowData?: { name?: string };
  // newer response includes this when ?includeData=false
  workflowName?: string;
  finished?: boolean;
}

// ── n8n handlers ──────────────────────────────────────────────────────────────

async function handleN8nListWorkflows(args: Record<string, unknown>): Promise<string> {
  const activeOnly = args.active_only === true;

  const data = await n8nFetch('/workflows') as { data?: N8nWorkflow[] };
  let workflows: N8nWorkflow[] = data.data ?? [];

  if (activeOnly) {
    workflows = workflows.filter((w) => w.active);
  }

  if (workflows.length === 0) {
    return activeOnly
      ? 'No active workflows found in n8n.'
      : 'No workflows found in n8n.';
  }

  const label = activeOnly ? 'active ' : '';
  const lines: string[] = [
    `n8n workflows — ${workflows.length} ${label}workflow${workflows.length !== 1 ? 's' : ''}:\n`,
  ];

  for (const wf of workflows) {
    const status = wf.active ? 'active' : 'inactive';
    lines.push(`• [${wf.id}] ${wf.name} (${status})`);
    if (wf.updatedAt) {
      lines.push(`  Last updated: ${fmt(wf.updatedAt)}`);
    }
  }

  return lines.join('\n');
}

async function handleN8nGetWorkflow(args: Record<string, unknown>): Promise<string> {
  const workflowId = String(args.workflow_id ?? '').trim();
  if (!workflowId) throw new Error('workflow_id is required');

  const wf = await n8nFetch(`/workflows/${workflowId}`) as N8nWorkflow;

  const nodeCount = wf.nodes?.length ?? 0;
  const triggerNode = wf.nodes?.find((n) =>
    n.type.toLowerCase().includes('trigger') || n.type.toLowerCase().includes('webhook'),
  );

  const lines: string[] = [
    `Workflow: ${wf.name}`,
    `ID: ${wf.id}`,
    `Status: ${wf.active ? 'Active (enabled)' : 'Inactive (disabled)'}`,
    `Nodes: ${nodeCount}`,
  ];

  if (triggerNode) {
    lines.push(`Trigger: ${triggerNode.name} (${triggerNode.type})`);
  }

  if (wf.description) {
    lines.push(`Description: ${wf.description}`);
  }

  if (wf.createdAt) lines.push(`Created: ${fmt(wf.createdAt)}`);
  if (wf.updatedAt) lines.push(`Updated: ${fmt(wf.updatedAt)}`);

  return lines.join('\n');
}

async function handleN8nRunWorkflow(args: Record<string, unknown>): Promise<string> {
  const workflowId = String(args.workflow_id ?? '').trim();
  if (!workflowId) throw new Error('workflow_id is required');

  const payload = (args.payload as Record<string, unknown> | undefined) ?? {};

  // First verify the workflow exists and is active
  let wf: N8nWorkflow;
  try {
    wf = await n8nFetch(`/workflows/${workflowId}`) as N8nWorkflow;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not find workflow ${workflowId}: ${msg}`);
  }

  if (!wf.active) {
    throw new Error(
      `Workflow "${wf.name}" (ID: ${workflowId}) is inactive. Activate it in n8n before triggering.`,
    );
  }

  // Trigger via the execute endpoint. n8n v1 API supports POST /workflows/{id}/run
  // for manual/test executions. For webhook-triggered workflows the caller should
  // hit the webhook URL directly — we fall back gracefully below.
  let execData: unknown;
  try {
    execData = await n8nFetch(`/workflows/${workflowId}/run`, {
      method: 'POST',
      body: Object.keys(payload).length > 0 ? { data: payload } : {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The /run endpoint requires a manual trigger node. Surface a clear error.
    throw new Error(
      `Could not trigger workflow "${wf.name}" via API: ${msg}. ` +
      'Ensure the workflow has a manual trigger node, or trigger it via its webhook URL.',
    );
  }

  const exec = execData as { executionId?: string | number };
  const execId = exec.executionId ? String(exec.executionId) : 'unknown';

  const lines = [
    `Workflow "${wf.name}" triggered successfully.`,
    `Execution ID: ${execId}`,
    `Use boss_n8n_recent_executions to check the result.`,
  ];

  if (Object.keys(payload).length > 0) {
    lines.splice(1, 0, `Payload: ${JSON.stringify(payload)}`);
  }

  return lines.join('\n');
}

async function handleN8nRecentExecutions(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
  const workflowId = args.workflow_id ? String(args.workflow_id) : undefined;
  const statusFilter = args.status ? String(args.status) : undefined;

  const params = new URLSearchParams({ limit: String(limit) });
  if (workflowId) params.set('workflowId', workflowId);
  if (statusFilter) params.set('status', statusFilter);

  const data = await n8nFetch(`/executions?${params.toString()}`) as {
    data?: N8nExecution[];
    count?: number;
  };

  const executions: N8nExecution[] = data.data ?? [];

  if (executions.length === 0) {
    const qualifier = workflowId ? ` for workflow ${workflowId}` : '';
    return `No recent executions found${qualifier}.`;
  }

  const filterNote = workflowId ? ` for workflow ${workflowId}` : '';
  const lines: string[] = [
    `Recent n8n executions${filterNote} — ${executions.length} result${executions.length !== 1 ? 's' : ''}:\n`,
  ];

  for (const exec of executions) {
    // Resolve status across n8n API versions
    let status: string;
    if (exec.status) {
      status = exec.status;
    } else if (exec.finished === true) {
      status = exec.data?.resultData?.error ? 'error' : 'success';
    } else {
      status = 'running';
    }

    const statusIcon = status === 'success' ? 'OK' : status === 'error' ? 'ERR' : status.toUpperCase();
    const wfName =
      exec.workflowName ?? exec.workflowData?.name ?? exec.workflowId ?? 'Unknown workflow';

    lines.push(`• [${statusIcon}] Execution ${exec.id} — ${wfName}`);

    if (exec.startedAt) {
      lines.push(`  Started: ${fmt(exec.startedAt)}`);
    }

    if (exec.stoppedAt && exec.startedAt) {
      const durationMs = new Date(exec.stoppedAt).getTime() - new Date(exec.startedAt).getTime();
      const durationSec = (durationMs / 1000).toFixed(1);
      lines.push(`  Duration: ${durationSec}s`);
    }

    if (status === 'error' && exec.data?.resultData?.error?.message) {
      const errMsg = exec.data.resultData.error.message.slice(0, 120);
      lines.push(`  Error: ${errMsg}`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── n8n Delegation + Local File handlers ─────────────────────────────────────

async function handleN8nCreateWorkflow(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '');
  if (!name) return 'Error: name is required';

  const nodes = (args.nodes as unknown[]) ?? [];
  const connections = (args.connections as Record<string, unknown>) ?? {};

  const body = { name, nodes, connections, settings: {} };
  const data = await n8nFetch('/workflows', { method: 'POST', body }) as Record<string, unknown>;

  const id = data.id ?? (data as any).data?.id;
  const base = n8nBaseUrl();
  return `Workflow created.\nID: ${id}\nName: ${name}\nURL: ${base}/workflow/${id}\n\nUse boss_n8n_activate_workflow to enable it.`;
}

async function handleN8nUpdateWorkflow(args: Record<string, unknown>): Promise<string> {
  const id = String(args.workflow_id ?? '');
  if (!id) return 'Error: workflow_id is required';

  const name = String(args.name ?? '');
  const nodes = (args.nodes as unknown[]) ?? [];
  const connections = (args.connections as Record<string, unknown>) ?? {};

  // n8n requires PUT with the full workflow body — active is read-only, never include it
  const body = { name, nodes, connections, settings: {} };
  await n8nFetch(`/workflows/${id}`, { method: 'PUT', body });

  return `Workflow ${id} updated. Name: ${name}`;
}

async function handleN8nActivateWorkflow(args: Record<string, unknown>): Promise<string> {
  const id = String(args.workflow_id ?? '');
  if (!id) return 'Error: workflow_id is required';

  await n8nFetch(`/workflows/${id}/activate`, { method: 'POST' });
  return `Workflow ${id} activated.`;
}

async function handleN8nDeactivateWorkflow(args: Record<string, unknown>): Promise<string> {
  const id = String(args.workflow_id ?? '');
  if (!id) return 'Error: workflow_id is required';

  await n8nFetch(`/workflows/${id}/deactivate`, { method: 'POST' });
  return `Workflow ${id} deactivated.`;
}

// ── n8n Template Search — search BEFORE building from scratch ────────────────

async function handleN8nSearchTemplates(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const limit = Number(args.limit ?? 10);
  if (!query) return 'Error: query is required';

  try {
    const res = await fetch(`https://api.n8n.io/api/templates/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) return `Template API error: ${res.status}`;
    const data = await res.json() as { workflows: Array<{ id: number; name: string; description: string; totalViews: number; nodes: Array<{ type: string }> }> };

    if (!data.workflows || data.workflows.length === 0) {
      return `No templates found for "${query}". You may need to build this workflow from scratch.`;
    }

    const results = data.workflows.map((t: any) => {
      const nodes = (t.nodes || []).map((n: any) => n.type?.split('.').pop()).filter(Boolean).join(', ');
      return `ID: ${t.id} | ${t.name} | ${t.totalViews} views\n  Nodes: ${nodes}\n  ${(t.description || '').slice(0, 150)}`;
    }).join('\n\n');

    return `Found ${data.workflows.length} templates for "${query}":\n\n${results}\n\nUse boss_n8n_get_template with the ID to fetch the full workflow JSON for import/modification.`;
  } catch (err) {
    return `Template search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleN8nGetTemplate(args: Record<string, unknown>): Promise<string> {
  const templateId = Number(args.template_id);
  if (!templateId) return 'Error: template_id is required';

  try {
    const res = await fetch(`https://api.n8n.io/api/templates/workflows/${templateId}`);
    if (!res.ok) return `Template API error: ${res.status}`;
    const data = await res.json() as { workflow: { name: string; nodes: unknown[]; connections: unknown } };

    if (!data.workflow) return `Template ${templateId} not found`;

    const nodeCount = data.workflow.nodes?.length || 0;
    return `Template "${data.workflow.name}" (${nodeCount} nodes):\n\n${JSON.stringify(data.workflow, null, 2).slice(0, MAX_AGGREGATE_RESULT_CHARS)}\n\nModify this JSON as needed, then use boss_n8n_create_workflow to import it.`;
  } catch (err) {
    return `Template fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleN8nDelegate(args: Record<string, unknown>): Promise<string> {
  const jobType = String(args.job_type ?? '');

  if (jobType !== 'airtable_full_scan') {
    return `Unknown job_type: ${jobType}. Supported: airtable_full_scan`;
  }

  const apiKey = process.env.AIRTABLE_API_KEY ?? '';
  if (!apiKey) return 'AIRTABLE_API_KEY not configured.';

  // ── Step 1: List all bases ────────────────────────────────────────────────
  let bases: Array<{ id: string; name: string; permissionLevel: string }>;
  try {
    const basesData = await airtableFetch('/meta/bases') as {
      bases: Array<{ id: string; name: string; permissionLevel: string }>;
    };
    bases = basesData.bases ?? [];
  } catch (err) {
    return `Failed to list Airtable bases: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (bases.length === 0) {
    return 'No Airtable bases found. Check that your API key has access to at least one base.';
  }

  const report: string[] = [
    `# Airtable Full Scan`,
    ``,
    `**${bases.length}** base${bases.length !== 1 ? 's' : ''} found.`,
    ``,
  ];

  // ── Step 2: For each base, get tables and sample records ──────────────────
  for (const base of bases) {
    report.push(`---`);
    report.push(`## ${base.name}`);
    report.push(`Base ID: \`${base.id}\` | Access: ${base.permissionLevel}`);
    report.push(``);

    // Get tables for this base
    let tables: Array<{
      id: string;
      name: string;
      fields?: Array<{ id: string; name: string; type: string }>;
    }>;
    try {
      const tablesData = await airtableFetch(`/meta/bases/${base.id}/tables`) as {
        tables: Array<{
          id: string;
          name: string;
          fields?: Array<{ id: string; name: string; type: string }>;
        }>;
      };
      tables = tablesData.tables ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403')) {
        report.push(`**Access denied (403)** — API key lacks permission for this base.`);
      } else {
        report.push(`**Error fetching tables:** ${msg}`);
      }
      report.push(``);
      continue;
    }

    if (tables.length === 0) {
      report.push(`No tables found.`);
      report.push(``);
      continue;
    }

    report.push(`**${tables.length}** table${tables.length !== 1 ? 's' : ''}:`);
    report.push(``);

    for (const table of tables) {
      report.push(`### ${table.name}`);
      report.push(`Table ID: \`${table.id}\``);

      // Show field schema
      if (table.fields && table.fields.length > 0) {
        report.push(`Fields (${table.fields.length}):`);
        for (const field of table.fields) {
          report.push(`- **${field.name}** (${field.type})`);
        }
      }

      // Get sample records
      try {
        const encodedTable = encodeURIComponent(table.name);
        const recordsData = await airtableFetch(
          `/${base.id}/${encodedTable}?maxRecords=10`,
        ) as {
          records: Array<{ id: string; fields: Record<string, unknown> }>;
        };
        const records = recordsData.records ?? [];

        if (records.length === 0) {
          report.push(`*No records.*`);
        } else {
          report.push(`Sample records (${records.length}):`);
          for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            report.push(`${i + 1}. Record \`${rec.id}\``);
            for (const [key, value] of Object.entries(rec.fields)) {
              const display = Array.isArray(value)
                ? value.join(', ')
                : typeof value === 'object' && value !== null
                  ? JSON.stringify(value)
                  : String(value ?? '');
              if (display) report.push(`   - ${key}: ${display}`);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403')) {
          report.push(`*Access denied (403) for records.*`);
        } else {
          report.push(`*Error fetching records:* ${msg}`);
        }
      }
      report.push(``);
    }
  }

  const result = report.join('\n').trim();
  return result.length > 100000
    ? result.substring(0, 100000) + '\n\n[truncated]'
    : result;
}

async function handleReadLocalFile(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args.path ?? '');
  if (!filePath) return 'Error: path is required';

  // Security: only allow reading from /tmp/boss-jobs/
  if (!filePath.startsWith('/tmp/boss-jobs/')) {
    return 'Error: can only read files from /tmp/boss-jobs/ for security.';
  }

  try {
    const fs = await import('node:fs');
    const content = fs.readFileSync(filePath, 'utf-8');
    // If it's JSON, format it nicely
    try {
      const data = JSON.parse(content);
      return JSON.stringify(data, null, 2);
    } catch {
      return content;
    }
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Home Assistant helpers ────────────────────────────────────────────────────

/**
 * Resolve the Home Assistant base URL.
 *
 * - On the host: http://localhost:8123 (default)
 * - Inside Docker: http://host.docker.internal:8123
 * - HA_BASE_URL env var overrides both for flexible deployment.
 */
function getHaBaseUrl(): string {
  return (process.env.HA_BASE_URL ?? 'http://localhost:8123').replace(/\/$/, '');
}

function getHaToken(): string {
  const token = process.env.HA_ACCESS_TOKEN;
  if (!token) throw new Error('HA_ACCESS_TOKEN is not set. Add it to the environment to enable Home Assistant tools.');
  return token;
}

async function haFetch<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const url = `${getHaBaseUrl()}${path}`;
  const fetchOpts: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${getHaToken()}`,
      'Content-Type': 'application/json',
    },
  };
  if (options.body !== undefined) {
    (fetchOpts as RequestInit & { body: string }).body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(url, fetchOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot connect to Home Assistant at ${getHaBaseUrl()} — ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Home Assistant API error (${res.status}) at ${path}: ${text}`);
  }

  // Some HA service-call endpoints return an empty body on success
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

// ── Home Assistant state types ────────────────────────────────────────────────

interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

/** "light.living_room" -> "Living Room" */
function haEntityLabel(entity_id: string): string {
  const objectId = entity_id.includes('.') ? entity_id.split('.').slice(1).join('.') : entity_id;
  return objectId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "light.living_room" -> "light" */
function haEntityDomain(entity_id: string): string {
  return entity_id.split('.')[0] ?? entity_id;
}

/** Format a single HA state into a compact human-readable line. */
function haFormatState(s: HaState): string {
  const label = (s.attributes.friendly_name as string | undefined) ?? haEntityLabel(s.entity_id);
  const domain = haEntityDomain(s.entity_id);
  const stateUpper = s.state.toUpperCase();
  const parts: string[] = [`${label}: ${stateUpper}`];
  const a = s.attributes;

  if (domain === 'light' && s.state === 'on') {
    if (typeof a.brightness === 'number') parts.push(`brightness: ${Math.round((a.brightness / 255) * 100)}%`);
    if (typeof a.color_temp === 'number') parts.push(`color temp: ${a.color_temp}K`);
  }
  if (domain === 'climate') {
    if (typeof a.current_temperature === 'number') parts.push(`current: ${a.current_temperature}°`);
    if (typeof a.temperature === 'number') parts.push(`set: ${a.temperature}°`);
    if (typeof a.hvac_action === 'string') parts.push(`action: ${a.hvac_action}`);
  }
  if (domain === 'sensor' || domain === 'binary_sensor') {
    if (typeof a.unit_of_measurement === 'string') parts[0] = `${label}: ${s.state} ${a.unit_of_measurement}`;
    if (typeof a.device_class === 'string') parts.push(`type: ${a.device_class}`);
  }
  if (domain === 'media_player' && s.state === 'playing') {
    const title = a.media_title ?? a.media_content_id;
    if (title) parts.push(`playing: ${title}`);
    if (typeof a.volume_level === 'number') parts.push(`volume: ${Math.round((a.volume_level as number) * 100)}%`);
  }
  if (typeof a.battery_level === 'number') parts.push(`battery: ${a.battery_level}%`);

  return `  • ${parts[0]}${parts.length > 1 ? ` (${parts.slice(1).join(', ')})` : ''}`;
}

// ── Home Assistant handlers ───────────────────────────────────────────────────

async function handleHaListDevices(args: Record<string, unknown>): Promise<string> {
  const domainFilter = (args.domain as string | undefined)?.toLowerCase();
  const states = await haFetch<HaState[]>('/api/states');

  const filtered = domainFilter
    ? states.filter((s) => haEntityDomain(s.entity_id) === domainFilter)
    : states;

  if (filtered.length === 0) {
    return domainFilter
      ? `No entities found for domain "${domainFilter}".`
      : 'No entities found in Home Assistant.';
  }

  // Group by domain for readable output
  const grouped = new Map<string, HaState[]>();
  for (const s of filtered) {
    const d = haEntityDomain(s.entity_id);
    if (!grouped.has(d)) grouped.set(d, []);
    grouped.get(d)!.push(s);
  }

  const sortedDomains = [...grouped.keys()].sort();
  const header = domainFilter
    ? `Home Assistant — ${domainFilter} entities (${filtered.length} total):\n`
    : `Home Assistant — all entities (${filtered.length} total):\n`;

  const lines: string[] = [header];
  for (const domain of sortedDomains) {
    const entities = grouped.get(domain)!;
    lines.push(`${domain.charAt(0).toUpperCase() + domain.slice(1)} (${entities.length}):`);
    for (const s of entities) lines.push(haFormatState(s));
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleHaGetState(args: Record<string, unknown>): Promise<string> {
  const entityId = String(args.entity_id ?? '').trim();
  if (!entityId) throw new Error('entity_id is required');

  const s = await haFetch<HaState>(`/api/states/${entityId}`);
  const a = s.attributes;
  const domain = haEntityDomain(s.entity_id);
  const displayName = (a.friendly_name as string | undefined) ?? haEntityLabel(s.entity_id);

  const lines: string[] = [
    `${displayName} (${s.entity_id})`,
    `State: ${s.state.toUpperCase()}`,
  ];

  if (domain === 'light' && s.state === 'on') {
    if (typeof a.brightness === 'number') lines.push(`Brightness: ${Math.round((a.brightness / 255) * 100)}%`);
    if (typeof a.color_temp === 'number') lines.push(`Color Temperature: ${a.color_temp}K`);
    if (Array.isArray(a.rgb_color)) lines.push(`RGB Color: ${(a.rgb_color as number[]).join(', ')}`);
  }
  if (domain === 'climate') {
    if (typeof a.current_temperature === 'number') lines.push(`Current Temperature: ${a.current_temperature}°`);
    if (typeof a.temperature === 'number') lines.push(`Target Temperature: ${a.temperature}°`);
    if (typeof a.humidity === 'number') lines.push(`Humidity: ${a.humidity}%`);
    if (typeof a.hvac_mode === 'string') lines.push(`Mode: ${a.hvac_mode}`);
    if (typeof a.hvac_action === 'string') lines.push(`Action: ${a.hvac_action}`);
  }
  if (domain === 'sensor' || domain === 'binary_sensor') {
    if (typeof a.unit_of_measurement === 'string') lines[1] = `State: ${s.state} ${a.unit_of_measurement}`;
    if (typeof a.device_class === 'string') lines.push(`Device Class: ${a.device_class}`);
    if (typeof a.state_class === 'string') lines.push(`State Class: ${a.state_class}`);
  }
  if (domain === 'media_player') {
    if (typeof a.media_title === 'string') lines.push(`Now Playing: ${a.media_title}`);
    if (typeof a.media_artist === 'string') lines.push(`Artist: ${a.media_artist}`);
    if (typeof a.volume_level === 'number') lines.push(`Volume: ${Math.round((a.volume_level as number) * 100)}%`);
    if (typeof a.is_volume_muted === 'boolean') lines.push(`Muted: ${a.is_volume_muted ? 'Yes' : 'No'}`);
  }
  if (typeof a.battery_level === 'number') lines.push(`Battery: ${a.battery_level}%`);
  if (typeof a.battery === 'number') lines.push(`Battery: ${a.battery}%`);

  lines.push(`Last Changed: ${fmt(s.last_changed)}`);
  return lines.join('\n');
}

async function handleHaTurnOn(args: Record<string, unknown>): Promise<string> {
  const entityId = String(args.entity_id ?? '').trim();
  if (!entityId) throw new Error('entity_id is required');
  const domain = haEntityDomain(entityId);
  await haFetch(`/api/services/${domain}/turn_on`, { method: 'POST', body: { entity_id: entityId } });
  const label = (await haFetch<HaState>(`/api/states/${entityId}`)).attributes.friendly_name as string | undefined
    ?? haEntityLabel(entityId);
  return `${label} (${entityId}) turned ON.`;
}

async function handleHaTurnOff(args: Record<string, unknown>): Promise<string> {
  const entityId = String(args.entity_id ?? '').trim();
  if (!entityId) throw new Error('entity_id is required');
  const domain = haEntityDomain(entityId);
  await haFetch(`/api/services/${domain}/turn_off`, { method: 'POST', body: { entity_id: entityId } });
  const label = (await haFetch<HaState>(`/api/states/${entityId}`)).attributes.friendly_name as string | undefined
    ?? haEntityLabel(entityId);
  return `${label} (${entityId}) turned OFF.`;
}

async function handleHaSetBrightness(args: Record<string, unknown>): Promise<string> {
  const entityId = String(args.entity_id ?? '').trim();
  if (!entityId) throw new Error('entity_id is required');
  if (haEntityDomain(entityId) !== 'light') {
    throw new Error(`"${entityId}" is not a light entity. boss_ha_set_brightness only works with light.* entities.`);
  }
  const brightnessPct = Number(args.brightness_pct ?? 0);
  if (brightnessPct < 1 || brightnessPct > 100) throw new Error('brightness_pct must be between 1 and 100');

  await haFetch('/api/services/light/turn_on', {
    method: 'POST',
    body: { entity_id: entityId, brightness_pct: brightnessPct },
  });

  const label = (await haFetch<HaState>(`/api/states/${entityId}`)).attributes.friendly_name as string | undefined
    ?? haEntityLabel(entityId);
  return `${label} (${entityId}) brightness set to ${brightnessPct}%.`;
}

async function handleHaRunAutomation(args: Record<string, unknown>): Promise<string> {
  const entityId = String(args.entity_id ?? '').trim();
  if (!entityId) throw new Error('entity_id is required');
  if (haEntityDomain(entityId) !== 'automation') {
    throw new Error(`"${entityId}" is not an automation entity. boss_ha_run_automation only works with automation.* entities.`);
  }

  await haFetch('/api/services/automation/trigger', {
    method: 'POST',
    body: { entity_id: entityId },
  });

  const label = (await haFetch<HaState>(`/api/states/${entityId}`)).attributes.friendly_name as string | undefined
    ?? haEntityLabel(entityId);
  return `Automation "${label}" (${entityId}) triggered successfully.`;
}

// ── Slack helpers ─────────────────────────────────────────────────────────────

const SLACK_API = 'https://slack.com/api';

/**
 * Make an authenticated call to the Slack Web API.
 * All Slack API responses use HTTP 200 with an `ok` boolean field.
 * Throws on network errors or when `ok` is false.
 */
async function slackFetch(
  method: string,
  params: Record<string, string | number> = {},
): Promise<Record<string, unknown>> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN is not configured.');

  const url = `${SLACK_API}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    throw new Error(`Slack HTTP error (${res.status}) calling ${method}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  if (!data.ok) {
    const errCode = String(data.error ?? 'unknown_error');
    if (errCode === 'ratelimited') {
      throw new Error('Slack rate limit hit — please retry in a moment.');
    }
    throw new Error(`Slack API error on ${method}: ${errCode}`);
  }

  return data;
}

/** Resolve a channel name (#general) or raw ID to a channel ID. */
async function resolveSlackChannel(channel: string): Promise<string> {
  // Already looks like an ID (starts with C, G, D, or W)
  if (/^[CGDW][A-Z0-9]+$/.test(channel)) return channel;
  const name = channel.replace(/^#/, '').toLowerCase();
  const data = await slackFetch('conversations.list', { limit: 200, exclude_archived: 1 });
  const channels = (data.channels as Array<Record<string, unknown>>) ?? [];
  const match = channels.find((c) => (c.name as string)?.toLowerCase() === name);
  if (!match) throw new Error(`Slack channel "${channel}" not found or bot is not a member.`);
  return match.id as string;
}

function fmtSlackTs(ts: string): string {
  const ms = parseFloat(ts) * 1000;
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// ── Slack approved channel enforcement ────────────────────────────────────────

async function getApprovedSlackChannels(): Promise<string[] | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM runtime_config WHERE key = 'SLACK_APPROVED_CHANNELS' AND tenant_id = 'default'",
    );
    if (rows.length === 0) return null; // No restrictions — all channels allowed
    const parsed = JSON.parse(rows[0].value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // On error, allow all (fail-open for reads)
  }
}

async function checkSlackChannelApproved(channelId: string, channelName?: string): Promise<boolean> {
  const approved = await getApprovedSlackChannels();
  if (!approved) return true; // No list = all approved
  if (approved.length === 0) return true; // Empty list = all approved
  // Check by ID or by name (with or without #)
  return approved.some(a =>
    a === channelId ||
    a.toLowerCase() === (channelName ?? '').toLowerCase() ||
    a.toLowerCase() === `#${(channelName ?? '').toLowerCase()}` ||
    `#${a.toLowerCase()}` === `#${(channelName ?? '').toLowerCase()}`
  );
}

// ── Slack handlers ────────────────────────────────────────────────────────────

async function handleSlackListChannels(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
  const data = await slackFetch('conversations.list', { limit, exclude_archived: 1 });
  const channels = (data.channels as Array<Record<string, unknown>>) ?? [];

  if (channels.length === 0) {
    return 'The bot is not a member of any Slack channels.';
  }

  const lines: string[] = [`Slack channels (${channels.length}):\n`];
  for (const ch of channels) {
    const name = String(ch.name ?? '(unnamed)');
    const id = String(ch.id ?? '');
    const members = ch.num_members !== undefined ? ` — ${ch.num_members} members` : '';
    const topic = (ch.topic as Record<string, string> | undefined)?.value;
    lines.push(`• #${name} [${id}]${members}`);
    if (topic) lines.push(`  Topic: ${topic.slice(0, 120)}`);
  }

  return lines.join('\n');
}

async function handleSlackReadChannel(args: Record<string, unknown>): Promise<string> {
  const channelInput = String(args.channel ?? '');
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);

  if (!channelInput) throw new Error('channel is required');
  const channelId = await resolveSlackChannel(channelInput);

  if (!(await checkSlackChannelApproved(channelId, channelInput))) {
    return `Error: Channel "${channelInput}" is not in the approved channel list. Ask Kevin to add it via Settings.`;
  }

  const data = await slackFetch('conversations.history', { channel: channelId, limit });
  const messages = (data.messages as Array<Record<string, unknown>>) ?? [];

  if (messages.length === 0) {
    return `No messages found in channel ${channelInput}.`;
  }

  const lines: string[] = [`Recent messages from #${channelInput.replace(/^#/, '')} (${messages.length}):\n`];

  // Reverse so oldest-first reads naturally
  for (const msg of [...messages].reverse()) {
    const ts = fmtSlackTs(String(msg.ts ?? '0'));
    const user = msg.username
      ? String(msg.username)
      : msg.user
        ? `<@${msg.user}>`
        : 'bot';
    const rawText = String(msg.text ?? '');
    const text = rawText.slice(0, 300);
    lines.push(`[${ts}] ${user}: ${text}${rawText.length > 300 ? '...' : ''}`);
  }

  return lines.join('\n');
}

async function handleSlackSendMessage(args: Record<string, unknown>): Promise<string> {
  const channelInput = String(args.channel ?? '');
  const text = String(args.text ?? '');

  if (!channelInput) throw new Error('channel is required');
  if (!text) throw new Error('text is required');

  const channelId = await resolveSlackChannel(channelInput);

  if (!(await checkSlackChannelApproved(channelId, channelInput))) {
    return `Error: Channel "${channelInput}" is not in the approved channel list. Ask Kevin to add it via Settings.`;
  }
  const data = await slackFetch('chat.postMessage', { channel: channelId, text });

  const msgBlock = data.message as Record<string, unknown> | undefined;
  const ts = fmtSlackTs(String(msgBlock?.ts ?? data.ts ?? '0'));

  return [
    'Slack message sent.',
    `Channel: ${channelInput}`,
    `Text: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`,
    `Sent at: ${ts}`,
  ].join('\n');
}

async function handleSlackSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const count = Math.min(Math.max(Number(args.count ?? 20), 1), 100);

  if (!query) throw new Error('query is required');

  const data = await slackFetch('search.messages', { query, count, highlight: 0 });
  const msgBlock = data.messages as Record<string, unknown> | undefined;
  const matches = (msgBlock?.matches as Array<Record<string, unknown>>) ?? [];

  if (matches.length === 0) {
    return `No Slack messages found matching: "${query}"`;
  }

  const lines: string[] = [`Slack search results for "${query}" — ${matches.length} match${matches.length !== 1 ? 'es' : ''}:\n`];

  for (const msg of matches) {
    const ts = fmtSlackTs(String(msg.ts ?? '0'));
    const user = (msg.username as string | undefined) ?? String(msg.user ?? 'unknown');
    const chBlock = msg.channel as Record<string, unknown> | undefined;
    const channel = chBlock?.name ? `#${chBlock.name}` : String(chBlock?.id ?? 'unknown');
    const rawText = String(msg.text ?? '');
    const text = rawText.replace(/<[^>]+>/g, '').slice(0, 300);
    lines.push(`• [${ts}] ${user} in ${channel}`);
    lines.push(`  ${text}${rawText.length > 300 ? '...' : ''}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function telegramFetch(
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');

  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (res.status === 429) {
    const body = (await res.json()) as Record<string, unknown>;
    const retryAfter = (body.parameters as Record<string, number> | undefined)?.retry_after ?? 30;
    throw new Error(`Telegram rate limit hit — retry after ${retryAfter}s.`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram HTTP error (${res.status}) calling ${method}: ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  if (!data.ok) {
    throw new Error(`Telegram API error on ${method}: ${String(data.description ?? 'unknown')}`);
  }

  return data;
}

function fmtTgDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function tgSenderName(from: Record<string, unknown> | undefined): string {
  if (!from) return 'unknown';
  const parts = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return parts || String(from.username ?? from.id ?? 'unknown');
}

function tgChatName(chat: Record<string, unknown>): string {
  if (chat.title) return String(chat.title);
  const parts = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return parts || String(chat.username ?? chat.id ?? 'unknown');
}

// ── Telegram handlers ─────────────────────────────────────────────────────────

async function handleTelegramGetUpdates(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
  const params: Record<string, unknown> = { limit };
  if (args.offset !== undefined) params.offset = Number(args.offset);

  const data = await telegramFetch('getUpdates', params);
  const updates = (data.result as Array<Record<string, unknown>>) ?? [];

  if (updates.length === 0) {
    return 'No new Telegram updates.';
  }

  const lines: string[] = [`Recent Telegram updates (${updates.length}):\n`];

  for (const update of updates) {
    const msg = (update.message ?? update.channel_post) as Record<string, unknown> | undefined;
    if (!msg) continue;

    const date = fmtTgDate(Number(msg.date ?? 0));
    const sender = tgSenderName(msg.from as Record<string, unknown> | undefined);
    const chat = tgChatName(msg.chat as Record<string, unknown>);
    const text = String(msg.text ?? msg.caption ?? '(non-text message)').slice(0, 300);
    const chatType = String((msg.chat as Record<string, unknown>)?.type ?? '');

    lines.push(`[${date}] ${sender}${chatType !== 'private' ? ` in ${chat}` : ''}: ${text}`);
  }

  return lines.join('\n');
}

async function handleTelegramSendMessage(args: Record<string, unknown>): Promise<string> {
  const chatId = String(args.chat_id ?? '');
  const text = String(args.text ?? '');
  const parseMode = args.parse_mode as string | undefined;

  if (!chatId) throw new Error('chat_id is required');
  if (!text) throw new Error('text is required');

  const params: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) params.parse_mode = parseMode;

  const data = await telegramFetch('sendMessage', params);
  const msg = data.result as Record<string, unknown>;
  const date = fmtTgDate(Number(msg.date ?? 0));
  const chat = tgChatName(msg.chat as Record<string, unknown>);

  return [
    'Telegram message sent.',
    `To: ${chat} (${chatId})`,
    `Text: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`,
    `Sent at: ${date}`,
    `Message ID: ${msg.message_id}`,
  ].join('\n');
}

// Shared reply queue — the Telegram bot writes here, send_and_wait reads
const telegramReplyQueue = new Map<string, { text: string; from: string; timestamp: number }>();

// Track which chats have an active send_and_wait
const telegramWaitingChats = new Set<string>();

// Called by the telegram bot when it sees a message that might be a reply
export function pushTelegramReply(chatId: string, text: string, from: string): void {
  telegramReplyQueue.set(chatId, { text, from, timestamp: Date.now() });
}

// Check if a chat has an active send_and_wait waiting for a reply
export function isTelegramWaiting(chatId: string): boolean {
  return telegramWaitingChats.has(chatId);
}

async function handleTelegramSendAndWait(args: Record<string, unknown>): Promise<string> {
  const chatId = String(args.chat_id ?? '');
  const text = String(args.text ?? '');
  const waitSeconds = Math.min(Number(args.wait_seconds ?? 60), 120);

  if (!chatId) throw new Error('chat_id is required');
  if (!text) throw new Error('text is required');

  // Clear any stale reply for this chat and mark as waiting
  telegramReplyQueue.delete(chatId);
  telegramWaitingChats.add(chatId);

  // Send the message
  const sendData = await telegramFetch('sendMessage', { chat_id: chatId, text });
  const sentMsg = sendData.result as Record<string, unknown>;
  const sentId = Number(sentMsg.message_id ?? 0);
  const sentAt = Date.now();

  // Wait for the background Telegram bot to catch a reply and put it in the queue
  const deadline = Date.now() + waitSeconds * 1000;

  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));

      const reply = telegramReplyQueue.get(chatId);
      if (reply && reply.timestamp > sentAt) {
        telegramReplyQueue.delete(chatId);
        const elapsed = Math.round((reply.timestamp - sentAt) / 1000);
        return [
          'Reply received.',
          `From: ${reply.from}`,
          `Text: ${reply.text}`,
          `Wait time: ${elapsed}s`,
        ].join('\n');
      }
    }

    return `No reply received within ${waitSeconds} seconds. Message was sent successfully (ID: ${sentId}).`;
  } finally {
    telegramWaitingChats.delete(chatId);
  }
}

async function handleTelegramListChats(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50);

  // Telegram has no direct "list chats" endpoint — derive from recent getUpdates
  const data = await telegramFetch('getUpdates', { limit: 100 });
  const updates = (data.result as Array<Record<string, unknown>>) ?? [];

  if (updates.length === 0) {
    return 'No recent Telegram chats found. The bot has not received any messages yet.';
  }

  // Deduplicate chats by chat ID, keep most recent appearance
  const seen = new Map<string | number, Record<string, unknown>>();
  for (const update of updates) {
    const msg = (update.message ?? update.channel_post) as Record<string, unknown> | undefined;
    if (!msg) continue;
    const chat = msg.chat as Record<string, unknown>;
    seen.set(chat.id as string | number, chat);
  }

  const chats = Array.from(seen.values()).slice(0, limit);
  const lines: string[] = [`Recent Telegram chats (${chats.length}):\n`];

  for (const chat of chats) {
    const name = tgChatName(chat);
    const type = String(chat.type ?? 'unknown');
    const id = String(chat.id ?? '');
    lines.push(`• ${name} [${type}] — ID: ${id}`);
    if (chat.username) lines.push(`  Username: @${chat.username}`);
  }

  return lines.join('\n');
}

// ── Notion helpers ────────────────────────────────────────────────────────────

const NOTION_VERSION = '2022-06-28';

/**
 * Perform an authenticated request against the Notion REST API.
 * Reads NOTION_API_KEY from the environment at call time.
 */
async function notionFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    throw new Error(
      'NOTION_API_KEY is not configured. Add your Notion integration token to the environment.',
    );
  }

  const fetchOpts: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  };
  if (options.body !== undefined) {
    (fetchOpts as RequestInit & { body: string }).body = JSON.stringify(options.body);
  }

  const res = await fetch(`https://api.notion.com/v1${path}`, fetchOpts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Normalise a Notion page/database ID to a canonical UUID.
 * Handles bare 32-char hex, dash-separated UUIDs, and full page URLs.
 */
function normaliseNotionId(raw: string): string {
  const urlMatch = raw.match(/([a-f0-9]{32}|[a-f0-9-]{36})\s*$/i);
  const clean = (urlMatch ? urlMatch[1] : raw).replace(/-/g, '');
  if (clean.length !== 32) return raw;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

/** Extract plain text from a Notion rich_text array. */
function richTextToPlain(richText: Array<{ plain_text?: string }>): string {
  return richText.map((t) => t.plain_text ?? '').join('');
}

/** Extract human-readable text from a single Notion block. */
function blockToText(block: Record<string, unknown>): string {
  const type = block.type as string | undefined;
  if (!type) return '';
  const content = block[type] as Record<string, unknown> | undefined;
  const rt = (content?.rich_text ?? content?.text) as Array<{ plain_text?: string }> | undefined;
  const plain = rt ? richTextToPlain(rt) : '';
  switch (type) {
    case 'paragraph':          return plain;
    case 'heading_1':          return `# ${plain}`;
    case 'heading_2':          return `## ${plain}`;
    case 'heading_3':          return `### ${plain}`;
    case 'bulleted_list_item': return `• ${plain}`;
    case 'numbered_list_item': return `1. ${plain}`;
    case 'to_do': {
      const checked = (content?.checked as boolean | undefined) ?? false;
      return `[${checked ? 'x' : ' '}] ${plain}`;
    }
    case 'quote':   return `> ${plain}`;
    case 'callout': return plain ? `[Callout] ${plain}` : '';
    case 'code':    return plain ? `\`\`\`\n${plain}\n\`\`\`` : '';
    case 'divider': return '---';
    default:        return plain;
  }
}

/** Extract a page's display title from its Notion properties object. */
function notionPageTitle(properties: Record<string, unknown>): string {
  for (const val of Object.values(properties)) {
    const prop = val as Record<string, unknown>;
    if (prop.type === 'title') {
      const rt = prop.title as Array<{ plain_text?: string }> | undefined;
      return rt ? richTextToPlain(rt) : '(Untitled)';
    }
  }
  return '(Untitled)';
}

// ── Notion handlers ───────────────────────────────────────────────────────────

async function handleNotionSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 10), 1), 50);
  const filterType = args.filter_type as string | undefined;

  const body: Record<string, unknown> = {
    query,
    page_size: maxResults,
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  };
  if (filterType === 'page' || filterType === 'database') {
    body.filter = { value: filterType, property: 'object' };
  }

  const data = await notionFetch('/search', { method: 'POST', body }) as {
    results: Array<Record<string, unknown>>;
    has_more: boolean;
  };
  const results = data.results ?? [];

  if (results.length === 0) {
    return `No Notion results found for: "${query}"`;
  }

  const lines: string[] = [
    `Notion search results for "${query}" — ${results.length} result${results.length !== 1 ? 's' : ''}${data.has_more ? ' (more available)' : ''}:\n`,
  ];

  for (const item of results) {
    const type = item.object as string;
    const id = item.id as string;
    const url = item.url as string | undefined;
    const editedAt = item.last_edited_time as string | undefined;
    let title = '(Untitled)';
    if (type === 'database') {
      const titleArr = (item.title as Array<{ plain_text?: string }> | undefined) ?? [];
      title = richTextToPlain(titleArr) || '(Untitled database)';
    } else {
      const props = item.properties as Record<string, unknown> | undefined;
      if (props) title = notionPageTitle(props);
    }
    lines.push(`• [${type === 'database' ? 'Database' : 'Page'}] ${title}`);
    lines.push(`  ID: ${id}`);
    if (editedAt) lines.push(`  Last edited: ${fmt(editedAt)}`);
    if (url) lines.push(`  Link: ${url}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleNotionGetPage(args: Record<string, unknown>): Promise<string> {
  const rawId = String(args.page_id ?? '');
  if (!rawId) throw new Error('page_id is required');
  const pageId = normaliseNotionId(rawId);

  const [pageData, blocksData] = await Promise.all([
    notionFetch(`/pages/${pageId}`) as Promise<Record<string, unknown>>,
    notionFetch(`/blocks/${pageId}/children?page_size=100`) as Promise<{
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor?: string;
    }>,
  ]);

  const properties = (pageData.properties ?? {}) as Record<string, unknown>;
  const title = notionPageTitle(properties);
  const url = pageData.url as string | undefined;
  const editedAt = pageData.last_edited_time as string | undefined;

  const lines: string[] = [`Notion page: ${title}`];
  if (editedAt) lines.push(`Last edited: ${fmt(editedAt)}`);
  if (url) lines.push(`Link: ${url}`);
  lines.push('');

  // Paginate blocks — up to 3 API pages (~300 blocks)
  let blocks = blocksData.results ?? [];
  let hasMore = blocksData.has_more;
  let cursor = blocksData.next_cursor;
  let apiPages = 1;

  while (hasMore && cursor && apiPages < 3) {
    const more = await notionFetch(
      `/blocks/${pageId}/children?page_size=100&start_cursor=${cursor}`,
    ) as { results: Array<Record<string, unknown>>; has_more: boolean; next_cursor?: string };
    blocks = blocks.concat(more.results ?? []);
    hasMore = more.has_more;
    cursor = more.next_cursor;
    apiPages++;
  }

  if (blocks.length === 0) {
    lines.push('(Page has no content blocks)');
  } else {
    lines.push('Content:');
    for (const block of blocks) {
      const text = blockToText(block);
      if (text) lines.push(text);
    }
    if (hasMore) lines.push('\n... (additional content truncated)');
  }

  return lines.join('\n');
}

async function handleNotionCreatePage(args: Record<string, unknown>): Promise<string> {
  const databaseId = normaliseNotionId(String(args.database_id ?? ''));
  const title = String(args.title ?? '');
  const content = args.content as string | undefined;
  const extraProps = (args.properties ?? {}) as Record<string, string>;

  if (!databaseId) throw new Error('database_id is required');
  if (!title) throw new Error('title is required');

  const properties: Record<string, unknown> = {
    title: { title: [{ text: { content: title } }] },
  };
  for (const [key, value] of Object.entries(extraProps)) {
    if (key === 'title') continue;
    properties[key] = { rich_text: [{ text: { content: String(value) } }] };
  }

  const body: Record<string, unknown> = {
    parent: { database_id: databaseId },
    properties,
  };
  if (content) {
    body.children = [{
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content } }] },
    }];
  }

  const data = await notionFetch('/pages', { method: 'POST', body }) as Record<string, unknown>;
  const createdId = data.id as string;
  const url = data.url as string | undefined;

  const lines = [
    'Notion page created successfully.',
    `Title: ${title}`,
    `Page ID: ${createdId}`,
  ];
  if (url) lines.push(`Link: ${url}`);
  return lines.join('\n');
}

async function handleNotionListDatabases(args: Record<string, unknown>): Promise<string> {
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 25), 1), 50);

  const data = await notionFetch('/search', {
    method: 'POST',
    body: {
      filter: { value: 'database', property: 'object' },
      page_size: maxResults,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    },
  }) as { results: Array<Record<string, unknown>>; has_more: boolean };

  const databases = data.results ?? [];

  if (databases.length === 0) {
    return 'No Notion databases found. Make sure the integration has been shared with the databases you want to access.';
  }

  const lines: string[] = [
    `Notion databases — ${databases.length} accessible${data.has_more ? ' (more available)' : ''}:\n`,
  ];
  for (const db of databases) {
    const titleArr = (db.title as Array<{ plain_text?: string }> | undefined) ?? [];
    const title = richTextToPlain(titleArr) || '(Untitled)';
    const id = db.id as string;
    const url = db.url as string | undefined;
    const editedAt = db.last_edited_time as string | undefined;
    lines.push(`• ${title}`);
    lines.push(`  ID: ${id}`);
    if (editedAt) lines.push(`  Last edited: ${fmt(editedAt)}`);
    if (url) lines.push(`  Link: ${url}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── Airtable helpers ──────────────────────────────────────────────────────────

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

/**
 * Perform an authenticated request against the Airtable REST API.
 * Reads AIRTABLE_API_KEY from the environment at call time.
 */
async function airtableFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const apiKey = process.env.AIRTABLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'AIRTABLE_API_KEY is not configured. Add your Airtable API key to the environment.',
    );
  }

  const fetchOpts: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (options.body !== undefined) {
    (fetchOpts as RequestInit & { body: string }).body = JSON.stringify(options.body);
  }

  const res = await fetch(`${AIRTABLE_BASE_URL}${path}`, {
    ...fetchOpts,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable API error (${res.status}): ${text}`);
  }
  return res.json();
}

/** Format a single Airtable record as a readable block of lines. */
function fmtAirtableRecord(
  record: { id: string; fields: Record<string, unknown> },
  index?: number,
): string[] {
  const lines: string[] = [];
  const prefix = index !== undefined ? `${index + 1}.` : '•';
  lines.push(`${prefix} Record ID: ${record.id}`);
  for (const [key, value] of Object.entries(record.fields)) {
    const display = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (display) lines.push(`   ${key}: ${display}`);
  }
  return lines;
}

// ── Airtable handlers ─────────────────────────────────────────────────────────

async function handleAirtableListBases(): Promise<string> {
  const data = await airtableFetch('/meta/bases') as {
    bases: Array<{ id: string; name: string; permissionLevel: string }>;
    offset?: string;
  };

  const bases = data.bases ?? [];
  if (bases.length === 0) {
    return 'No Airtable bases found. Check that your API key has access to at least one base.';
  }

  const lines: string[] = [`Airtable bases — ${bases.length} accessible:\n`];
  for (const base of bases) {
    lines.push(`• ${base.name}`);
    lines.push(`  ID: ${base.id}`);
    lines.push(`  Access: ${base.permissionLevel}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function handleAirtableListRecords(args: Record<string, unknown>): Promise<string> {
  const baseId = String(args.base_id ?? '');
  const tableName = String(args.table_name ?? '');
  const maxRecords = Math.min(Math.max(Number(args.max_records ?? 20), 1), 100);
  const view = args.view as string | undefined;

  if (!baseId) throw new Error('base_id is required');
  if (!tableName) throw new Error('table_name is required');

  interface AirtableListResponse {
    records: Array<{ id: string; fields: Record<string, unknown> }>;
    offset?: string;
  }

  const allRecords: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams({
      pageSize: String(Math.min(maxRecords - allRecords.length, 100)),
    });
    if (view) params.set('view', view);
    if (offset) params.set('offset', offset);

    const encodedTable = encodeURIComponent(tableName);
    const data = await airtableFetch(`/${baseId}/${encodedTable}?${params}`) as AirtableListResponse;
    allRecords.push(...(data.records ?? []));
    offset = data.offset;
  } while (offset && allRecords.length < maxRecords);

  const records = allRecords.slice(0, maxRecords);

  if (records.length === 0) {
    return `No records found in table "${tableName}".`;
  }

  const lines: string[] = [
    `Airtable — "${tableName}" (${records.length} record${records.length !== 1 ? 's' : ''}${offset ? ', more available' : ''}):\n`,
  ];
  for (let i = 0; i < records.length; i++) {
    lines.push(...fmtAirtableRecord(records[i], i));
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function handleAirtableCreateRecord(args: Record<string, unknown>): Promise<string> {
  const baseId = String(args.base_id ?? '');
  const tableName = String(args.table_name ?? '');
  const fields = (args.fields ?? {}) as Record<string, unknown>;

  if (!baseId) throw new Error('base_id is required');
  if (!tableName) throw new Error('table_name is required');
  if (Object.keys(fields).length === 0) throw new Error('fields must not be empty');

  const encodedTable = encodeURIComponent(tableName);
  const data = await airtableFetch(`/${baseId}/${encodedTable}`, {
    method: 'POST',
    body: { fields },
  }) as { id: string; fields: Record<string, unknown>; createdTime?: string };

  const lines = [
    'Airtable record created successfully.',
    `Record ID: ${data.id}`,
    `Table: ${tableName}`,
  ];
  if (data.createdTime) lines.push(`Created: ${fmt(data.createdTime)}`);
  lines.push('Fields:');
  for (const [key, value] of Object.entries(data.fields)) {
    const display = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (display) lines.push(`  ${key}: ${display}`);
  }
  return lines.join('\n');
}

async function handleAirtableCreateBase(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '');
  if (!name) return 'Error: name is required';

  const tables = (args.tables as unknown[]) ?? [{
    name: 'Table 1',
    fields: [{ name: 'Name', type: 'singleLineText' }],
  }];

  // Get workspace ID — required for base creation
  let workspaceId = args.workspace_id ? String(args.workspace_id) : undefined;
  if (!workspaceId) {
    // List workspaces to find the first one
    const wsData = await airtableFetch('/meta/workspaces') as { workspaces?: Array<{ id: string; name: string }> };
    workspaceId = wsData.workspaces?.[0]?.id;
    if (!workspaceId) return 'Error: no Airtable workspaces found. Create one at airtable.com first.';
  }

  const body = { name, workspaceId, tables };
  const data = await airtableFetch('/meta/bases', { method: 'POST', body }) as {
    id: string;
    name: string;
    tables?: Array<{ id: string; name: string }>;
  };

  const lines = [
    `Base created successfully.`,
    `Base ID: ${data.id}`,
    `Name: ${data.name}`,
  ];
  if (data.tables) {
    lines.push(`Tables: ${data.tables.map(t => `${t.name} (${t.id})`).join(', ')}`);
  }
  return lines.join('\n');
}

async function handleAirtableCreateTable(args: Record<string, unknown>): Promise<string> {
  const baseId = String(args.base_id ?? '');
  const name = String(args.name ?? '');
  const fields = (args.fields as unknown[]) ?? [];

  if (!baseId) return 'Error: base_id is required';
  if (!name) return 'Error: name is required';
  if (fields.length === 0) return 'Error: at least one field is required';

  const body = { name, fields };
  const data = await airtableFetch(`/meta/bases/${baseId}/tables`, { method: 'POST', body }) as {
    id: string;
    name: string;
    fields?: Array<{ id: string; name: string; type: string }>;
  };

  const lines = [
    `Table created successfully.`,
    `Table ID: ${data.id}`,
    `Name: ${data.name}`,
    `Base: ${baseId}`,
  ];
  if (data.fields) {
    lines.push('Fields:');
    for (const f of data.fields) lines.push(`  - ${f.name} (${f.type})`);
  }
  return lines.join('\n');
}

async function handleAirtableSearch(args: Record<string, unknown>): Promise<string> {
  const baseId = String(args.base_id ?? '');
  const tableName = String(args.table_name ?? '');
  const fieldName = String(args.field_name ?? '');
  const value = String(args.value ?? '');
  const maxRecords = Math.min(Math.max(Number(args.max_records ?? 10), 1), 50);

  if (!baseId) throw new Error('base_id is required');
  if (!tableName) throw new Error('table_name is required');
  if (!fieldName) throw new Error('field_name is required');
  if (!value) throw new Error('value is required');

  // SEARCH() is case-insensitive — better UX than FIND()
  const formula = `SEARCH(LOWER("${value.replace(/"/g, '\\"')}"), LOWER({${fieldName.replace(/}/g, '\\}')}}))`;
  const params = new URLSearchParams({
    filterByFormula: formula,
    pageSize: String(maxRecords),
  });

  const encodedTable = encodeURIComponent(tableName);
  const data = await airtableFetch(`/${baseId}/${encodedTable}?${params}`) as {
    records: Array<{ id: string; fields: Record<string, unknown> }>;
    offset?: string;
  };

  const records = data.records ?? [];

  if (records.length === 0) {
    return `No records found in "${tableName}" where ${fieldName} contains "${value}".`;
  }

  const lines: string[] = [
    `Airtable search — "${tableName}" where ${fieldName} contains "${value}" — ${records.length} result${records.length !== 1 ? 's' : ''}${data.offset ? ' (more available)' : ''}:\n`,
  ];
  for (let i = 0; i < records.length; i++) {
    lines.push(...fmtAirtableRecord(records[i], i));
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ── Make.com helpers ──────────────────────────────────────────────────────────

const MAKE_BASE = 'https://us2.make.com/api/v2';
// Default org — can be overridden per tool call
const MAKE_DEFAULT_ORG_ID = 4658230;

function getMakeApiKey(): string {
  const key = process.env.MAKE_API_KEY;
  if (!key) throw new Error('MAKE_API_KEY is not configured. Add it in Settings to use Make.com tools.');
  return key;
}

async function makeFetch(
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<unknown> {
  const url = `${MAKE_BASE}${path}`;
  const fetchOpts: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Token ${getMakeApiKey()}`,
      'Content-Type': 'application/json',
    },
  };
  if (options.body !== undefined) {
    (fetchOpts as RequestInit & { body: string }).body = JSON.stringify(options.body);
  }
  const res = await fetch(url, fetchOpts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Make.com API error (${res.status}): ${text}`);
  }
  return res.json();
}

interface MakeScenario {
  id: number;
  name: string;
  isActive: boolean;
  lastEdit?: string;
  nextExec?: string;
  scheduling?: { type: string; interval?: number };
  description?: string;
  blueprint?: { modules?: Array<{ module: string }> };
}

interface MakeExecution {
  id: string;
  scenarioId: number;
  scenarioName?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  operationsConsumed?: number;
}

async function handleMakeListOrgs(): Promise<string> {
  const data = (await makeFetch('/organizations')) as { organizations?: Array<{ id: number; name: string; zone: string }> };
  const orgs = data.organizations ?? [];
  if (orgs.length === 0) return 'No Make.com organizations found.';

  const lines = [`Make.com organizations (${orgs.length}):\n`];
  for (const o of orgs) {
    lines.push(`  ${o.id} | ${o.name} (${o.zone})`);
  }
  return lines.join('\n');
}

async function handleMakeListTeams(args: Record<string, unknown>): Promise<string> {
  const orgId = Number(args.organization_id ?? MAKE_DEFAULT_ORG_ID);
  const data = (await makeFetch(`/teams?organizationId=${orgId}`)) as { teams?: Array<{ id: number; name: string }> };
  const teams = data.teams ?? [];
  if (teams.length === 0) return `No teams found for organization ${orgId}.`;

  const lines = [`Teams for org ${orgId} (${teams.length}):\n`];
  for (const t of teams) {
    lines.push(`  ${t.id} | ${t.name}`);
  }
  return lines.join('\n');
}

async function handleMakeListScenarios(args: Record<string, unknown>): Promise<string> {
  const activeOnly = Boolean(args.active_only ?? false);

  let offset = 0;
  const pageSize = 100;
  const allScenarios: MakeScenario[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({
      organizationId: String(MAKE_DEFAULT_ORG_ID),
      pg_offset: String(offset),
      pg_limit: String(pageSize),
    });
    const data = (await makeFetch(`/scenarios?${params}`)) as { scenarios?: MakeScenario[] };
    const page = data.scenarios ?? [];
    allScenarios.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  const scenarios = activeOnly ? allScenarios.filter((s) => s.isActive) : allScenarios;

  if (scenarios.length === 0) {
    return activeOnly ? 'No active Make.com scenarios found.' : 'No Make.com scenarios found.';
  }

  const active = scenarios.filter((s) => s.isActive).length;
  const lines: string[] = [`Make.com scenarios — ${scenarios.length} total (${active} active):\n`];

  for (const s of scenarios) {
    const status = s.isActive ? '[ACTIVE]' : '[inactive]';
    lines.push(`• ${s.name} ${status}`);
    lines.push(`  ID: ${s.id}`);
    if (s.scheduling?.type) {
      const interval = s.scheduling.interval ? ` every ${s.scheduling.interval}s` : '';
      lines.push(`  Schedule: ${s.scheduling.type}${interval}`);
    }
    if (s.nextExec) lines.push(`  Next run: ${fmt(s.nextExec)}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleMakeRunScenario(args: Record<string, unknown>): Promise<string> {
  const scenarioId = Number(args.scenario_id);
  if (!scenarioId || isNaN(scenarioId)) throw new Error('scenario_id is required and must be a number');

  const data = (await makeFetch(`/scenarios/${scenarioId}/run`, { method: 'POST' })) as {
    executionId?: string;
    data?: { executionId?: string };
  };

  const executionId = data.executionId ?? data.data?.executionId ?? '(unknown)';

  return [
    `Make.com scenario ${scenarioId} triggered successfully.`,
    `Execution ID: ${executionId}`,
    `Use boss_make_recent_executions with scenario_id=${scenarioId} to check the result.`,
  ].join('\n');
}

async function handleMakeRecentExecutions(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
  const scenarioId = args.scenario_id !== undefined ? Number(args.scenario_id) : undefined;

  const params = new URLSearchParams({
    organizationId: String(MAKE_DEFAULT_ORG_ID),
    pg_limit: String(limit),
    pg_offset: '0',
  });
  if (scenarioId) params.set('scenarioId', String(scenarioId));

  const data = (await makeFetch(`/scenarios/executions?${params}`)) as {
    scenarioExecutions?: MakeExecution[];
    executions?: MakeExecution[];
  };

  const executions: MakeExecution[] = data.scenarioExecutions ?? data.executions ?? [];

  if (executions.length === 0) {
    return scenarioId
      ? `No recent executions found for scenario ${scenarioId}.`
      : 'No recent Make.com executions found.';
  }

  const lines: string[] = [
    `Make.com recent executions — ${executions.length} result${executions.length !== 1 ? 's' : ''}:\n`,
  ];

  for (const ex of executions) {
    const name = ex.scenarioName ? ` (${ex.scenarioName})` : '';
    lines.push(`• Scenario ${ex.scenarioId}${name} — ${ex.status.toUpperCase()}`);
    if (ex.startedAt) lines.push(`  Started: ${fmt(ex.startedAt)}`);
    if (ex.finishedAt && ex.startedAt) {
      const ms = new Date(ex.finishedAt).getTime() - new Date(ex.startedAt).getTime();
      lines.push(`  Duration: ${(ms / 1000).toFixed(1)}s`);
    }
    if (ex.operationsConsumed !== undefined) lines.push(`  Operations used: ${ex.operationsConsumed}`);
    lines.push(`  Execution ID: ${ex.id}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleMakeGetScenario(args: Record<string, unknown>): Promise<string> {
  const scenarioId = Number(args.scenario_id);
  if (!scenarioId || isNaN(scenarioId)) throw new Error('scenario_id is required and must be a number');

  const data = (await makeFetch(`/scenarios/${scenarioId}`)) as { scenario?: MakeScenario };
  const s = data.scenario;
  if (!s) throw new Error(`Scenario ${scenarioId} not found.`);

  const lines: string[] = [
    `Make.com scenario: ${s.name}`,
    `ID: ${s.id}`,
    `Status: ${s.isActive ? 'Active' : 'Inactive'}`,
  ];

  if (s.description) lines.push(`Description: ${s.description}`);
  if (s.scheduling?.type) {
    const interval = s.scheduling.interval ? ` every ${s.scheduling.interval}s` : '';
    lines.push(`Schedule: ${s.scheduling.type}${interval}`);
  }
  if (s.nextExec) lines.push(`Next run: ${fmt(s.nextExec)}`);
  if (s.lastEdit) lines.push(`Last edited: ${fmt(s.lastEdit)}`);

  const modules = s.blueprint?.modules;
  if (modules && modules.length > 0) {
    const uniqueApps = [...new Set(modules.map((m) => m.module.split(':')[0]))];
    lines.push(`Apps used: ${uniqueApps.join(', ')}`);
    lines.push(`Module count: ${modules.length}`);
  }

  return lines.join('\n');
}

async function handleMakeActivate(args: Record<string, unknown>): Promise<string> {
  const scenarioId = Number(args.scenario_id);
  if (!scenarioId || isNaN(scenarioId)) throw new Error('scenario_id is required');

  // Make API uses POST /scenarios/{id}/start to activate (NOT /activate)
  await makeFetch(`/scenarios/${scenarioId}/start`, { method: 'POST' });
  return `Scenario ${scenarioId} activated (started).`;
}

async function handleMakeDeactivate(args: Record<string, unknown>): Promise<string> {
  const scenarioId = Number(args.scenario_id);
  if (!scenarioId || isNaN(scenarioId)) throw new Error('scenario_id is required');

  await makeFetch(`/scenarios/${scenarioId}/stop`, { method: 'POST' });
  return `Scenario ${scenarioId} deactivated (stopped).`;
}

async function handleMakeCreateScenario(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '');
  if (!name) throw new Error('name is required');

  const teamId = args.team_id ? Number(args.team_id) : undefined;
  const description = args.description ? String(args.description) : undefined;
  const blueprint = args.blueprint ? String(args.blueprint) : undefined;

  // If no team_id, get the first team
  let resolvedTeamId = teamId;
  if (!resolvedTeamId) {
    const teams = (await makeFetch(`/teams?organizationId=${MAKE_DEFAULT_ORG_ID}`)) as { teams?: Array<{ id: number }> };
    resolvedTeamId = teams.teams?.[0]?.id;
    if (!resolvedTeamId) throw new Error('No teams found in Make.com organization');
  }

  const body: Record<string, unknown> = {
    name,
    teamId: resolvedTeamId,
    // scheduling is REQUIRED and must be a stringified JSON string
    scheduling: args.scheduling ? String(args.scheduling) : '{"type":"indefinitely","interval":900}',
  };
  if (description) body.description = description;
  // Blueprint must be a stringified JSON string AND must include metadata.version
  if (blueprint) {
    // Ensure it's a string, not an object
    body.blueprint = typeof blueprint === 'string' ? blueprint : JSON.stringify(blueprint);
  } else {
    // Minimal valid blueprint
    body.blueprint = JSON.stringify({
      name,
      metadata: { version: 1 },
      flow: [],
    });
  }

  const data = (await makeFetch('/scenarios', { method: 'POST', body })) as { scenario?: { id: number; name: string } };
  const s = data.scenario;
  if (!s) throw new Error('Failed to create scenario — no response from Make API');

  return `Scenario created successfully.\nID: ${s.id}\nName: ${s.name}\n\nUse boss_make_activate with scenario_id=${s.id} to start it.`;
}

async function handleMakeUpdateScenario(args: Record<string, unknown>): Promise<string> {
  const scenarioId = Number(args.scenario_id);
  if (!scenarioId || isNaN(scenarioId)) throw new Error('scenario_id is required');

  const body: Record<string, unknown> = {};
  if (args.name) body.name = String(args.name);
  if (args.description) body.description = String(args.description);
  if (args.blueprint) body.blueprint = String(args.blueprint);
  if (args.scheduling) body.scheduling = JSON.parse(String(args.scheduling));

  if (Object.keys(body).length === 0) throw new Error('Nothing to update — provide name, description, blueprint, or scheduling');

  await makeFetch(`/scenarios/${scenarioId}`, { method: 'PATCH', body });
  return `Scenario ${scenarioId} updated. PATCH returned 200 but always test execution to confirm it works.`;
}

// ── Gemini helpers ────────────────────────────────────────────────────────────

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_VISION_MODEL = 'gemini-1.5-flash';
const GEMINI_TIMEOUT_MS = 30_000;

function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not configured. Add it in Settings to use Gemini tools. Get a key at aistudio.google.com.');
  return key;
}

/**
 * Fetch an image from a URL and return it as a base64 string with its MIME type.
 */
async function fetchImageAsBase64(url: string): Promise<{ mimeType: string; data: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch image from URL (${res.status}): ${url}`);
    const contentType = res.headers.get('content-type') ?? 'image/png';
    // Normalise to a supported MIME type
    const mimeType = contentType.split(';')[0].trim() as string;
    const buffer = await res.arrayBuffer();
    const data = Buffer.from(buffer).toString('base64');
    return { mimeType, data };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Low-level Gemini generateContent call.
 * Returns the raw response body as a parsed object.
 */
async function geminiGenerateContent(
  model: string,
  body: object,
): Promise<unknown> {
  const apiKey = getGeminiApiKey();
  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text();
    let errMsg = `Gemini API error (${res.status}): ${text}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) errMsg = `Gemini error: ${parsed.error.message}`;
    } catch { /* use raw text */ }
    throw new Error(errMsg);
  }

  return res.json();
}

/**
 * Extract the first base64 image part from a Gemini generateContent response.
 * Returns { mimeType, data } or null if no image was produced.
 */
function extractGeminiImage(
  response: unknown,
): { mimeType: string; data: string } | null {
  const r = response as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: { mimeType: string; data: string };
        }>;
      };
    }>;
  };
  for (const candidate of r.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return { mimeType: part.inlineData.mimeType, data: part.inlineData.data };
      }
    }
  }
  return null;
}

/**
 * Extract concatenated text parts from a Gemini generateContent response.
 */
function extractGeminiText(response: unknown): string {
  const r = response as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const parts: string[] = [];
  for (const candidate of r.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text) parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

// ── Gemini handlers ───────────────────────────────────────────────────────────

const STYLE_SUFFIXES: Record<string, string> = {
  photo:        ', photorealistic photography style',
  illustration: ', digital illustration style, flat design',
  painting:     ', traditional painting style, fine art',
  '3d':         ', 3D rendered, high detail, ray tracing',
};

const ASPECT_SUFFIXES: Record<string, string> = {
  '1:1':  ', square aspect ratio 1:1',
  '16:9': ', widescreen landscape aspect ratio 16:9',
  '9:16': ', portrait mobile aspect ratio 9:16',
  '4:3':  ', standard screen aspect ratio 4:3',
};

async function handleGeminiImageGenerate(args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) return 'boss_image_generate: "prompt" is required.';

  const style = args.style as string | undefined;
  const aspectRatio = args.aspect_ratio as string | undefined;

  let fullPrompt = prompt;
  if (style && STYLE_SUFFIXES[style]) fullPrompt += STYLE_SUFFIXES[style];
  if (aspectRatio && ASPECT_SUFFIXES[aspectRatio]) fullPrompt += ASPECT_SUFFIXES[aspectRatio];

  const response = await geminiGenerateContent(GEMINI_IMAGE_MODEL, {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const image = extractGeminiImage(response);
  if (!image) {
    const text = extractGeminiText(response);
    return text
      ? `Image generation did not produce an image. Gemini response: ${text}`
      : 'Image generation did not produce an image. The model may have declined the request.';
  }

  const dataUri = `data:${image.mimeType};base64,${image.data}`;
  return [
    '[IMAGE_GENERATED]',
    dataUri,
    '[/IMAGE_GENERATED]',
    `Prompt: ${prompt}`,
  ].join('\n');
}

async function handleGeminiImageEdit(args: Record<string, unknown>): Promise<string> {
  const instruction = String(args.instruction ?? '').trim();
  if (!instruction) return 'boss_image_edit: "instruction" is required.';

  const imageUrl = args.image_url as string | undefined;
  const imageBase64 = args.image_base64 as string | undefined;

  if (!imageUrl && !imageBase64) {
    return 'boss_image_edit: provide either "image_url" or "image_base64".';
  }

  let mimeType = 'image/png';
  let base64Data: string;

  if (imageUrl) {
    const fetched = await fetchImageAsBase64(imageUrl);
    mimeType = fetched.mimeType;
    base64Data = fetched.data;
  } else {
    // Strip data URI prefix if present
    const raw = imageBase64!;
    const match = raw.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    } else {
      base64Data = raw;
    }
  }

  const response = await geminiGenerateContent(GEMINI_IMAGE_MODEL, {
    contents: [{
      parts: [
        { text: instruction },
        { inlineData: { mimeType, data: base64Data } },
      ],
    }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  });

  const image = extractGeminiImage(response);
  if (!image) {
    const text = extractGeminiText(response);
    return text
      ? `Image editing did not produce an image. Gemini response: ${text}`
      : 'Image editing did not produce an image. The model may have declined the request.';
  }

  const dataUri = `data:${image.mimeType};base64,${image.data}`;
  return [
    '[IMAGE_GENERATED]',
    dataUri,
    '[/IMAGE_GENERATED]',
    `Instruction: ${instruction}`,
  ].join('\n');
}

async function handleGeminiImageDescribe(args: Record<string, unknown>): Promise<string> {
  const imageUrl = args.image_url as string | undefined;
  const imageBase64 = args.image_base64 as string | undefined;
  const question = String(args.question ?? '').trim() || 'Describe this image in detail.';

  if (!imageUrl && !imageBase64) {
    return 'boss_image_describe: provide either "image_url" or "image_base64".';
  }

  let mimeType = 'image/png';
  let base64Data: string;

  if (imageUrl) {
    const fetched = await fetchImageAsBase64(imageUrl);
    mimeType = fetched.mimeType;
    base64Data = fetched.data;
  } else {
    const raw = imageBase64!;
    const match = raw.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    } else {
      base64Data = raw;
    }
  }

  const response = await geminiGenerateContent(GEMINI_VISION_MODEL, {
    contents: [{
      parts: [
        { text: question },
        { inlineData: { mimeType, data: base64Data } },
      ],
    }],
  });

  const text = extractGeminiText(response);
  return text || 'Gemini did not return a description for this image.';
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

const STRIPE_BASE = 'https://api.stripe.com/v1';

function getStripeApiKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured. Add it in Settings to use Stripe tools.');
  return key;
}

async function stripeFetch(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    params?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<unknown> {
  const method = options.method ?? 'GET';
  const cleanParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined) cleanParams[k] = String(v);
  }

  let url = `${STRIPE_BASE}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${getStripeApiKey()}` };
  const fetchOpts: RequestInit = { method, headers };

  if (method === 'GET') {
    if (Object.keys(cleanParams).length > 0) url += '?' + new URLSearchParams(cleanParams).toString();
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    (fetchOpts as RequestInit & { body: string }).body = new URLSearchParams(cleanParams).toString();
  }

  const res = await fetch(url, fetchOpts);
  if (!res.ok) {
    const text = await res.text();
    let errMsg = `Stripe API error (${res.status}): ${text}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) errMsg = `Stripe error: ${parsed.error.message}`;
    } catch { /* use raw text */ }
    throw new Error(errMsg);
  }
  return res.json();
}

function fmtCents(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount / 100);
}

interface StripeCustomer {
  id: string;
  name?: string;
  email?: string;
  currency?: string;
  created: number;
  balance?: number;
}

interface StripeInvoice {
  id: string;
  number?: string;
  customer: string;
  customer_name?: string;
  customer_email?: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  status: string;
  due_date?: number;
  created: number;
  hosted_invoice_url?: string;
}

interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  description?: string;
  customer?: string;
  billing_details?: { name?: string; email?: string };
  created: number;
}

interface StripeBalance {
  available: Array<{ amount: number; currency: string }>;
  pending: Array<{ amount: number; currency: string }>;
}

interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

async function handleStripeListCustomers(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
  const email = args.email as string | undefined;

  const data = (await stripeFetch('/customers', {
    params: { limit, ...(email ? { email } : {}) },
  })) as StripeList<StripeCustomer>;

  if (data.data.length === 0) {
    return email ? `No Stripe customers found with email "${email}".` : 'No Stripe customers found.';
  }

  const moreNote = data.has_more ? ` (showing first ${limit} — there are more)` : '';
  const lines: string[] = [
    `Stripe customers — ${data.data.length} result${data.data.length !== 1 ? 's' : ''}${moreNote}:\n`,
  ];

  for (const c of data.data) {
    lines.push(`• ${c.name ?? '(No name)'}`);
    if (c.email) lines.push(`  Email: ${c.email}`);
    lines.push(`  Customer ID: ${c.id}`);
    lines.push(`  Created: ${fmt(new Date(c.created * 1000))}`);
    if (c.balance && c.balance !== 0) {
      lines.push(`  Credit balance: ${fmtCents(Math.abs(c.balance), c.currency ?? 'usd')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleStripeListInvoices(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
  const customerId = args.customer_id as string | undefined;
  const status = args.status as string | undefined;

  const data = (await stripeFetch('/invoices', {
    params: {
      limit,
      ...(customerId ? { customer: customerId } : {}),
      ...(status ? { status } : {}),
    },
  })) as StripeList<StripeInvoice>;

  if (data.data.length === 0) return 'No Stripe invoices found matching the criteria.';

  const moreNote = data.has_more ? ` (showing first ${limit} — there are more)` : '';
  const lines: string[] = [
    `Stripe invoices — ${data.data.length} result${data.data.length !== 1 ? 's' : ''}${moreNote}:\n`,
  ];

  for (const inv of data.data) {
    const customerLabel = inv.customer_name ?? inv.customer_email ?? inv.customer;
    lines.push(`• Invoice ${inv.number ?? inv.id} — ${inv.status.toUpperCase()}`);
    lines.push(`  Customer: ${customerLabel}`);
    lines.push(`  Amount due: ${fmtCents(inv.amount_due, inv.currency)}`);
    if (inv.status === 'paid') lines.push(`  Amount paid: ${fmtCents(inv.amount_paid, inv.currency)}`);
    lines.push(`  Created: ${fmt(new Date(inv.created * 1000))}`);
    if (inv.due_date) lines.push(`  Due: ${fmt(new Date(inv.due_date * 1000))}`);
    if (inv.hosted_invoice_url) lines.push(`  Link: ${inv.hosted_invoice_url}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleStripeListPayments(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
  const customerId = args.customer_id as string | undefined;

  const data = (await stripeFetch('/charges', {
    params: { limit, ...(customerId ? { customer: customerId } : {}) },
  })) as StripeList<StripeCharge>;

  if (data.data.length === 0) return 'No Stripe payments found matching the criteria.';

  const moreNote = data.has_more ? ` (showing first ${limit} — there are more)` : '';
  const lines: string[] = [
    `Stripe payments — ${data.data.length} result${data.data.length !== 1 ? 's' : ''}${moreNote}:\n`,
  ];

  for (const ch of data.data) {
    const name = ch.billing_details?.name ?? ch.customer ?? '(anonymous)';
    lines.push(`• ${fmtCents(ch.amount, ch.currency)} — ${ch.status.toUpperCase()}`);
    lines.push(`  Customer: ${name}`);
    if (ch.billing_details?.email) lines.push(`  Email: ${ch.billing_details.email}`);
    if (ch.description) lines.push(`  Description: ${ch.description}`);
    lines.push(`  Date: ${fmt(new Date(ch.created * 1000))}`);
    lines.push(`  Charge ID: ${ch.id}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function handleStripeGetBalance(_args: Record<string, unknown>): Promise<string> {
  const data = (await stripeFetch('/balance')) as StripeBalance;
  const lines: string[] = ['Stripe account balance:\n'];

  if (data.available.length > 0) {
    lines.push('Available (can be paid out):');
    for (const b of data.available) lines.push(`  ${fmtCents(b.amount, b.currency)}`);
  }
  if (data.pending.length > 0) {
    lines.push('Pending (in transit):');
    for (const b of data.pending) lines.push(`  ${fmtCents(b.amount, b.currency)}`);
  }

  return lines.join('\n');
}

async function handleStripeCreateInvoice(args: Record<string, unknown>): Promise<string> {
  const customerId = String(args.customer_id ?? '');
  const amount = Number(args.amount);
  const currency = String(args.currency ?? 'usd').toLowerCase();
  const description = String(args.description ?? '');
  const dueDays = Math.max(Number(args.due_days ?? 30), 1);

  if (!customerId) throw new Error('customer_id is required to create an invoice');
  if (!amount || isNaN(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer in cents (e.g. 10000 = $100.00)');
  }
  if (!description) throw new Error('description is required for the invoice line item');

  const dueDateUnix = Math.floor(Date.now() / 1000) + dueDays * 24 * 60 * 60;

  // Step 1 — create the pending invoice item
  await stripeFetch('/invoiceitems', {
    method: 'POST',
    params: { customer: customerId, amount, currency, description },
  }) as { id: string };

  // Step 2 — create the draft invoice; Stripe auto-attaches pending items
  const invoice = (await stripeFetch('/invoices', {
    method: 'POST',
    params: {
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: String(dueDays),
    },
  })) as StripeInvoice;

  return [
    'Stripe draft invoice created.',
    `Invoice ID: ${invoice.id}`,
    `Customer: ${customerId}`,
    `Amount: ${fmtCents(invoice.amount_due, invoice.currency)}`,
    `Status: ${invoice.status}`,
    `Due: ${fmt(new Date(dueDateUnix * 1000))}`,
    '',
    'The invoice is saved as a draft. Finalize and send it from the Stripe Dashboard or via the Stripe API.',
  ].join('\n');
}

// ── Sub-agent spawn handlers ──────────────────────────────────────────────────
//
// These handlers are invoked when the main brain calls boss_spawn_agent or
// boss_spawn_parallel. They reach the shared BrainRouter singleton (imported
// from router-singleton.ts to avoid a circular dep with routes/brain.ts).
//
// Role-based default tool sets are intentionally narrow — sub-agents do their
// job better when they only have the tools they actually need.

import { getSharedRouter } from '../router-singleton.js';
import { runAgent } from '../agents/runner.js';
import { runAgentPool } from '../agents/pool.js';
import type { AgentRole, AgentSpec } from '../agents/types.js';

// No artificial cap — agents run until done. Natural bounds: context window + rate limits.
const AGENT_MAX_ITERATIONS = 50;

// Minimal read-only or write tool sets per role.
// Only includes tools that could actually be configured at runtime.
// Every role can spawn sub-agents (swarm pattern). Leaders delegate to children.
const SPAWN_TOOLS = ['boss_spawn_agent', 'boss_spawn_parallel'];

const ROLE_DEFAULT_TOOLS: Record<AgentRole, string[]> = {
  researcher: [
    'boss_calendar_today',
    'boss_calendar_upcoming',
    'boss_gmail_unread',
    'boss_gmail_search',
    'boss_gmail_read',
    'boss_drive_search',
    'boss_drive_recent',
    'boss_drive_read_doc',
    'boss_contacts_search',
    'boss_airtable_list_bases',
    'boss_airtable_list_records',
    'boss_airtable_search',
    'boss_notion_search',
    'boss_notion_get_page',
    'boss_notion_list_databases',
    'boss_n8n_list_workflows',
    'boss_n8n_recent_executions',
    'boss_read_local_file',
  ],
  executor: [
    'boss_gmail_archive',
    'boss_gmail_mark_read',
    'boss_gmail_label',
    'boss_gmail_reply',
    'boss_gmail_send',
    'boss_n8n_run_workflow',
    'boss_n8n_list_workflows',
    'boss_n8n_delegate',
    'boss_make_run_scenario',
    'boss_make_list_scenarios',
    'boss_tasks_create',
    'boss_tasks_complete',
    'boss_calendar_create',
    'boss_ha_turn_on',
    'boss_ha_turn_off',
    'boss_ha_run_automation',
  ],
  analyst: [
    'boss_gmail_unread',
    'boss_gmail_search',
    'boss_gmail_read',
    'boss_drive_search',
    'boss_drive_recent',
    'boss_drive_read_doc',
    'boss_airtable_list_bases',
    'boss_airtable_list_records',
    'boss_airtable_search',
    'boss_notion_search',
    'boss_notion_get_page',
    'boss_notion_list_databases',
    'boss_calendar_today',
    'boss_calendar_upcoming',
    'boss_tasks_pending',
    'boss_stripe_list_invoices',
    'boss_stripe_list_payments',
    'boss_stripe_get_balance',
  ],
  writer: [
    'boss_gmail_send',
    'boss_gmail_reply',
    'boss_gmail_archive',
    'boss_gmail_mark_read',
    'boss_tasks_create',
    'boss_notion_create_page',
    'boss_airtable_create_record',
    'boss_calendar_create',
    'boss_slack_send_message',
    'boss_telegram_send_message',
  ],
};

// WS-4: hard cap on parallel fan-out from a single boss_spawn_parallel call.
const MAX_PARALLEL_SPAWN = 8;

function resolveAllowedTools(role: AgentRole, toolsArg: unknown): string[] {
  const requested =
    Array.isArray(toolsArg) && toolsArg.length > 0
      ? toolsArg.filter((t): t is string => typeof t === 'string')
      : ROLE_DEFAULT_TOOLS[role];
  // WS-4: a spawned sub-agent must NOT be able to spawn further agents — that is
  // the unbounded-recursion / exponential-fan-out risk. Strip spawn tools from
  // EVERY child grant, whether from role defaults or an explicit request, so the
  // spawn tree is at most one level deep.
  return requested.filter((t) => !SPAWN_TOOLS.includes(t));
}

async function handleSpawnAgent(args: Record<string, unknown>): Promise<string> {
  const role = args.role as AgentRole;
  const task = args.task as string;

  if (!role || !task) {
    return 'boss_spawn_agent: "role" and "task" are required.';
  }

  const validRoles: AgentRole[] = ['researcher', 'executor', 'analyst', 'writer'];
  if (!validRoles.includes(role)) {
    return `boss_spawn_agent: invalid role "${role}". Must be one of: ${validRoles.join(', ')}.`;
  }

  const agentId = `agent-${role}-${Date.now()}`;
  const spec: AgentSpec = {
    id: agentId,
    role,
    task,
    parentConversationId: 'main',
    maxIterations: AGENT_MAX_ITERATIONS,
    allowedTools: resolveAllowedTools(role, args.tools),
  };

  const router = getSharedRouter();
  const result = await runAgent(spec, router);

  const lines = [
    `Agent ${agentId} [${role}] — ${result.status.toUpperCase()}`,
    `Iterations: ${result.iterations}  |  Latency: ${result.latencyMs}ms`,
    `Tools used: ${result.toolsUsed.length > 0 ? result.toolsUsed.join(', ') : 'none'}`,
    '',
    result.output,
  ];
  return lines.join('\n');
}

async function handleSpawnParallel(args: Record<string, unknown>): Promise<string> {
  const agentsArg = args.agents;

  if (!Array.isArray(agentsArg) || agentsArg.length === 0) {
    return 'boss_spawn_parallel: "agents" must be a non-empty array.';
  }

  // WS-4: bound fan-out — never spawn more than MAX_PARALLEL_SPAWN in one call.
  const cappedAgents = agentsArg.slice(0, MAX_PARALLEL_SPAWN);
  const droppedCount = agentsArg.length - cappedAgents.length;

  const validRoles: AgentRole[] = ['researcher', 'executor', 'analyst', 'writer'];
  const specs: AgentSpec[] = [];
  const errors: string[] = [];

  for (let i = 0; i < cappedAgents.length; i++) {
    const entry = cappedAgents[i] as Record<string, unknown>;
    const role = entry.role as AgentRole;
    const task = entry.task as string;

    if (!role || !task) {
      errors.push(`agents[${i}]: "role" and "task" are required.`);
      continue;
    }
    if (!validRoles.includes(role)) {
      errors.push(`agents[${i}]: invalid role "${role}".`);
      continue;
    }

    specs.push({
      id: `agent-${role}-${i}-${Date.now()}`,
      role,
      task,
      parentConversationId: 'main',
      maxIterations: AGENT_MAX_ITERATIONS,
      allowedTools: resolveAllowedTools(role, entry.tools),
    });
  }

  if (errors.length > 0) {
    return `boss_spawn_parallel: validation errors:\n${errors.join('\n')}`;
  }

  const router = getSharedRouter();
  const results = await runAgentPool(specs, router);

  const sections = results.map((result, i) => {
    const spec = specs[i];
    return [
      `--- Agent ${i + 1}: ${spec.id} [${spec.role}] — ${result.status.toUpperCase()} ---`,
      `Iterations: ${result.iterations}  |  Latency: ${result.latencyMs}ms`,
      `Tools used: ${result.toolsUsed.length > 0 ? result.toolsUsed.join(', ') : 'none'}`,
      '',
      result.output,
    ].join('\n');
  });

  const header =
    droppedCount > 0
      ? `⚠️ Capped at ${MAX_PARALLEL_SPAWN} parallel agents; ${droppedCount} not spawned — re-call boss_spawn_parallel for the rest.\n\n`
      : '';
  return header + sections.join('\n\n');
}

// ── Email agent handlers ──────────────────────────────────────────────────────

/**
 * Returns the 5 most recent unresolved attention items from the email log.
 * The brain calls this when the user asks what emails need their attention.
 */
async function handleEmailAttention(_args: Record<string, unknown>): Promise<string> {
  const pool = getPool();

  const result = await pool.query<{
    id: string;
    sender: string;
    subject: string;
    category: string;
    received_at: Date;
    boss_notes: string | null;
  }>(
    `SELECT id, sender, subject, category, received_at, boss_notes
       FROM boss_email_log
      WHERE needs_attention = true
        AND resolved_at IS NULL
      ORDER BY processed_at DESC
      LIMIT 5`,
  );

  if (result.rows.length === 0) {
    return 'No emails currently need your attention. Your inbox is clear.';
  }

  const lines: string[] = [
    `Emails needing your attention — ${result.rows.length} item${result.rows.length !== 1 ? 's' : ''}:\n`,
  ];

  for (const row of result.rows) {
    const receivedDate = row.received_at.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    lines.push(`• [${row.category.toUpperCase()}] ${row.subject}`);
    lines.push(`  From: ${row.sender}  |  Received: ${receivedDate}`);
    lines.push(`  ID: ${row.id}`);
    if (row.boss_notes) {
      lines.push(`  BOS's note: ${row.boss_notes}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Returns the daily email digest from the processed email log.
 * Covers today's counts, open attention items, invoices due, and newsletter nuggets.
 */
async function handleEmailDigest(_args: Record<string, unknown>): Promise<string> {
  const pool = getPool();

  const [countResult, attentionResult, categoryResult, invoiceResult, nuggetResult] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM boss_email_log WHERE processed_at >= CURRENT_DATE`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM boss_email_log WHERE needs_attention = true AND resolved_at IS NULL`,
      ),
      pool.query<{ category: string; count: string }>(
        `SELECT category, COUNT(*)::text AS count
           FROM boss_email_log
          WHERE processed_at >= CURRENT_DATE
          GROUP BY category
          ORDER BY COUNT(*) DESC`,
      ),
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
      pool.query<{ golden_nugget: string }>(
        `SELECT golden_nugget
           FROM boss_email_log
          WHERE golden_nugget IS NOT NULL
            AND processed_at >= (now() - interval '7 days')
          ORDER BY processed_at DESC
          LIMIT 10`,
      ),
    ]);

  const totalProcessed = parseInt(countResult.rows[0]?.count ?? '0', 10);
  const totalAttention = parseInt(attentionResult.rows[0]?.count ?? '0', 10);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const lines: string[] = [`Email Digest — ${today}\n`];

  lines.push(`Processed today: ${totalProcessed}`);
  lines.push(`Needs attention: ${totalAttention}`);

  if (categoryResult.rows.length > 0) {
    lines.push('\nBreakdown by category:');
    for (const row of categoryResult.rows) {
      lines.push(`  ${row.category}: ${row.count}`);
    }
  }

  if (invoiceResult.rows.length > 0) {
    lines.push(`\nInvoices due in the next 7 days (${invoiceResult.rows.length}):`);
    for (const row of invoiceResult.rows) {
      const due = row.invoice_due_date
        ? row.invoice_due_date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Unknown';
      const amount = row.invoice_amount != null ? ` — $${parseFloat(row.invoice_amount).toFixed(2)}` : '';
      lines.push(`  • ${row.sender}${amount}  (due ${due})`);
      lines.push(`    "${row.subject}"`);
    }
  }

  if (nuggetResult.rows.length > 0) {
    lines.push(`\nGolden nuggets from newsletters (last 7 days):`);
    for (const row of nuggetResult.rows) {
      lines.push(`  • ${row.golden_nugget}`);
    }
  }

  return lines.join('\n');
}

// ── Router ────────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

// ── Filesystem handlers ──────────────────────────────────────────────────────

// Full access — when running on host, direct paths. In Docker, /data/home.
const IS_DOCKER = process.env.BOSS_RUNTIME === 'docker';
const HOME_PREFIX = IS_DOCKER ? '/data/home' : '/home/boss';
const ALLOWED_READ_PREFIXES = [HOME_PREFIX, '/tmp/boss-jobs', '/tmp'];
const ALLOWED_WRITE_PREFIXES = [HOME_PREFIX, '/tmp/boss-jobs', '/tmp'];

async function handleFsRead(args: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs');
  const filePath = String(args.path ?? '');
  const maxLines = Number(args.max_lines ?? 500);

  if (!ALLOWED_READ_PREFIXES.some(p => filePath.startsWith(p))) {
    return `Error: can only read from ${ALLOWED_READ_PREFIXES.join(', ')}`;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n\n[... truncated at ${maxLines} lines, file has ${lines.length} total]`;
    }
    return content;
  } catch (err) {
    return `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleFsWrite(args: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const filePath = String(args.path ?? '');
  const content = String(args.content ?? '');

  if (!ALLOWED_WRITE_PREFIXES.some(p => filePath.startsWith(p))) {
    return `Error: can only write to ${ALLOWED_WRITE_PREFIXES.join(', ')}`;
  }

  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Written ${content.length} characters to ${filePath}`;
  } catch (err) {
    return `Error writing ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleFsList(args: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dirPath = String(args.path ?? '');
  const recursive = args.recursive === true;
  const maxDepth = Number(args.max_depth ?? 2);

  if (!ALLOWED_READ_PREFIXES.some(p => dirPath.startsWith(p))) {
    return `Error: can only list ${ALLOWED_READ_PREFIXES.join(', ')}`;
  }

  const lines: string[] = [];
  function walk(dir: string, depth: number, prefix: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`);
          if (recursive && depth < maxDepth) walk(full, depth + 1, prefix + '  ');
        } else {
          try {
            const stat = fs.statSync(full);
            const size = stat.size < 1024 ? `${stat.size}B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)}KB` : `${(stat.size / 1048576).toFixed(1)}MB`;
            lines.push(`${prefix}${entry.name} (${size})`);
          } catch {
            lines.push(`${prefix}${entry.name}`);
          }
        }
      }
    } catch (err) {
      lines.push(`${prefix}[error: ${err instanceof Error ? err.message : String(err)}]`);
    }
  }

  walk(dirPath, 0, '');
  return lines.length > 0 ? lines.join('\n') : 'Directory is empty.';
}

async function handleFsSearch(args: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dirPath = String(args.path ?? '');
  const pattern = String(args.pattern ?? '').toLowerCase();
  const contentSearch = args.content_search === true;

  if (!ALLOWED_READ_PREFIXES.some(p => dirPath.startsWith(p))) {
    return `Error: can only search ${ALLOWED_READ_PREFIXES.join(', ')}`;
  }

  const results: string[] = [];
  const maxResults = 20;

  function walk(dir: string, depth: number) {
    if (results.length >= maxResults || depth > 5) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          walk(full, depth + 1);
        } else {
          if (!contentSearch && entry.name.toLowerCase().includes(pattern)) {
            results.push(full);
          } else if (contentSearch) {
            try {
              const stat = fs.statSync(full);
              if (stat.size > 500_000) continue; // skip large files
              const content = fs.readFileSync(full, 'utf-8');
              if (content.toLowerCase().includes(pattern)) {
                const lineNum = content.substring(0, content.toLowerCase().indexOf(pattern)).split('\n').length;
                results.push(`${full}:${lineNum}`);
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(dirPath, 0);
  return results.length > 0
    ? `Found ${results.length} match${results.length !== 1 ? 'es' : ''}:\n${results.join('\n')}`
    : `No matches for "${pattern}" in ${dirPath}`;
}

async function handleFsAppend(args: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs');
  const filePath = String(args.path ?? '');
  const content = String(args.content ?? '');

  if (!ALLOWED_WRITE_PREFIXES.some(p => filePath.startsWith(p))) {
    return `Error: can only write to ${ALLOWED_WRITE_PREFIXES.join(', ')}`;
  }

  try {
    fs.appendFileSync(filePath, content, 'utf-8');
    return `Appended ${content.length} characters to ${filePath}`;
  } catch (err) {
    return `Error appending to ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Passkey management handlers ───────────────────────────────────────────────

async function handleGeneratePasskey(args: Record<string, unknown>): Promise<string> {
  const email = String(args.email ?? '');
  if (!email) return 'Error: email is required';

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; display_name: string | null }>(
    'SELECT id, display_name FROM users WHERE email = $1', [email.toLowerCase()],
  );
  if (rows.length === 0) return `Error: no user found with email ${email}`;

  const code = String(crypto.randomInt(100_000_000, 999_999_999));
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  await pool.query('UPDATE users SET passkey_hash = $1, updated_at = now() WHERE id = $2', [hash, rows[0].id]);

  return `Passkey generated for ${rows[0].display_name || email}.\n\nCode: ${code}\n\nShare this with the user securely. It cannot be retrieved again. They will need it to log in.`;
}

async function handleResetPasskey(args: Record<string, unknown>): Promise<string> {
  const email = String(args.email ?? '');
  if (!email) return 'Error: email is required';

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; display_name: string | null }>(
    'SELECT id, display_name FROM users WHERE email = $1', [email.toLowerCase()],
  );
  if (rows.length === 0) return `Error: no user found with email ${email}`;

  await pool.query('UPDATE users SET passkey_hash = NULL, updated_at = now() WHERE id = $1', [rows[0].id]);

  return `Passkey removed for ${rows[0].display_name || email}. They can log in with just email and password until a new passkey is generated.`;
}

// ── CRM (GoHighLevel) handlers ────────────────────────────────────────────────

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_LOCATION = 'NymYyL8jmYkUtvAkDH2e';

async function ghlFetch(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const pool = (await import('../db.js')).getPool();
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM runtime_config WHERE key = 'crm_api_key' AND tenant_id = 'default'",
  );
  const apiKey = rows[0]?.value;
  if (!apiKey) throw new Error('CRM API key not configured');

  const res = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function handleCrmSearchContacts(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const limit = Number(args.limit ?? 10);
  if (!query) return 'Error: query is required';

  const data = await ghlFetch(`/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(query)}&limit=${limit}`) as any;
  const contacts = data.contacts ?? [];
  if (contacts.length === 0) return `No contacts found for "${query}".`;

  return contacts.map((c: any) =>
    `${c.contactName || c.firstName + ' ' + c.lastName} | ${c.email || 'no email'} | ${c.phone || 'no phone'} | ${c.companyName || ''} | ID: ${c.id}`
  ).join('\n');
}

async function handleCrmGetContact(args: Record<string, unknown>): Promise<string> {
  const id = String(args.contactId ?? '');
  if (!id) return 'Error: contactId is required';

  const data = await ghlFetch(`/contacts/${id}`) as any;
  const c = data.contact ?? data;
  return JSON.stringify({
    id: c.id, name: c.contactName, firstName: c.firstName, lastName: c.lastName,
    email: c.email, phone: c.phone, company: c.companyName, tags: c.tags,
    source: c.source, dateAdded: c.dateAdded, assignedTo: c.assignedTo,
    customFields: c.customFields,
  }, null, 2);
}

async function handleCrmCreateContact(args: Record<string, unknown>): Promise<string> {
  const body: Record<string, unknown> = { locationId: GHL_LOCATION };
  if (args.firstName) body.firstName = String(args.firstName);
  if (args.lastName) body.lastName = String(args.lastName);
  if (args.email) body.email = String(args.email);
  if (args.phone) body.phone = String(args.phone);
  if (args.companyName) body.companyName = String(args.companyName);
  if (args.tags) body.tags = args.tags;
  if (args.source) body.source = String(args.source);

  const data = await ghlFetch('/contacts/', 'POST', body) as any;
  return `Contact created: ${data.contact?.id || data.id}\nName: ${data.contact?.contactName || args.firstName}`;
}

async function handleCrmUpdateContact(args: Record<string, unknown>): Promise<string> {
  const id = String(args.contactId ?? '');
  if (!id) return 'Error: contactId is required';

  const body: Record<string, unknown> = {};
  for (const key of ['firstName', 'lastName', 'email', 'phone', 'companyName', 'tags']) {
    if (args[key] !== undefined) body[key] = args[key];
  }

  await ghlFetch(`/contacts/${id}`, 'PUT', body);
  return `Contact ${id} updated.`;
}

async function handleCrmListPipelines(args: Record<string, unknown>): Promise<string> {
  const data = await ghlFetch(`/opportunities/pipelines?locationId=${GHL_LOCATION}`) as any;
  const pipelines = data.pipelines ?? [];
  if (pipelines.length === 0) return 'No pipelines found.';

  return pipelines.map((p: any) => {
    const stages = (p.stages ?? []).map((s: any) => `  - ${s.name} (ID: ${s.id})`).join('\n');
    return `Pipeline: ${p.name} (ID: ${p.id})\n${stages}`;
  }).join('\n\n');
}

async function handleCrmSearchOpportunities(args: Record<string, unknown>): Promise<string> {
  // GHL v2 /opportunities/search uses snake_case query params (unlike contacts).
  let path = `/opportunities/search?location_id=${GHL_LOCATION}`;
  if (args.pipelineId) path += `&pipeline_id=${args.pipelineId}`;
  if (args.stageId) path += `&pipeline_stage_id=${args.stageId}`;
  if (args.contactId) path += `&contact_id=${args.contactId}`;
  if (args.query) path += `&q=${encodeURIComponent(String(args.query))}`;
  path += `&limit=${args.limit || 20}`;

  const data = await ghlFetch(path) as any;
  const opps = data.opportunities ?? [];
  if (opps.length === 0) return 'No opportunities found.';

  return opps.map((o: any) =>
    `${o.name} | $${o.monetaryValue || 0} | ${o.pipelineStageId || 'unknown stage'} | ${o.status} | Contact: ${o.contactId} | ID: ${o.id}`
  ).join('\n');
}

async function handleCrmCreateOpportunity(args: Record<string, unknown>): Promise<string> {
  const body = {
    locationId: GHL_LOCATION,
    pipelineId: String(args.pipelineId),
    pipelineStageId: String(args.stageId),
    contactId: String(args.contactId),
    name: String(args.name),
    monetaryValue: args.monetaryValue ? Number(args.monetaryValue) : undefined,
    status: String(args.status || 'open'),
  };

  const data = await ghlFetch('/opportunities/', 'POST', body) as any;
  return `Opportunity created: ${data.opportunity?.id || data.id}\nName: ${args.name}`;
}

async function handleCrmGetConversations(args: Record<string, unknown>): Promise<string> {
  const contactId = String(args.contactId ?? '');
  if (!contactId) return 'Error: contactId is required';

  const data = await ghlFetch(`/conversations/search?locationId=${GHL_LOCATION}&contactId=${contactId}`) as any;
  const convos = data.conversations ?? [];
  if (convos.length === 0) return 'No conversations found for this contact.';

  return convos.slice(0, 5).map((c: any) =>
    `${c.type || 'unknown'} | ${c.lastMessageDate || ''} | ${c.lastMessageBody?.slice(0, 100) || 'no content'} | ID: ${c.id}`
  ).join('\n');
}

async function handleCrmSendMessage(args: Record<string, unknown>): Promise<string> {
  const contactId = String(args.contactId ?? '');
  const type = String(args.type ?? 'sms');
  const message = String(args.message ?? '');
  if (!contactId || !message) return 'Error: contactId and message are required';

  const body: Record<string, unknown> = {
    type,
    contactId,
    message,
  };
  if (type === 'email' && args.subject) body.subject = String(args.subject);

  const data = await ghlFetch('/conversations/messages', 'POST', body) as any;
  return `Message sent via ${type}: ${data.messageId || data.id || 'sent'}`;
}

// ── Persistent agent handlers ─────────────────────────────────────────────────

async function handleCreatePersistentAgent(args: Record<string, unknown>): Promise<string> {
  const { createPersistentAgent } = await import('../agents/persistent-scheduler.js');
  const name = String(args.name ?? '');
  const instructions = String(args.instructions ?? '');
  if (!name || !instructions) return 'Error: name and instructions are required';

  const agent = await createPersistentAgent({
    name,
    instructions,
    cronExpression: args.cron_expression ? String(args.cron_expression) : undefined,
  });

  return `Persistent agent created.\nID: ${agent.id}\nName: ${agent.name}\nSchedule: ${args.cron_expression || '0 */4 * * *'}\nStatus: active\n\nThe agent will run on its next scheduled heartbeat.`;
}

async function handleListPersistentAgents(): Promise<string> {
  const { listPersistentAgents } = await import('../agents/persistent-scheduler.js');
  const agents = await listPersistentAgents();

  if (agents.length === 0) return 'No persistent agents found.';

  const lines = [`Persistent agents (${agents.length}):\n`];
  for (const a of agents) {
    const lastRun = a.last_run_at ? new Date(a.last_run_at).toLocaleString() : 'never';
    lines.push(`• ${a.name} [${a.status}]`);
    lines.push(`  ID: ${a.id}`);
    lines.push(`  Schedule: ${a.cron_expression}`);
    lines.push(`  Last run: ${lastRun} (${a.run_count} total runs)`);
    lines.push(`  Instructions: ${a.instructions.slice(0, 100)}...`);
    lines.push('');
  }
  return lines.join('\n');
}

async function handleUpdatePersistentAgent(args: Record<string, unknown>): Promise<string> {
  const { updatePersistentAgent } = await import('../agents/persistent-scheduler.js');
  const id = String(args.agent_id ?? '');
  if (!id) return 'Error: agent_id is required';

  await updatePersistentAgent(id, {
    instructions: args.instructions ? String(args.instructions) : undefined,
    cronExpression: args.cron_expression ? String(args.cron_expression) : undefined,
    status: args.status ? String(args.status) : undefined,
    name: args.name ? String(args.name) : undefined,
  });

  return `Agent ${id} updated.`;
}

async function handleDeletePersistentAgent(args: Record<string, unknown>): Promise<string> {
  const { deletePersistentAgent } = await import('../agents/persistent-scheduler.js');
  const id = String(args.agent_id ?? '');
  if (!id) return 'Error: agent_id is required';

  await deletePersistentAgent(id);
  return `Agent ${id} deleted.`;
}

// ── Web search handlers ──────────────────────────────────────────────────────

async function handleWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  if (!query) return 'Error: query is required';
  const maxResults = Math.min(Number(args.max_results ?? 5), 10);

  try {
    // Use DuckDuckGo HTML search (no API key needed)
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BOS/2.0; +https://starrandpartners.ai)',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return `Search failed: HTTP ${res.status}`;

    const html = await res.text();

    // Parse results from DDG HTML
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const resultBlocks = html.split('class="result__body"');

    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i];

      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>(.*?)<\/a>/s);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      // Extract URL
      const urlMatch = block.match(/class="result__url"[^>]*>(.*?)<\/a>/s);
      let url = urlMatch ? urlMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (url && !url.startsWith('http')) url = `https://${url}`;

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>(.*?)<\/a>/s)
        ?? block.match(/class="result__snippet"[^>]*>(.*?)<\//s);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    if (results.length === 0) {
      return `No results found for: "${query}"`;
    }

    const lines = [`Web search results for "${query}":\n`];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    }
    return lines.join('\n').trim();
  } catch (err) {
    return `Search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '');
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return 'Error: valid URL starting with http:// or https:// is required';
  }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BOS/2.0; +https://starrandpartners.ai)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });

    if (!res.ok) return `Fetch failed: HTTP ${res.status}`;

    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();

    // If it's plain text or JSON, return directly
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      return text.slice(0, 15000);
    }

    // Strip HTML to readable text
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return 'Page fetched but no readable text content found.';
    return cleaned.slice(0, 15000);
  } catch (err) {
    return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Self-modification tools ──────────────────────────────────────────────────
// These give BOS the ability to modify, build, test, and version its own code.
// Restricted to admin trust tier. All changes go to boss-dev directory.

// Source paths — adapt to runtime mode
const BOSS_SRC = IS_DOCKER ? '/data/home/boss-dev' : '/home/boss/boss-dev';
const HOST_BOSS_SRC = IS_DOCKER ? '/data/home/boss-dev' : '/home/boss/boss-dev';
const DOCKER_COMPOSE_DIR = IS_DOCKER ? '/data/home/boss-dev' : '/home/boss/boss-dev';

// Blocked patterns for shell safety
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+\/(?!data|tmp)/,  // rm -rf outside /data or /tmp
  /\bsudo\b/,                       // no sudo
  /\bshutdown\b/,                   // no shutdown
  /\breboot\b/,                     // no reboot
  /\bmkfs\b/,                       // no disk format
  /\bdd\s+if=/,                     // no dd
  /\biptables\b/,                   // no firewall changes
  /\buseradd\b/,                    // no user management
  /\bpasswd\b/,                     // no password changes
  />\s*\/etc\//,                    // no writing to /etc
  />\s*\/usr\//,                    // no writing to /usr
];

async function handleBash(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? '');
  const timeoutMs = Math.min(Number(args.timeout ?? 60000), 300000); // max 5 min
  const cwd = String(args.cwd ?? HOST_BOSS_SRC);

  if (!command) return 'Error: command is required';

  // Safety check
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return `Error: command blocked by safety rules — matches ${pattern.source}`;
    }
  }

  const { execSync } = await import('node:child_process');

  try {
    const output = execSync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
    });
    const trimmed = output.length > 30000 ? output.slice(0, 30000) + '\n[... truncated at 30K chars]' : output;
    return trimmed || '(command completed with no output)';
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    const stdout = e.stdout ? e.stdout.slice(0, 10000) : '';
    const stderr = e.stderr ? e.stderr.slice(0, 10000) : '';
    return `Exit code: ${e.status ?? 'unknown'}\n${stdout ? `stdout:\n${stdout}\n` : ''}${stderr ? `stderr:\n${stderr}` : e.message ?? 'unknown error'}`;
  }
}

async function handleSelfPatch(args: Record<string, unknown>): Promise<string> {
  const fs = await import('node:fs');
  const filePath = String(args.path ?? '');
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  const replaceAll = args.replace_all === true;

  // Path validation — must be in boss-dev
  const resolved = filePath.startsWith('/data/home/') ? filePath : `${BOSS_SRC}/${filePath}`;
  if (!resolved.startsWith(BOSS_SRC)) {
    return `Error: can only patch files in ${BOSS_SRC}`;
  }

  if (!oldStr) return 'Error: old_string is required';
  if (oldStr === newStr) return 'Error: old_string and new_string are identical';

  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    const count = content.split(oldStr).length - 1;

    if (count === 0) {
      return `Error: old_string not found in ${filePath}. The file has ${content.split('\n').length} lines. Use boss_fs_read to verify the exact content.`;
    }
    if (count > 1 && !replaceAll) {
      return `Error: old_string found ${count} times in ${filePath}. Set replace_all=true to replace all, or provide more surrounding context to make it unique.`;
    }

    const updated = replaceAll ? content.replaceAll(oldStr, newStr) : content.replace(oldStr, newStr);
    fs.writeFileSync(resolved, updated, 'utf-8');

    return `Patched ${filePath}: ${replaceAll ? `replaced ${count} occurrences` : 'replaced 1 occurrence'}`;
  } catch (err) {
    return `Error patching ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleSelfGrep(args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern ?? '');
  const path = String(args.path ?? BOSS_SRC);
  const glob = String(args.glob ?? '');
  const maxResults = Math.min(Number(args.max_results ?? 50), 200);

  if (!pattern) return 'Error: pattern is required';

  const resolved = path.startsWith('/data/home/') ? path : `${BOSS_SRC}/${path}`;
  if (!resolved.startsWith(BOSS_SRC) && !resolved.startsWith('/data/home')) {
    return `Error: can only search in ${BOSS_SRC}`;
  }

  try {
    const { execSync } = await import('node:child_process');
    const args_arr = ['rg', '--no-heading', '-n', '--max-count', String(maxResults)];
    if (glob) args_arr.push('--glob', glob);
    args_arr.push('--', pattern, resolved);

    const output = execSync(args_arr.join(' '), {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 512 * 1024,
    });
    return output.slice(0, 30000) || 'No matches found.';
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return 'No matches found.';
    return `Search error: ${e.stdout || (err instanceof Error ? err.message : String(err))}`;
  }
}

async function handleSelfBuild(args: Record<string, unknown>): Promise<string> {
  const services = (args.services as string[] | undefined) ?? ['api'];
  const validServices = ['api', 'web', 'worker', 'gateway', 'stt'];
  const filtered = services.filter(s => validServices.includes(s));
  if (filtered.length === 0) return `Error: valid services are ${validServices.join(', ')}`;

  const { execSync } = await import('node:child_process');

  try {
    // Step 1: TypeScript check (skip if npx not available in container — will be caught by build)
    const tscResult = execSync(`cd ${BOSS_SRC} && npx tsc --noEmit --pretty 2>&1 || true`, {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });

    const hasErrors = tscResult.includes('error TS');
    if (hasErrors) {
      return `TypeScript check failed — fix errors before building:\n\n${tscResult.slice(0, 10000)}`;
    }

    // Step 2: Docker build (docker CLI talks to host daemon via mounted socket)
    const buildCmd = `cd ${DOCKER_COMPOSE_DIR} && docker compose build ${filtered.join(' ')} 2>&1`;
    const buildResult = execSync(buildCmd, {
      encoding: 'utf-8',
      timeout: 300000, // 5 min
      maxBuffer: 2 * 1024 * 1024,
    });

    // Step 3: Docker restart
    const upCmd = `cd ${DOCKER_COMPOSE_DIR} && docker compose up -d ${filtered.join(' ')} 2>&1`;
    const upResult = execSync(upCmd, {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });

    return `Build successful.\n\nBuild output (last 2000 chars):\n${buildResult.slice(-2000)}\n\nDeploy:\n${upResult}`;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `Build failed:\n${e.stderr?.slice(0, 5000) || e.stdout?.slice(0, 5000) || e.message || 'unknown error'}`;
  }
}

async function handleSelfTest(args: Record<string, unknown>): Promise<string> {
  const testFile = args.file ? String(args.file) : '';
  const { execSync } = await import('node:child_process');

  try {
    const cmd = testFile
      ? `cd ${HOST_BOSS_SRC} && npx vitest run ${testFile} --reporter=verbose 2>&1`
      : `cd ${HOST_BOSS_SRC} && npx vitest run --reporter=verbose 2>&1`;

    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    });

    return output.slice(0, 30000);
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const output = (e.stdout || '') + '\n' + (e.stderr || '');
    return `Tests failed:\n${output.slice(0, 15000)}`;
  }
}

async function handleSelfGit(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? '');
  const { execSync } = await import('node:child_process');
  const opts = { cwd: HOST_BOSS_SRC, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 512 * 1024 };

  try {
    switch (action) {
      case 'status':
        return execSync('git status --short', opts) || 'Working tree clean.';

      case 'diff':
        return execSync('git diff --stat', opts).slice(0, 15000) || 'No changes.';

      case 'diff_file': {
        const file = String(args.file ?? '');
        if (!file) return 'Error: file is required for diff_file';
        return execSync(`git diff -- "${file}"`, opts).slice(0, 15000) || 'No changes.';
      }

      case 'log':
        return execSync('git log --oneline -20', opts);

      case 'commit': {
        const message = String(args.message ?? '');
        if (!message) return 'Error: message is required for commit';

        // Always commit to a boss/ branch, never master
        const currentBranch = execSync('git branch --show-current', opts).trim();
        if (currentBranch === 'master' || currentBranch === 'main') {
          const branchName = `boss/self-edit-${Date.now()}`;
          execSync(`git checkout -b "${branchName}"`, opts);
        }

        execSync('git add -A', opts);
        const commitMsg = `${message}\n\nSelf-modified-by: BOS`;
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, opts);

        const branch = execSync('git branch --show-current', opts).trim();
        return `Committed to branch: ${branch}\nMessage: ${message}\n\nKevin must approve merge to master.`;
      }

      case 'branch':
        return execSync('git branch -a', opts);

      case 'checkout': {
        const branch = String(args.branch ?? 'master');
        // Safety: only allow switching to existing branches or boss/ prefixed
        if (!branch.startsWith('boss/') && branch !== 'master' && branch !== 'main') {
          return 'Error: can only checkout master, main, or boss/* branches';
        }
        return execSync(`git checkout "${branch}"`, opts);
      }

      default:
        return `Error: unknown git action "${action}". Valid: status, diff, diff_file, log, commit, branch, checkout`;
    }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `Git error: ${e.stderr || e.message || String(err)}`;
  }
}

async function handleSelfIntrospect(args: Record<string, unknown>): Promise<string> {
  const what = String(args.what ?? 'overview');
  const { execSync } = await import('node:child_process');
  const opts = { cwd: HOST_BOSS_SRC, encoding: 'utf-8' as const, timeout: 15000, maxBuffer: 512 * 1024 };

  switch (what) {
    case 'overview': {
      const lineCount = execSync(
        `find . \\( -name "*.ts" -o -name "*.tsx" \\) -not -path "*/node_modules/*" -not -path "*/dist/*" | xargs wc -l 2>/dev/null | tail -1`,
        opts,
      ).trim();
      const fileCount = execSync(
        `find . \\( -name "*.ts" -o -name "*.tsx" \\) -not -path "*/node_modules/*" -not -path "*/dist/*" | wc -l`,
        opts,
      ).trim();
      const containers = execSync('docker ps --format "table {{.Names}}\\t{{.Status}}" 2>/dev/null | grep boss || echo "no containers"', opts).trim();
      const gitLog = execSync('git log --oneline -5', opts).trim();

      return [
        `BOS Codebase Overview:`,
        `Total: ${lineCount.split(/\s+/)[0]} lines across ${fileCount} files`,
        ``,
        `Recent commits:`,
        gitLog,
        ``,
        `Running containers:`,
        containers,
      ].join('\n');
    }

    case 'tools': {
      const toolCount = execSync(`grep -c "boss_" ${HOST_BOSS_SRC}/apps/api/src/tools/executor.ts | head -1 || echo 0`, opts).trim();
      return `Total tool references in executor: ${toolCount}. Use boss_self_grep to search for specific tools.`;
    }

    case 'errors': {
      const logs = execSync('docker compose logs api --tail 50 2>&1 | grep -i "error\\|warn\\|fail" || echo "No recent errors"', opts).trim();
      return logs.slice(0, 10000);
    }

    default:
      return `Error: unknown introspection target "${what}". Valid: overview, tools, errors`;
  }
}

// ── TTS handler ─────────────────────────────────────────────────────────────

async function handleTtsSpeak(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '');
  if (!text) return 'Error: text is required';

  const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return 'Error: Google API key not configured for TTS.';

  const voice = String(args.voice ?? 'en-US-Wavenet-J');
  const speed = Number(args.speed ?? 1.0);

  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: text.substring(0, 4000) },
      voice: { languageCode: 'en-US', name: voice },
      audioConfig: { audioEncoding: 'MP3', speakingRate: speed },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return `TTS error: ${res.status}`;
  const data = await res.json() as { audioContent: string };
  return `[AUDIO]\ndata:audio/mp3;base64,${data.audioContent}\n[/AUDIO]\nSpoke ${text.length} characters.`;
}

// ── GitHub handlers ─────────────────────────────────────────────────────────

const GH_API = 'https://api.github.com';
function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? '';
  return {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BOS-AIOS/2.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ghFetch(path: string): Promise<unknown> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.substring(0, 300)}`);
  }
  return res.json();
}

async function handleGithubSearchRepos(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const max = Math.min(Number(args.max_results ?? 5), 20);
  if (!query) return 'Error: query is required';

  const data = await ghFetch(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${max}`) as {
    total_count: number; items: Array<{ full_name: string; description: string; stargazers_count: number; language: string; updated_at: string; html_url: string }>;
  };

  if (!data.items?.length) return `No repositories found for "${query}"`;
  const lines = [`${data.total_count} repos found (showing ${data.items.length}):\n`];
  for (const r of data.items) {
    lines.push(`• ${r.full_name} — ${r.stargazers_count}★ ${r.language ?? ''}`);
    if (r.description) lines.push(`  ${r.description.substring(0, 150)}`);
    lines.push(`  ${r.html_url}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function handleGithubSearchCode(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const max = Math.min(Number(args.max_results ?? 5), 20);
  if (!query) return 'Error: query is required';

  const data = await ghFetch(`/search/code?q=${encodeURIComponent(query)}&per_page=${max}`) as {
    total_count: number; items: Array<{ name: string; path: string; repository: { full_name: string }; html_url: string }>;
  };

  if (!data.items?.length) return `No code matches for "${query}"`;
  const lines = [`${data.total_count} code matches (showing ${data.items.length}):\n`];
  for (const r of data.items) {
    lines.push(`• ${r.repository.full_name}/${r.path}`);
    lines.push(`  ${r.html_url}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function handleGithubReadFile(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? '');
  const filePath = String(args.path ?? '');
  const ref = String(args.ref ?? 'main');
  if (!owner || !repo || !filePath) return 'Error: owner, repo, and path are required';

  const data = await ghFetch(`/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`) as {
    content?: string; encoding?: string; size: number; name: string;
  };

  if (!data.content) return `File not found or is a directory: ${filePath}`;
  if (data.encoding === 'base64') {
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    if (content.length > 50_000) {
      return `${data.name} (${data.size} bytes, truncated):\n\n${content.substring(0, 50_000)}\n\n[truncated]`;
    }
    return `${data.name} (${data.size} bytes):\n\n${content}`;
  }
  return data.content;
}

async function handleGithubListRepos(args: Record<string, unknown>): Promise<string> {
  const org = args.org as string | undefined;
  const sort = String(args.sort ?? 'updated');
  const max = Math.min(Number(args.max_results ?? 10), 50);

  const path = org ? `/orgs/${org}/repos?sort=${sort}&per_page=${max}` : `/user/repos?sort=${sort}&per_page=${max}`;
  const data = await ghFetch(path) as Array<{ full_name: string; description: string; private: boolean; language: string; updated_at: string }>;

  if (!data.length) return org ? `No repos found for org "${org}"` : 'No repositories found.';
  const lines = [`${data.length} repositories:\n`];
  for (const r of data) {
    lines.push(`• ${r.full_name} ${r.private ? '[private]' : '[public]'} ${r.language ?? ''}`);
    if (r.description) lines.push(`  ${r.description.substring(0, 120)}`);
    lines.push(`  Updated: ${new Date(r.updated_at).toLocaleDateString()}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function handleGithubListIssues(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? '');
  const state = String(args.state ?? 'open');
  const max = Math.min(Number(args.max_results ?? 10), 50);
  if (!owner || !repo) return 'Error: owner and repo are required';

  const data = await ghFetch(`/repos/${owner}/${repo}/issues?state=${state}&per_page=${max}`) as
    Array<{ number: number; title: string; state: string; user: { login: string }; created_at: string; labels: Array<{ name: string }>; pull_request?: unknown }>;

  if (!data.length) return `No ${state} issues in ${owner}/${repo}`;
  const issues = data.filter(i => !i.pull_request);
  const prs = data.filter(i => i.pull_request);

  const lines: string[] = [];
  if (issues.length) {
    lines.push(`Issues (${issues.length}):\n`);
    for (const i of issues) {
      const labels = i.labels.map(l => l.name).join(', ');
      lines.push(`• #${i.number} ${i.title} [${i.state}] by ${i.user.login}${labels ? ` (${labels})` : ''}`);
    }
    lines.push('');
  }
  if (prs.length) {
    lines.push(`Pull Requests (${prs.length}):\n`);
    for (const p of prs) {
      lines.push(`• #${p.number} ${p.title} [${p.state}] by ${p.user.login}`);
    }
  }
  return lines.join('\n').trim() || `No results in ${owner}/${repo}`;
}

async function handleGithubRepoTree(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? '');
  const dirPath = String(args.path ?? '');
  const ref = String(args.ref ?? 'main');
  if (!owner || !repo) return 'Error: owner and repo are required';

  const path = dirPath ? `/repos/${owner}/${repo}/contents/${dirPath}?ref=${ref}` : `/repos/${owner}/${repo}/contents?ref=${ref}`;
  const data = await ghFetch(path) as Array<{ name: string; type: string; size: number; path: string }>;

  if (!Array.isArray(data)) return 'Not a directory or repo not found.';
  const lines = [`${owner}/${repo}${dirPath ? '/' + dirPath : ''} (${data.length} items):\n`];
  const dirs = data.filter(d => d.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
  const files = data.filter(d => d.type === 'file').sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) lines.push(`  ${d.name}/`);
  for (const f of files) {
    const size = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
    lines.push(`  ${f.name} (${size})`);
  }
  return lines.join('\n').trim();
}

// ── vS.0.2 — CI/PR introspection handlers ────────────────────────────────────

async function handleGithubWorkflowRuns(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const max = Math.min(Number(args.max_results ?? 10), 20);
  const status = args.status ? `&status=${args.status}` : '';

  const data = await ghFetch(`/repos/${owner}/${repo}/actions/runs?per_page=${max}${status}`) as {
    total_count: number;
    workflow_runs: Array<{
      id: number; name: string; status: string; conclusion: string | null;
      head_branch: string; created_at: string; html_url: string; run_number: number;
    }>;
  };

  const runs = data.workflow_runs ?? [];
  if (!runs.length) return 'No workflow runs found.';

  const lines = [`${data.total_count} total runs (showing ${runs.length}):\n`];
  for (const r of runs) {
    const icon = r.conclusion === 'success' ? 'PASS' : r.conclusion === 'failure' ? 'FAIL' : r.status;
    lines.push(`  [${icon}] #${r.run_number} ${r.name} (${r.head_branch}) — ${r.created_at}`);
    lines.push(`         ID: ${r.id} | ${r.html_url}`);
  }
  return lines.join('\n').trim();
}

async function handleGithubWorkflowRunLogs(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const runId = Number(args.run_id);
  if (!runId) return 'Error: run_id is required';

  // Get jobs for this run (logs are per-job)
  const jobsData = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`) as {
    jobs: Array<{ id: number; name: string; status: string; conclusion: string | null; steps: Array<{ name: string; status: string; conclusion: string | null }> }>;
  };

  const jobs = jobsData.jobs ?? [];
  if (!jobs.length) return `No jobs found for run ${runId}`;

  const lines = [`Run ${runId} — ${jobs.length} job(s):\n`];
  for (const job of jobs) {
    const icon = job.conclusion === 'success' ? 'PASS' : job.conclusion === 'failure' ? 'FAIL' : job.status;
    lines.push(`[${icon}] ${job.name}`);
    for (const step of (job.steps ?? [])) {
      const sIcon = step.conclusion === 'success' ? 'ok' : step.conclusion === 'failure' ? 'FAIL' : step.status;
      lines.push(`  ${sIcon}: ${step.name}`);
    }
    lines.push('');
  }

  // If any job failed, try to fetch its log (text, truncated)
  const failedJob = jobs.find(j => j.conclusion === 'failure');
  if (failedJob) {
    try {
      const token = process.env.GITHUB_TOKEN ?? '';
      const logRes = await fetch(`${GH_API}/repos/${owner}/${repo}/actions/jobs/${failedJob.id}/logs`, {
        headers: { ...ghHeaders(), Accept: 'application/vnd.github.v3+json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      if (logRes.ok) {
        const logText = await logRes.text();
        lines.push(`\n--- Failed job "${failedJob.name}" log (last 5000 chars) ---`);
        lines.push(logText.slice(-5000));
      }
    } catch {
      lines.push(`(Could not fetch log for failed job ${failedJob.id})`);
    }
  }

  return lines.join('\n').trim();
}

async function handleGithubPrComments(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const prNum = Number(args.pr_number);
  if (!prNum) return 'Error: pr_number is required';

  // Get both review comments (inline) and issue comments (general)
  const [reviewComments, issueComments] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/pulls/${prNum}/comments`) as Promise<
      Array<{ user: { login: string }; body: string; path: string; line: number | null; created_at: string }>
    >,
    ghFetch(`/repos/${owner}/${repo}/issues/${prNum}/comments`) as Promise<
      Array<{ user: { login: string }; body: string; created_at: string }>
    >,
  ]);

  const lines: string[] = [];

  if (reviewComments.length > 0) {
    lines.push(`${reviewComments.length} inline review comment(s):\n`);
    for (const c of reviewComments) {
      lines.push(`  @${c.user.login} on ${c.path}${c.line ? `:${c.line}` : ''} (${c.created_at})`);
      lines.push(`  ${c.body.substring(0, 500)}`);
      lines.push('');
    }
  }

  if (issueComments.length > 0) {
    lines.push(`${issueComments.length} general comment(s):\n`);
    for (const c of issueComments) {
      lines.push(`  @${c.user.login} (${c.created_at})`);
      lines.push(`  ${c.body.substring(0, 500)}`);
      lines.push('');
    }
  }

  if (lines.length === 0) return `No comments on PR #${prNum}.`;
  return lines.join('\n').trim();
}

async function handleGithubPrStatus(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const prNum = Number(args.pr_number);
  if (!prNum) return 'Error: pr_number is required';

  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNum}`) as {
    title: string; state: string; mergeable: boolean | null; mergeable_state: string;
    labels: Array<{ name: string }>; user: { login: string }; head: { ref: string };
    base: { ref: string }; additions: number; deletions: number; changed_files: number;
    created_at: string; updated_at: string;
  };

  const reviews = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNum}/reviews`) as
    Array<{ user: { login: string }; state: string; submitted_at: string }>;

  // Get check runs for the PR's head SHA
  const headSha = ((await ghFetch(`/repos/${owner}/${repo}/pulls/${prNum}`) as { head: { sha: string } }).head.sha);
  const checks = await ghFetch(`/repos/${owner}/${repo}/commits/${headSha}/check-runs`) as {
    total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
  };

  const lines = [
    `PR #${prNum}: ${pr.title}`,
    `  State: ${pr.state} | Mergeable: ${pr.mergeable ?? 'unknown'} (${pr.mergeable_state})`,
    `  Branch: ${pr.head.ref} → ${pr.base.ref}`,
    `  Author: @${pr.user.login} | +${pr.additions}/-${pr.deletions} in ${pr.changed_files} files`,
    `  Labels: ${pr.labels.map(l => l.name).join(', ') || 'none'}`,
    `  Created: ${pr.created_at} | Updated: ${pr.updated_at}`,
    '',
  ];

  if (reviews.length > 0) {
    lines.push(`Reviews (${reviews.length}):`);
    for (const r of reviews) {
      lines.push(`  @${r.user.login}: ${r.state} (${r.submitted_at})`);
    }
    lines.push('');
  }

  if (checks.check_runs?.length > 0) {
    lines.push(`CI Checks (${checks.total_count}):`);
    for (const c of checks.check_runs) {
      const icon = c.conclusion === 'success' ? 'PASS' : c.conclusion === 'failure' ? 'FAIL' : c.status;
      lines.push(`  [${icon}] ${c.name}`);
    }
  } else {
    lines.push('CI Checks: none');
  }

  return lines.join('\n').trim();
}

async function handleGithubOpenIssue(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const title = String(args.title ?? '');
  const body = String(args.body ?? '');
  if (!title) return 'Error: title is required';

  const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];

  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) return 'Error: GITHUB_TOKEN not configured';

  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    return `Error creating issue: ${res.status} — ${text.substring(0, 300)}`;
  }

  const issue = (await res.json()) as { number: number; html_url: string };
  return `Issue #${issue.number} created: ${issue.html_url}`;
}

// ── vS.0.3 — BOS opens her own PRs ──────────────────────────────────────

async function handleGithubOpenPr(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const title = String(args.title ?? '');
  const body = String(args.body ?? '');
  const head = String(args.head ?? '');
  const base = String(args.base || 'master');
  if (!title) return 'Error: title is required';
  if (!head) return 'Error: head branch is required';

  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) return 'Error: GITHUB_TOKEN not configured';

  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    return `Error creating PR: ${res.status} — ${text.substring(0, 400)}`;
  }

  const pr = (await res.json()) as { number: number; html_url: string };
  return `PR #${pr.number} created: ${pr.html_url}`;
}

async function handleGithubRequestReview(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const prNum = Number(args.pr_number);
  if (!prNum) return 'Error: pr_number is required';

  const reviewers = Array.isArray(args.reviewers) ? args.reviewers.map(String) : ['TCntryPrd'];

  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) return 'Error: GITHUB_TOKEN not configured';

  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${prNum}/requested_reviewers`, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewers }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    return `Error requesting review: ${res.status} — ${text.substring(0, 300)}`;
  }

  return `Review requested from ${reviewers.join(', ')} on PR #${prNum}`;
}

async function handleGithubPrComment(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const prNum = Number(args.pr_number);
  const body = String(args.body ?? '');
  if (!prNum) return 'Error: pr_number is required';
  if (!body) return 'Error: body is required';

  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) return 'Error: GITHUB_TOKEN not configured';

  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/issues/${prNum}/comments`, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    return `Error posting comment: ${res.status} — ${text.substring(0, 300)}`;
  }

  const comment = (await res.json()) as { id: number; html_url: string };
  return `Comment posted on PR #${prNum}: ${comment.html_url}`;
}

// ── vS.0.5 — Self-deploy handlers ──────────────────────────────────────────

const ALLOWED_TAG_PATTERNS = [/^vS\.\d+/, /^vD\.\d+/];

async function handleGithubPushTag(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const tag = String(args.tag ?? '');
  const message = String(args.message ?? '');
  if (!tag) return 'Error: tag is required';
  if (!message) return 'Error: message is required';

  // Safety gate: only allow vS.* and vD.* tags
  if (!ALLOWED_TAG_PATTERNS.some(p => p.test(tag))) {
    return `Error: tag "${tag}" not allowed. BOS can only push vS.* and vD.* tags. v1.*/v2.* tags are Kevin-only.`;
  }

  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) return 'Error: GITHUB_TOKEN not configured';

  // Get the SHA to tag (default: master HEAD)
  let sha = String(args.sha ?? '');
  if (!sha) {
    const ref = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/master`) as { object: { sha: string } };
    sha = ref.object.sha;
  }

  // Create annotated tag object
  const tagObj = await fetch(`${GH_API}/repos/${owner}/${repo}/git/tags`, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag,
      message,
      object: sha,
      type: 'commit',
      tagger: {
        name: 'BOS',
        email: 'boss@starrpartners.ai',
        date: new Date().toISOString(),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!tagObj.ok) {
    const text = await tagObj.text();
    return `Error creating tag object: ${tagObj.status} — ${text.substring(0, 300)}`;
  }

  const tagData = (await tagObj.json()) as { sha: string };

  // Create the ref pointing to the tag object
  const refRes = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: tagData.sha }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!refRes.ok) {
    const text = await refRes.text();
    return `Error creating tag ref: ${refRes.status} — ${text.substring(0, 300)}`;
  }

  return `Tag ${tag} pushed to ${owner}/${repo} (commit: ${sha.substring(0, 8)})`;
}

async function handleGithubReleaseNotes(args: Record<string, unknown>): Promise<string> {
  const owner = String(args.owner || 'TCntryPrd');
  const repo = String(args.repo || 'boss-dev');
  const toRef = String(args.to_ref || 'master');

  let sinceTag = String(args.since_tag ?? '');

  // Auto-detect last tag if not provided
  if (!sinceTag) {
    const tags = await ghFetch(`/repos/${owner}/${repo}/tags?per_page=1`) as Array<{ name: string }>;
    if (tags.length > 0) {
      sinceTag = tags[0].name;
    } else {
      return 'Error: no tags found and since_tag not provided';
    }
  }

  // Get commits between tags
  const comparison = await ghFetch(
    `/repos/${owner}/${repo}/compare/${sinceTag}...${toRef}`,
  ) as {
    total_commits: number;
    commits: Array<{ sha: string; commit: { message: string; author: { date: string } } }>;
  };

  if (!comparison.commits?.length) return `No commits between ${sinceTag} and ${toRef}.`;

  // Group by conventional commit prefix
  const groups: Record<string, string[]> = {};
  for (const c of comparison.commits) {
    const msg = c.commit.message.split('\n')[0]; // first line only
    const match = msg.match(/^(feat|fix|docs|chore|refactor|test|ci|perf)\b/i);
    const category = match ? match[1].toLowerCase() : 'other';
    (groups[category] ??= []).push(`- ${msg} (${c.sha.substring(0, 7)})`);
  }

  const lines = [`## Release Notes: ${sinceTag} → ${toRef}\n`, `${comparison.total_commits} commit(s)\n`];
  const order = ['feat', 'fix', 'refactor', 'docs', 'chore', 'test', 'ci', 'perf', 'other'];
  for (const cat of order) {
    if (groups[cat]?.length) {
      lines.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
      lines.push(...groups[cat]);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

// ── YouTube handlers ────────────────────────────────────────────────────────

async function handleYoutubeSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  const maxResults = Math.min(Math.max(Number(args.max_results ?? 5), 1), 20);
  if (!query) return 'Error: query is required';

  // Use YouTube Data API v3 if key available, otherwise use innertube search
  const apiKey = process.env.YOUTUBE_API_KEY || process.env.GEMINI_API_KEY; // Google API keys work for YouTube too
  if (!apiKey) return 'Error: No YouTube/Google API key configured. Add YOUTUBE_API_KEY or use your GEMINI_API_KEY (same Google API key works).';

  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(maxResults),
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    return `YouTube API error (${res.status}): ${text.substring(0, 300)}`;
  }

  const data = await res.json() as {
    items?: Array<{
      id: { videoId: string };
      snippet: { title: string; channelTitle: string; publishedAt: string; description: string };
    }>;
  };

  if (!data.items?.length) return `No videos found for "${query}"`;

  const lines = [`YouTube results for "${query}":\n`];
  for (const item of data.items) {
    lines.push(`• ${item.snippet.title}`);
    lines.push(`  Channel: ${item.snippet.channelTitle}`);
    lines.push(`  Published: ${new Date(item.snippet.publishedAt).toLocaleDateString()}`);
    lines.push(`  ID: ${item.id.videoId}`);
    lines.push(`  URL: https://youtube.com/watch?v=${item.id.videoId}`);
    if (item.snippet.description) {
      lines.push(`  ${item.snippet.description.substring(0, 150).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function handleYoutubeTranscript(args: Record<string, unknown>): Promise<string> {
  let videoId = String(args.video_id ?? '');
  if (!videoId) return 'Error: video_id is required';

  // Extract video ID from URL if needed
  const urlMatch = videoId.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  if (urlMatch) videoId = urlMatch[1];
  if (videoId.length > 11) videoId = videoId.substring(0, 11);

  // Fetch the video page to get caption track info
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BOS/2.0)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!pageRes.ok) return `Error fetching video page: ${pageRes.status}`;

    const html = await pageRes.text();

    // Extract captions URL from the page's player response
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) {
      return 'No captions/transcript available for this video. The creator may not have enabled subtitles.';
    }

    let tracks;
    try {
      tracks = JSON.parse(captionMatch[1]) as Array<{ baseUrl: string; languageCode: string; name?: { simpleText?: string } }>;
    } catch {
      return 'Error parsing caption data from YouTube.';
    }

    if (!tracks.length) return 'No caption tracks found.';

    // Prefer English, fall back to first track
    const englishTrack = tracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en'));
    const track = englishTrack ?? tracks[0];

    // Fetch the caption XML
    const captionRes = await fetch(track.baseUrl, { signal: AbortSignal.timeout(15_000) });
    if (!captionRes.ok) return `Error fetching captions: ${captionRes.status}`;

    const xml = await captionRes.text();

    // Parse XML to extract text (simple regex — YouTube captions are well-formed)
    const textParts: string[] = [];
    const regex = /<text[^>]*>(.*?)<\/text>/gs;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      let text = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, ' ')
        .trim();
      if (text) textParts.push(text);
    }

    if (textParts.length === 0) return 'Transcript is empty — captions exist but contain no text.';

    const transcript = textParts.join(' ');
    const langLabel = track.name?.simpleText ?? track.languageCode ?? 'unknown';

    if (transcript.length > 100_000) {
      return `Transcript (${langLabel}, truncated to 100K chars):\n\n${transcript.substring(0, 100_000)}\n\n[... truncated]`;
    }
    return `Transcript (${langLabel}, ${textParts.length} segments):\n\n${transcript}`;
  } catch (err) {
    return `Error fetching transcript: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Memory handlers ─────────────────────────────────────────────────────────

async function handleMemorySave(args: Record<string, unknown>): Promise<string> {
  const category = String(args.category ?? 'fact');
  const content = String(args.content ?? '');
  const confidence = Number(args.confidence ?? 0.8);
  if (!content) return 'Error: content is required';

  const pool = getPool();
  await pool.query(
    `INSERT INTO boss_memory (category, content, source, confidence, conversation_id)
     VALUES ($1, $2, 'explicit', $3, 'brain-tool')`,
    [category, content, Math.max(0, Math.min(1, confidence))],
  );
  return `Saved to memory (${category}): ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`;
}

async function handleMemoryRecall(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').toLowerCase();
  const category = args.category as string | undefined;
  const limit = Math.min(Number(args.limit ?? 10), 50);
  if (!query) return 'Error: query is required';

  const pool = getPool();
  const params: unknown[] = [`%${query}%`, limit];
  let sql = `SELECT id, category, content, confidence, created_at FROM boss_memory WHERE LOWER(content) LIKE $1`;
  if (category) {
    sql += ` AND category = $${params.length + 1}`;
    params.push(category);
  }
  sql += ` ORDER BY confidence DESC, created_at DESC LIMIT $2`;

  const { rows } = await pool.query(sql, params);
  if (rows.length === 0) return `No memories found matching "${args.query}"`;

  // Update access stats
  const ids = rows.map((r: { id: number }) => r.id);
  await pool.query(
    `UPDATE boss_memory SET last_accessed = now(), access_count = access_count + 1 WHERE id = ANY($1)`,
    [ids],
  );

  const lines = rows.map((r: { category: string; content: string; confidence: number; created_at: string }, i: number) =>
    `${i + 1}. [${r.category}] (${Math.round(r.confidence * 100)}%) ${r.content}\n   Saved: ${new Date(r.created_at).toLocaleDateString()}`
  );
  return `Found ${rows.length} memor${rows.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n\n')}`;
}

async function handleMemoryList(args: Record<string, unknown>): Promise<string> {
  const category = args.category as string | undefined;
  const limit = Math.min(Number(args.limit ?? 20), 100);

  const pool = getPool();
  const params: unknown[] = [limit];
  let sql = `SELECT id, category, content, confidence, created_at, access_count FROM boss_memory`;
  if (category) {
    sql += ` WHERE category = $${params.length + 1}`;
    params.push(category);
  }
  sql += ` ORDER BY created_at DESC LIMIT $1`;

  const { rows } = await pool.query(sql, params);
  if (rows.length === 0) return category ? `No memories in category "${category}"` : 'Memory is empty.';

  const lines = rows.map((r: { category: string; content: string; confidence: number; access_count: number; created_at: string }, i: number) =>
    `${i + 1}. [${r.category}] ${r.content}\n   Confidence: ${Math.round(r.confidence * 100)}% | Accessed: ${r.access_count}x | Saved: ${new Date(r.created_at).toLocaleDateString()}`
  );
  return `${rows.length} memor${rows.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n\n')}`;
}

// ── System monitoring handlers ───────────────────────────────────────────────

async function handleSysInfo(): Promise<string> {
  // Read system info by executing the host script via the mounted volume
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  try {
    const { stdout } = await exec('/bin/sh', ['/data/home/boss-dev/scripts/sys-info.sh'], { timeout: 15_000 });
    // Parse and format
    try {
      const info = JSON.parse(stdout);
      const lines = [
        `Server: ${info.hostname}`,
        `OS: ${info.os} (kernel ${info.kernel})`,
        `Uptime: ${info.uptime}`,
        `CPU: ${info.cpu} (${info.cpu_cores} cores)`,
        `Load: ${info.load}`,
        `Memory: ${info.memory_used_mb}MB / ${info.memory_total_mb}MB (${info.memory_pct}%)`,
        `Disk: ${info.disk_used} / ${info.disk_total} (${info.disk_pct} used, ${info.disk_avail} free)`,
        `Tailscale: ${info.tailscale_hostname} (${info.tailscale_ip})`,
        `Updates available: ${info.updates_available}`,
        '',
        'Docker containers:',
      ];
      for (const c of info.docker_containers ?? []) {
        lines.push(`  ${c.name}: ${c.status} (${c.image})`);
      }
      return lines.join('\n');
    } catch {
      return stdout;
    }
  } catch (err) {
    return `Error getting system info: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleSysUpdates(): Promise<string> {
  const fs = await import('node:fs');
  const statusFile = '/data/home/boss-dev/scripts/updates-check.txt';
  try {
    const content = fs.readFileSync(statusFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.includes('upgradable'));
    if (lines.length === 0) return 'System is up to date. No packages need upgrading.';
    return `${lines.length} packages can be upgraded:\n\n${lines.join('\n')}`;
  } catch {
    return 'Update status file not found. The cron job that writes it may not have run yet.';
  }
}

async function handleSysDocker(): Promise<string> {
  const fs = await import('node:fs');
  try {
    return fs.readFileSync('/data/home/boss-dev/scripts/docker-status.txt', 'utf-8');
  } catch {
    return 'Docker status file not found. The cron job that writes it may not have run yet.';
  }
}

async function handleSysServices(): Promise<string> {
  try {
    const fs = await import('node:fs');
    // Read from a status file that a cron job keeps updated
    const statusFile = '/data/home/boss-dev/scripts/services-status.txt';
    if (fs.existsSync(statusFile)) {
      return fs.readFileSync(statusFile, 'utf-8');
    }
    return 'Service status not available. Set up a cron job to write status to ~/boss-dev/scripts/services-status.txt';
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Tool handler map ─────────────────────────────────────────────────────────

// ── Employee Agents ops + cost report (for the COO) ──────────────────────────
async function handleEmployeeAgentsReport(_args: Record<string, unknown>): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT a.name, a.status, a.cron_expression, a.model, a.last_run_at, a.run_count, a.error_count,
           coalesce(r.runs_24h, 0) AS runs_24h,
           coalesce(r.cost_24h, 0) AS cost_24h,
           coalesce(r.cost_7d, 0)  AS cost_7d,
           r.last_status,
           left(coalesce(a.last_result, ''), 400) AS last_result
      FROM boss_persistent_agents a
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE finished_at > now() - interval '24 hours') AS runs_24h,
               coalesce(sum(cost_usd) FILTER (WHERE finished_at > now() - interval '24 hours'), 0) AS cost_24h,
               coalesce(sum(cost_usd) FILTER (WHERE finished_at > now() - interval '7 days'), 0)   AS cost_7d,
               (array_agg(status ORDER BY finished_at DESC))[1] AS last_status
          FROM boss_agent_runs WHERE agent_id = a.id
      ) r ON true
     ORDER BY a.name
  `);
  if (rows.length === 0) return 'No Employee Agents registered.';
  const lines = (rows as Array<Record<string, unknown>>).map((a) => {
    const last = a.last_run_at ? new Date(a.last_run_at as string).toISOString() : 'never';
    const cost24 = Number(a.cost_24h ?? 0).toFixed(4);
    const cost7 = Number(a.cost_7d ?? 0).toFixed(4);
    return `• ${a.name} [${a.status}] cron=${a.cron_expression} model=${a.model ?? '-'}\n` +
      `   last run: ${last} (${a.last_status ?? '-'}); runs ${a.run_count} ok / ${a.error_count} err; 24h runs: ${a.runs_24h}\n` +
      `   cost: $${cost24} (24h) / $${cost7} (7d)\n` +
      `   last report: ${String(a.last_result ?? '').slice(0, 300)}`;
  });
  return `Employee Agents — ops + cost report:\n\n${lines.join('\n\n')}`;
}

// ── Email log write (email agent persists processed mail for the dashboard) ───
async function handleEmailLogWrite(args: Record<string, unknown>): Promise<string> {
  const messageId = String(args.message_id ?? '');
  if (!messageId) return 'Error: message_id is required';
  const pool = getPool();
  const invAmt = args.invoice_amount != null ? Number(args.invoice_amount) : null;
  await pool.query(
    `INSERT INTO boss_email_log
       (message_id, account_email, sender, subject, category, needs_attention, action_taken,
        draft_content, invoice_amount, invoice_due_date, golden_nugget, boss_notes, received_at, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now())`,
    [
      messageId,
      String(args.account_email ?? ''),
      String(args.sender ?? ''),
      String(args.subject ?? ''),
      String(args.category ?? 'other'),
      args.needs_attention === true,
      args.action_taken != null ? String(args.action_taken) : null,
      args.draft_created === true ? '[draft created]' : null,
      invAmt != null && Number.isFinite(invAmt) ? invAmt : null,
      args.invoice_due_date ? String(args.invoice_due_date) : null,
      args.golden_nugget != null ? String(args.golden_nugget) : null,
      args.boss_notes != null ? String(args.boss_notes) : null,
    ],
  );
  return `Logged email ${messageId} (${args.category}${args.needs_attention === true ? ', needs attention' : ''}).`;
}

import { handleHealthBrief, handleHealthSummary } from './health.js';
import { VALIDATOR_TOOL_HANDLERS } from './validator.js';
import { TRIAGE_TOOL_HANDLERS } from './triage-reason.js';
import { FINANCIAL_TOOL_HANDLERS } from './financial-reason.js';
import { AGENT_EVAL_TOOL_HANDLERS } from './agent-evals.js';
import { CLIENT_ROUTING_TOOL_HANDLERS } from './client-routing.js';
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // Health (read-only brief + daily summary over health_daily)
  boss_health_brief: handleHealthBrief,
  boss_health_summary: handleHealthSummary,
  ...VALIDATOR_TOOL_HANDLERS,
  ...TRIAGE_TOOL_HANDLERS,
  ...FINANCIAL_TOOL_HANDLERS,
  ...AGENT_EVAL_TOOL_HANDLERS,
  ...CLIENT_ROUTING_TOOL_HANDLERS,
  // ── Google Workspace ──────────────────────────────────────────────────────
  boss_calendar_today: handleCalendarToday,
  boss_calendar_upcoming: handleCalendarUpcoming,
  boss_calendar_create: handleCalendarCreate,
  boss_gmail_unread: handleGmailUnread,
  boss_gmail_search: handleGmailSearch,
  boss_gmail_send: handleGmailSend,
  boss_gmail_read: handleGmailRead,
  boss_gmail_archive: handleGmailArchive,
  boss_gmail_mark_read: handleGmailMarkRead,
  boss_gmail_label: handleGmailLabel,
  boss_gmail_reply: handleGmailReply,
  boss_gmail_draft: handleGmailDraft,
  boss_gmail_draft_reply: handleGmailDraftReply,
  boss_gmail_quick_ack: handleGmailQuickAck,
  boss_tasks_pending: handleTasksPending,
  boss_tasks_create: handleTasksCreate,
  boss_tasks_complete: handleTasksComplete,
  boss_tasks_delete: handleTasksDelete,
  boss_drive_search: handleDriveSearch,
  boss_drive_recent: handleDriveRecent,
  boss_drive_read_doc: handleDriveReadDoc,
  boss_drive_create_doc: handleDriveCreateDoc,
  boss_google_registry: handleGoogleRegistry,
  boss_google_usage: handleGoogleUsage,
  boss_contacts_search: handleContactsSearch,
  // ── n8n ───────────────────────────────────────────────────────────────────
  boss_n8n_list_workflows: handleN8nListWorkflows,
  boss_n8n_get_workflow: handleN8nGetWorkflow,
  boss_n8n_run_workflow: handleN8nRunWorkflow,
  boss_n8n_recent_executions: handleN8nRecentExecutions,
  boss_n8n_create_workflow: handleN8nCreateWorkflow,
  boss_n8n_update_workflow: handleN8nUpdateWorkflow,
  boss_n8n_activate_workflow: handleN8nActivateWorkflow,
  boss_n8n_deactivate_workflow: handleN8nDeactivateWorkflow,
  boss_n8n_delegate: handleN8nDelegate,
  boss_n8n_search_templates: handleN8nSearchTemplates,
  boss_n8n_get_template: handleN8nGetTemplate,
  boss_read_local_file: handleReadLocalFile,
  // ── Home Assistant ────────────────────────────────────────────────────────
  boss_ha_list_devices: handleHaListDevices,
  boss_ha_get_state: handleHaGetState,
  boss_ha_turn_on: handleHaTurnOn,
  boss_ha_turn_off: handleHaTurnOff,
  boss_ha_set_brightness: handleHaSetBrightness,
  boss_ha_run_automation: handleHaRunAutomation,
  // ── Slack ─────────────────────────────────────────────────────────────────
  boss_slack_list_channels: handleSlackListChannels,
  boss_slack_read_channel: handleSlackReadChannel,
  boss_slack_send_message: handleSlackSendMessage,
  boss_slack_search: handleSlackSearch,
  // ── Meta (Facebook / Instagram / Threads / WhatsApp Cloud / Ads) ────────────
  ...META_TOOL_HANDLERS,
  // ── LinkedIn ────────────────────────────────────────────────────────────────
  ...LINKEDIN_TOOL_HANDLERS,
  // ── Email draft rating + learning ───────────────────────────────────────────
  ...EMAIL_DRAFT_TOOL_HANDLERS,
  // ── Telegram ──────────────────────────────────────────────────────────────
  boss_telegram_get_updates: handleTelegramGetUpdates,
  boss_telegram_send_message: handleTelegramSendMessage,
  boss_telegram_send_and_wait: handleTelegramSendAndWait,
  boss_telegram_list_chats: handleTelegramListChats,
  // ── Notion ────────────────────────────────────────────────────────────────
  boss_notion_search: handleNotionSearch,
  boss_notion_get_page: handleNotionGetPage,
  boss_notion_create_page: handleNotionCreatePage,
  boss_notion_list_databases: handleNotionListDatabases,
  // ── Airtable ──────────────────────────────────────────────────────────────
  boss_airtable_list_bases: (_args) => handleAirtableListBases(),
  boss_airtable_list_records: handleAirtableListRecords,
  boss_airtable_create_record: handleAirtableCreateRecord,
  boss_airtable_create_base: handleAirtableCreateBase,
  boss_airtable_create_table: handleAirtableCreateTable,
  boss_airtable_search: handleAirtableSearch,
  // ── Make.com ──────────────────────────────────────────────────────────────
  boss_make_list_orgs: handleMakeListOrgs,
  boss_make_list_teams: handleMakeListTeams,
  boss_make_list_scenarios: handleMakeListScenarios,
  boss_make_run_scenario: handleMakeRunScenario,
  boss_make_recent_executions: handleMakeRecentExecutions,
  boss_make_get_scenario: handleMakeGetScenario,
  boss_make_activate: handleMakeActivate,
  boss_make_deactivate: handleMakeDeactivate,
  boss_make_create_scenario: handleMakeCreateScenario,
  boss_make_update_scenario: handleMakeUpdateScenario,
  // ── Gemini ────────────────────────────────────────────────────────────────
  boss_image_generate: handleGeminiImageGenerate,
  boss_image_edit: handleGeminiImageEdit,
  boss_image_describe: handleGeminiImageDescribe,
  // ── Stripe ────────────────────────────────────────────────────────────────
  boss_stripe_list_customers: handleStripeListCustomers,
  boss_stripe_list_invoices: handleStripeListInvoices,
  boss_stripe_list_payments: handleStripeListPayments,
  boss_stripe_get_balance: handleStripeGetBalance,
  boss_stripe_create_invoice: handleStripeCreateInvoice,
  // ── Sub-agent spawning (always available — no API key gate) ───────────────
  boss_spawn_agent: handleSpawnAgent,
  boss_spawn_parallel: handleSpawnParallel,
  // ── Email agent (always available — reads internal Postgres log) ───────────
  boss_email_attention: handleEmailAttention,
  boss_email_digest: handleEmailDigest,
  boss_email_log_write: handleEmailLogWrite,
  boss_employee_agents_report: handleEmployeeAgentsReport,
  // ── Filesystem (always available — reads/writes local project files) ─────
  // ── TTS ─────────────────────────────────────────────────────────────────
  boss_tts_speak: handleTtsSpeak,
  // ── GitHub ──────────────────────────────────────────────────────────────
  boss_github_search_repos: handleGithubSearchRepos,
  boss_github_search_code: handleGithubSearchCode,
  boss_github_read_file: handleGithubReadFile,
  boss_github_list_repos: handleGithubListRepos,
  boss_github_list_issues: handleGithubListIssues,
  boss_github_repo_tree: handleGithubRepoTree,
  // vS.0.2 — CI/PR introspection
  boss_github_workflow_runs: handleGithubWorkflowRuns,
  boss_github_workflow_run_logs: handleGithubWorkflowRunLogs,
  boss_github_pr_comments: handleGithubPrComments,
  boss_github_pr_status: handleGithubPrStatus,
  boss_github_open_issue: handleGithubOpenIssue,
  // vS.0.3 — BOS opens her own PRs
  boss_github_open_pr: handleGithubOpenPr,
  boss_github_request_review: handleGithubRequestReview,
  boss_github_pr_comment: handleGithubPrComment,
  // vS.0.5 — Self-deploy
  boss_github_push_tag: handleGithubPushTag,
  boss_release_notes: handleGithubReleaseNotes,
  // ── YouTube ─────────────────────────────────────────────────────────────
  boss_youtube_search: handleYoutubeSearch,
  boss_youtube_transcript: handleYoutubeTranscript,
  // ── Memory ──────────────────────────────────────────────────────────────
  // ── Memory ──────────────────────────────────────────────────────────────
  boss_memory_save: handleMemorySave,
  boss_memory_recall: handleMemoryRecall,
  boss_memory_list: handleMemoryList,
  // ── Weaviate vector search ─────────────────────────────────────────────
  boss_email_search: (args) => executeWeaviateTool('boss_email_search', args),
  boss_email_keyword_search: (args) => executeWeaviateTool('boss_email_keyword_search', args),
  boss_knowledge_search: (args) => executeWeaviateTool('boss_knowledge_search', args),
  boss_knowledge_ingest: (args) => executeWeaviateTool('boss_knowledge_ingest', args),
  // ── ERA Context (finance — CFO agent) ──────────────────────────────────────
  boss_era_accounts: (args) => executeEraTool('boss_era_accounts', args),
  boss_era_financial_overview: (args) => executeEraTool('boss_era_financial_overview', args),
  boss_era_transactions: (args) => executeEraTool('boss_era_transactions', args),
  boss_era_search_transactions: (args) => executeEraTool('boss_era_search_transactions', args),
  boss_era_cash_flow: (args) => executeEraTool('boss_era_cash_flow', args),
  boss_era_recurring_charges: (args) => executeEraTool('boss_era_recurring_charges', args),
  // ── Finance snapshot (CFO agent persists for the dashboard) ─────────────────
  boss_finance_snapshot_save: (args) => executeFinanceTool('boss_finance_snapshot_save', args),
  boss_incidents_list: (args) => executeCtoTool('boss_incidents_list', args),
  boss_cost_rollup: (args) => executeCtoTool('boss_cost_rollup', args),
  boss_incident_update: (args) => executeCtoTool('boss_incident_update', args),
  boss_playbook_save: (args) => executeCtoTool('boss_playbook_save', args),
  boss_agent_control: (args) => executeCtoTool('boss_agent_control', args),
  // ── CRM snapshot (Sales agent persists for the dashboard) ───────────────────
  boss_crm_snapshot_save: (args) => executeCrmSnapshotTool('boss_crm_snapshot_save', args),
  // ── CRM sync + metrics (Collector mirrors GHL; Strategist reads local) ──────
  boss_crm_sync: (_args) => executeCrmSync(),
  boss_crm_metrics: (_args) => executeCrmMetrics(),
  // ── System monitoring ────────────────────────────────────────────────────
  boss_sys_info: (_args) => handleSysInfo(),
  boss_sys_updates: (_args) => handleSysUpdates(),
  boss_sys_docker: (_args) => handleSysDocker(),
  boss_sys_services: (_args) => handleSysServices(),
  // ── Backup status (vD.0.1) ────────────────────────────────────────────────
  boss_backup_status: (_args) => handleBackupStatus(),
  // ── Host status (vS.0.1) ─────────────────────────────────────────────────
  boss_host_status: (_args) => handleHostStatus(),
  // ── Self-identity (vS.0.4) ──────────────────────────────────────────────
  boss_self_identity: (_args) => handleSelfIdentity(),
  boss_self_reflect: handleSelfReflect,
  boss_self_goals: handleSelfGoals,
  // ── Host management (vS.1.0) ────────────────────────────────────────────
  boss_host_apt: handleHostApt,
  boss_host_systemctl: handleHostSystemctl,
  boss_host_cron: handleHostCron,
  boss_admin_audit_log: handleAdminAuditLog,
  // ── Host security (vS.1.1) ──────────────────────────────────────────────
  boss_host_firewall: (_args) => handleHostFirewall(),
  boss_host_ports: (_args) => handleHostPorts(),
  boss_host_certs: (_args) => handleHostCerts(),
  boss_host_authlog: (_args) => handleHostAuthlog(),
  boss_host_ssh_keys: (_args) => handleHostSshKeys(),
  boss_host_fail2ban: (_args) => handleHostFail2ban(),
  // ── Telemetry & self-improvement (vS.2.0) ───────────────────────────────
  boss_telemetry_alerts: (_args) => handleTelemetryAlerts(),
  boss_self_propose_fix: handleSelfProposeFix,
  boss_telemetry_history: handleTelemetryHistory,
  // ── Kanban brain tools (v1.7.14) ────────────────────────────────────────
  boss_tasks_move: handleTasksMove,
  boss_tasks_advance: handleTasksAdvance,
  boss_tasks_block: handleTasksBlock,
  // ── Filesystem ──────────────────────────────────────────────────────────
  boss_fs_read: handleFsRead,
  boss_fs_write: handleFsWrite,
  boss_fs_list: handleFsList,
  boss_fs_search: handleFsSearch,
  boss_fs_append: handleFsAppend,
  // Self-modification tools
  boss_bash: handleBash,
  boss_self_patch: handleSelfPatch,
  boss_self_grep: handleSelfGrep,
  boss_self_build: handleSelfBuild,
  boss_self_test: handleSelfTest,
  boss_self_git: handleSelfGit,
  boss_self_introspect: handleSelfIntrospect,
  // Web search
  boss_web_search: handleWebSearch,
  boss_web_fetch: handleWebFetch,
  // Persistent agents
  boss_create_persistent_agent: handleCreatePersistentAgent,
  boss_list_persistent_agents: handleListPersistentAgents,
  boss_update_persistent_agent: handleUpdatePersistentAgent,
  boss_delete_persistent_agent: handleDeletePersistentAgent,
  // ── Voice agent routing ────────────────────────────────────────────────
  boss_voice_route_agent: handleVoiceRouteAgent,
  boss_voice_list_agents: (_args) => handleVoiceListAgents(),
  boss_voice_navigate: handleVoiceNavigate,
  boss_ui_command: handleUICommand,
  // ── CRM (GoHighLevel) ───────────────────────────────────────────────────
  boss_crm_search_contacts: handleCrmSearchContacts,
  boss_crm_get_contact: handleCrmGetContact,
  boss_crm_create_contact: handleCrmCreateContact,
  boss_crm_update_contact: handleCrmUpdateContact,
  boss_crm_list_pipelines: handleCrmListPipelines,
  boss_crm_search_opportunities: handleCrmSearchOpportunities,
  boss_crm_create_opportunity: handleCrmCreateOpportunity,
  boss_crm_get_conversations: handleCrmGetConversations,
  boss_crm_send_message: handleCrmSendMessage,
  // ── Pipeline Engine (Little Rascals backbone) ──────────────────────────
  boss_task_list: handleTaskList,
  boss_task_create: handleTaskCreate,
  boss_task_advance: handleTaskAdvance,
};

/**
 * Execute a BOS brain tool call by name.
 *
 * @param toolName  - The tool name from the brain's tool_use block
 * @param args      - Arguments from the brain (already parsed JSON object)
 * @param _tenantId - Reserved for future multi-tenant token isolation
 * @returns Human-readable string result for the brain to synthesize
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctxOrTenant: string | ToolCtx,
): Promise<string> {
  const ctx: ToolCtx = typeof ctxOrTenant === 'string' ? { tenantId: ctxOrTenant } : ctxOrTenant;
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return `Unknown tool: "${toolName}". Available tools: ${Object.keys(TOOL_HANDLERS).join(', ')}`;
  }
  const gate = await gateToolCall(toolName, args, ctx);
  if (!gate.allow) return gate.pendingResult ?? '⏸ Queued for your approval.';
  const t0 = Date.now();
  try {
    const result = await handler(args);
    recordExecuted(toolName, gate.tier, ctx, Date.now() - t0);
    if (result.length > MAX_TOOL_RESULT_CHARS) {
      return result.slice(0, MAX_TOOL_RESULT_CHARS) + '\n[truncated — result exceeded limit]';
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool "${toolName}" failed: ${msg}`;
  }
}
