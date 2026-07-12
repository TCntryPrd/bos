/**
 * Slack proxy routes — /api/slack/*
 *
 * Outbound surface for agents that have a row in slack_agent_grants.
 * Sodapop is the only one in v1; future agents are added by inserting
 * a grant row.
 *
 * All requests must include either:
 *   - X-BOSS-Internal: true   (host-side service calls)
 *   - and X-Agent-Handle: <handle>   (which agent is making the call)
 *
 * Or be authenticated via the user JWT (operator-driven, e.g. UI tile
 * acknowledging an attention item).
 *
 * Endpoints:
 *   GET  /api/slack/health                  bot identity check (auth.test)
 *   GET  /api/slack/attention               list open attention items
 *   POST /api/slack/attention/:id/ack       mark item acknowledged
 *   POST /api/slack/attention/:id/dismiss   dismiss without action
 *   POST /api/slack/attention/:id/respond   record that agent responded (with ts)
 *   POST /api/slack/post                    post a message (channel + text)
 *   POST /api/slack/react                   add an emoji reaction
 *   POST /api/slack/threads/:channel/:ts    fetch thread replies
 *   GET  /api/slack/users/:id               resolve user id → display name
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import {
  authTest,
  postMessage,
  addReaction,
  repliesInThread,
  lookupUser,
} from '../lib/slack-client.js';

interface AttentionRow {
  id: string;
  tenant_id: string;
  flagged_by: string;
  source_channel: string;
  source_ts: string;
  source_user: string | null;
  source_user_name: string | null;
  preview: string;
  reason: string | null;
  permalink: string | null;
  status: string;
  created_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
}

const DEFAULT_TENANT = 'd05cde41-4754-4f1f-ae13-ecb0be8b6fad';

function tenantOf(req: FastifyRequest): string {
  return (req.tenant?.tenantId as string) || DEFAULT_TENANT;
}

function agentHandleOf(req: FastifyRequest): string | null {
  const h = req.headers['x-agent-handle'];
  if (typeof h === 'string' && h.length > 0) return h;
  return null;
}

async function hasGrant(tenantId: string, handle: string, scope: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT scopes FROM slack_agent_grants WHERE tenant_id = $1 AND agent_handle = $2`,
    [tenantId, handle],
  );
  if (rows.length === 0) return false;
  const scopes = rows[0].scopes as string[] | null;
  if (!Array.isArray(scopes)) return false;
  return scopes.includes(scope);
}

async function requireGrant(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string,
): Promise<{ tenantId: string; handle: string } | null> {
  const tenantId = tenantOf(req);
  const handle = agentHandleOf(req);
  if (!handle) {
    reply.status(400).send({ error: 'X-Agent-Handle header required' });
    return null;
  }
  const ok = await hasGrant(tenantId, handle, scope);
  if (!ok) {
    reply.status(403).send({ error: `agent "${handle}" missing slack scope "${scope}"` });
    return null;
  }
  return { tenantId, handle };
}

export async function slackRoutes(server: FastifyInstance) {
  // ── Health / identity ─────────────────────────────────────────────────────

  server.get('/health', async (_req, reply) => {
    try {
      const r = await authTest() as { ok: boolean; user?: string; team?: string; error?: string };
      if (!r.ok) return reply.status(503).send({ ok: false, error: r.error });
      return reply.send({ ok: true, user: r.user, team: r.team });
    } catch (e) {
      return reply.status(503).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Attention queue ───────────────────────────────────────────────────────

  server.get<{ Querystring: { status?: string; limit?: string } }>(
    '/attention',
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const status = req.query.status ?? 'open';
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
      const { rows } = await getPool().query<AttentionRow>(
        `SELECT * FROM slack_attention
         WHERE tenant_id = $1 AND status = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [tenantId, status, limit],
      );
      return reply.send({
        items: rows.map((r) => ({
          id: r.id,
          flaggedBy: r.flagged_by,
          channel: r.source_channel,
          ts: r.source_ts,
          userId: r.source_user,
          userName: r.source_user_name,
          preview: r.preview,
          reason: r.reason,
          permalink: r.permalink,
          status: r.status,
          createdAt: r.created_at,
          acknowledgedAt: r.acknowledged_at,
          resolvedAt: r.resolved_at,
        })),
      });
    },
  );

  server.post<{ Params: { id: string }; Body: { text?: string; skipReply?: boolean } }>(
    '/attention/:id/ack',
    async (req, reply) => {
      const tenantId = tenantOf(req);

      // Fetch the row first so we know which channel/ts to reply against.
      const { rows } = await getPool().query<AttentionRow>(
        `SELECT * FROM slack_attention WHERE tenant_id=$1 AND id=$2`,
        [tenantId, req.params.id],
      );
      if (rows.length === 0) {
        return reply.status(404).send({ ok: false, error: 'not found' });
      }
      const row = rows[0];
      if (row.status !== 'open') {
        return reply.send({ ok: true, alreadyAcknowledged: true });
      }

      // Default canned reply — body.text overrides, body.skipReply suppresses.
      const cannedText =
        req.body?.text?.trim() ||
        '👀 Got it — Kevin saw this and will respond shortly.';

      let replyOk = true;
      let replyTs: string | undefined;
      let reactionOk = true;
      if (!req.body?.skipReply) {
        try {
          const r = await postMessage({
            channel: row.source_channel,
            text: cannedText,
            threadTs: row.source_ts,
          }) as { ok: boolean; ts?: string; error?: string };
          replyOk = r.ok;
          replyTs = r.ts;
        } catch {
          replyOk = false;
        }
        try {
          const rx = await addReaction(row.source_channel, row.source_ts, 'eyes') as { ok: boolean; error?: string };
          reactionOk = rx.ok || rx.error === 'already_reacted';
        } catch {
          reactionOk = false;
        }
      }

      // Always mark acknowledged in the DB even if Slack write partially
      // failed — operator already chose to ack on the BOS side.
      const { rowCount } = await getPool().query(
        `UPDATE slack_attention SET status='acknowledged', acknowledged_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='open'`,
        [tenantId, req.params.id],
      );

      return reply.send({
        ok: (rowCount ?? 0) > 0,
        replyOk,
        replyTs,
        reactionOk,
      });
    },
  );

  server.post<{ Params: { id: string } }>(
    '/attention/:id/dismiss',
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const { rowCount } = await getPool().query(
        `UPDATE slack_attention SET status='dismissed', resolved_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, req.params.id],
      );
      return reply.send({ ok: (rowCount ?? 0) > 0 });
    },
  );

  server.post<{ Params: { id: string }; Body: { responseTs?: string } }>(
    '/attention/:id/respond',
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const { rowCount } = await getPool().query(
        `UPDATE slack_attention SET status='responded', resolved_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, req.params.id],
      );
      return reply.send({ ok: (rowCount ?? 0) > 0, responseTs: req.body?.responseTs });
    },
  );

  // ── Outbound: post / react / threads / users (require grant) ──────────────

  server.post<{
    Body: {
      channel: string;
      text: string;
      threadTs?: string;
      blocks?: unknown[];
      username?: string;
      iconEmoji?: string;
    };
  }>('/post', async (req, reply) => {
    const grant = await requireGrant(req, reply, 'post');
    if (!grant) return;
    if (!req.body.channel || !req.body.text) {
      return reply.status(400).send({ error: 'channel and text are required' });
    }
    const result = await postMessage({
      channel: req.body.channel,
      text: req.body.text,
      threadTs: req.body.threadTs,
      blocks: req.body.blocks,
      username: req.body.username,
      iconEmoji: req.body.iconEmoji,
    }) as { ok: boolean; ts?: string; channel?: string; error?: string };
    if (!result.ok) {
      return reply.status(502).send({ ok: false, error: result.error });
    }
    return reply.send({ ok: true, ts: result.ts, channel: result.channel });
  });

  server.post<{ Body: { channel: string; ts: string; name: string } }>(
    '/react',
    async (req, reply) => {
      const grant = await requireGrant(req, reply, 'react');
      if (!grant) return;
      const { channel, ts, name } = req.body;
      if (!channel || !ts || !name) {
        return reply.status(400).send({ error: 'channel, ts, name required' });
      }
      const result = await addReaction(channel, ts, name) as { ok: boolean; error?: string };
      if (!result.ok && result.error !== 'already_reacted') {
        return reply.status(502).send({ ok: false, error: result.error });
      }
      return reply.send({ ok: true });
    },
  );

  server.get<{ Params: { channel: string; ts: string }; Querystring: { limit?: string } }>(
    '/threads/:channel/:ts',
    async (req, reply) => {
      const grant = await requireGrant(req, reply, 'threads');
      if (!grant) return;
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
      const result = await repliesInThread(req.params.channel, req.params.ts, limit);
      if (!result.ok) {
        return reply.status(502).send({ ok: false, error: result.error });
      }
      return reply.send(result);
    },
  );

  server.get<{ Params: { id: string } }>(
    '/users/:id',
    async (req, reply) => {
      const grant = await requireGrant(req, reply, 'users');
      if (!grant) return;
      const u = await lookupUser(req.params.id);
      return reply.send(u);
    },
  );
}
