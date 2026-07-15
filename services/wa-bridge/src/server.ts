/**
 * BOS wa-bridge — Baileys-based WhatsApp bridge (protocol-level, NO browser).
 *
 * Replaces the retired `openwa` service (@open-wa/wa-automate + headless
 * Chromium), which died when WhatsApp Web stopped exposing `window.Debug`.
 * The REST surface and webhook payloads below are deliberately IDENTICAL to
 * the old service so the BOS api needs no behavioral change:
 *
 *   GET  /healthz                                              — liveness (no auth, 200 even when the socket is down)
 *   GET  /api/sessions/:id                                     — { id, status, phone?, pushname? }
 *   GET  /api/sessions/:id/qr                                  — 200 { qr: 'data:image/png;base64,...' } | 202 pending | 409 paired
 *   POST /api/sessions/:id/messages/send-text                  — { chatId, text } → { ok, id, messageId }
 *   GET  /api/sessions/:id/contacts                            — Contact[]
 *   GET  /api/sessions/:id/contacts/:contactId                 — Contact
 *   GET  /api/sessions/:id/groups                              — Group[]
 *   GET  /api/sessions/:id/chats?limit=N                       — ChatSummary[] (chat index; newest-active first)
 *   GET  /api/sessions/:id/channels/:chatId/messages?limit=N   — Message[] (see HISTORY below)
 *   GET  /api/sessions/:id/messages/:messageId/media           — { url: dataUri, mimetype }
 *   POST /api/sessions/:id/logout                              — unpair; session flips to scan_qr
 *
 * Auth: every /api route requires `X-API-Key` == WA_BRIDGE_API_KEY (constant-time).
 * No key configured = refuse to start (fail-closed).
 *
 * JID DIALECT: Baileys speaks `<digits>@s.whatsapp.net`; the BOS api and its
 * Postgres rows speak OpenWA's `<digits>@c.us` (see phoneToChatId + the webhook
 * receiver's phoneFromChatId). This bridge therefore translates on both edges:
 * inbound BOS ids (bare digits, @c.us, or @s.whatsapp.net) are normalized for
 * Baileys, and every id we hand back or webhook out is rendered @c.us. Groups
 * (@g.us) and @lid are identical in both dialects and pass through untouched.
 *
 * HISTORY — REAL BEHAVIOR CHANGE vs. OpenWA: Baileys cannot ask the server for
 * "the last N messages of chat X". /channels/:chatId/messages is served from a
 * rolling on-disk store of messages this bridge has SEEN (live traffic plus the
 * on-connect history sync). Old threads that predate pairing are NOT backfillable.
 * BOS's inbox is fed by webhook → Postgres, so it builds forward from pairing.
 * An unknown chat returns [] — never a 500.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
  proto,
} from '@whiskeysockets/baileys';
import type { Contact, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { ContactStore, MessageStore, PER_CHAT_CAP } from './store.js';
import type { StoredContact, StoredMessage } from './store.js';

// ── Config (fail-closed) ────────────────────────────────────────────────────

const API_KEY = process.env.WA_BRIDGE_API_KEY ?? '';
const SESSION_ID = process.env.WA_BRIDGE_SESSION_ID ?? '';
const WEBHOOK_URL = process.env.WA_BRIDGE_WEBHOOK_URL ?? '';
const WEBHOOK_TOKEN = process.env.WA_BRIDGE_WEBHOOK_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 2785);
const DATA_DIR = process.env.WA_BRIDGE_DATA_DIR ?? '/data/session';
const AUTH_DIR = join(DATA_DIR, 'auth');

if (!API_KEY) {
  console.error('[wa-bridge] FATAL: WA_BRIDGE_API_KEY is not set — refusing to start.');
  process.exit(1);
}
if (!SESSION_ID) {
  console.error('[wa-bridge] FATAL: WA_BRIDGE_SESSION_ID is not set — refusing to start.');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.warn('[wa-bridge] WARNING: WA_BRIDGE_WEBHOOK_URL not set — inbound events will NOT be forwarded.');
}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [wa-bridge] ${level.toUpperCase()} ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

/** Baileys' own logger — silenced; we log the events we care about ourselves. */
const waLogger = pino({ level: process.env.WA_BRIDGE_LOG_LEVEL ?? 'silent' });

