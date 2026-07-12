/**
 * Telegram Bot inbound channel — public Fastify webhook (P4 channels).
 *
 *   POST /api/webhooks/telegram — Telegram delivers updates as JSON. There is no
 *        body HMAC; instead Telegram echoes the secret token configured at
 *        setWebhook time in the `X-Telegram-Bot-Api-Secret-Token` header. We
 *        compare it (timing-safe) against TELEGRAM_WEBHOOK_SECRET. Verified,
 *        de-duplicated (by update_id) inbound text is routed into the brain
 *        (CoS) via the internal /api/brain/chat loop, and the reply is sent back
 *        to the chat through the Telegram Bot API (best-effort).
 *
 * FEATURE-FLAGGED OFF: without BOTH TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET
 * the route answers 503 and never touches the DB or brain.
 *
 * Public route: it lives under /api/webhooks/ which is already in the auth and
 * tenant middleware public-path lists. The secret-token header is the auth.
 * Persistence/brain failures never block the (fast) 200 ack Telegram expects.
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';

const TENANT = 'default';
const CHANNEL = 'telegram';

// Sender allowlist — only configured Telegram user/chat IDs reach the brain. FAIL CLOSED: an
// empty/absent TELEGRAM_ALLOWED_IDS denies everyone, so an activated bot is never an open door
// to the CoS (the secret token only proves the request came from the bot, not WHO sent it).
function isAllowedSender(fromId: number | undefined, chatId: number | undefined): boolean {
  const allow = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return false;
  return (fromId != null && allow.includes(String(fromId))) || (chatId != null && allow.includes(String(chatId)));
}

// Channel tool grant — SCOPED (not '*') by default; the P1 risk gate still queues any tier-2/3
// action. Override with CHANNEL_ALLOWED_TOOLS (comma list, or '*' for full access).
function channelAllowedTools(): string[] {
  const e = process.env.CHANNEL_ALLOWED_TOOLS?.trim();
  if (e === '*') return ['*'];
  if (e) return e.split(',').map((s) => s.trim()).filter(Boolean);
  return ['boss_gmail_unread', 'boss_gmail_search', 'boss_gmail_draft', 'boss_calendar_upcoming', 'boss_tasks_create', 'boss_tasks_list', 'boss_memory_save', 'boss_knowledge_ingest', 'boss_drive_recent', 'boss_financial_reason', 'boss_triage_reason'];
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
interface TelegramMessage {
  message_id?: number;
  text?: string;
  chat?: { id?: number; type?: string; title?: string };
  from?: { id?: number; username?: string; first_name?: string };
}

export async function telegramChannelRoutes(server: FastifyInstance): Promise<void> {
  server.post(
    '/telegram',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (!botToken || !secret) {
        // Channel disabled — fail closed, no side effects.
        return reply.status(503).send({ error: 'telegram channel not configured' });
      }

      // Auth = the secret token Telegram echoes from setWebhook.
      const provided = headerStr(request.headers['x-telegram-bot-api-secret-token']);
      if (!provided || !timingSafeEqualStr(provided, secret)) {
        request.log.warn('Telegram webhook secret token: mismatch');
        return reply.status(401).send({ error: 'invalid secret token' });
      }

      const update = (request.body ?? {}) as TelegramUpdate;
      const msg = update.message ?? update.edited_message;
      const updateId = update.update_id;
      const chatId = msg?.chat?.id;
      const text = msg?.text ?? '';
      const fromName = msg?.from?.username || msg?.from?.first_name || (msg?.from?.id != null ? String(msg.from.id) : 'unknown');

      // Idempotency — dedupe redeliveries by Telegram's monotonic update_id.
      const dedupeKey = updateId != null ? String(updateId) : crypto.randomUUID();
      let isNew = true;
      try {
        isNew = await recordInbound(dedupeKey, fromName, chatId != null ? String(chatId) : '', text, update);
      } catch (err) {
        request.log.warn({ err }, 'Telegram inbound persistence failed; using in-memory dedupe');
        isNew = rememberSeen(`${CHANNEL}:${dedupeKey}`);
      }

      // Ack immediately. Route into the brain + reply asynchronously (only for
      // genuinely new text messages addressed to a chat).
      if (isNew && chatId != null && text.trim()) {
        if (!isAllowedSender(msg?.from?.id, chatId)) {
          request.log.warn({ fromId: msg?.from?.id, chatId }, 'Telegram inbound from non-allowlisted sender — dropped (not routed to brain)');
        } else {
          void routeToBrainAndReply(chatId, fromName, text, botToken, request).catch((err) =>
            request.log.warn({ err, chatId }, 'Telegram brain routing failed'),
          );
        }
      }

      return reply.status(200).send({ ok: true });
    },
  );
}

function headerStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

// ── Inbound persistence + idempotency ────────────────────────────────────────
async function recordInbound(
  updateId: string,
  from: string,
  chatId: string,
  body: string,
  raw: unknown,
): Promise<boolean> {
  const pool = getPool();
  await ensureChannelTable(pool);
  const res = await pool.query(
    `INSERT INTO boss_channel_messages
       (tenant_id, channel, provider_message_id, direction, sender, recipient, body, conversation_id, raw)
     VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, channel, provider_message_id) DO NOTHING`,
    [TENANT, CHANNEL, updateId, from, chatId, body, conversationId(chatId), JSON.stringify(raw ?? {})],
  );
  return (res.rowCount ?? 0) > 0;
}

let tableReady = false;
async function ensureChannelTable(pool: ReturnType<typeof getPool>): Promise<void> {
  if (tableReady) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS boss_channel_messages (
       id BIGSERIAL PRIMARY KEY,
       tenant_id TEXT NOT NULL DEFAULT 'default',
       channel TEXT NOT NULL,
       provider_message_id TEXT NOT NULL,
       direction TEXT NOT NULL DEFAULT 'inbound',
       sender TEXT,
       recipient TEXT,
       body TEXT,
       conversation_id TEXT,
       raw JSONB,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (tenant_id, channel, provider_message_id)
     )`,
  );
  tableReady = true;
}

// In-memory dedupe fallback when the DB is unavailable (bounded).
const seen = new Set<string>();
function rememberSeen(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 5000) {
    let n = 0;
    for (const k of seen) {
      seen.delete(k);
      if (++n >= 1000) break;
    }
  }
  return true;
}

function conversationId(chatId: string): string {
  return `telegram-${chatId}`;
}

// ── Brain routing + outbound reply ───────────────────────────────────────────
async function routeToBrainAndReply(
  chatId: number,
  fromName: string,
  body: string,
  botToken: string,
  request: FastifyRequest,
): Promise<void> {
  const reply = await callBrain(chatId, fromName, body);
  if (!reply) return;

  // Persist the outbound turn (best-effort).
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO boss_channel_messages
         (tenant_id, channel, provider_message_id, direction, sender, recipient, body, conversation_id)
       VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7)
       ON CONFLICT (tenant_id, channel, provider_message_id) DO NOTHING`,
      [TENANT, CHANNEL, `out-${crypto.randomUUID()}`, 'bot', String(chatId), reply, conversationId(String(chatId))],
    );
  } catch { /* best-effort */ }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply.slice(0, 4000) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      request.log.warn({ status: res.status }, 'Telegram outbound send failed');
    }
  } catch (err) {
    request.log.warn({ err }, 'Telegram outbound send error');
  }
}

async function callBrain(chatId: number, fromName: string, message: string): Promise<string> {
  const port = process.env.PORT || '8010';
  const res = await fetch(`http://127.0.0.1:${port}/api/brain/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BOSS-Internal': 'true' },
    body: JSON.stringify({
      message: `[INBOUND TELEGRAM from ${fromName}]\n\n${message}`,
      conversationId: conversationId(String(chatId)),
      // Scoped channel grant (default excludes bash/host/send); P1 gate queues tier-2/3 anyway.
      allowedTools: channelAllowedTools(),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json()) as { response?: string; error?: string };
  return data.response || '';
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
