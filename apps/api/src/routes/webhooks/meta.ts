/**
 * Meta Graph API webhook receiver — Facebook Pages/Messenger, Instagram,
 * WhatsApp Cloud.
 *
 *   GET  /api/webhooks/meta — verification handshake. Meta sends
 *        ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<nonce>.
 *        We compare the token against META_WEBHOOK_VERIFY_TOKEN (mirrored from
 *        the stored credentials) and echo the challenge as plain text.
 *
 *   POST /api/webhooks/meta — event delivery. Each POST is signed with
 *        X-Hub-Signature-256: sha256=<hex>; we recompute HMAC-SHA256 over the
 *        raw body with META_APP_SECRET (env, mirrored from creds; falls back to
 *        the decrypted app secret) and reject mismatches. Successful deliveries
 *        are persisted to boss_meta_events and fanned out per product:
 *          - whatsapp_business_account → boss_whatsapp_* (source-agnostic w/ OpenWA)
 *          - page (Messenger)          → boss_fb_threads / boss_fb_messages
 *          - instagram (DMs)           → boss_fb_threads (platform='instagram')
 *        then 200 within Meta's 2-second window.
 *
 * The webhook URL itself is the secret (plus verify-token + signature); it's in
 * the auth + tenant middleware public-paths list. Persistence failures never
 * block the 200 ack (else Meta marks the endpoint unhealthy).
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool } from '../../db.js';
import { getMetaCreds } from '../../lib/meta-graph.js';

interface VerifyQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

const TENANT = 'default';

export async function metaWebhookRoutes(server: FastifyInstance) {
  // ── Verification handshake (GET) ──────────────────────────────────────────
  server.get<{ Querystring: VerifyQuery }>(
    '/meta',
    { config: { skipAuth: true } },
    async (request, reply) => {
      // Prefer the stored (encrypted) verify token over any .env placeholder.
      const credsG = await getMetaCreds(TENANT).catch(() => null);
      const expected = credsG?.webhookVerifyToken ?? process.env.META_WEBHOOK_VERIFY_TOKEN;
      if (!expected) {
        request.log.error('META_WEBHOOK_VERIFY_TOKEN not configured');
        return reply.status(503).send({ error: 'webhook not configured' });
      }

      const mode = request.query['hub.mode'];
      const token = request.query['hub.verify_token'];
      const challenge = request.query['hub.challenge'];

      if (mode === 'subscribe' && typeof token === 'string' && timingSafeEqualStr(token, expected) && typeof challenge === 'string') {
        request.log.info('Meta webhook verification: accepted');
        return reply.type('text/plain').status(200).send(challenge);
      }

      request.log.warn({ mode, hasToken: !!token, match: token === expected }, 'Meta webhook verification: rejected');
      return reply.status(403).send({ error: 'verification failed' });
    },
  );

  // ── Event delivery (POST) ─────────────────────────────────────────────────
  server.post(
    '/meta',
    { config: { skipAuth: true } },
    async (request, reply) => {
      // Verify against ANY connected app's secret (social #1, messaging #2,
      // whatsapp #3) — each Meta app signs its own webhooks with its own secret.
      const credsP = await getMetaCreds(TENANT).catch(() => null);
      const secrets = [credsP?.appSecret, credsP?.messaging.appSecret, credsP?.whatsapp.appSecret, process.env.META_APP_SECRET]
        .filter((s): s is string => !!s);
      if (secrets.length === 0) {
        request.log.error('No Meta app secret configured');
        return reply.status(200).send({ ok: true, persisted: false, reason: 'app_secret_missing' });
      }

      const sigHeader = request.headers['x-hub-signature-256'];
      const signature = typeof sigHeader === 'string' ? sigHeader : '';
      if (!signature.startsWith('sha256=')) {
        return reply.status(401).send({ error: 'missing signature' });
      }
      const provided = signature.slice('sha256='.length);

      const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      const ok = secrets.some((s) => timingSafeEqualHex(provided, crypto.createHmac('sha256', s).update(raw, 'utf8').digest('hex')));
      if (!ok) {
        request.log.warn('Meta webhook signature: mismatch');
        return reply.status(401).send({ error: 'invalid signature' });
      }

      const body = (request.body ?? {}) as MetaEventBody;
      request.log.info({ object: body.object }, 'Meta webhook event');

      // Persist + fan out (best-effort — never block the 200 ack).
      try {
        await persistAndFanOut(body, request);
      } catch (err) {
        request.log.warn({ err, object: body.object }, 'Meta webhook persistence failed');
      }

      // Optional: notify a rascal so the event lands in a chat surface.
      const notifyHandle = process.env.META_WEBHOOK_NOTIFY_HANDLE;
      if (notifyHandle) {
        try { await notifyRascal(notifyHandle, body); }
        catch (err) { request.log.warn({ err, notifyHandle }, 'Meta webhook chat notification failed'); }
      }

      return reply.status(200).send({ ok: true });
    },
  );
}

// ── Types ──────────────────────────────────────────────────────────────────
interface MetaEventBody {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: Array<Record<string, unknown>>;
    changes?: Array<Record<string, unknown>>;
  }>;
}

// ── Persistence + fan-out ────────────────────────────────────────────────────
async function persistEvent(object: string, eventType: string, externalId: string | null, summary: string, payload: unknown): Promise<void> {
  await getPool().query(
    `INSERT INTO boss_meta_events (tenant_id, object, event_type, external_id, summary, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [TENANT, object, eventType, externalId, summary.slice(0, 500), JSON.stringify(payload)],
  );
}

async function persistAndFanOut(body: MetaEventBody, request: FastifyRequest): Promise<void> {
  const object = body.object ?? 'unknown';
  const entries = body.entry ?? [];

  for (const entry of entries) {
    if (object === 'whatsapp_business_account') {
      for (const change of entry.changes ?? []) {
        await handleWhatsAppChange(change, request);
      }
    } else if (object === 'page' || object === 'instagram') {
      const platform = object === 'instagram' ? 'instagram' : 'messenger';
      for (const m of entry.messaging ?? []) {
        await handleMessagingEvent(m, platform, request);
      }
      for (const change of entry.changes ?? []) {
        const field = String((change as { field?: string }).field ?? 'change');
        await persistEvent(object, field, entry.id ?? null, `${object} ${field} event`, change);
      }
    } else {
      await persistEvent(object, 'unknown', entry.id ?? null, `${object} event`, entry);
    }
  }
}

// WhatsApp Cloud: entry.changes[].value.{messages[],contacts[],statuses[],metadata}
async function handleWhatsAppChange(change: Record<string, unknown>, request: FastifyRequest): Promise<void> {
  const value = (change.value ?? {}) as {
    messages?: Array<Record<string, unknown>>;
    contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
    statuses?: Array<Record<string, unknown>>;
  };
  const pool = getPool();
  const contactName = value.contacts?.[0]?.profile?.name ?? null;

  for (const msg of value.messages ?? []) {
    const from = String(msg.from ?? '');
    if (!from) continue;
    const waId = String(msg.id ?? '');
    const chatId = `${from}@c.us`;
    const phone = `+${from}`;
    const type = String(msg.type ?? 'text');
    const text = type === 'text'
      ? String((msg.text as { body?: string } | undefined)?.body ?? '')
      : `[${type}]`;
    const tsSec = parseInt(String(msg.timestamp ?? ''), 10);
    const sentAt = Number.isFinite(tsSec) ? new Date(tsSec * 1000) : new Date();
    const preview = text.length > 140 ? `${text.slice(0, 137)}...` : text;

    await pool.query(
      `INSERT INTO boss_whatsapp_threads
         (tenant_id, chat_id, display_name, phone, is_group, last_message_wa_id,
          last_message_at, last_message_preview, last_message_from_me, unread_count, updated_at)
       VALUES ('default', $1, $2, $3, false, $4, $5, $6, false, 1, NOW())
       ON CONFLICT (tenant_id, chat_id) DO UPDATE SET
         display_name = COALESCE(boss_whatsapp_threads.display_name, EXCLUDED.display_name),
         last_message_wa_id = EXCLUDED.last_message_wa_id,
         last_message_at = EXCLUDED.last_message_at,
         last_message_preview = EXCLUDED.last_message_preview,
         last_message_from_me = false,
         unread_count = boss_whatsapp_threads.unread_count + 1,
         updated_at = NOW()`,
      [chatId, contactName ?? phone, phone, waId || null, sentAt, preview],
    );
    await pool.query(
      `INSERT INTO boss_whatsapp_messages
         (tenant_id, chat_id, wa_message_id, direction, from_me, author, sender_name,
          body, message_type, media_url, reply_to_wa_message_id, ack_status, sent_at)
       VALUES ('default', $1, $2, 'inbound', false, NULL, $3, $4, $5, NULL, NULL, 'delivered', $6)
       ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
      [chatId, waId || null, contactName, text, type, sentAt],
    );
    await persistEvent('whatsapp_business_account', 'message', waId || null, `WA from ${contactName ?? phone}: ${preview}`, msg);
  }

  for (const st of value.statuses ?? []) {
    await persistEvent('whatsapp_business_account', 'status', String(st.id ?? '') || null, `WA status ${String(st.status ?? '')}`, st);
  }
  request.log.info({ messages: value.messages?.length ?? 0, statuses: value.statuses?.length ?? 0 }, 'WA Cloud change processed');
}

// Messenger / IG DMs: messaging[].{sender,recipient,message,timestamp,postback}
async function handleMessagingEvent(m: Record<string, unknown>, platform: string, request: FastifyRequest): Promise<void> {
  const sender = (m.sender as { id?: string } | undefined)?.id ?? null;
  const recipient = (m.recipient as { id?: string } | undefined)?.id ?? null;
  const message = m.message as { mid?: string; text?: string; is_echo?: boolean } | undefined;
  const postback = m.postback as { payload?: string; title?: string } | undefined;
  if (!sender) return;

  const creds = await getMetaCreds(TENANT).catch(() => null);
  const pageId = creds?.facebook.pageId;
  // is_echo is the authoritative outbound signal; pageId compare only helps Messenger.
  const fromPage = message?.is_echo === true || (platform === 'messenger' && !!pageId && sender === pageId);
  // The "thread" is keyed by the external user (the non-page party).
  const participant = fromPage ? recipient : sender;
  if (!participant) return;

  const text = message?.text ?? (postback ? `[postback] ${postback.title ?? postback.payload ?? ''}` : '[non-text]');
  const tsMs = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
  const sentAt = new Date(tsMs);
  const preview = text.length > 140 ? `${text.slice(0, 137)}...` : text;
  const pool = getPool();

  await pool.query(
    `INSERT INTO boss_fb_threads
       (tenant_id, conversation_id, platform, participant_id, last_message_at,
        last_message_preview, last_message_from_page, unread_count, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (tenant_id, conversation_id) DO UPDATE SET
       last_message_at = EXCLUDED.last_message_at,
       last_message_preview = EXCLUDED.last_message_preview,
       last_message_from_page = EXCLUDED.last_message_from_page,
       unread_count = CASE WHEN EXCLUDED.last_message_from_page THEN boss_fb_threads.unread_count
                           ELSE boss_fb_threads.unread_count + 1 END,
       updated_at = NOW()`,
    [participant, platform, participant, sentAt, preview, fromPage, fromPage ? 0 : 1],
  );
  // Only persist a message row when we have a mid (dedupe key). Mid-less events
  // (postbacks/reads) would never collide on UNIQUE(tenant_id,mid) and would
  // duplicate on webhook redelivery — they're already in boss_meta_events.
  if (message?.mid) {
    await pool.query(
      `INSERT INTO boss_fb_messages
         (tenant_id, conversation_id, mid, platform, direction, sender_id, sender_name, body, created_at)
       VALUES ('default', $1, $2, $3, $4, $5, NULL, $6, $7)
       ON CONFLICT (tenant_id, mid) DO NOTHING`,
      [participant, message.mid, platform, fromPage ? 'outbound' : 'inbound', sender, text, sentAt],
    );
  }
  await persistEvent(platform === 'instagram' ? 'instagram' : 'page', 'message', message?.mid ?? null, `${platform} ${fromPage ? 'out' : 'in'}: ${preview}`, m);
  request.log.info({ platform, fromPage, participant }, 'Messaging event processed');
}

// ── Optional rascal notification (unchanged behavior) ────────────────────────
async function notifyRascal(handle: string, body: MetaEventBody): Promise<void> {
  const sess = await getPool().query<{ id: string }>(
    `SELECT id FROM boss_chat_sessions
       WHERE rascal_handle = $1 AND archived = FALSE
       ORDER BY updated_at DESC LIMIT 1`,
    [handle],
  );
  if (sess.rows.length === 0) throw new Error(`no active chat session for rascal "${handle}"`);
  const summary = summarizeMetaEvent(body);
  await getPool().query(
    `INSERT INTO boss_chat_messages (session_id, role, content) VALUES ($1, 'system', $2)`,
    [sess.rows[0].id, summary],
  );
}

function summarizeMetaEvent(body: MetaEventBody): string {
  const product = body.object ?? 'unknown';
  const entries = body.entry ?? [];
  const counts = {
    messaging: entries.reduce((n, e) => n + ((e.messaging as unknown[] | undefined)?.length ?? 0), 0),
    changes:   entries.reduce((n, e) => n + ((e.changes   as unknown[] | undefined)?.length ?? 0), 0),
  };
  const detail =
    counts.messaging > 0 ? `${counts.messaging} message event(s)` :
    counts.changes   > 0 ? `${counts.changes} change event(s)` :
    `${entries.length} entry(ies)`;
  return `[meta-webhook] ${product}: ${detail}\n\n\`\`\`json\n${JSON.stringify(body, null, 2).slice(0, 1500)}\n\`\`\``;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
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