function safeEqual(a: string, b: string): boolean {
  // Hash both sides to equal length so timingSafeEqual never throws.
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── JID dialect translation (Baileys ⇄ BOS/OpenWA) ──────────────────────────

/** BOS/OpenWA id (`@c.us`, bare digits, or already-Baileys) → Baileys jid. */
function toWaJid(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (!value.includes('@')) {
    const digits = value.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
  }
  if (value.endsWith('@c.us')) return `${value.slice(0, -5)}@s.whatsapp.net`;
  return value;
}

/** Baileys jid → the `@c.us` dialect BOS stores and parses. Groups/lids pass through. */
function toBosId(jid: string | null | undefined): string {
  if (!jid) return '';
  // Strip Baileys' device suffix ("15551234567:12@s.whatsapp.net").
  const [user = '', server = ''] = jid.split('@');
  const bare = user.split(':')[0];
  if (!server) return bare;
  if (server === 's.whatsapp.net' || server === 'c.us') return `${bare}@c.us`;
  return `${bare}@${server}`;
}

// ── Message normalization (BOS webhook receiver's exact field set) ───────────

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

type Content = proto.IMessage;

/** Unwrap ephemeral / view-once / device-sent envelopes to the real content. */
function unwrap(message: Content | null | undefined): Content | null {
  let m = message ?? null;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.viewOnceMessageV2Extension?.message ??
      m.documentWithCaptionMessage?.message ??
      m.deviceSentMessage?.message ??
      null;
    if (!inner) return m;
    m = inner;
  }
  return m;
}

/** Map Baileys content → the OpenWA-style `type` string BOS's previewBody()/media check expects. */
function messageType(content: Content | null): string {
  if (!content) return 'chat';
  if (content.conversation || content.extendedTextMessage) return 'chat';
  if (content.imageMessage) return 'image';
  if (content.videoMessage) return 'video';
  if (content.audioMessage) return content.audioMessage.ptt ? 'ptt' : 'audio';
  if (content.documentMessage) return 'document';
  if (content.stickerMessage) return 'sticker';
  if (content.locationMessage || content.liveLocationMessage) return 'location';
  if (content.contactMessage || content.contactsArrayMessage) return 'vcard';
  if (content.reactionMessage) return 'reaction';
  if (content.protocolMessage) return 'protocol';
  return 'chat';
}

function messageBody(content: Content | null): string {
  if (!content) return '';
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.listResponseMessage?.title ??
    content.templateButtonReplyMessage?.selectedDisplayText ??
    content.reactionMessage?.text ??
    ''
  );
}

function mediaMimetype(content: Content | null): string | null {
  if (!content) return null;
  return (
    content.imageMessage?.mimetype ??
    content.videoMessage?.mimetype ??
    content.audioMessage?.mimetype ??
    content.documentMessage?.mimetype ??
    content.stickerMessage?.mimetype ??
    null
  );
}

function quotedId(content: Content | null): string | undefined {
  if (!content) return undefined;
  // Reactions point at their target through `reactionMessage.key`, not the
  // context-info path used by quoted replies. Keep that id so BOS can render
  // the emoji on the message it belongs to rather than as a separate bubble.
  const reactionTargetId = content.reactionMessage?.key?.id;
  if (reactionTargetId) return reactionTargetId;
  const ctx =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.stickerMessage?.contextInfo ??
    null;
  return ctx?.stanzaId ?? undefined;
}

/**
 * Baileys WAMessageStatus (ERROR 0, PENDING 1, SERVER_ACK 2, DELIVERY_ACK 3,
 * READ 4, PLAYED 5) → the -1..4 ack scale the BOS receiver's ACK_LABEL maps
 * (failed / pending / sent / delivered / read / played).
 */
function toAck(status: number | null | undefined): number | undefined {
  if (status === null || status === undefined) return undefined;
  switch (status) {
    case 0: return -1; // ERROR   → failed
    case 1: return 0;  // PENDING → pending
    case 2: return 1;  // SERVER_ACK   → sent
    case 3: return 2;  // DELIVERY_ACK → delivered
    case 4: return 3;  // READ   → read
    case 5: return 4;  // PLAYED → played
    default: return undefined;
  }
}

