/**
 * WhatsApp bridge client — the single WhatsApp transport for BOS.
 *
 * Talks to the Baileys-backed bridge REST server (container `wa-bridge`):
 *   base   WA_BRIDGE_URL     (default http://wa-bridge:2785/api)
 *   auth   X-API-Key: WA_BRIDGE_API_KEY
 *   scope  /sessions/{WA_BRIDGE_SESSION_ID}/...
 *
 * Endpoints used:
 *   POST /sessions/{s}/messages/send-text            { chatId, text } → { messageId }
 *   GET  /sessions/{s}                                → { status, phone? }
 *   GET  /sessions/{s}/qr                             → 200 { qr: 'data:image/png;base64,...' } | 202 (not issued yet) | 409 (already paired)
 *   POST /sessions/{s}/logout                         → unpair
 *   GET  /sessions/{s}/contacts                       → WaContact[]
 *   GET  /sessions/{s}/contacts/{id}                  → WaContact
 *   GET  /sessions/{s}/groups                         → [{ id, name }]
 *   GET  /sessions/{s}/chats?limit=N                  → WaChatSummary[] (chat index — the only enumeration there is)
 *   GET  /sessions/{s}/channels/{chatId}/messages?limit=N → message[]
 *   GET  /sessions/{s}/messages/{id}/media            → { url: dataUri, mimetype } | 404 (key evicted)
 *
 * All callers (routes/whatsapp.ts, tools/meta.ts, routes/agents.ts, the
 * scheduled dispatcher) go through sendWhatsAppText / sendWhatsAppTextAndPersist
 * so the send + local-persist behavior lives in exactly one place. The bridge
 * does not reliably echo API-initiated sends back over the webhook, so we
 * persist outbound rows ourselves (idempotent on wa_message_id — a webhook echo
 * is a no-op).
 */
import { getPool } from '../db.js';

export interface WaConfig {
  baseUrl: string;
  sessionId: string;
  apiKey: string;
  sessionPhone: string;
}

export interface WaSessionStatus {
  status: string;
  phone: string | null;
  raw: Record<string, unknown>;
}

/** `reason` is set only when there is no QR to show: why not. */
export type WaQrReason = 'pending' | 'already_paired';

export interface WaQrResult {
  qr: string | null;
  reason: WaQrReason | null;
}

export interface WaContact {
  id?: string;
  name?: string;
  pushName?: string;
  pushname?: string;
  formattedName?: string;
  verifiedName?: string;
  number?: string;
  isMyContact?: boolean;
  isBlocked?: boolean;
  isGroup?: boolean;
}

export interface WaGroup {
  id: string;
  name?: string;
}

export interface WaHistoryMessage {
  id?: string;
  from?: string;
  to?: string;
  body?: string;
  type?: string;
  /** SECONDS since epoch (bridge dialect) — multiply by 1000 for a JS Date. */
  timestamp?: number;
  fromMe?: boolean;
  hasMedia?: boolean;
  author?: string;
  sender?: string;
  senderName?: string;
  sender_name?: string;
  pushName?: string;
  pushname?: string;
  /** Target message id for a quoted reply or a reaction. */
  quotedMsgId?: string;
  /** -1 failed · 0 pending · 1 sent · 2 delivered · 3 read · 4 played */
  ack?: number;
}

/** One row of the bridge's chat index (GET /chats). */
export interface WaChatSummary {
  chatId: string;
  /** Only set when the bridge's contact store knows a name for it. */
  name?: string;
  isGroup: boolean;
  messageCount: number;
  /** SECONDS since epoch. */
  lastMessageAt: number;
}

export function getWaBridgeConfig(): WaConfig {
  return {
    baseUrl: (process.env.WA_BRIDGE_URL ?? 'http://wa-bridge:2785/api').replace(/\/$/, ''),
    sessionId: process.env.WA_BRIDGE_SESSION_ID ?? '',
    apiKey: process.env.WA_BRIDGE_API_KEY ?? '',
    sessionPhone: process.env.WA_BRIDGE_SESSION_PHONE ?? '',
  };
}

