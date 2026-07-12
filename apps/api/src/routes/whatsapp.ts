/**
 * WhatsApp surface API — threads + per-thread messages + send.
 *
 *   GET    /api/whatsapp/threads                       — list threads (sorted by last_message_at)
 *   GET    /api/whatsapp/threads/:chatId/messages      — message history for one thread
 *   POST   /api/whatsapp/threads/:chatId/send          — send a text reply (manual)
 *   POST   /api/whatsapp/threads/:chatId/mark-read     — zero the unread counter
 *
 * Live WhatsApp traffic is served through Unipile. The older OpenWA paths
 * below are retained as legacy code, but the active API short-circuits to
 * Unipile so stale local OpenWA tables are not shown in the UI.
 */
import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.js';
import {
  findUnipileAccount,
  isUnipileConfigured,
  listUnipileChatMessages,
  listUnipileChats,
  sendUnipileChatMessage,
  startUnipileWhatsAppChat,
  type UnipileChat,
  type UnipileMessage,
} from '../lib/unipile.js';

const OPENWA_BASE = process.env.OPENWA_BASE_URL ?? 'http://localhost:2785/api';
const OPENWA_SESSION = process.env.OPENWA_SESSION_ID ?? '932ccb22-8072-4bee-906c-0c1bae593a1f';
const OPENWA_KEY = process.env.OPENWA_API_KEY ?? '';
const UNIPILE_CHAT_PREFIX = 'unipile:';

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