function normalizeMessage(raw: WAMessage): StoredMessage | null {
  const id = raw.key?.id ?? '';
  const chatId = toBosId(raw.key?.remoteJid);
  if (!id || !chatId) return null;

  const fromMe = raw.key?.fromMe === true;
  const isGroupMsg = chatId.endsWith('@g.us');
  const content = unwrap(raw.message);
  const type = messageType(content);
  const mimetype = mediaMimetype(content);

  // In groups Baileys puts the real sender on key.participant; 1:1 has none.
  const participant = toBosId(raw.key?.participant ?? raw.participant ?? null) || undefined;
  const author = isGroupMsg ? participant : undefined;
  const sender = fromMe ? undefined : (participant ?? chatId);
  const pushName = raw.pushName ?? undefined;

  return {
    id,
    chatId,
    from: fromMe ? undefined : (participant ?? chatId),
    to: fromMe ? chatId : undefined,
    fromMe,
    author,
    sender,
    senderName: pushName,
    pushName,
    notifyName: pushName,
    verifiedName: raw.verifiedBizName ?? undefined,
    formattedName: undefined,
    body: messageBody(content),
    type,
    hasMedia: Boolean(mimetype) || MEDIA_TYPES.has(type),
    quotedMsgId: quotedId(content),
    // SECONDS since epoch — the BOS receiver's tsToDate() coerces to ms itself.
    timestamp: Number(raw.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000),
    isGroupMsg,
    ack: toAck(typeof raw.status === 'number' ? raw.status : undefined),
  };
}

function contactFromMessage(msg: StoredMessage): StoredContact | null {
  const id = msg.author ?? (msg.fromMe ? '' : msg.chatId);
  if (!id) return null;
  return {
    id,
    name: msg.pushName,
    pushname: msg.pushName,
    pushName: msg.pushName,
    verifiedName: msg.verifiedName,
    number: id.endsWith('@c.us') ? id.replace(/@c\.us$/, '') : undefined,
    isGroup: id.endsWith('@g.us'),
  };
}

/** Best name we hold for a contact/group, in descending trustworthiness. */
function contactDisplayName(contact: StoredContact | undefined): string | undefined {
  if (!contact) return undefined;
  const name =
    contact.verifiedName ||
    contact.name ||
    contact.formattedName ||
    contact.pushname ||
    contact.pushName ||
    contact.shortName ||
    '';
  return name.trim() || undefined;
}

// ── Outbound webhook dispatch (retry + backoff, never throws) ───────────────

type WebhookEvent = 'message.received' | 'message.sent' | 'message.ack' | 'message.revoked' | 'session.status';

const WEBHOOK_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

async function emitWebhook(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  if (!WEBHOOK_URL) return;
  const payload = JSON.stringify({
    event,
    sessionId: SESSION_ID,
    timestamp: Math.floor(Date.now() / 1000),
    data,
  });
  for (let attempt = 0; attempt <= WEBHOOK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Token': WEBHOOK_TOKEN,
        },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      log('warn', `webhook ${event} → HTTP ${res.status} (attempt ${attempt + 1})`);
    } catch (err) {
      log('warn', `webhook ${event} delivery failed (attempt ${attempt + 1})`, err);
    }
    if (attempt < WEBHOOK_RETRY_DELAYS_MS.length) await sleep(WEBHOOK_RETRY_DELAYS_MS[attempt]);
  }
  log('error', `webhook ${event} dropped after ${WEBHOOK_RETRY_DELAYS_MS.length + 1} attempts`);
}

/** Fire-and-forget: a webhook failure must never take the socket down. */
function fireWebhook(event: WebhookEvent, data: Record<string, unknown>): void {
  void emitWebhook(event, data).catch((err) => log('error', 'webhook dispatch crashed (isolated)', err));
}

// ── Session ─────────────────────────────────────────────────────────────────

type SessionStatus = 'starting' | 'scan_qr' | 'ready' | 'error';

const messages = new MessageStore(DATA_DIR, (m, e) => log('error', m, e));
const contacts = new ContactStore(DATA_DIR, (m, e) => log('error', m, e));

/**
 * Raw protos, in memory only, for media download + Baileys' retry `getMessage`.
 * Not persisted: the proto carries binary media keys that don't survive a naive
 * JSON round-trip. Consequence: media for a message can only be fetched while
 * it's still in this cache (BOS fetches it inline in the webhook handler, so in
 * practice it always is). A restart drops it → /media returns 404.
 */
