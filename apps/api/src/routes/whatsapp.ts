/**
 * WhatsApp surface API — bridge-backed threads + messages + send + pairing.
 *
 *   GET    /api/whatsapp/threads                       — list threads (sorted by last_message_at)
 *   GET    /api/whatsapp/threads/:chatId/messages      — message history for one thread
 *   POST   /api/whatsapp/threads/:chatId/send          — send a text reply (manual)
 *   POST   /api/whatsapp/threads/:chatId/mark-read     — zero the unread counter
 *   POST   /api/whatsapp/threads/:chatId/sync          — pull recent history from the bridge
 *   GET    /api/whatsapp/contacts                      — contact list (local table)
 *   POST   /api/whatsapp/contacts/sync                 — pull contacts from the bridge
 *   POST   /api/whatsapp/sync-names                    — refresh thread display names from the bridge
 *   POST   /api/whatsapp/import-history                — start the one-shot bulk history import (background job)
 *   GET    /api/whatsapp/import-history/status         — progress of that job
 *   POST   /api/whatsapp/start-conversation            — send first message to a phone number
 *   POST   /api/whatsapp/schedule                      — schedule a future message
 *   GET    /api/whatsapp/scheduled                     — list scheduled messages
 *   POST   /api/whatsapp/scheduled/:id/cancel          — cancel a pending scheduled message
 *   POST   /api/whatsapp/scheduled/:id/approve         — approve a scheduled message for send
 *   GET    /api/whatsapp/status                        — provider/session/pairing state (never 500s)
 *   GET    /api/whatsapp/qr                            — pairing QR (data URL)
 *   POST   /api/whatsapp/logout                        — unpair the session
 *   POST   /api/whatsapp/disclaimer-ack                — record disclaimer acknowledgement (informational; never gates /qr)
 *
 * Transport is the Baileys wa-bridge only (lib/wa-bridge.ts). Reads come from
 * the local boss_whatsapp_* tables, which the bridge's webhook receiver
 * (routes/webhooks/whatsapp.ts) keeps populated. Sends go to the bridge and are
 * persisted locally in the same call — the bridge doesn't always echo API sends
 * back over the webhook.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { getPool } from '../db.js';
import { getRuntimeConfig, setRuntimeConfig } from '../config-store.js';
import {
  fetchWaChatHistory,
  fetchWaMediaDataUrl,
  getWaQr,
  getWaSessionStatus,
  isWaBridgeConfigured,
  isPairedStatus,
  listWaChats,
  listWaContacts,
  listWaGroups,
  logoutWaSession,
  phoneToChatId,
  sendWhatsAppTextAndPersist,
  WA_BRIDGE_PER_CHAT_CAP,
  type WaContact,
  type WaHistoryMessage,
} from '../lib/wa-bridge.js';

const DISCLAIMER_KEY = 'WHATSAPP_DISCLAIMER_ACCEPTED_AT';
const HISTORY_IMPORTED_KEY = 'WHATSAPP_HISTORY_IMPORTED_AT';
// Single-tenant box — every boss_whatsapp_* row and the disclaimer runtime_config
// key live under this tenant. Kept in one place so /status, /qr and
// /disclaimer-ack can never drift apart.
const TENANT_ID = 'default';

interface ThreadRow {
  chat_id: string;
  display_name: string | null;
  phone: string | null;
  is_group: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_from_me: boolean | null;
  unread_count: number;
  archived: boolean;
}

interface MessageRow {
  id: string;
  chat_id: string;
  wa_message_id: string | null;
  direction: string;
  from_me: boolean;
  author: string | null;
  sender_name: string | null;
  body: string | null;
  message_type: string;
  media_url: string | null;
  reply_to_wa_message_id: string | null;
  ack_status: string | null;
  sent_at: string;
}

interface ContactRow {
  contact_id: string;
  display_name: string | null;
  phone: string | null;
  push_name: string | null;
  verified_name: string | null;
  is_my_contact: boolean | null;
  is_blocked: boolean | null;
  is_group: boolean;
  last_seen_at: string | null;
  synced_at: string;
}

function authorFromMessageId(id: string | undefined, chatId: string): string | null {
  if (!id || !chatId.endsWith('@g.us')) return null;
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  if (!suffix || suffix === id || suffix === chatId) return null;
  return suffix.includes('@') ? suffix : null;
}

function nameFromWaContact(contact: WaContact): string | null {
  return contact.verifiedName || contact.name || contact.formattedName || contact.pushName || contact.pushname || null;
}

function phoneFromWaContact(contact: WaContact): string | null {
  if (contact.number) return contact.number.startsWith('+') ? contact.number : `+${contact.number}`;
  if (contact.id?.endsWith('@c.us')) return `+${contact.id.replace(/@c\.us$/, '')}`;
  return null;
}

async function upsertWhatsappContact(contact: WaContact, lastSeenAt: Date | null = null): Promise<string | null> {
  const contactId = contact.id ?? null;
  if (!contactId) return null;
  const displayName = nameFromWaContact(contact);
  const pool = getPool();
  await pool.query(
    `INSERT INTO boss_whatsapp_contacts
       (tenant_id, contact_id, display_name, phone, push_name, verified_name,
        is_my_contact, is_blocked, is_group, source_payload, last_seen_at, synced_at, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NOW(), NOW())
     ON CONFLICT (tenant_id, contact_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, boss_whatsapp_contacts.display_name),
           phone = COALESCE(EXCLUDED.phone, boss_whatsapp_contacts.phone),
           push_name = COALESCE(EXCLUDED.push_name, boss_whatsapp_contacts.push_name),
           verified_name = COALESCE(EXCLUDED.verified_name, boss_whatsapp_contacts.verified_name),
           is_my_contact = COALESCE(EXCLUDED.is_my_contact, boss_whatsapp_contacts.is_my_contact),
           is_blocked = COALESCE(EXCLUDED.is_blocked, boss_whatsapp_contacts.is_blocked),
           is_group = EXCLUDED.is_group,
           source_payload = COALESCE(EXCLUDED.source_payload, boss_whatsapp_contacts.source_payload),
           last_seen_at = GREATEST(
             COALESCE(boss_whatsapp_contacts.last_seen_at, EXCLUDED.last_seen_at),
             COALESCE(EXCLUDED.last_seen_at, boss_whatsapp_contacts.last_seen_at)
           ),
           synced_at = NOW(),
           updated_at = NOW()`,
    [
      contactId,
      displayName,
      phoneFromWaContact(contact),
      contact.pushName ?? contact.pushname ?? null,
      contact.verifiedName ?? null,
      contact.isMyContact ?? null,
      contact.isBlocked ?? null,
      contact.isGroup === true || contactId.endsWith('@g.us'),
      JSON.stringify(contact),
      lastSeenAt,
    ],
  );
  return displayName;
}

// ── Scheduled-message dispatcher ─────────────────────────────────────────────
// Nothing else in the system ever sent approved scheduled rows; this closes
// the loop. Runs on a small interval, claims due approved rows one batch at
// a time, sends via the bridge, and marks each row sent/failed independently.
const DISPATCH_INTERVAL_MS = 30_000;
const DISPATCH_BATCH_LIMIT = 10;
let dispatcherTimer: NodeJS.Timeout | null = null;
let dispatchRunning = false;

async function dispatchDueScheduledMessages(log: FastifyBaseLogger): Promise<void> {
  if (dispatchRunning) return;
  dispatchRunning = true;
  try {
    if (!isWaBridgeConfigured()) return;
    const pool = getPool();
    // Claim a batch atomically so a crashed send can't be double-claimed by
    // an overlapping tick. Rows stuck in 'sending' (api died mid-send) are
    // reclaimed after a grace window — otherwise they'd be orphaned forever.
    const { rows } = await pool.query<{ id: string; chat_id: string; message: string }>(
      `UPDATE boss_whatsapp_scheduled
          SET status = 'sending', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM boss_whatsapp_scheduled
           WHERE tenant_id = $2
             AND (
               (status = 'approved' AND send_at <= NOW())
               OR (status = 'sending' AND updated_at < NOW() - interval '10 minutes')
             )
           ORDER BY send_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, chat_id, message`,
      [DISPATCH_BATCH_LIMIT, TENANT_ID],
    );

    for (const row of rows) {
      try {
        const sent = await sendWhatsAppTextAndPersist(row.chat_id, row.message);
        await pool.query(
          `UPDATE boss_whatsapp_scheduled
              SET status = 'sent', sent_at = NOW(), wa_message_id = $2, updated_at = NOW()
            WHERE id = $1`,
          [row.id, sent.messageId],
        );
        log.info({ id: row.id, chatId: row.chat_id }, 'whatsapp scheduled message sent');
      } catch (err) {
        log.error({ err, id: row.id, chatId: row.chat_id }, 'whatsapp scheduled message failed');
        await pool.query(
          `UPDATE boss_whatsapp_scheduled
              SET status = 'failed', updated_at = NOW()
            WHERE id = $1`,
          [row.id],
        ).catch(() => { /* row stays 'sending'; operator can requeue */ });
      }
    }
  } catch (err) {
    log.error({ err }, 'whatsapp scheduled dispatcher tick failed');
  } finally {
    dispatchRunning = false;
  }
}

