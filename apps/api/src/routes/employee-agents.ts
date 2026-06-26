/**
 * Employee Agents observability surface — /api/employee-agents
 *
 * Read-only tiles for the portal's reserved "Employee Agents" page and the COO.
 * Employee Agents are headless (no chat) — they run on a heartbeat and report to
 * the COO + dashboard. This surface exposes their status, heartbeat, run/error
 * counts, last report, and analytics + cost rolled up from boss_agent_runs so the
 * COO (and Kevin) can see what each agent is doing and what it costs, and tune it.
 *
 *   GET /api/employee-agents          — all agents + 24h/7d cost & run rollup
 *   GET /api/employee-agents/:id/runs — recent run history for one agent
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';

export async function employeeAgentsRoutes(server: FastifyInstance): Promise<void> {
  // GET / — list agents with cost/analytics rollup
  server.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT a.id, a.name, a.status, a.cron_expression, a.model,
             a.last_run_at, a.run_count, a.error_count,
             left(coalesce(a.last_result, ''), 1000) AS last_result,
             coalesce(r.runs_24h, 0)   AS runs_24h,
             coalesce(r.cost_24h, 0)   AS cost_24h,
             coalesce(r.cost_7d, 0)    AS cost_7d,
             coalesce(r.tokens_7d, 0)  AS tokens_7d,
             coalesce(r.avg_ms_7d, 0)  AS avg_ms_7d,
             r.last_status
        FROM boss_persistent_agents a
        LEFT JOIN LATERAL (
          SELECT
            count(*) FILTER (WHERE finished_at > now() - interval '24 hours')                        AS runs_24h,
            coalesce(sum(cost_usd) FILTER (WHERE finished_at > now() - interval '24 hours'), 0)        AS cost_24h,
            coalesce(sum(cost_usd) FILTER (WHERE finished_at > now() - interval '7 days'), 0)          AS cost_7d,
            coalesce(sum(tokens_in + tokens_out) FILTER (WHERE finished_at > now() - interval '7 days'), 0) AS tokens_7d,
            coalesce(avg(duration_ms) FILTER (WHERE finished_at > now() - interval '7 days'), 0)::int  AS avg_ms_7d,
            (array_agg(status ORDER BY finished_at DESC))[1]                                           AS last_status
          FROM boss_agent_runs WHERE agent_id = a.id
        ) r ON true
       ORDER BY a.name
    `);
    return reply.send({ agents: rows });
  });

  // GET /:id/runs — recent run history for one agent
  server.get('/:id/runs', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT started_at, finished_at, status, model, provider,
              tokens_in, tokens_out, cost_usd, duration_ms,
              left(coalesce(summary, ''), 600) AS summary
         FROM boss_agent_runs
        WHERE agent_id = $1
        ORDER BY finished_at DESC
        LIMIT 30`,
      [id],
    );
    return reply.send({ runs: rows });
  });
}

export default employeeAgentsRoutes;