const RAW_CACHE_CAP = 3_000;
const rawCache = new Map<string, WAMessage>();

function cacheRaw(msg: WAMessage): void {
  const id = msg.key?.id;
  if (!id) return;
  rawCache.set(id, msg);
  if (rawCache.size > RAW_CACHE_CAP) {
    const oldest = rawCache.keys().next().value;
    if (oldest !== undefined) rawCache.delete(oldest);
  }
}

class Session {
  sock: WASocket | null = null;
  status: SessionStatus = 'starting';
  qrDataUri: string | null = null;
  phone: string | null = null;
  pushname: string | null = null;
  private restarting = false;
  private saveCreds: (() => Promise<void>) | null = null;

  setStatus(next: SessionStatus, reason: string): void {
    if (this.status === next) return;
    this.status = next;
    log('info', `session status → ${next} (${reason})`);
    fireWebhook('session.status', {
      sessionId: SESSION_ID,
      status: next,
      reason,
      phone: this.phone ?? undefined,
      pushname: this.pushname ?? undefined,
    });
  }

  requireReady(): WASocket {
    if (!this.sock || this.status !== 'ready') {
      const err = new Error(`session_not_ready:${this.status}`) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    return this.sock;
  }

  async start(): Promise<void> {
    if (this.status !== 'scan_qr') this.setStatus('starting', 'socket launch');
    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      this.saveCreds = saveCreds;
      const { version } = await fetchLatestBaileysVersion();
      log('info', `connecting with WA protocol version ${version.join('.')}`);

      const sock = makeWASocket({
        version,
        auth: state,
        logger: waLogger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: true,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        // Lets Baileys re-send a message the peer failed to decrypt.
        getMessage: async (key) => rawCache.get(key.id ?? '')?.message ?? undefined,
      });
      this.sock = sock;
      this.wire(sock);
    } catch (err) {
      log('error', 'socket launch failed', err);
      this.sock = null;
      this.setStatus('error', 'launch failed');
      this.scheduleRestart(15_000, 'launch failure');
    }
  }

  private wire(sock: WASocket): void {
    sock.ev.on('creds.update', () => {
      void this.saveCreds?.().catch((err) => log('warn', 'saveCreds failed', err));
    });

    sock.ev.on('connection.update', (update) => {
      void this.onConnectionUpdate(update).catch((err) => log('error', 'connection.update handler failed', err));
    });

    sock.ev.on('messages.upsert', ({ messages: batch, type }) => {
      // 'notify' = live traffic, 'append' = filled in by the server (e.g. our
      // own sends echoed back). Both are real messages; both get stored, only
      // fresh ones webhook out.
      for (const raw of batch) {
        try {
          this.ingest(raw, type === 'notify' || type === 'append');
        } catch (err) {
          log('error', 'messages.upsert handler failed', err);
        }
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        try {
          const id = key?.id ?? '';
          const chatId = toBosId(key?.remoteJid);
          if (!id || !chatId) continue;

          // A revoke arrives as an update that nulls the message content.
          if (update.message === null) {
            messages.patch(chatId, id, { body: '', type: 'revoked' });
            fireWebhook('message.revoked', { id, chatId, timestamp: Math.floor(Date.now() / 1000) });
            continue;
          }

          const ack = toAck(typeof update.status === 'number' ? update.status : undefined);
          if (ack === undefined) continue;
          messages.patch(chatId, id, { ack });
          fireWebhook('message.ack', {
            id,
            chatId,
            ack,
            fromMe: key?.fromMe === true,
            timestamp: Math.floor(Date.now() / 1000),
          });
        } catch (err) {
          log('error', 'messages.update handler failed', err);
        }
      }
    });

    // On-connect history sync: the ONLY backfill Baileys offers. Store it (so
    // /channels/:chatId/messages has something to serve) but do NOT webhook it
    // — replaying months of old messages into the BOS inbox as "new" would be
    // both wrong and a retry storm.
    sock.ev.on('messaging-history.set', ({ messages: batch, contacts: contactBatch }) => {
      try {
        for (const raw of batch ?? []) this.ingest(raw, false);
        for (const c of contactBatch ?? []) this.ingestContact(c);
        log('info', `history sync: ${batch?.length ?? 0} messages, ${contactBatch?.length ?? 0} contacts`);
      } catch (err) {
        log('error', 'messaging-history.set handler failed', err);
      }
    });

    sock.ev.on('contacts.upsert', (batch) => {
      for (const c of batch) this.ingestContact(c);
    });
    sock.ev.on('contacts.update', (batch) => {
      for (const c of batch) this.ingestContact(c);
    });
  }

