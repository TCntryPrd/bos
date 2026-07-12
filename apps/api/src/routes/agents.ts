/**
 * Autonomous agent operations routes — /api/agent-ops/*
 *
 * Runtime operations for autonomous agents (Mercury email manager, Spanky WhatsApp manager, etc.)
 * Separate from /api/agents/* which handles rascals/outsiders registry CRUD.
 *
 * - Push notifications for human approval
 * - Decision tracking and feedback learning
 * - Agent state management (polling cursors, last run)
 * - Monitoring assignments (which chats/emails each agent watches)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { findUnipileAccount, isUnipileConfigured, sendUnipileChatMessage, startUnipileWhatsAppChat } from '../lib/unipile.js';

const UNIPILE_CHAT_PREFIX = 'unipile:';

function getTenantId(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

export default async function agentsRoutes(app: FastifyInstance): Promise<void> {
  // -------- GET /api/agent-ops/notifications --------
  // Fetch pending push notifications for current user
  app.get('/agent-ops/notifications', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const userId = 'kevin'; // TODO: get from auth context

    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT n.id, n.agent_handle, n.title, n.body, n.data, n.priority,
             n.action_required, n.action_type, n.related_decision_id,
             n.created_at, n.expires_at,
             d.draft, d.context, d.confidence_score
        FROM boss_push_notifications n
   LEFT JOIN boss_agent_decisions d ON d.id = n.related_decision_id
       WHERE n.tenant_id = $1
         AND n.user_id = $2
         AND n.read_at IS NULL
         AND (n.expires_at IS NULL OR n.expires_at > NOW())
    ORDER BY n.priority DESC, n.created_at DESC
    `, [tenantId, userId]);

    return reply.send({ notifications: rows });
  });

  // -------- POST /api/agents/notifications/:id/action --------
  // User takes action on a notification (approve, modify, reject)
  interface NotificationActionBody {
    action: 'approve' | 'modify' | 'reject';
    modification?: Record<string, unknown>;
  }
  app.post<{ Params: { id: string }; Body: NotificationActionBody }>(
    '/agent-ops/notifications/:id/action',
    async (req, reply) => {
      const { id } = req.params;
      const { action, modification } = req.body;
      const tenantId = getTenantId(req);
      const pool = getPool();

      // Mark notification as acted upon
      const nResult = await pool.query(`
        UPDATE boss_push_notifications
           SET acted_at = NOW(), read_at = COALESCE(read_at, NOW())
         WHERE id = $1 AND tenant_id = $2
     RETURNING related_decision_id, agent_handle, data
      `, [id, tenantId]);

      if (nResult.rowCount === 0) {
        return reply.code(404).send({ error: 'notification not found' });
      }

      const { related_decision_id, agent_handle, data } = nResult.rows[0];

      // Update related decision if exists
      if (related_decision_id) {
        await pool.query(`
          UPDATE boss_agent_decisions
             SET human_action = $1,
                 human_modification = $2,
                 decided_at = NOW()
           WHERE id = $3 AND tenant_id = $4
        `, [action === 'approve' ? 'approved' : action === 'modify' ? 'modified' : 'rejected',
            modification ?? null, related_decision_id, tenantId]);
      }

      // Execute the action based on type
      const actionType = data.action_type;
      if (action === 'approve' || action === 'modify') {
        if (actionType === 'send_whatsapp') {
          const chatId = data.chat_id as string;
          const message = action === 'modify' && modification?.message
            ? String(modification.message)
            : String(data.draft_message);

          if (isUnipileConfigured()) {
            const liveChatId = chatId?.startsWith(UNIPILE_CHAT_PREFIX) ? chatId.slice(UNIPILE_CHAT_PREFIX.length) : chatId;
            const account = await findUnipileAccount('WHATSAPP');
            const sent = liveChatId
              ? await sendUnipileChatMessage(liveChatId, message, account?.id)
              : await startUnipileWhatsAppChat(String(data.phone ?? data.to ?? ''), message);
            return reply.send({ ok: true, action: 'sent', messageId: sent.messageId });
          }

          // Legacy OpenWA path, retained only when Unipile is not configured.
          const OPENWA_BASE = process.env.OPENWA_BASE_URL ?? 'http://localhost:2785/api';
          const OPENWA_SESSION = process.env.OPENWA_SESSION_ID;
          const OPENWA_KEY = process.env.OPENWA_API_KEY;

          const wa = await fetch(`${OPENWA_BASE}/sessions/${OPENWA_SESSION}/messages/send-text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': OPENWA_KEY ?? '' },
            body: JSON.stringify({ chatId, text: message }),
          });

          if (!wa.ok) {
            return reply.code(502).send({ error: 'whatsapp_send_failed' });
          }

          const waData = await wa.json() as { messageId?: string };
          await pool.query(`
            INSERT INTO boss_whatsapp_messages
              (tenant_id, chat_id, wa_message_id, direction, from_me, body, message_type, ack_status, sent_at)
            VALUES ('default', $1, $2, 'outbound', true, $3, 'chat', 'sent', NOW())
            ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
          `, [chatId, waData.messageId ?? null, message]);

          return reply.send({ ok: true, action: 'sent', messageId: waData.messageId });
        }

        if (actionType === 'send_email') {
          // TODO: Implement email sending via Gmail connector
          return reply.code(501).send({ error: 'email_sending_not_implemented' });
        }
      }

      return reply.send({ ok: true, action });
    }
  );

  // -------- POST /api/agents/decisions --------
  // Agent creates a decision record (draft email, draft WhatsApp, etc.)
  interface CreateDecisionBody {
    agent_handle: string;
    decision_type: 'draft_email' | 'draft_whatsapp' | 'extract_insight' | 'create_task';
    context: Record<string, unknown>;
    draft: Record<string, unknown>;
    confidence_score?: number;
    model_used: string;
    tokens_used?: number;
    cost_usd?: number;
  }
  app.post<{ Body: CreateDecisionBody }>('/agent-ops/decisions', async (req, reply) => {
    const tenantId = getTenantId(req);
    const body = req.body;
    const pool = getPool();

    const { rows } = await pool.query(`
      INSERT INTO boss_agent_decisions
        (tenant_id, agent_handle, decision_type, context, draft, confidence_score, model_used, tokens_used, cost_usd)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, created_at
    `, [tenantId, body.agent_handle, body.decision_type, body.context, body.draft,
        body.confidence_score ?? null, body.model_used, body.tokens_used ?? null, body.cost_usd ?? null]);

    const decision = rows[0];
    return reply.code(201).send({ decision });
  });

  // -------- POST /api/agents/notify --------
  // Create a push notification for human review
  interface CreateNotificationBody {
    agent_handle: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    action_required?: boolean;
    action_type?: string;
    related_decision_id?: string;
    expires_in_seconds?: number;
  }
  app.post<{ Body: CreateNotificationBody }>('/agent-ops/notify', async (req, reply) => {
    const tenantId = getTenantId(req);
    const userId = 'kevin'; // TODO: get from agent's assigned user
    const body = req.body;
    const pool = getPool();

    const expiresAt = body.expires_in_seconds
      ? new Date(Date.now() + body.expires_in_seconds * 1000)
      : null;

    const { rows } = await pool.query(`
      INSERT INTO boss_push_notifications
        (tenant_id, user_id, agent_handle, title, body, data, priority, action_required, action_type, related_decision_id, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, created_at
    `, [tenantId, userId, body.agent_handle, body.title, body.body, body.data,
        body.priority ?? 'normal', body.action_required ?? false, body.action_type ?? null,
        body.related_decision_id ?? null, expiresAt]);

    const notification = rows[0];
    return reply.code(201).send({ notification });
  });

  // -------- GET /api/agents/monitors/whatsapp --------
  // List WhatsApp monitoring assignments
  app.get('/agent-ops/monitors/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(req);
    const pool = getPool();

    const { rows } = await pool.query(`
      SELECT m.chat_id, m.agent_handle, m.enabled, m.confidence_threshold,
             t.display_name, t.phone, t.is_group, t.last_message_at
        FROM boss_whatsapp_monitors m
        JOIN boss_whatsapp_threads t ON t.tenant_id = m.tenant_id AND t.chat_id = m.chat_id
       WHERE m.tenant_id = $1
    ORDER BY t.last_message_at DESC NULLS LAST
    `, [tenantId]);

    return reply.send({ monitors: rows });
  });

  // -------- GET /api/agents/state/:handle/:key --------
  // Get agent state value
  app.get<{ Params: { handle: string; key: string } }>(
    '/agent-ops/state/:handle/:key',
    async (req, reply) => {
      const tenantId = getTenantId(req);
      const { handle, key } = req.params;
      const pool = getPool();

      const { rows } = await pool.query(`
        SELECT state_value, updated_at
          FROM boss_agent_state
         WHERE tenant_id = $1 AND agent_handle = $2 AND state_key = $3
      `, [tenantId, handle, key]);

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'state not found' });
      }

      return reply.send(rows[0]);
    }
  );

  // -------- PUT /api/agents/state/:handle/:key --------
  // Update agent state
  app.put<{ Params: { handle: string; key: string }; Body: { value: Record<string, unknown> } }>(
    '/agent-ops/state/:handle/:key',
    async (req, reply) => {
      const tenantId = getTenantId(req);
      const { handle, key } = req.params;
      const { value } = req.body;
      const pool = getPool();

      await pool.query(`
        INSERT INTO boss_agent_state (tenant_id, agent_handle, state_key, state_value, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (tenant_id, agent_handle, state_key)
        DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()
      `, [tenantId, handle, key, value]);

      return reply.send({ ok: true });
    }
  );
}