/** Called once from server.ts after DB init. Safe to call when the bridge is unconfigured — each tick re-checks. */
export function startWhatsAppScheduledDispatcher(log: FastifyBaseLogger): void {
  if (dispatcherTimer) return;
  dispatcherTimer = setInterval(() => {
    void dispatchDueScheduledMessages(log);
  }, DISPATCH_INTERVAL_MS);
  dispatcherTimer.unref();
  log.info({ intervalMs: DISPATCH_INTERVAL_MS }, 'whatsapp scheduled dispatcher started');
}

export function stopWhatsAppScheduledDispatcher(): void {
  if (dispatcherTimer) {
    clearInterval(dispatcherTimer);
    dispatcherTimer = null;
  }
}

// ── History import (bulk, idempotent, background) ────────────────────────────
//
// WHY THIS EXISTS: on pairing, WhatsApp pushes a history sync which the bridge
// persists to its own disk store — but the bridge deliberately does NOT webhook
// those messages (replaying months of old chats as `message.received` would spam
// the inbox and retry-storm this api). The result is a real user's history
// sitting in the bridge, invisible to BOS. This job pulls it across explicitly,
// once, on the user's say-so.
//
// It is safe to run twice: threads UPSERT, messages ON CONFLICT DO NOTHING on
// the (tenant_id, wa_message_id) partial unique index, and media is only fetched
// for rows that don't already have it.