  /** Store a message; webhook it out only when it's live traffic. */
  private ingest(raw: WAMessage, notify: boolean): void {
    const norm = normalizeMessage(raw);
    if (!norm) return;

    // Protocol messages (revokes, key distribution, …) aren't chat content.
    if (norm.type === 'protocol') {
      const content = unwrap(raw.message);
      const protocolMessage = content?.protocolMessage;
      const isRevoke = protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE;
      if (isRevoke && protocolMessage?.key?.id) {
        const targetId = protocolMessage.key.id;
        messages.patch(norm.chatId, targetId, { body: '', type: 'revoked' });
        fireWebhook('message.revoked', {
          id: targetId,
          chatId: norm.chatId,
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
      return;
    }

    cacheRaw(raw);
    messages.upsert(norm);
    const contact = contactFromMessage(norm);
    if (contact) contacts.upsert(contact);
    if (notify) fireWebhook(norm.fromMe ? 'message.sent' : 'message.received', { ...norm });
  }

  private ingestContact(raw: Partial<Contact>): void {
    const id = toBosId(raw.id);
    if (!id) return;
    contacts.upsert({
      id,
      name: raw.name ?? undefined,
      pushname: raw.notify ?? undefined,
      pushName: raw.notify ?? undefined,
      formattedName: raw.name ?? undefined,
      verifiedName: raw.verifiedName ?? undefined,
      number: id.endsWith('@c.us') ? id.replace(/@c\.us$/, '') : undefined,
      isMyContact: Boolean(raw.name),
      isGroup: id.endsWith('@g.us'),
    });
  }

  private async onConnectionUpdate(update: Partial<{ connection: string; lastDisconnect: { error?: Error } | undefined; qr: string }>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        this.qrDataUri = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
        this.setStatus('scan_qr', 'qr issued');
        log('info', 'new pairing QR captured');
      } catch (err) {
        log('error', 'failed to render QR to PNG', err);
      }
      return;
    }

    if (connection === 'open') {
      this.qrDataUri = null;
      const me = this.sock?.user;
      this.phone = me?.id ? toBosId(me.id).replace(/@.+$/, '') : this.phone;
      this.pushname = me?.name ?? me?.verifiedName ?? this.pushname;
      this.setStatus('ready', 'connection open');
      return;
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log('warn', `connection closed (statusCode=${statusCode ?? 'none'}, loggedOut=${loggedOut})`);

      if (loggedOut) {
        // The phone unpaired us. Reconnecting with these creds is pointless —
        // wipe them and come back up as a fresh QR.
        this.wipeAuth();
        this.phone = null;
        this.pushname = null;
        this.qrDataUri = null;
        this.setStatus('scan_qr', 'logged out');
        this.scheduleRestart(2_000, 'logged out — fresh pairing');
        return;
      }

      // Everything else (restartRequired, connectionLost, timedOut, 515, …) is
      // transient: reconnect. Don't touch status if we're mid-pairing (scan_qr)
      // — the QR is still the right thing for the UI to show.
      if (this.status !== 'scan_qr') this.setStatus('starting', 'reconnecting');
      this.scheduleRestart(statusCode === DisconnectReason.restartRequired ? 500 : 5_000, `close ${statusCode ?? 'unknown'}`);
    }
  }

  private wipeAuth(): void {
    try {
      rmSync(AUTH_DIR, { recursive: true, force: true });
      log('info', 'auth state wiped — next start issues a fresh QR');
    } catch (err) {
      log('error', 'failed to wipe auth state', err);
    }
  }

  scheduleRestart(delayMs: number, reason: string): void {
    if (this.restarting) return;
    this.restarting = true;
    log('info', `restarting socket in ${delayMs}ms (${reason})`);
    setTimeout(() => {
      void (async () => {
        try {
          this.sock?.ev.removeAllListeners('connection.update');
          this.sock?.end(undefined);
        } catch {
          // Already dead — nothing to clean up.
        }
        this.sock = null;
        this.restarting = false;
        await this.start();
      })();
    }, delayMs);
  }

  async logout(): Promise<void> {
    const sock = this.sock;
    if (sock) {
      await Promise.resolve(sock.logout()).catch((err: unknown) => log('warn', 'logout() failed, wiping anyway', err));
    }
    this.wipeAuth();
    this.phone = null;
    this.pushname = null;
    this.qrDataUri = null;
    this.setStatus('scan_qr', 'logout requested');
    this.scheduleRestart(1_000, 'logout requested');
  }
}

const session = new Session();

// ── HTTP server ─────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Unauthenticated + always 200, even with the socket down: this is a liveness
// probe, not a readiness probe. A dead WhatsApp session must NOT kill the port
// (BOS needs to still read status/qr to recover).
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, status: session.status });
});

