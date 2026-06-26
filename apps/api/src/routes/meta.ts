/**
 * Meta connector + read API  (prefix /api/meta).
 *
 *   GET  /api/meta/status                 — non-secret connection summary (dashboard tile)
 *   POST /api/meta/credentials            — register the §6 credential JSON (admin); encrypts + stores
 *   GET  /api/meta/fb/threads             — Facebook Messenger threads from the local mirror (tile)
 *   GET  /api/meta/fb/conversations       — live FB Messenger conversations via Graph (debug/agent)
 *   GET  /api/meta/events?limit=          — recent Meta webhook events (boss_meta_events)
 *   POST /api/meta/subscribe              — subscribe the Page (and WABA) to the app webhooks (admin)
 *
 * Auth: standard authMiddleware applies (Bearer). Mutating routes are admin-gated.
 * Secrets are NEVER returned — status reports booleans + non-secret ids only.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { setRuntimeConfig } from '../config-store.js';
import {
  storeMetaCreds, getMetaCreds, metaStatus, clearMetaCredsCache,
  fbListConversations, fbPageActivity, fbPublishPost, socialActivity, graphCall, GRAPH_VERSION,
  type MetaCredsInput,
} from '../lib/meta-graph.js';

function isAdmin(request: FastifyRequest): boolean {
  const role = request.auth?.role;
  return role === 'admin' || role === 'owner';
}

export async function metaRoutes(server: FastifyInstance) {
  // ── Status ────────────────────────────────────────────────────────────────
  server.get('/status', async (_request, reply) => {
    const creds = await getMetaCreds('default');
    return reply.send(metaStatus(creds));
  });

  // ── Register credentials (admin) ────────────────────────────────────────────
  server.post<{ Body: MetaCredsInput }>('/credentials', async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only admins can register Meta credentials' });
    }
    const body = request.body ?? {};
    const hasToken = !!(
      body.system_user_token || body.facebook?.page_access_token || body.instagram?.access_token ||
      body.whatsapp?.access_token || body.threads?.access_token || body.ads?.access_token ||
      body.messaging?.page_access_token
    );
    // app_secret is OPTIONAL — a token alone is enough to connect (Graph reads/writes
    // + agents work via the token). The app secret only enables inbound webhook HMAC
    // verification and can be added later.
    if (!body.app_id && !hasToken) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Provide app_id and/or at least one access token' });
    }
    try {
      const creds = await storeMetaCreds(body);
      // Mirror only the NON-secret app id into runtime_config (so the Connections
      // page shows Meta configured). The app secret + verify token are NOT
      // persisted here — runtime_config is plaintext; the webhook reads them from
      // the encrypted boss_meta_credentials store instead.
      if (body.app_id) await setRuntimeConfig('META_APP_ID', body.app_id, 'default');
      clearMetaCredsCache('default');
      return reply.send({ status: 'ok', connection: metaStatus(creds) });
    } catch (err) {
      request.log.error({ err }, 'meta credentials store failed');
      return reply.status(500).send({ error: 'store_failed', message: (err as Error).message });
    }
  });

  // ── Facebook Messenger threads (local mirror, for the tile) ──────────────────
  server.get<{ Querystring: { limit?: string } }>('/fb/threads', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200);
    const { rows } = await getPool().query(
      `SELECT conversation_id, platform, participant_id, participant_name,
              last_message_at, last_message_preview, last_message_from_page, unread_count
         FROM boss_fb_threads
        WHERE tenant_id = 'default'
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
    return reply.send({ threads: rows });
  });

  // ── Live FB conversations via Graph (debug / agent) ──────────────────────────
  server.get<{ Querystring: { limit?: string } }>('/fb/conversations', async (request, reply) => {
    if (!isAdmin(request)) return reply.status(403).send({ error: 'Forbidden' });
    const creds = await getMetaCreds('default');
    if (!creds?.facebook.pageAccessToken) {
      return reply.status(409).send({ error: 'not_connected', message: 'Facebook Page is not connected' });
    }
    try {
      const limit = Math.min(parseInt(request.query.limit ?? '25', 10) || 25, 50);
      const data = await fbListConversations(creds, limit);
      return reply.send({ conversations: data });
    } catch (err) {
      request.log.error({ err }, 'fb conversations fetch failed');
      return reply.status(502).send({ error: 'graph_error', message: (err as Error).message });
    }
  });

  // ── Facebook Page activity ("notifications") for the FB tile ─────────────────
  server.get('/fb/activity', async (_request, reply) => {
    const creds = await getMetaCreds('default');
    if (!creds?.facebook.pageAccessToken) return reply.status(409).send({ error: 'not_connected', message: 'Facebook Page is not connected' });
    try {
      return reply.send(await fbPageActivity(creds, 10));
    } catch (err) {
      _request.log.error({ err }, 'fb activity fetch failed');
      return reply.status(502).send({ error: 'graph_error', message: (err as Error).message });
    }
  });

  // ── Combined FB + IG rich activity (commenters, reactions, types) ────────────
  server.get('/social', async (request, reply) => {
    const creds = await getMetaCreds('default');
    if (!creds) return reply.send({ facebook: null, instagram: null });
    try {
      return reply.send(await socialActivity(creds, 8));
    } catch (err) {
      request.log.error({ err }, 'social activity fetch failed');
      return reply.status(502).send({ error: 'graph_error', message: (err as Error).message });
    }
  });

  // ── Publish a post to the Facebook Page (admin) ──────────────────────────────
  server.post<{ Body: { message?: string; link?: string } }>('/fb/post', async (request, reply) => {
    if (!isAdmin(request)) return reply.status(403).send({ error: 'Forbidden' });
    const message = String(request.body?.message ?? '').trim();
    if (!message) return reply.status(400).send({ error: 'bad_request', message: 'message is required' });
    const creds = await getMetaCreds('default');
    if (!creds?.facebook.pageAccessToken) return reply.status(409).send({ error: 'not_connected' });
    try {
      const r = await fbPublishPost(creds, message, request.body?.link?.trim() || undefined);
      return reply.send({ ok: true, id: r.id });
    } catch (err) {
      request.log.error({ err }, 'fb post failed');
      return reply.status(502).send({ error: 'graph_error', message: (err as Error).message });
    }
  });

  // ── Recent Meta webhook events ───────────────────────────────────────────────
  server.get<{ Querystring: { limit?: string } }>('/events', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200);
    const { rows } = await getPool().query(
      `SELECT id, object, event_type, external_id, summary, created_at
         FROM boss_meta_events
        WHERE tenant_id = 'default'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return reply.send({ events: rows });
  });

  // ── Subscribe the Page (+ optionally WABA) to the app webhooks (admin) ───────
  server.post('/subscribe', async (request, reply) => {
    if (!isAdmin(request)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const creds = await getMetaCreds('default');
    if (!creds?.facebook.pageId || !creds.facebook.pageAccessToken) {
      return reply.status(409).send({ error: 'not_connected', message: 'Facebook Page is not connected' });
    }
    const results: Record<string, unknown> = {};
    try {
      results.page = await graphCall(`${creds.facebook.pageId}/subscribed_apps`, {
        token: creds.facebook.pageAccessToken,
        method: 'POST',
        body: { subscribed_fields: ['messages', 'messaging_postbacks', 'message_deliveries', 'messaging_reads', 'feed'] },
        version: GRAPH_VERSION,
      });
    } catch (err) {
      results.page = { error: (err as Error).message };
    }
    return reply.send({ status: 'ok', results });
  });
}