const IMPORT_MESSAGE_CHUNK = 100;
const IMPORT_MEDIA_CONCURRENCY = 4;
const IMPORT_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

/** Bridge ack scale (-1..4) → the label column the UI renders. */
const ACK_LABEL: Record<string, string> = {
  '-1': 'failed', '0': 'pending', '1': 'sent', '2': 'delivered', '3': 'read', '4': 'played',
};

export interface WhatsappImportSummary {
  chats: number;
  threadsUpserted: number;
  messagesInserted: number;
  messagesSkipped: number;
  mediaFetched: number;
  errors: string[];
}

interface ImportJobState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { chatsDone: number; chatsTotal: number; messagesInserted: number };
  lastError: string | null;
  summary: WhatsappImportSummary | null;
}

// In-process only — no new tables. A restart mid-import loses the progress
// readout, not the imported data (every chat is committed as it goes), and the
// job is re-runnable.
const importJob: ImportJobState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  progress: { chatsDone: 0, chatsTotal: 0, messagesInserted: 0 },
  lastError: null,
  summary: null,
};

/** A bare phone/jid is not a NAME — never let one overwrite a real display_name. */
function isPhoneLikeName(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^\+?\d[\d\s().-]*$/.test(trimmed) || /@(s\.whatsapp\.net|c\.us|g\.us|lid)$/i.test(trimmed);
}