/** Cheap configuration check — env only, never a network call. */
export function isWaBridgeConfigured(): boolean {
  const config = getWaBridgeConfig();
  return Boolean(config.baseUrl && config.sessionId && config.apiKey);
}

async function waBridgeFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getWaBridgeConfig();
  if (!isWaBridgeConfigured()) throw new Error('The WhatsApp bridge is not configured (WA_BRIDGE_URL / WA_BRIDGE_SESSION_ID / WA_BRIDGE_API_KEY).');

  const headers = new Headers(init.headers);
  headers.set('X-API-Key', config.apiKey);
  if (init.body && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  const res = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(config.sessionId)}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'error' in body
      ? String((body as { error?: unknown }).error)
      : text.slice(0, 300);
    throw new Error(`WhatsApp bridge HTTP ${res.status}: ${detail}`);
  }
  return body as T;
}

/** Normalize an E.164-ish phone (with or without +) to a WhatsApp chat id. */
export function phoneToChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) throw new Error('A phone number is required.');
  return `${digits}@c.us`;
}

const PAIRED_STATUSES = /connected|authenticated|inchat|successchat|ready/i;

export function isPairedStatus(status: string): boolean {
  return PAIRED_STATUSES.test(status);
}

export async function getWaSessionStatus(): Promise<WaSessionStatus> {
  const data = await waBridgeFetch<Record<string, unknown>>('');
  const status = typeof data.status === 'string' ? data.status : 'unknown';
  const phone = typeof data.phone === 'string' && data.phone
    ? data.phone
    : (getWaBridgeConfig().sessionPhone || null);
  return { status, phone, raw: data };
}

/**
 * Pairing QR. The bridge has three normal outcomes here and only one of
 * them is an error:
 *   200 → a QR is available
 *   202 → session is up but no QR issued yet (the normal startup window)
 *   409 → already paired (session ready), so there is nothing to scan
 * 202/409 are reported as reasons, NOT thrown — the UI renders them as states.
 */
export async function getWaQr(): Promise<WaQrResult> {
  const config = getWaBridgeConfig();
  if (!isWaBridgeConfigured()) throw new Error('The WhatsApp bridge is not configured (WA_BRIDGE_URL / WA_BRIDGE_SESSION_ID / WA_BRIDGE_API_KEY).');

  const res = await fetch(
    `${config.baseUrl}/sessions/${encodeURIComponent(config.sessionId)}/qr`,
    {
      headers: { 'X-API-Key': config.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    },
  );

  if (res.status === 202) return { qr: null, reason: 'pending' };
  if (res.status === 409) return { qr: null, reason: 'already_paired' };

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'error' in body
      ? String((body as { error?: unknown }).error)
      : text.slice(0, 300);
    throw new Error(`WhatsApp bridge HTTP ${res.status}: ${detail}`);
  }

  const qr = body && typeof body === 'object' && typeof (body as { qr?: unknown }).qr === 'string'
    ? (body as { qr: string }).qr
    : '';
  return qr ? { qr, reason: null } : { qr: null, reason: 'pending' };
}

export async function logoutWaSession(): Promise<void> {
  await waBridgeFetch<unknown>('/logout', { method: 'POST' });
}

export async function listWaContacts(): Promise<WaContact[]> {
  const data = await waBridgeFetch<unknown>('/contacts');
  return Array.isArray(data) ? (data as WaContact[]) : [];
}

export async function getWaContact(contactId: string): Promise<WaContact | null> {
  try {
    return await waBridgeFetch<WaContact>(`/contacts/${encodeURIComponent(contactId)}`);
  } catch {
    return null;
  }
}

export async function listWaGroups(): Promise<WaGroup[]> {
  const data = await waBridgeFetch<unknown>('/groups');
  return Array.isArray(data) ? (data as WaGroup[]) : [];
}

/**
 * The bridge's rolling store keeps at most 500 messages per chat, and its
 * /channels/:id/messages route clamps `limit` to exactly that. Asking for 500
 * therefore means "everything you have for this chat" — which is what the
 * history importer wants.
 */