const api = express.Router();

api.use((req: Request, res: Response, next: NextFunction) => {
  const provided = req.header('x-api-key') ?? '';
  if (!provided || !safeEqual(provided, API_KEY)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

// Single real session behind a multi-session shape: unknown ids 404.
api.use('/sessions/:sessionId', (req: Request, res: Response, next: NextFunction) => {
  if (req.params.sessionId !== SESSION_ID) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  next();
});

api.get('/sessions/:sessionId', (_req: Request, res: Response) => {
  res.json({
    id: SESSION_ID,
    status: session.status,
    phone: session.phone ?? undefined,
    pushname: session.pushname ?? undefined,
  });
});

api.get('/sessions/:sessionId/qr', (_req: Request, res: Response) => {
  if (session.status === 'ready') {
    res.status(409).json({ error: 'already_paired', status: 'ready' });
    return;
  }
  if (!session.qrDataUri) {
    res.status(202).json({ status: session.status, message: 'qr not issued yet — retry shortly' });
    return;
  }
  res.json({ qr: session.qrDataUri });
});

api.post('/sessions/:sessionId/messages/send-text', (req: Request, res: Response) => {
  void (async () => {
    const chatIdRaw = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!chatIdRaw || !text) {
      res.status(400).json({ error: 'bad_request', message: 'chatId and text are required' });
      return;
    }
    const sock = session.requireReady();
    const jid = toWaJid(chatIdRaw);
    if (!jid) {
      res.status(400).json({ error: 'bad_request', message: 'chatId is not a usable phone or jid' });
      return;
    }

    const sent = await sock.sendMessage(jid, { text });
    const messageId = sent?.key?.id ?? '';
    if (!messageId) {
      res.status(502).json({ error: 'send_failed' });
      return;
    }
    // Store our own send immediately; messages.upsert('append') would also
    // deliver it, but the store is idempotent on id so a double is harmless.
    if (sent) {
      cacheRaw(sent);
      const norm = normalizeMessage(sent);
      if (norm) messages.upsert(norm);
    }
    // BOTH keys: the BOS client reads `messageId`; `id` is kept for parity.
    res.json({ ok: true, id: messageId, messageId });
  })().catch((err) => sendError(res, err, 'send-text'));
});

// Contacts come from the local store (contacts.upsert / history sync / seen
// pushNames), so they answer even while the socket is reconnecting.
api.get('/sessions/:sessionId/contacts', (_req: Request, res: Response) => {
  res.json(contacts.all());
});

api.get('/sessions/:sessionId/contacts/:contactId', (req: Request, res: Response) => {
  const requested = decodeURIComponent(req.params.contactId);
  const id = toBosId(toWaJid(requested)) || requested;
  const contact = contacts.get(id) ?? contacts.get(requested);
  if (!contact) {
    res.status(404).json({ error: 'contact_not_found' });
    return;
  }
  res.json(contact);
});

api.get('/sessions/:sessionId/groups', (_req: Request, res: Response) => {
  void (async () => {
    const sock = session.requireReady();
    const groups = await sock.groupFetchAllParticipating();
    res.json(
      Object.values(groups).map((g) => ({
        id: toBosId(g.id),
        name: g.subject ?? undefined,
        isGroup: true,
        participantsCount: Array.isArray(g.participants) ? g.participants.length : undefined,
      })),
    );
  })().catch((err) => sendError(res, err, 'groups'));
});

/**
 * Chat index — the only way to ENUMERATE conversations. Derived from the
 * message store (which chats it has seen) + the contact store (their names).
 * Newest-active first. `?limit=N` truncates; omitted = every chat.
 *
 * Names: contacts only. A group whose subject we've never been told comes back
 * with `name: undefined` — the caller decides the fallback (it has a DB of
 * contacts of its own). Never guesses a name from a message pushName, which in
 * a group is the SENDER, not the group.
 */
api.get('/sessions/:sessionId/chats', (req: Request, res: Response) => {
  try {
    const raw = req.query.limit;
    const parsed = raw === undefined ? NaN : parseInt(String(raw), 10);
    const summaries = messages.listChats();
    const limited = Number.isFinite(parsed) && parsed > 0 ? summaries.slice(0, parsed) : summaries;

    res.json(
      limited.map((chat) => ({
        chatId: chat.chatId,
        name: contactDisplayName(contacts.get(chat.chatId)),
        isGroup: chat.chatId.endsWith('@g.us'),
        messageCount: chat.messageCount,
        // seconds since epoch, same dialect as StoredMessage.timestamp
        lastMessageAt: chat.lastMessageAt,
      })),
    );
  } catch (err) {
    log('warn', 'chat list failed — returning empty', err);
    res.json([]);
  }
});

/**
 * History. Served ENTIRELY from the local rolling store — see the HISTORY note
 * at the top of this file. Unknown chat → [] (200), never a 500.
 * The limit is capped at PER_CHAT_CAP: the store cannot hold more than that per
 * chat, so an importer asking for "everything" gets everything there is.
 */
api.get('/sessions/:sessionId/channels/:chatId/messages', (req: Request, res: Response) => {
  try {
    const requested = decodeURIComponent(req.params.chatId);
    const chatId = toBosId(toWaJid(requested)) || requested;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), PER_CHAT_CAP);
    res.json(messages.list(chatId, limit));
  } catch (err) {
    log('warn', 'history lookup failed — returning empty', err);
    res.json([]);
  }
});

