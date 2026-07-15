/**
 * WhatsApp bridge webhook receiver — inbound WhatsApp messages + ack updates.
 *
 * POST /api/webhooks/whatsapp
 *
 * Payload shapes (per the bridge's events enum):
 *   - message.received  → upsert thread + insert inbound message row, bump unread
 *   - message.sent      → upsert thread + insert outbound message row (echo of our own send)
 *   - message.ack       → update existing message row's ack_status
 *   - session.*         → log only (status changes, qr, etc.)
 *
 * Auth: shared-secret header WA_BRIDGE_WEBHOOK_TOKEN. The bridge is configured
 * to send `X-Webhook-Token: <token>`. Without the header or with the
 * wrong value, returns 401. The endpoint itself is in the public-paths
 * list (no tenant context — webhook is anonymous third party).
 *
 * Returns 200 quickly even on parse errors so the bridge's retry policy
 * doesn't hammer us; persistence failures are logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getPool } from '../../db.js';
import { getWaBridgeConfig, getWaContact, isWaBridgeConfigured, listWaGroups } from '../../lib/wa-bridge.js';

/** Constant-time compare. Hashing first equalizes length so timingSafeEqual never throws. */
function safeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

interface WaPayload {
  event?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
  timestamp?: number | string;
}

interface WaMessage {
  id?: string;
  chatId?: string;
  from?: string;
  to?: string;
  fromMe?: boolean;
  author?: string;
  sender?: string;
  senderName?: string;
  sender_name?: string;
  pushName?: string;
  pushname?: string;
  formattedName?: string;
  verifiedName?: string;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  mediaUrl?: string;
  quotedMsgId?: string;
  timestamp?: number;
  isGroupMsg?: boolean;
  notifyName?: string;
  ack?: number | string;
}

const ACK_LABEL: Record<string, string> = {
  '-1': 'failed',
  '0': 'pending',
  '1': 'sent',
  '2': 'delivered',
  '3': 'read',
  '4': 'played',
};

function ackLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw);
  return ACK_LABEL[key] ?? key;
}

function previewBody(body: string | undefined | null, type: string | undefined): string {
  if (body && body.length > 0) {
    return body.length > 140 ? `${body.slice(0, 137)}...` : body;
  }
  switch (type) {
    case 'image': return '📷 image';
    case 'video': return '🎬 video';
    case 'audio': return '🎤 audio';
    case 'ptt': return '🎤 voice note';
    case 'document': return '📄 document';
    case 'sticker': return '🖼 sticker';
    case 'location': return '📍 location';
    case 'contact': case 'vcard': return '👤 contact';
    default: return `[${type ?? 'unknown'}]`;
  }
}

function phoneFromChatId(chatId: string | undefined): string | null {
  if (!chatId) return null;
  // Format 1: "15551234567@c.us" - standard format with phone
  const standard = chatId.match(/^(\d+)@c\.us$/);
  if (standard) return `+${standard[1]}`;

  // Format 2: "30992551153826@lid" - linked device ID (extract phone from lid)
  // The lid number often contains the phone, typically last 10-15 digits
  const lid = chatId.match(/^(\d+)@lid$/);
  if (lid && lid[1].length >= 10) {
    // Extract what looks like a phone number from the end
    const num = lid[1].slice(-12); // Last 12 digits (country code + number)
    return `+${num}`;
  }

  return null;
}

function tsToDate(ts: number | undefined): Date {
  // The bridge returns seconds since epoch on inbound; coerce to ms.
  if (!ts || !isFinite(ts)) return new Date();
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms);
}

function nameFromContact(contact: {
  name?: string | null;
  pushName?: string | null;
  pushname?: string | null;
  formattedName?: string | null;
  verifiedName?: string | null;
}): string | null {
  return contact.verifiedName || contact.name || contact.formattedName || contact.pushName || contact.pushname || null;
}

// A WhatsApp group message carries the sender's push name, not the group
// subject. Keep a short-lived group-subject cache so a busy group does not
// repeatedly ask the bridge for the full group list, and never use a sender as
// a group title.
const GROUP_NAME_CACHE_TTL_MS = 5 * 60 * 1000;
let groupNames = new Map<string, string>();
let groupNamesFetchedAt = 0;
let groupNamesRefresh: Promise<void> | null = null;