interface OpenWaContact {
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

function unipileRouteChatId(chatId: string): string {
  return chatId.startsWith(UNIPILE_CHAT_PREFIX) ? chatId.slice(UNIPILE_CHAT_PREFIX.length) : chatId;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function unipilePhone(value?: string | null): string | null {
  if (!value) return null;
  const stripped = value.replace(/@(s\.whatsapp\.net|c\.us|lid)$/i, '');
  return stripped ? `+${stripped.replace(/^\+/, '')}` : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textFrom(source: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) return value;
  }
  return null;
}

function nestedTextFrom(source: Record<string, unknown> | null | undefined, parentKeys: string[], keys: string[]): string | null {
  if (!source) return null;
  for (const parentKey of parentKeys) {
    const value = textFrom(recordValue(source[parentKey]), keys);
    if (value) return value;
  }
  return null;
}

function entityDisplayName(entity: Record<string, unknown> | null | undefined): string | null {
  return textFrom(entity, ['display_name', 'displayName', 'full_name', 'fullName', 'name', 'push_name', 'pushName', 'verified_name', 'verifiedName']);
}

function entityProviderId(entity: Record<string, unknown> | null | undefined): string | null {
  return textFrom(entity, ['provider_id', 'providerId', 'attendee_provider_id', 'attendeeProviderId', 'id']);
}

function firstAttendee(chat: UnipileChat): Record<string, unknown> | null {
  return recordValue(chat.attendee) ?? chat.attendees?.map(recordValue).find(Boolean) ?? null;
}

function unipileChatProviderId(chat: UnipileChat): string | null {
  return chat.attendee_provider_id ?? chat.provider_id ?? entityProviderId(firstAttendee(chat));
}

function isUnipileGroupChat(chat: UnipileChat): boolean {
  const type = String(chat.type ?? '').toLowerCase();
  if (type.includes('group')) return true;
  if ((chat.provider_id ?? '').endsWith('@g.us') || (chat.attendee_provider_id ?? '').endsWith('@g.us')) return true;
  return Array.isArray(chat.attendees) && chat.attendees.length > 1;
}

function unipileChatDisplayName(chat: UnipileChat): string | null {
  const attendee = firstAttendee(chat);
  return chat.name ?? chat.subject ?? entityDisplayName(attendee);
}

function unipileMessageSenderName(message: UnipileMessage): string | null {
  const source = message as unknown as Record<string, unknown>;
  return message.sender_name
    ?? message.sender_full_name
    ?? entityDisplayName(recordValue(message.sender))
    ?? entityDisplayName(recordValue(message.attendee))
    ?? nestedTextFrom(source, ['sender', 'attendee', 'author', 'from'], ['display_name', 'displayName', 'full_name', 'fullName', 'name', 'push_name', 'pushName'])
    ?? null;
}

function mapUnipileChat(chat: UnipileChat): ThreadRow {
  const providerId = unipileChatProviderId(chat);
  const phone = unipilePhone(providerId);
  return {
    chat_id: `${UNIPILE_CHAT_PREFIX}${chat.id}`,
    display_name: unipileChatDisplayName(chat) ?? phone ?? providerId ?? chat.id,
    phone,
    is_group: isUnipileGroupChat(chat),
    last_message_at: chat.timestamp ?? null,
    last_message_preview: chat.subject ?? null,
    last_message_from_me: null,
    unread_count: Number(chat.unread_count ?? 0),
    archived: asBool(chat.archived),
  };
}

function mapUnipileMessage(message: UnipileMessage): MessageRow {
  const fromMe = asBool(message.is_sender);
  const id = message.id ?? message.message_id ?? `${message.chat_id ?? 'unipile'}-${message.timestamp ?? Date.now()}`;
  const senderName = unipileMessageSenderName(message);
  return {
    id: `${UNIPILE_CHAT_PREFIX}${id}`,
    chat_id: `${UNIPILE_CHAT_PREFIX}${message.chat_id ?? ''}`,
    wa_message_id: message.message_id ?? message.id ?? null,
    direction: fromMe ? 'outbound' : 'inbound',
    from_me: fromMe,
    author: message.sender_id ?? null,
    sender_name: senderName,
    body: message.text ?? null,
    message_type: message.message_type ?? 'chat',
    media_url: null,
    ack_status: asBool(message.seen) ? 'seen' : asBool(message.delivered) ? 'delivered' : null,
    sent_at: message.timestamp ?? new Date().toISOString(),
  };
}

function mapUnipileContact(chat: UnipileChat): ContactRow {
  const providerId = unipileChatProviderId(chat);
  const phone = unipilePhone(providerId);
  const displayName = unipileChatDisplayName(chat);
  return {
    contact_id: `${UNIPILE_CHAT_PREFIX}${chat.id}`,
    display_name: displayName ?? phone,
    phone,
    push_name: displayName,
    verified_name: null,
    is_my_contact: null,
    is_blocked: null,
    is_group: isUnipileGroupChat(chat),
    last_seen_at: chat.timestamp ?? null,
    synced_at: new Date().toISOString(),
  };
}

function chatIdToPhone(chatId: string): string {
  // Send-text expects "{number}" not "{number}@c.us" or "{number}@lid"
  // @lid is WhatsApp's new linked device ID format
  return chatId.replace(/@c\.us$/, '').replace(/@g\.us$/, '').replace(/@lid$/, '');
}

function authorFromMessageId(id: string | undefined, chatId: string): string | null {
  if (!id || !chatId.endsWith('@g.us')) return null;
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  if (!suffix || suffix === id || suffix === chatId) return null;
  return suffix.includes('@') ? suffix : null;
}

function nameFromOpenWaContact(contact: OpenWaContact): string | null {
  return contact.verifiedName || contact.name || contact.formattedName || contact.pushName || contact.pushname || null;
}

function phoneFromOpenWaContact(contact: OpenWaContact): string | null {
  if (contact.number) return contact.number.startsWith('+') ? contact.number : `+${contact.number}`;
  if (contact.id?.endsWith('@c.us')) return `+${contact.id.replace(/@c\.us$/, '')}`;
  return null;
}

async function upsertWhatsappContact(contact: OpenWaContact, lastSeenAt: Date | null = null): Promise<string | null> {
  const contactId = contact.id ?? null;
  if (!contactId) return null;
  const displayName = nameFromOpenWaContact(contact);
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
      phoneFromOpenWaContact(contact),
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

export async function whatsappRoutes(server: FastifyInstance) {
  // ── List threads ────────────────────────────────────────────────────────
  server.get('/threads', async (request, reply) => {
    if (!isUnipileConfigured()) return reply.send({ threads: [] });
    try {
      const chats = await listUnipileChats('WHATSAPP', 200);
      return reply.send({ threads: chats.map(mapUnipileChat) });
    } catch (err) {
      request.log.error({ err }, 'unipile whatsapp threads failed');
      return reply.status(502).send({ error: 'unipile_threads_failed' });
    }

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
      if (!isUnipileConfigured()) return reply.send({ chatId, messages: [] });
      try {
        const messages = await listUnipileChatMessages(unipileRouteChatId(chatId), Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200));
        return reply.send({ chatId, messages: messages.map(mapUnipileMessage) });
      } catch (err) {
        request.log.error({ err, chatId }, 'unipile whatsapp messages failed');
        return reply.status(502).send({ error: 'unipile_messages_failed' });
      }

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
                message_type, media_url, ack_status, sent_at
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
      if (!isUnipileConfigured()) return reply.status(503).send({ error: 'unipile_not_configured' });
      try {
        const account = await findUnipileAccount('WHATSAPP');
        const sent = await sendUnipileChatMessage(unipileRouteChatId(chatId), message, account?.id);
        return reply.send({ ok: true, unipile: sent });
      } catch (err) {
        request.log.error({ err, chatId }, 'unipile whatsapp send failed');
        return reply.status(502).send({ error: 'unipile_send_failed' });
      }
      if (!OPENWA_KEY) return reply.status(503).send({ error: 'openwa_not_configured' });

      try {
        const wa = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/messages/send-text`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': OPENWA_KEY,
          },
          body: JSON.stringify({ chatId, text: message }),
        });
        const data = (await wa.json().catch(() => ({}))) as Record<string, unknown>;
        if (!wa.ok) {
          request.log.warn({ chatId, status: wa.status, data }, 'openwa send-text failed');
          return reply.status(502).send({ error: 'openwa_send_failed', detail: data });
        }

        // Manually persist the sent message since OpenWA doesn't always webhook for API-sent messages
        const waMessageId = typeof data.messageId === 'string' ? data.messageId : null;
        const sentAt = new Date();
        const pool = getPool();

        await pool.query(
          `INSERT INTO boss_whatsapp_messages
             (tenant_id, chat_id, wa_message_id, direction, from_me, author,
              body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
           VALUES ('default', $1, $2, 'outbound', true, NULL, $3, 'chat', NULL, NULL, 'sent', $4)
           ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
             DO NOTHING`,
          [chatId, waMessageId, message, sentAt],
        );

        // Update thread last_message and clear unread
        await pool.query(
          `UPDATE boss_whatsapp_threads
              SET last_message_wa_id = $2,
                  last_message_at = $3,
                  last_message_preview = $4,
                  last_message_from_me = true,
                  unread_count = 0,
                  updated_at = NOW()
            WHERE tenant_id = 'default' AND chat_id = $1`,
          [chatId, waMessageId, sentAt, message.substring(0, 100)],
        );

        return reply.send({ ok: true, openwa: data });
      } catch (err) {
        request.log.error({ err, chatId }, 'send-text exception');
        return reply.status(500).send({ error: 'send_failed' });
      }
    },
  );

  // ── Live contact list derived from Unipile WhatsApp chats ───────────────
  server.get('/contacts', async (_request, reply) => {
    if (!isUnipileConfigured()) return reply.send({ contacts: [] });
    const chats = await listUnipileChats('WHATSAPP', 500);
    return reply.send({ contacts: chats.map(mapUnipileContact) });

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
    if (!isUnipileConfigured()) return reply.status(503).send({ error: 'unipile_not_configured' });
    try {
      const chats = await listUnipileChats('WHATSAPP', 500);
      return reply.send({ ok: true, upserted: 0, total: chats.length });
    } catch (err) {
      request.log.error({ err }, 'unipile whatsapp contacts sync failed');
      return reply.status(502).send({ error: 'unipile_contacts_failed' });
    }

    if (!OPENWA_KEY) return reply.status(503).send({ error: 'openwa_not_configured' });
    try {
      const contactsRes = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/contacts`, {
        headers: { 'X-API-Key': OPENWA_KEY },
      });
      if (!contactsRes.ok) return reply.status(502).send({ error: 'openwa_contacts_failed' });
      const contacts = (await contactsRes.json().catch(() => [])) as OpenWaContact[];

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

  // ── Legacy name sync. With Unipile live, this is a no-op. ───────────────
  server.post('/sync-names', async (request, reply) => {
    if (isUnipileConfigured()) return reply.send({ ok: true, updated: 0, source: 'unipile' });

    if (!OPENWA_KEY) return reply.status(503).send({ error: 'openwa_not_configured' });
    const pool = getPool();
    try {
      const headers = { 'X-API-Key': OPENWA_KEY };

      // Fetch groups and contacts in parallel
      const [groupsRes, contactsRes] = await Promise.all([
        fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/groups`, { headers }),
        fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/contacts`, { headers }),
      ]);

      // group id → name
      const groupMap = new Map<string, string>();
      if (groupsRes.ok) {
        const groups = (await groupsRes.json().catch(() => [])) as Array<{ id: string; name?: string }>;
        for (const g of groups) {
          if (g.id && g.name) groupMap.set(g.id, g.name);
        }
      }

      // contact number → name (prefer saved name over pushName)
      const contactMap = new Map<string, { name: string; phone: string }>();
      if (contactsRes.ok) {
        const contacts = (await contactsRes.json().catch(() => [])) as OpenWaContact[];
        for (const c of contacts) {
          await upsertWhatsappContact(c);
          const num = c.number ?? c.id?.replace(/@c\.us$/, '') ?? '';
          const displayName = nameFromOpenWaContact(c);
          if (num && displayName) {
            contactMap.set(num, { name: displayName, phone: num });
          }
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
    if (isUnipileConfigured()) {
      return reply.send({ ok: true });
    }
    await getPool().query(
      `UPDATE boss_whatsapp_threads
          SET unread_count = 0, updated_at = NOW()
        WHERE tenant_id = 'default' AND chat_id = $1`,
      [chatId],
    );
    return reply.send({ ok: true });
  });

  // ── Legacy message sync. With Unipile live, this is a no-op. ────────────
  server.post<{ Params: { chatId: string } }>('/threads/:chatId/sync', async (request, reply) => {
    if (isUnipileConfigured()) return reply.send({ ok: true, synced: 0, source: 'unipile' });

    if (!OPENWA_KEY) return reply.status(503).send({ error: 'openwa_not_configured' });
    const chatId = decodeURIComponent(request.params.chatId);
    const SESSION_PHONE = process.env.OPENWA_SESSION_PHONE ?? '15397777906';

    try {
      const res = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/channels/${encodeURIComponent(chatId)}/messages?limit=50`, {
        headers: { 'X-API-Key': OPENWA_KEY }
      });
      if (!res.ok) return reply.status(502).send({ error: 'openwa_fetch_failed' });

      const messages = (await res.json().catch(() => [])) as Array<{
        id?: string; from?: string; to?: string; body?: string; type?: string;
        timestamp?: number; fromMe?: boolean; hasMedia?: boolean; author?: string;
        sender?: string; senderName?: string; sender_name?: string; pushName?: string; pushname?: string;
      }>;

      let synced = 0;
      const pool = getPool();
      for (const msg of messages) {
        if (!msg.id) continue;
        const fromPhone = typeof msg.from === 'string' ? msg.from.replace(/@.+$/, '') : '';
        const fromMe = msg.fromMe === true || fromPhone === SESSION_PHONE || msg.id.startsWith('true_');
        const direction = fromMe ? 'outbound' : 'inbound';
        const sentAt = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
        const author = msg.author || msg.sender || authorFromMessageId(msg.id, chatId);
        const senderName = msg.senderName || msg.sender_name || msg.pushName || msg.pushname || null;

        const result = await pool.query(
          `INSERT INTO boss_whatsapp_messages
             (tenant_id, chat_id, wa_message_id, direction, from_me, author,
              sender_name, body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
           VALUES ('default', $1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, $8)
           ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL
             DO UPDATE SET
               author = COALESCE(boss_whatsapp_messages.author, EXCLUDED.author),
               sender_name = COALESCE(boss_whatsapp_messages.sender_name, EXCLUDED.sender_name)
           RETURNING id`,
          [chatId, msg.id, direction, fromMe, author, senderName, msg.body ?? null, msg.type ?? 'chat', sentAt]
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
      const { chatId, message, sendAt, createdBy = 'kevin' } = request.body;
      if (!chatId || !message || !sendAt) {
        return reply.status(400).send({ error: 'chatId, message, and sendAt required' });
      }

      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO boss_whatsapp_scheduled
           (tenant_id, chat_id, message, send_at, created_by, status)
         VALUES ('default', $1, $2, $3, $4, 'pending')
         RETURNING id, created_at`,
        [chatId, message, sendAt, createdBy]
      );

      return reply.code(201).send({ scheduled: rows[0] });
    }
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
          JOIN boss_whatsapp_threads t ON t.tenant_id = s.tenant_id AND t.chat_id = s.chat_id
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
    }
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
          WHERE id = $1 AND tenant_id = 'default' AND status = 'pending'
          RETURNING id`,
        [id]
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'not found or already processed' });
      }

      return reply.send({ ok: true, cancelled: rows[0].id });
    }
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
        [id]
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'not found or already processed' });
      }

      return reply.send({ ok: true, approved: rows[0] });
    }
  );

  // POST /api/whatsapp/start-conversation - Start new conversation with phone number
  server.post<{ Body: { phone: string; message: string } }>(
    '/start-conversation',
    async (request, reply) => {
      const { phone, message } = request.body;
      if (!phone || !message) {
        return reply.status(400).send({ error: 'phone and message required' });
      }
      if (!isUnipileConfigured()) return reply.status(503).send({ error: 'unipile_not_configured' });

      try {
        const sent = await startUnipileWhatsAppChat(phone, message);
        return reply.send({ ok: true, chatId: sent.chatId ? `${UNIPILE_CHAT_PREFIX}${sent.chatId}` : null, messageId: sent.messageId });
      } catch (err) {
        request.log.error({ err, phone }, 'unipile start-conversation failed');
        return reply.status(502).send({ error: 'unipile_start_conversation_failed' });
      }

      // Normalize phone to chatId format
      const cleanPhone = phone.replace(/\D/g, '');
      const chatId = `${cleanPhone}@c.us`;

      const pool = getPool();

      // Check if thread exists, create if not
      await pool.query(
        `INSERT INTO boss_whatsapp_threads (tenant_id, chat_id, display_name, phone, is_group)
         VALUES ('default', $1, $2, $3, false)
         ON CONFLICT (tenant_id, chat_id) DO NOTHING`,
        [chatId, `+${cleanPhone}`, `+${cleanPhone}`]
      );

      // Send message via existing send endpoint logic
      if (!OPENWA_KEY) return reply.status(503).send({ error: 'openwa_not_configured' });

      try {
        const wa = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/messages/send-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': OPENWA_KEY },
          body: JSON.stringify({ chatId, text: message }),
        });

        const data = (await wa.json().catch(() => ({}))) as Record<string, unknown>;
        if (!wa.ok) {
          return reply.status(502).send({ error: 'openwa_send_failed', detail: data });
        }

        const waMessageId = typeof data.messageId === 'string' ? data.messageId : null;
        const sentAt = new Date();

        // Persist sent message
        await pool.query(
          `INSERT INTO boss_whatsapp_messages
             (tenant_id, chat_id, wa_message_id, direction, from_me, body, message_type, ack_status, sent_at)
           VALUES ('default', $1, $2, 'outbound', true, $3, 'chat', 'sent', $4)
           ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
          [chatId, waMessageId, message, sentAt]
        );

        // Update thread
        await pool.query(
          `UPDATE boss_whatsapp_threads
              SET last_message_wa_id = $2, last_message_at = $3,
                  last_message_preview = $4, last_message_from_me = true, updated_at = NOW()
            WHERE tenant_id = 'default' AND chat_id = $1`,
          [chatId, waMessageId, message.substring(0, 100), sentAt]
        );

        return reply.send({ ok: true, chatId, messageId: waMessageId });
      } catch (err) {
        request.log.error({ err, phone }, 'start-conversation failed');
        return reply.status(500).send({ error: 'send_failed' });
      }
    }
  );
}