function phoneFromChatId(chatId: string): string | null {
  if (!chatId.endsWith('@c.us')) return null;
  const digits = chatId.replace(/@c\.us$/, '').replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

function previewOf(msg: WaHistoryMessage | undefined): string | null {
  if (!msg) return null;
  const body = (msg.body ?? '').trim();
  if (body) return body.substring(0, 100);
  const type = msg.type ?? '';
  return IMPORT_MEDIA_TYPES.has(type) ? `[${type}]` : null;
}

/** Run `fn` over `items` with a bounded worker pool. `fn` must never throw. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/** Import every message the bridge holds for one chat. Throws only on a hard DB/bridge failure. */
async function importOneChat(
  chat: { chatId: string; name?: string; isGroup: boolean },
  perChatLimit: number,
  withMedia: boolean,
  contactNames: Map<string, string>,
  summary: WhatsappImportSummary,
  log: FastifyBaseLogger,
): Promise<void> {
  const pool = getPool();
  const chatId = chat.chatId;
  const sessionPhone = process.env.WA_BRIDGE_SESSION_PHONE ?? '';
  const isGroup = chat.isGroup || chatId.endsWith('@g.us');
  const phone = phoneFromChatId(chatId);

  const history = await fetchWaChatHistory(chatId, perChatLimit);
  // The bridge returns oldest-first, so the last element is the newest.
  const newest = history[history.length - 1];
  const lastMessageAt = newest?.timestamp ? new Date(newest.timestamp * 1000) : null;

  // Name precedence: a contact BOS already knows > the name the bridge has >
  // the phone number. The phone is a placeholder, flagged as such so the UPSERT
  // below refuses to let it clobber a real name.
  const resolvedName = contactNames.get(chatId) ?? chat.name ?? null;
  const displayName = resolvedName ?? phone ?? chatId;
  const nameIsReal = !isPhoneLikeName(resolvedName);

  await pool.query(
    `INSERT INTO boss_whatsapp_threads
       (tenant_id, chat_id, display_name, phone, is_group,
        last_message_at, last_message_preview, last_message_from_me, updated_at)
     VALUES ($1, $2, $3, $4, $5::boolean, $6, $7, $8::boolean, NOW())
     ON CONFLICT (tenant_id, chat_id) DO UPDATE
       SET display_name = CASE
             -- Only a REAL name may overwrite what's there; a phone number can
             -- fill a blank but must never replace a name we already have.
             WHEN $9::boolean THEN EXCLUDED.display_name
             ELSE COALESCE(boss_whatsapp_threads.display_name, EXCLUDED.display_name)
           END,
           phone = COALESCE(boss_whatsapp_threads.phone, EXCLUDED.phone),
           is_group = EXCLUDED.is_group,
           -- The preview/from_me pair belongs to whichever message is actually
           -- newest, so an import of old history can't rewrite a live thread's
           -- header with a stale line.
           last_message_preview = CASE
             WHEN EXCLUDED.last_message_at IS NOT NULL
              AND (boss_whatsapp_threads.last_message_at IS NULL
                   OR EXCLUDED.last_message_at > boss_whatsapp_threads.last_message_at)
               THEN EXCLUDED.last_message_preview
             ELSE boss_whatsapp_threads.last_message_preview
           END,
           last_message_from_me = CASE
             WHEN EXCLUDED.last_message_at IS NOT NULL
              AND (boss_whatsapp_threads.last_message_at IS NULL
                   OR EXCLUDED.last_message_at > boss_whatsapp_threads.last_message_at)
               THEN EXCLUDED.last_message_from_me
             ELSE boss_whatsapp_threads.last_message_from_me
           END,
           last_message_at = GREATEST(
             COALESCE(boss_whatsapp_threads.last_message_at, EXCLUDED.last_message_at),
             COALESCE(EXCLUDED.last_message_at, boss_whatsapp_threads.last_message_at)
           ),
           updated_at = NOW()`,
    [
      TENANT_ID,
      chatId,
      displayName,
      phone,
      isGroup,
      lastMessageAt,
      previewOf(newest),
      newest?.fromMe === true,
      nameIsReal,
    ],
  );
  summary.threadsUpserted++;

  if (!history.length) return;

  // Dedupe within the batch: two rows with the same wa_message_id in one
  // statement are harmless under DO NOTHING, but there is no reason to ship them.
  const seen = new Set<string>();
  const rows = history.filter((msg) => {
    if (!msg.id || seen.has(msg.id)) return false;
    seen.add(msg.id);
    return true;
  });

  for (let i = 0; i < rows.length; i += IMPORT_MESSAGE_CHUNK) {
    const chunk = rows.slice(i, i + IMPORT_MESSAGE_CHUNK);
    const params: unknown[] = [];
    const tuples: string[] = [];

    for (const msg of chunk) {
      const fromPhone = typeof msg.from === 'string' ? msg.from.replace(/@.+$/, '') : '';
      const fromMe = msg.fromMe === true
        || (Boolean(sessionPhone) && fromPhone === sessionPhone)
        || (msg.id ?? '').startsWith('true_');
      const author = msg.author || msg.sender || authorFromMessageId(msg.id, chatId);
      const senderName = msg.senderName || msg.sender_name || msg.pushName || msg.pushname || null;
      // Bridge timestamps are SECONDS.
      const sentAt = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
      const ack = typeof msg.ack === 'number' ? (ACK_LABEL[String(msg.ack)] ?? null) : null;

      const base = params.length;
      params.push(
        TENANT_ID,
        chatId,
        msg.id,
        fromMe ? 'outbound' : 'inbound',
        fromMe,
        author,
        senderName,
        msg.body ?? null,
        msg.type ?? 'chat',
        msg.quotedMsgId ?? null,
        ack,
        sentAt,
      );
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}, NULL, $${base + 10}, $${base + 11}, $${base + 12})`,
      );
    }

    // The partial unique index (tenant_id, wa_message_id) WHERE wa_message_id
    // IS NOT NULL is what makes a re-run a no-op instead of a duplicate storm.
    const result = await pool.query(
      `INSERT INTO boss_whatsapp_messages
         (tenant_id, chat_id, wa_message_id, direction, from_me, author,
          sender_name, body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
         DO UPDATE SET
           reply_to_wa_message_id = COALESCE(
             boss_whatsapp_messages.reply_to_wa_message_id,
             EXCLUDED.reply_to_wa_message_id
           )
         WHERE boss_whatsapp_messages.reply_to_wa_message_id IS NULL
           AND EXCLUDED.reply_to_wa_message_id IS NOT NULL`,
      params,
    );

    const inserted = result.rowCount ?? 0;
    summary.messagesInserted += inserted;
    summary.messagesSkipped += chunk.length - inserted;
    importJob.progress.messagesInserted = summary.messagesInserted;
  }

  if (!withMedia) return;

  // MEDIA — best effort, never fatal. The bridge can only decrypt media whose
  // keys are still in its in-memory cache (recent messages only, wiped on
  // restart), so most historical media 404s. That is expected: we leave
  // media_url null and move on.
  const candidates = rows
    .filter((msg) => msg.hasMedia === true && IMPORT_MEDIA_TYPES.has(msg.type ?? ''))
    .map((msg) => msg.id as string);
  if (!candidates.length) return;

  // Don't re-fetch media a previous run (or the live webhook) already stored.
  const { rows: already } = await pool.query<{ wa_message_id: string }>(
    `SELECT wa_message_id FROM boss_whatsapp_messages
      WHERE tenant_id = $1 AND wa_message_id = ANY($2::text[]) AND media_url IS NOT NULL`,
    [TENANT_ID, candidates],
  );
  const have = new Set(already.map((r) => r.wa_message_id));
  const todo = candidates.filter((id) => !have.has(id));
  if (!todo.length) return;

  await mapWithConcurrency(todo, IMPORT_MEDIA_CONCURRENCY, async (messageId) => {
    try {
      const url = await fetchWaMediaDataUrl(messageId);
      if (!url) return;
      await pool.query(
        `UPDATE boss_whatsapp_messages
            SET media_url = $3
          WHERE tenant_id = $1 AND wa_message_id = $2 AND media_url IS NULL`,
        [TENANT_ID, messageId, url],
      );
      summary.mediaFetched++;
    } catch (err) {
      // Media is a bonus, never a reason to fail an import.
      log.debug({ err, messageId }, 'whatsapp history import: media fetch skipped');
    }
  });
}

async function runHistoryImport(
  log: FastifyBaseLogger,
  opts: { chatLimit?: number; perChatLimit?: number; media: boolean },
): Promise<void> {
  const summary: WhatsappImportSummary = {
    chats: 0,
    threadsUpserted: 0,
    messagesInserted: 0,
    messagesSkipped: 0,
    mediaFetched: 0,
    errors: [],
  };
  const perChatLimit = Math.min(
    Math.max(Math.trunc(opts.perChatLimit ?? WA_BRIDGE_PER_CHAT_CAP) || WA_BRIDGE_PER_CHAT_CAP, 1),
    WA_BRIDGE_PER_CHAT_CAP,
  );

  try {
    const chats = await listWaChats(opts.chatLimit);
    summary.chats = chats.length;
    importJob.progress.chatsTotal = chats.length;
    log.info({ chats: chats.length, perChatLimit, media: opts.media }, 'whatsapp history import started');

    // Names BOS already holds beat anything the bridge guesses.
    const contactNames = new Map<string, string>();
    try {
      const { rows } = await getPool().query<{ contact_id: string; display_name: string | null }>(
        `SELECT contact_id, display_name FROM boss_whatsapp_contacts
          WHERE tenant_id = $1 AND display_name IS NOT NULL`,
        [TENANT_ID],
      );
      for (const row of rows) {
        if (row.display_name && !isPhoneLikeName(row.display_name)) contactNames.set(row.contact_id, row.display_name);
      }
    } catch (err) {
      log.warn({ err }, 'whatsapp history import: contact name preload failed (continuing)');
    }

    for (const chat of chats) {
      try {
        await importOneChat(chat, perChatLimit, opts.media, contactNames, summary, log);
      } catch (err) {
        // One bad chat must not abort the run.
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push(`${chat.chatId}: ${message}`);
        log.warn({ err, chatId: chat.chatId }, 'whatsapp history import: chat failed (continuing)');
      } finally {
        importJob.progress.chatsDone++;
      }
    }

    importJob.summary = summary;
    importJob.lastError = null;
    // Mark it done so the UI stops offering the import. A run that imported
    // nothing still counts: there was nothing to import.
    await setRuntimeConfig(HISTORY_IMPORTED_KEY, new Date().toISOString(), TENANT_ID);
    log.info({ ...summary, errors: summary.errors.length }, 'whatsapp history import finished');
  } catch (err) {
    // Only a total failure (bridge unreachable, DB down) lands here.
    const message = err instanceof Error ? err.message : String(err);
    importJob.lastError = message;
    importJob.summary = summary;
    log.error({ err }, 'whatsapp history import failed');
  } finally {
    importJob.running = false;
    importJob.finishedAt = new Date().toISOString();
  }
}

export async function whatsappRoutes(server: FastifyInstance) {
  // ── Session status (never 500s — the WhatsApp page polls this) ──────────
  server.get('/status', async (request, reply) => {
    let disclaimerAcceptedAt: string | null = null;
    let historyImportedAt: string | null = null;
    try {
      disclaimerAcceptedAt = await getRuntimeConfig(DISCLAIMER_KEY, TENANT_ID);
    } catch {
      // runtime_config unavailable — treat as not accepted
    }
    try {
      historyImportedAt = await getRuntimeConfig(HISTORY_IMPORTED_KEY, TENANT_ID);
    } catch {
      // runtime_config unavailable — treat as not imported (the import is
      // idempotent, so the worst case is the banner offering it again)
    }
    const historyImported = Boolean(historyImportedAt);

    if (!isWaBridgeConfigured()) {
      return reply.send({
        provider: 'baileys',
        configured: false,
        session: { status: 'not_configured', phone: null },
        paired: false,
        disclaimerAcceptedAt,
        historyImported,
        historyImportedAt,
      });
    }

    try {
      const session = await getWaSessionStatus();
      return reply.send({
        provider: 'baileys',
        configured: true,
        session: { status: session.status, phone: session.phone },
        paired: isPairedStatus(session.status),
        disclaimerAcceptedAt,
        historyImported,
        historyImportedAt,
      });
    } catch (err) {
      // The env IS configured — this is a transient outage, not a missing
      // install. Reporting configured:false here would tell the user the
      // service doesn't exist and bounce a paired session back to the gate.
      request.log.warn({ err }, 'whatsapp bridge status check failed');
      return reply.send({
        provider: 'baileys',
        configured: true,
        session: { status: 'unreachable', phone: null },
        paired: false,
        disclaimerAcceptedAt,
        historyImported,
        historyImportedAt,
      });
    }
  });

  // ── History import ──────────────────────────────────────────────────────
  // Long-running by nature (5k+ messages, plus media attempts), so it runs as a
  // background job: this returns immediately and the client polls /status below.
  server.post<{
    Body?: { chatLimit?: number; perChatLimit?: number; media?: boolean };
    Querystring: { media?: string };
  }>('/import-history', async (request, reply) => {
    if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });
    if (importJob.running) {
      return reply.status(409).send({ error: 'import_already_running', startedAt: importJob.startedAt });
    }

    const media = request.query?.media !== 'false' && request.body?.media !== false;
    const chatLimit = Number(request.body?.chatLimit) > 0 ? Math.trunc(Number(request.body?.chatLimit)) : undefined;
    const perChatLimit = Number(request.body?.perChatLimit) > 0 ? Math.trunc(Number(request.body?.perChatLimit)) : undefined;

    importJob.running = true;
    importJob.startedAt = new Date().toISOString();
    importJob.finishedAt = null;
    importJob.lastError = null;
    importJob.summary = null;
    importJob.progress = { chatsDone: 0, chatsTotal: 0, messagesInserted: 0 };

    // Deliberately not awaited — runHistoryImport owns its own error handling
    // and always clears `running` in a finally block.
    void runHistoryImport(request.log, { chatLimit, perChatLimit, media });

    return reply.send({ started: true });
  });

  server.get('/import-history/status', async (_request, reply) => {
    return reply.send({
      running: importJob.running,
      startedAt: importJob.startedAt,
      finishedAt: importJob.finishedAt,
      progress: importJob.progress,
      lastError: importJob.lastError,
      summary: importJob.summary,
    });
  });

  // ── Pairing QR ───────────────────────────────────────────────────────────
  // The disclaimer is informational, not an authorization step: the UI shows it
  // before revealing the QR and records an acknowledgement when it is closed,
  // but the QR is never withheld on that basis.
  server.get('/qr', async (request, reply) => {
    if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });

    try {
      const { qr, reason } = await getWaQr();
      // No QR is a normal state during startup (202) and after pairing (409) —
      // both are 200s with a reason, not errors.
      if (!qr) return reply.send({ qr: null, reason: reason ?? 'pending' });
      return reply.send({ qr, reason: null });
    } catch (err) {
      request.log.error({ err }, 'whatsapp bridge qr fetch failed');
      return reply.status(502).send({ error: 'whatsapp_qr_failed' });
    }
  });

  // ── Logout / unpair ──────────────────────────────────────────────────────
  server.post('/logout', async (request, reply) => {
    if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });
    try {
      await logoutWaSession();
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, 'whatsapp bridge logout failed');
      return reply.status(502).send({ error: 'whatsapp_logout_failed' });
    }
  });

  // ── Disclaimer acknowledgement (web gates QR pairing on this) ────────────
  server.post('/disclaimer-ack', async (request, reply) => {
    const acceptedAt = new Date().toISOString();
    try {
      await setRuntimeConfig(DISCLAIMER_KEY, acceptedAt, TENANT_ID);
      return reply.send({ ok: true, disclaimerAcceptedAt: acceptedAt });
    } catch (err) {
      request.log.error({ err }, 'disclaimer-ack persist failed');
      return reply.status(500).send({ error: 'disclaimer_ack_failed' });
    }
  });

  // ── List threads ────────────────────────────────────────────────────────
  server.get('/threads', async (_request, reply) => {
    const { rows } = await getPool().query<ThreadRow>(
      `SELECT chat_id, display_name, phone, is_group, last_message_at,
              last_message_preview, last_message_from_me, unread_count, archived
         FROM boss_whatsapp_threads
        WHERE tenant_id = 'default' AND archived = false
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT 200`,
    );
    return reply.send({ threads: rows });
  });

  // ── Messages for one thread ─────────────────────────────────────────────
  server.get<{ Params: { chatId: string }; Querystring: { limit?: string; before?: string } }>(
    '/threads/:chatId/messages',
    async (request, reply) => {
      const chatId = decodeURIComponent(request.params.chatId);
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200);
      const before = request.query.before;
      const params: unknown[] = [chatId];
      let whereExtra = '';
      if (before) {
        params.push(before);
        whereExtra = `AND sent_at < $${params.length}`;
      }
      params.push(limit);
      const { rows } = await getPool().query<MessageRow>(
        `SELECT id, chat_id, wa_message_id, direction, from_me, author, sender_name, body,
                message_type, media_url, reply_to_wa_message_id, ack_status, sent_at
           FROM boss_whatsapp_messages
          WHERE tenant_id = 'default' AND chat_id = $1 ${whereExtra}
          ORDER BY sent_at DESC
          LIMIT $${params.length}`,
        params,
      );
      // Return in chronological order for UI rendering
      return reply.send({ chatId, messages: rows.reverse() });
    },
  );

  // ── Send a manual reply ─────────────────────────────────────────────────
  server.post<{ Params: { chatId: string }; Body: { message: string; replyToWaId?: string } }>(
    '/threads/:chatId/send',
    async (request, reply) => {
      const chatId = decodeURIComponent(request.params.chatId);
      const message = String(request.body?.message ?? '').trim();
      if (!message) return reply.status(400).send({ error: 'bad_request', message: 'message is required' });
      if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });

      try {
        const sent = await sendWhatsAppTextAndPersist(chatId, message);
        return reply.send({ ok: true, messageId: sent.messageId });
      } catch (err) {
        request.log.error({ err, chatId }, 'whatsapp bridge send failed');
        return reply.status(502).send({ error: 'whatsapp_send_failed' });
      }
    },
  );

  // ── Contact list (local table, webhook + sync populated) ─────────────────
  server.get('/contacts', async (_request, reply) => {
    const { rows } = await getPool().query<ContactRow>(
      `SELECT contact_id, display_name, phone, push_name, verified_name,
              is_my_contact, is_blocked, is_group, last_seen_at, synced_at
         FROM boss_whatsapp_contacts
        WHERE tenant_id = 'default'
        ORDER BY COALESCE(display_name, push_name, phone, contact_id) ASC
        LIMIT 500`,
    );
    return reply.send({ contacts: rows });
  });

  server.post('/contacts/sync', async (request, reply) => {
    if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });
    try {
      const contacts = await listWaContacts();
      let upserted = 0;
      for (const contact of contacts) {
        if (await upsertWhatsappContact(contact)) upserted++;
      }
      return reply.send({ ok: true, upserted, total: contacts.length });
    } catch (err) {
      request.log.error({ err }, 'whatsapp contacts sync failed');
      return reply.status(500).send({ error: 'contacts_sync_failed' });
    }
  });

  // ── Refresh thread display names from bridge groups + contacts ──────────
  server.post('/sync-names', async (request, reply) => {
    if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });
    const pool = getPool();
    try {
      // Fetch groups and contacts in parallel
      const [groups, contacts] = await Promise.all([listWaGroups(), listWaContacts()]);

      // group id → name
      const groupMap = new Map<string, string>();
      for (const g of groups) {
        if (g.id && g.name) groupMap.set(g.id, g.name);
      }

      // contact number → name (prefer saved name over pushName)
      const contactMap = new Map<string, { name: string; phone: string }>();
      for (const c of contacts) {
        await upsertWhatsappContact(c);
        const num = c.number ?? c.id?.replace(/@c\.us$/, '') ?? '';
        const displayName = nameFromWaContact(c);
        if (num && displayName) {
          contactMap.set(num, { name: displayName, phone: num });
        }
      }

      // Fetch all threads from DB
      const { rows } = await pool.query<ThreadRow>(
        `SELECT chat_id, is_group, display_name, phone FROM boss_whatsapp_threads WHERE tenant_id = 'default'`,
      );

      let updated = 0;
      for (const row of rows) {
        let newName: string | null = null;
        let newPhone: string | null = null;

        if (row.is_group) {
          newName = groupMap.get(row.chat_id) ?? null;
        } else {
          // Extract number from chat_id: strip @c.us, @lid, etc.
          const num = row.chat_id.replace(/@\S+$/, '');
          const found = contactMap.get(num);
          if (found) { newName = found.name; newPhone = found.phone; }
        }

        if (!newName && !newPhone) continue;
        const nameToSet = newName ?? row.display_name;
        const phoneToSet = newPhone ?? row.phone;
        if (nameToSet === row.display_name && phoneToSet === row.phone) continue;

        await pool.query(
          `UPDATE boss_whatsapp_threads
              SET display_name = $2, phone = $3, updated_at = NOW()
            WHERE tenant_id = 'default' AND chat_id = $1`,
          [row.chat_id, nameToSet, phoneToSet],
        );
        updated++;
      }

      return reply.send({ ok: true, updated, total: rows.length });
    } catch (err) {
      request.log.error({ err }, 'sync-names failed');
      return reply.status(500).send({ error: 'sync_failed' });
    }
  });

  // ── Mark a thread read ──────────────────────────────────────────────────
  server.post<{ Params: { chatId: string } }>('/threads/:chatId/mark-read', async (request, reply) => {
    const chatId = decodeURIComponent(request.params.chatId);
    await getPool().query(
      `UPDATE boss_whatsapp_threads
          SET unread_count = 0, updated_at = NOW()
        WHERE tenant_id = 'default' AND chat_id = $1`,
      [chatId],
    );
    return reply.send({ ok: true });
  });

  // ── Backfill message history for one thread from the bridge ─────────────
  server.post<{ Params: { chatId: string } }>('/threads/:chatId/sync', async (request, reply) => {
    if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });
    const chatId = decodeURIComponent(request.params.chatId);
    const sessionPhone = process.env.WA_BRIDGE_SESSION_PHONE ?? '';

    try {
      const messages = await fetchWaChatHistory(chatId, 50);

      let synced = 0;
      const pool = getPool();
      for (const msg of messages) {
        if (!msg.id) continue;
        const fromPhone = typeof msg.from === 'string' ? msg.from.replace(/@.+$/, '') : '';
        const fromMe = msg.fromMe === true || (Boolean(sessionPhone) && fromPhone === sessionPhone) || msg.id.startsWith('true_');
        const direction = fromMe ? 'outbound' : 'inbound';
        const sentAt = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
        const author = msg.author || msg.sender || authorFromMessageId(msg.id, chatId);
        const senderName = msg.senderName || msg.sender_name || msg.pushName || msg.pushname || null;

        const result = await pool.query(
          `INSERT INTO boss_whatsapp_messages
             (tenant_id, chat_id, wa_message_id, direction, from_me, author,
              sender_name, body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
           VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NULL, $10)
           ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
             DO UPDATE SET
               author = COALESCE(boss_whatsapp_messages.author, EXCLUDED.author),
               sender_name = COALESCE(boss_whatsapp_messages.sender_name, EXCLUDED.sender_name),
               reply_to_wa_message_id = COALESCE(
                 boss_whatsapp_messages.reply_to_wa_message_id,
                 EXCLUDED.reply_to_wa_message_id
               )
           RETURNING id`,
          [
            chatId,
            msg.id,
            direction,
            fromMe,
            author,
            senderName,
            msg.body ?? null,
            msg.type ?? 'chat',
            msg.quotedMsgId ?? null,
            sentAt,
          ],
        );
        if (result.rowCount && result.rowCount > 0) synced++;
      }

      return reply.send({ ok: true, synced, total: messages.length });
    } catch (err) {
      request.log.error({ err, chatId }, 'sync failed');
      return reply.status(500).send({ error: 'sync_failed' });
    }
  });

  // ── Scheduled messages (reminders, follow-ups) ─────────────────────────

  // POST /api/whatsapp/schedule - Schedule a future message
  server.post<{ Body: { chatId: string; message: string; sendAt: string; createdBy?: string } }>(
    '/schedule',
    async (request, reply) => {
      const { chatId, message, sendAt, createdBy = 'owner' } = request.body;
      if (!chatId || !message || !sendAt) {
        return reply.status(400).send({ error: 'chatId, message, and sendAt required' });
      }

      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO boss_whatsapp_scheduled
           (tenant_id, chat_id, message, send_at, created_by, status)
         VALUES ('default', $1, $2, $3, $4, 'pending')
         RETURNING id, created_at`,
        [chatId, message, sendAt, createdBy],
      );

      return reply.code(201).send({ scheduled: rows[0] });
    },
  );

  // GET /api/whatsapp/scheduled - List scheduled messages
  server.get<{ Querystring: { status?: string; chatId?: string } }>(
    '/scheduled',
    async (request, reply) => {
      const { status, chatId } = request.query;
      const pool = getPool();

      let sql = `
        SELECT s.id, s.chat_id, s.message, s.send_at, s.created_by, s.status,
               s.sent_at, s.wa_message_id, s.created_at,
               t.display_name, t.phone
          FROM boss_whatsapp_scheduled s
          -- LEFT: a message scheduled to a chat with no thread row yet (cold
          -- start / brand-new number) must still be listable and approvable.
          LEFT JOIN boss_whatsapp_threads t ON t.tenant_id = s.tenant_id AND t.chat_id = s.chat_id
         WHERE s.tenant_id = 'default'
      `;
      const params: unknown[] = [];

      if (status) {
        params.push(status);
        sql += ` AND s.status = $${params.length}`;
      }
      if (chatId) {
        params.push(chatId);
        sql += ` AND s.chat_id = $${params.length}`;
      }

      sql += ' ORDER BY s.send_at ASC';

      const { rows } = await pool.query(sql, params);
      return reply.send({ scheduled: rows });
    },
  );

  // POST /api/whatsapp/scheduled/:id/cancel - Cancel scheduled message
  server.post<{ Params: { id: string } }>(
    '/scheduled/:id/cancel',
    async (request, reply) => {
      const { id } = request.params;
      const pool = getPool();

      const { rows } = await pool.query(
        `UPDATE boss_whatsapp_scheduled
            SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1 AND tenant_id = 'default' AND status IN ('pending', 'approved')
          RETURNING id`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'not found or already processed' });
      }

      return reply.send({ ok: true, cancelled: rows[0].id });
    },
  );

  // POST /api/whatsapp/scheduled/:id/approve - Approve scheduled message for send
  server.post<{ Params: { id: string } }>(
    '/scheduled/:id/approve',
    async (request, reply) => {
      const { id } = request.params;
      const pool = getPool();

      const { rows } = await pool.query(
        `UPDATE boss_whatsapp_scheduled
            SET status = 'approved', draft_approved = true, updated_at = NOW()
          WHERE id = $1 AND tenant_id = 'default' AND status = 'pending'
          RETURNING id, chat_id, message, send_at`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'not found or already processed' });
      }

      return reply.send({ ok: true, approved: rows[0] });
    },
  );

  // POST /api/whatsapp/start-conversation - Start new conversation with phone number
  server.post<{ Body: { phone: string; message: string } }>(
    '/start-conversation',
    async (request, reply) => {
      const { phone, message } = request.body;
      if (!phone || !message) {
        return reply.status(400).send({ error: 'phone and message required' });
      }
      if (!isWaBridgeConfigured()) return reply.status(503).send({ error: 'whatsapp_not_configured' });

      try {
        const chatId = phoneToChatId(phone);
        const sent = await sendWhatsAppTextAndPersist(chatId, message);
        return reply.send({ ok: true, chatId, messageId: sent.messageId });
      } catch (err) {
        request.log.error({ err, phone }, 'start-conversation failed');
        return reply.status(502).send({ error: 'whatsapp_send_failed' });
      }
    },
  );
}