async function fetchWaGroupName(chatId: string, log?: FastifyInstance['log']): Promise<string | null> {
  if (!isWaBridgeConfigured()) return null;

  if (Date.now() - groupNamesFetchedAt >= GROUP_NAME_CACHE_TTL_MS && !groupNamesRefresh) {
    groupNamesRefresh = listWaGroups()
      .then((groups) => {
        const next = new Map<string, string>();
        for (const group of groups) {
          if (group.id && group.name) next.set(group.id, group.name);
        }
        groupNames = next;
        groupNamesFetchedAt = Date.now();
      })
      .catch((err) => {
        log?.debug({ err, chatId }, 'failed to refresh WhatsApp group names');
      })
      .finally(() => {
        groupNamesRefresh = null;
      });
  }

  if (groupNamesRefresh) await groupNamesRefresh;
  return groupNames.get(chatId) ?? null;
}

function authorFromMessageId(id: string, chatId: string, isGroup: boolean): string | null {
  if (!isGroup || !id) return null;
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  if (!suffix || suffix === id || suffix === chatId) return null;
  return suffix.includes('@') ? suffix : null;
}

async function fetchWaContactName(contactId: string, log?: FastifyInstance['log']): Promise<string | null> {
  if (!isWaBridgeConfigured()) return null;
  try {
    const contact = await getWaContact(contactId);
    return contact ? nameFromContact(contact) : null;
  } catch (err) {
    log?.debug({ err, contactId }, 'failed to fetch contact name');
    return null;
  }
}