export const WA_BRIDGE_PER_CHAT_CAP = 500;

export async function fetchWaChatHistory(chatId: string, limit = 50): Promise<WaHistoryMessage[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), WA_BRIDGE_PER_CHAT_CAP);
  const data = await waBridgeFetch<unknown>(`/channels/${encodeURIComponent(chatId)}/messages?limit=${safeLimit}`);
  return Array.isArray(data) ? (data as WaHistoryMessage[]) : [];
}

/**
 * Chat index. The bridge has no server-side chat list either — this is
 * "every conversation the bridge has SEEN" (live traffic + the on-connect
 * history sync), newest-active first. Omit `limit` for all of them.
 */
export async function listWaChats(limit?: number): Promise<WaChatSummary[]> {
  const query = limit && limit > 0 ? `?limit=${Math.trunc(limit)}` : '';
  const data = await waBridgeFetch<unknown>(`/chats${query}`);
  return Array.isArray(data) ? (data as WaChatSummary[]) : [];
}

/**
 * Media as a self-contained data URI, or null when it cannot be produced.
 *
 * The bridge can only decrypt media whose raw proto (and therefore its media
 * keys) is still in its in-memory cache. That cache holds recently-seen
 * messages and does not survive a restart, so HISTORICAL media is usually a
 * 404. Null is the expected answer, not an error — callers must treat it as
 * "no media", never as a failure.
 */
export async function fetchWaMediaDataUrl(messageId: string): Promise<string | null> {
  try {
    const data = await waBridgeFetch<{ url?: unknown }>(`/messages/${encodeURIComponent(messageId)}/media`);
    return typeof data?.url === 'string' && data.url ? data.url : null;
  } catch {
    return null;
  }
}

/** Raw send — returns the bridge message id when the server reports one. */
export async function sendWhatsAppText(chatId: string, text: string): Promise<{ messageId: string | null; raw: Record<string, unknown> }> {
  const data = await waBridgeFetch<Record<string, unknown>>('/messages/send-text', {
    method: 'POST',
    body: JSON.stringify({ chatId, text }),
  });
  const messageId = typeof data.messageId === 'string' ? data.messageId : null;
  return { messageId, raw: data };
}

/**
 * Send + persist. The bridge doesn't always webhook API-initiated sends, so we
 * write the outbound message row + thread bump ourselves. Idempotent on
 * wa_message_id, so a webhook echo (when it does arrive) is harmless.
 */
export async function sendWhatsAppTextAndPersist(
  chatId: string,
  text: string,
  tenantId = 'default',
): Promise<{ messageId: string | null; chatId: string }> {
  const { messageId } = await sendWhatsAppText(chatId, text);
  const sentAt = new Date();
  const pool = getPool();

  // Ensure the thread exists (cold start on a brand-new conversation).
  const phone = chatId.endsWith('@c.us') ? `+${chatId.replace(/@c\.us$/, '')}` : null;
  await pool.query(
    `INSERT INTO boss_whatsapp_threads (tenant_id, chat_id, display_name, phone, is_group)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, chat_id) DO NOTHING`,
    [tenantId, chatId, phone, phone, chatId.endsWith('@g.us')],
  );

  await pool.query(
    `INSERT INTO boss_whatsapp_messages
       (tenant_id, chat_id, wa_message_id, direction, from_me, author,
        body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
     VALUES ($1, $2, $3, 'outbound', true, NULL, $4, 'chat', NULL, NULL, 'sent', $5)
     ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
       DO NOTHING`,
    [tenantId, chatId, messageId, text, sentAt],
  );

  await pool.query(
    `UPDATE boss_whatsapp_threads
        SET last_message_wa_id = $3,
            last_message_at = $4,
            last_message_preview = $5,
            last_message_from_me = true,
            unread_count = 0,
            updated_at = NOW()
      WHERE tenant_id = $1 AND chat_id = $2`,
    [tenantId, chatId, messageId, sentAt, text.substring(0, 100)],
  );

  return { messageId, chatId };
}
