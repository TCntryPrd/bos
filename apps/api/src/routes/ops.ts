/**
 * Ops-Health routes — /api/ops
 *
 * Computes a 0-100 operational-health score (the dashboard's "Priority Score"
 * gauge) from REAL signals only:
 *   - Employee-Agent run success rate over the last 24h (boss_agent_runs)
 *   - Task on-track % — open tasks not past due (boss_tasks)
 *   - Unresolved attention items the email agent flagged (boss_email_log)
 *
 *   GET /api/ops/health — { score, label, components: { agents, tasks, attention } }
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';

export async function opsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();

    // 1) Agent reliability — % of runs in the last 24h that completed ok.
    const agentQ = await pool.query<{ total: string; ok: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE status IN ('ok','completed','success'))::text AS ok
         FROM boss_agent_runs WHERE started_at > now() - interval '24 hours'`,
    );
    const aTotal = Number(agentQ.rows[0]?.total ?? 0);
    const aOk = Number(agentQ.rows[0]?.ok ?? 0);
    const agentsPct = aTotal > 0 ? Math.round((aOk / aTotal) * 100) : 100;

    // 2) Tasks on-track — open tasks (pending/active) that are not past due.
    let open = 0;
    let overdue = 0;
    try {
      const taskQ = await pool.query<{ open: string; overdue: string }>(
        `SELECT count(*) FILTER (WHERE status IN ('pending','active') AND archived_at IS NULL)::text AS open,
                count(*) FILTER (WHERE status IN ('pending','active') AND archived_at IS NULL
                                 AND due_at IS NOT NULL AND due_at < now())::text AS overdue
           FROM boss_tasks`,
      );
      open = Number(taskQ.rows[0]?.open ?? 0);
      overdue = Number(taskQ.rows[0]?.overdue ?? 0);
    } catch { /* table may not exist yet */ }
    const tasksPct = open > 0 ? Math.round(((open - overdue) / open) * 100) : 100;

    // 3) Attention — unresolved P1/P2/client items the email agent flagged.
    let attentionOpen = 0;
    try {
      const attnQ = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM boss_email_log WHERE needs_attention = true AND resolved_at IS NULL`,
      );
      attentionOpen = Number(attnQ.rows[0]?.n ?? 0);
    } catch { /* table may be empty */ }
    // 0 unresolved → 100; each open item costs 8 pts, floor 40.
    const attentionPct = Math.max(40, 100 - attentionOpen * 8);

    // Weighted composite: agents are the strongest signal of system health.
    const score = Math.round(agentsPct * 0.5 + tasksPct * 0.3 + attentionPct * 0.2);
    const label = score >= 90 ? 'Excellent' : score >= 75 ? 'Healthy' : score >= 60 ? 'Watch' : 'Needs attention';

    return reply.send({
      score,
      label,
      components: {
        agents: { pct: agentsPct, ok: aOk, total: aTotal },
        tasks: { pct: tasksPct, open, overdue },
        attention: { pct: attentionPct, open: attentionOpen },
      },
      updated_at: new Date().toISOString(),
    });
  });
}

export default opsRoutes;
