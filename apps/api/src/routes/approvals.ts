/**
 * Approvals routes — /api/approvals  (Fusion P1)
 *
 * The principal's "Needs Your OK" surface. Lists pending human-in-the-loop approvals
 * created by the risk gate (tools/risk.ts) and lets the principal approve / edit / deny.
 * On approve the tool is executed with the gate bypassed (approvedApprovalId), the result
 * is stored on the row, and the action is written to the append-only audit log.
 *
 *   GET  /api/approvals?status=pending           — list (default pending, non-expired)
 *   POST /api/approvals/:id/decide               — { decision: approve|edit|deny, args?, }
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { executeTool } from '../tools/executor.js';
import { audit, recordApprovalOutcome } from '../tools/risk.js';
import { currentTenantId } from '../lib/tenant.js';

interface ApprovalRow {
  id: string;
  tenant_id: string;
  conversation_id: string | null;
  agent_name: string | null;
  tool_name: string;
  tool_args: Record<string, unknown>;
  risk_tier: number;
  commit_message: string;
  status: string;
}

export async function approvalsRoutes(server: FastifyInstance): Promise<void> {
  // ── List ────────────────────────────────────────────────────────────────────
  server.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const status = String((request.query as { status?: string })?.status ?? 'pending');
    const tenantId = currentTenantId(request.auth?.tenantId);
    const pool = getPool();
    // Lazily expire stale pending rows so the tile never shows dead approvals.
    if (status === 'pending') {
      await pool.query(
        `UPDATE boss_approvals SET status='expired' WHERE tenant_id=$1 AND status='pending' AND expires_at < now()`,
        [tenantId]).catch(() => {});
    }
    const { rows } = await pool.query<ApprovalRow & { created_at: string; expires_at: string }>(
      `SELECT id, tool_name, risk_tier, commit_message, agent_name, conversation_id, status, created_at, expires_at
       FROM boss_approvals WHERE tenant_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 100`,
      [tenantId, status]);
    return reply.send({ approvals: rows });
  });

  // ── Decide ──────────────────────────────────────────────────────────────────
  server.post('/:id/decide', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { decision?: string; args?: Record<string, unknown> };
    const decision = body.decision;
    const decidedBy = request.auth?.userId ?? 'principal';
    if (!decision || !['approve', 'edit', 'deny'].includes(decision)) {
      return reply.status(400).send({ error: 'decision must be approve | edit | deny' });
    }
    const pool = getPool();
    const { rows } = await pool.query<ApprovalRow>(`SELECT * FROM boss_approvals WHERE id=$1`, [id]);
    if (rows.length === 0) return reply.status(404).send({ error: 'approval not found' });
    const a = rows[0];
    if (a.status !== 'pending') return reply.status(409).send({ error: `approval already ${a.status}` });

    if (decision === 'deny') {
      await pool.query(`UPDATE boss_approvals SET status='denied', decided_by=$2, decided_at=now() WHERE id=$1`, [id, decidedBy]);
      await audit(a.tenant_id, decidedBy, 'approval.denied', { id, toolName: a.tool_name });
      void recordApprovalOutcome(a.tenant_id, a.tool_name, false); // learn: denial re-gates this tool
      return reply.send({ ok: true, status: 'denied' });
    }

    // approve / edit
    const args = decision === 'edit' && body.args ? body.args : a.tool_args;
    await pool.query(
      `UPDATE boss_approvals SET status='approved', tool_args=$2::jsonb, decided_by=$3, decided_at=now() WHERE id=$1`,
      [id, JSON.stringify(args), decidedBy]);
    await audit(a.tenant_id, decidedBy, 'approval.approved', { id, toolName: a.tool_name, edited: decision === 'edit' });

    let result: string;
    try {
      result = await executeTool(a.tool_name, args, {
        tenantId: a.tenant_id,
        userId: decidedBy,
        conversationId: a.conversation_id ?? undefined,
        agentName: a.agent_name ?? undefined,
        approvedApprovalId: id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await pool.query(`UPDATE boss_approvals SET status='failed', result=$2 WHERE id=$1`, [id, msg]);
      return reply.status(500).send({ ok: false, status: 'failed', error: msg });
    }
    await pool.query(`UPDATE boss_approvals SET status='executed', result=$2 WHERE id=$1`, [id, result]);
    await audit(a.tenant_id, decidedBy, 'tool.executed', { id, toolName: a.tool_name });
    void recordApprovalOutcome(a.tenant_id, a.tool_name, true); // learn: enough OKs -> auto-approve next time
    return reply.send({ ok: true, status: 'executed', result });
  });
}

export default approvalsRoutes;