async function upsertWhatsappContactFromMessage(contactId: string, fields: WaMessage, lastSeenAt: Date): Promise<void> {
  const displayName = nameFromContact(fields);
  await getPool().query(
    `INSERT INTO boss_whatsapp_contacts
       (tenant_id, contact_id, display_name, phone, push_name, verified_name,
        is_group, source_payload, last_seen_at, synced_at, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())
     ON CONFLICT (tenant_id, contact_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, boss_whatsapp_contacts.display_name),
           phone = COALESCE(EXCLUDED.phone, boss_whatsapp_contacts.phone),
           push_name = COALESCE(EXCLUDED.push_name, boss_whatsapp_contacts.push_name),
           verified_name = COALESCE(EXCLUDED.verified_name, boss_whatsapp_contacts.verified_name),
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
      phoneFromChatId(contactId),
      fields.pushName ?? fields.pushname ?? null,
      fields.verifiedName ?? null,
      contactId.endsWith('@g.us'),
      JSON.stringify({
        id: contactId,
        name: fields.formattedName ?? null,
        pushName: fields.pushName ?? fields.pushname ?? null,
        verifiedName: fields.verifiedName ?? null,
        notifyName: fields.notifyName ?? null,
      }),
      lastSeenAt,
    ],
  );
}

export async function whatsappWebhookRoutes(server: FastifyInstance) {
  server.post(
    '/whatsapp',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const expectedToken = process.env.WA_BRIDGE_WEBHOOK_TOKEN;
      if (!expectedToken) {
        // HARD REFUSAL: without a shared secret we cannot authenticate the
        // sender, so nothing gets persisted. Loud on purpose — an operator
        // seeing dropped messages should find this immediately.
        request.log.error(
          { event: (request.body as WaPayload | undefined)?.event ?? null },
          'WA_BRIDGE_WEBHOOK_TOKEN is NOT configured — REFUSING to persist inbound WhatsApp webhook. Set WA_BRIDGE_WEBHOOK_TOKEN in the API env and configure the WhatsApp bridge to send X-Webhook-Token.',
        );
        return reply.status(200).send({ ok: true, persisted: false, reason: 'token_not_configured' });
      }

      // Header only. A `?token=` query param would land in traefik/api access
      // logs in plaintext; the bridge always sends the header.
      const headerToken = request.headers['x-webhook-token'] ?? request.headers['x-api-key'];
      const got = typeof headerToken === 'string'
        ? headerToken
        : Array.isArray(headerToken) ? (headerToken[0] ?? '') : '';
      if (!got || !safeEqual(got, expectedToken)) {
        request.log.warn({ hasHeader: !!headerToken }, 'whatsapp webhook: bad token');
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const body = (request.body ?? {}) as WaPayload;
      const event = body.event ?? '';
      const data = (body.data ?? body.payload ?? {}) as WaMessage;
      const pool = getPool();
      try {
        switch (event) {
          case 'message.received':
          case 'message.sent':
          case 'message':
          case 'message_create': {
            const chatId = data.chatId ?? data.from ?? data.to ?? null;
            if (!chatId) {
              request.log.warn({ event }, 'wa webhook: no chatId, dropping');
              return reply.status(200).send({ ok: true, persisted: false, reason: 'no_chat_id' });
            }
            // fromMe: explicit event name wins; otherwise check boolean flag or
            // id string prefix (whatsapp-web.js encodes as "true_<chatId>_<msgId>")
            // or check if 'from' field matches our session phone number
            const sessionPhone = process.env.WA_BRIDGE_SESSION_PHONE ?? '';
            const idStr = typeof data.id === 'string' ? data.id : '';
            const fromPhone = typeof data.from === 'string' ? data.from.replace(/@.+$/, '') : '';
            const fromMe = event === 'message.sent'
              || data.fromMe === true
              || idStr.startsWith('true_')
              || (Boolean(sessionPhone) && fromPhone === sessionPhone);
            const direction = fromMe ? 'outbound' : 'inbound';
            request.log.info({ event, idStr, fromMeFlag: data.fromMe, fromMe, direction, chatId, author: data.author, to: data.to, from: data.from }, 'wa webhook fromMe detection');
            const isGroup = data.isGroupMsg === true || chatId.endsWith('@g.us');
            const sentAt = tsToDate(typeof data.timestamp === 'number' ? data.timestamp : undefined);
            const author = data.author || data.sender || authorFromMessageId(idStr, chatId, isGroup);
            let senderName = data.senderName || data.sender_name || null;
            if (!senderName && isGroup && author && !fromMe) {
              senderName = nameFromContact(data) ?? await fetchWaContactName(author, request.log);
            }

            // In a group, notifyName is the last sender — never its title.
            // Resolve the actual group subject from the bridge. Direct chats
            // continue to prefer the contact's own name, then their phone.
            let displayName: string | null;
            if (isGroup) {
              displayName = await fetchWaGroupName(chatId, request.log);
            } else {
              displayName = data.notifyName || await fetchWaContactName(chatId, request.log);
              if (!displayName) displayName = phoneFromChatId(chatId);
            }
            const preview = previewBody(data.body ?? null, data.type);

            await upsertWhatsappContactFromMessage(chatId, data, sentAt);
            if (author && !fromMe) {
              await upsertWhatsappContactFromMessage(author, { ...data, id: author }, sentAt);
            }

            // Fetch media URL if this is a media message
            let mediaUrl = data.mediaUrl ?? null;
            if (!mediaUrl && data.hasMedia && data.id && isWaBridgeConfigured()
              && (data.type === 'image' || data.type === 'video' || data.type === 'audio' || data.type === 'ptt' || data.type === 'document')) {
              try {
                const config = getWaBridgeConfig();
                const mediaRes = await fetch(`${config.baseUrl}/sessions/${encodeURIComponent(config.sessionId)}/messages/${encodeURIComponent(data.id)}/media`, {
                  headers: { 'X-API-Key': config.apiKey },
                });
                if (mediaRes.ok) {
                  const mediaData = await mediaRes.json() as { url?: string };
                  mediaUrl = mediaData.url ?? null;
                }
              } catch (err) {
                request.log.warn({ err, messageId: data.id }, 'failed to fetch media URL');
              }
            }

            // Upsert thread first; then insert message.
            await pool.query(
              `INSERT INTO boss_whatsapp_threads
                 (tenant_id, chat_id, display_name, phone, is_group,
                  last_message_wa_id, last_message_at, last_message_preview,
                  last_message_from_me, unread_count, updated_at)
               VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8,
                       CASE WHEN $8 THEN 0 ELSE 1 END, NOW())
               ON CONFLICT (tenant_id, chat_id) DO UPDATE
                 SET display_name = CASE
                       WHEN EXCLUDED.display_name IS NULL OR btrim(EXCLUDED.display_name) = ''
                         THEN boss_whatsapp_threads.display_name
                       WHEN boss_whatsapp_threads.display_name IS NULL OR btrim(boss_whatsapp_threads.display_name) = ''
                         THEN EXCLUDED.display_name
                       WHEN boss_whatsapp_threads.display_name = boss_whatsapp_threads.phone
                         OR boss_whatsapp_threads.display_name = boss_whatsapp_threads.chat_id
                         OR boss_whatsapp_threads.display_name LIKE '+%'
                         THEN EXCLUDED.display_name
                       WHEN EXCLUDED.display_name = EXCLUDED.phone
                         OR EXCLUDED.display_name = EXCLUDED.chat_id
                         OR EXCLUDED.display_name LIKE '+%'
                         THEN boss_whatsapp_threads.display_name
                       ELSE EXCLUDED.display_name
                     END,
                     phone                = COALESCE(EXCLUDED.phone, boss_whatsapp_threads.phone),
                     is_group             = EXCLUDED.is_group,
                     last_message_wa_id   = EXCLUDED.last_message_wa_id,
                     last_message_at      = EXCLUDED.last_message_at,
                     last_message_preview = EXCLUDED.last_message_preview,
                     last_message_from_me = EXCLUDED.last_message_from_me,
                     unread_count = CASE
                       WHEN EXCLUDED.last_message_from_me THEN boss_whatsapp_threads.unread_count
                       ELSE boss_whatsapp_threads.unread_count + 1
                     END,
                     updated_at = NOW()`,
              [chatId, displayName, phoneFromChatId(chatId), isGroup,
               data.id ?? null, sentAt, preview, fromMe],
            );

            // Insert message, idempotent on wa_message_id if provided.
            await pool.query(
              `INSERT INTO boss_whatsapp_messages
                 (tenant_id, chat_id, wa_message_id, direction, from_me, author,
                  sender_name, body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
               VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
               DO UPDATE SET
                 author = COALESCE(boss_whatsapp_messages.author, EXCLUDED.author),
                 sender_name = COALESCE(boss_whatsapp_messages.sender_name, EXCLUDED.sender_name),
                 reply_to_wa_message_id = COALESCE(
                   boss_whatsapp_messages.reply_to_wa_message_id,
                   EXCLUDED.reply_to_wa_message_id
                 )`,
              [chatId, data.id ?? null, direction, fromMe, author ?? null, senderName,
               data.body ?? null, data.type ?? 'text', mediaUrl,
               data.quotedMsgId ?? null, ackLabel(data.ack), sentAt],
            );
            return reply.status(200).send({ ok: true, persisted: true, event });
          }

          case 'message.ack': {
            const waId = data.id ?? null;
            if (!waId) {
              return reply.status(200).send({ ok: true, persisted: false, reason: 'no_wa_id' });
            }
            await pool.query(
              `UPDATE boss_whatsapp_messages
                  SET ack_status = $2
                WHERE tenant_id = 'default' AND wa_message_id = $1`,
              [waId, ackLabel(data.ack)],
            );
            return reply.status(200).send({ ok: true, persisted: true, event });
          }

          case 'message.revoked': {
            const waId = data.id ?? null;
            if (waId) {
              await pool.query(
                `UPDATE boss_whatsapp_messages
                    SET ack_status = 'revoked'
                  WHERE tenant_id = 'default' AND wa_message_id = $1`,
                [waId],
              );
            }
            return reply.status(200).send({ ok: true, persisted: !!waId, event });
          }

          default:
            // Log session.* and any unknown events; not stored.
            request.log.info({ event }, 'wa webhook: event ignored');
            return reply.status(200).send({ ok: true, persisted: false, event });
        }
      } catch (err) {
        request.log.error({ err, event }, 'wa webhook: persistence failed');
        // 200 anyway so the bridge doesn't retry-storm.
        return reply.status(200).send({ ok: true, persisted: false, error: 'persistence_failed' });
      }
    },
  );
}