api.get('/sessions/:sessionId/messages/:messageId/media', (req: Request, res: Response) => {
  void (async () => {
    const sock = session.requireReady();
    const messageId = decodeURIComponent(req.params.messageId);
    const raw = rawCache.get(messageId);
    if (!raw) {
      res.status(404).json({ error: 'message_not_found', message: 'not in the media cache (restart or too old)' });
      return;
    }
    const content = unwrap(raw.message);
    const mimetype = mediaMimetype(content);
    if (!mimetype) {
      res.status(422).json({ error: 'not_a_media_message' });
      return;
    }
    // downloadMediaMessage('buffer') returns a Buffer. Base64 it explicitly —
    // interpolating the Buffer into a template string would UTF-8 mangle every
    // byte (the exact bug the old service shipped).
    const buffer = await downloadMediaMessage(
      raw,
      'buffer',
      {},
      { logger: waLogger, reuploadRequest: sock.updateMediaMessage },
    );
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as unknown as Uint8Array);
    res.json({ url: `data:${mimetype};base64,${bytes.toString('base64')}`, mimetype });
  })().catch((err) => sendError(res, err, 'media'));
});

api.post('/sessions/:sessionId/logout', (_req: Request, res: Response) => {
  void (async () => {
    await session.logout();
    res.json({ ok: true, status: session.status });
  })().catch((err) => sendError(res, err, 'logout'));
});

app.use('/api', api);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found' });
});

function sendError(res: Response, err: unknown, where: string): void {
  const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  if (statusCode >= 500) log('error', `${where} failed`, err);
  else log('warn', `${where}: ${message}`);
  if (!res.headersSent) {
    res.status(statusCode).json({ error: statusCode === 409 ? 'session_not_ready' : 'internal_error', message });
  }
}

// A crashed handler or a rejected webhook must never take the process (and with
// it the HTTP surface BOS polls for status) down.
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection (kept alive)', reason);
});
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException (kept alive)', err);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('info', `${signal} — flushing stores and exiting`);
    messages.flush();
    contacts.flush();
    process.exit(0);
  });
}

app.listen(PORT, '0.0.0.0', () => {
  log('info', `listening on :${PORT} (session '${SESSION_ID}', data dir '${DATA_DIR}')`);
  void session.start();
});
