/**
 * roundtable routes — /api/roundtable
 *   POST /transcript  — PUBLIC webhook Recall posts live transcripts to (secret-gated)
 *   POST /spawn       — start an advisor's voice bot into a Zoom meeting (authed)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { currentTenantId } from '../lib/tenant.js';
import { getAdvisor } from '../lib/board.js';
import { handleUtterance, spawnAdvisorBot } from '../lib/roundtable.js';

export async function roundtableRoutes(server: FastifyInstance): Promise<void> {
  server.post('/transcript', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { advisor?: string; name?: string; secret?: string };
    if (!process.env.ROUNDTABLE_SECRET || q.secret !== process.env.ROUNDTABLE_SECRET) { return reply.status(403).send({}); }
    reply.send({ ok: true }); // ack fast — process async
    if (q.advisor) void handleUtterance(currentTenantId(undefined), q.advisor, (q.name || '').toLowerCase(), (request.body ?? {}) as Record<string, unknown>);
    return reply;
  });

  server.post('/spawn', async (request: FastifyRequest, reply: FastifyReply) => {
    const b = (request.body ?? {}) as { meeting_url?: string; advisor_id?: string };
    if (!b.meeting_url || !b.advisor_id) return reply.status(400).send({ error: 'meeting_url + advisor_id required' });
    const adv = await getAdvisor(currentTenantId(request.auth?.tenantId), b.advisor_id);
    if (!adv) return reply.status(404).send({ error: 'advisor not found' });
    const r = await spawnAdvisorBot({
      meetingUrl: b.meeting_url, advisorId: b.advisor_id, advisorName: adv.display_name,
      firstName: (adv.display_name.split(/\s+/)[0] || '').toLowerCase(),
      webhookBase: process.env.PUBLIC_BASE || 'https://vasari.starrpartners.ai',
      secret: process.env.ROUNDTABLE_SECRET || '',
    });
    return reply.send(r);
  });
}

export default roundtableRoutes;
