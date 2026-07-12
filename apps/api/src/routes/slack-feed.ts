/**
 * Slack feed read API (prefix /api/slack-feed) — backs the dashboard Sales tile.
 *
 *   GET /api/slack-feed/sales?limit=     — recent flagged sales + today's roll-up
 *   GET /api/slack-feed/messages?channel=&limit=  — recent captured channel messages
 *   POST /api/slack-feed/poll            — force a poll now (admin; useful during a sales event)
 *
 * Data is populated by lib/slack-feed.ts (pollSalesChannels). Auth: Bearer.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';
import { pollSalesChannels } from '../lib/slack-feed.js';

function isAdmin(request: FastifyRequest): boolean {
  const role = request.auth?.role;
  return role === 'admin' || role === 'owner';
}

// ── Event-funnel parser for #sales-event-stats ──────────────────────────────
// Posts report webinar/event attendance per funnel stage, e.g.
//   "AI UNLEASHED ... Sprint Start 140 Peak 169 Pitch 160 Link 155 End 43"
//   "... Start:3 Peak:7 Offer:6 Link Drop:6 Close:1"
//   "... 11 at open • 87 at start • 137 peak attendance • 124 at offer"
// Multi-track posts are summed per stage. Format quirks (typos, bullets,
// keyword-before-number vs number-before-keyword) are handled.
const STAGE_KEYS: Record<string, string[]> = {
  open: ['open'],
  start: ['start'],
  peak: ['peak'],
  offer: ['offer', 'ofer', 'pitch'],
  link: ['link drop', 'link'],
  end: ['end'],
  close: ['close'],
};
function escRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function extractStage(text: string, keys: string[]): number | null {
  let total = 0, found = false;
  for (const kw of keys) {
    const k = escRe(kw);
    let hit = false, m: RegExpExecArray | null;
    const re1 = new RegExp(k + '\\s*(?:attendance)?\\s*[:\\-]?\\s*\\*{0,2}(\\d{1,5})', 'gi');
    while ((m = re1.exec(text))) { total += parseInt(m[1], 10) || 0; found = true; hit = true; }
    if (!hit) {
      const re2 = new RegExp('(\\d{1,5})\\s*\\*{0,2}\\s*(?:at\\s+)?' + k, 'gi');
      while ((m = re2.exec(text))) { total += parseInt(m[1], 10) || 0; found = true; }
    }
  }
  return found ? total : null;
}
export function parseEventFunnel(raw: string): { name: string; date: string | null; stages: Record<string, number | null>; hasData: boolean } {
  const clean = (raw || '').replace(/[\r\n]+/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const stages: Record<string, number | null> = {};
  for (const [stage, keys] of Object.entries(STAGE_KEYS)) stages[stage] = extractStage(clean, keys);
  const cut = clean.search(/\b(sprint|consultant|leadership|start|peak|open|attendance|webclass|cmo)\b/i);
  let name = (cut > 5 ? clean.slice(0, cut) : clean).replace(/[\-–—:•|]+\s*$/, '').trim().slice(0, 80).trim();
  const dateM = clean.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{0,4}/i);
  const hasData = Object.values(stages).some((v) => v != null && v > 0);
  return { name: name || 'Event', date: dateM ? dateM[0].trim() : null, stages, hasData };
}

export async function slackFeedRoutes(server: FastifyInstance) {
  // Event-attendance funnel stats parsed from #sales-event-stats posts.
  server.get<{ Querystring: { limit?: string } }>('/sales', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '40', 10) || 40, 100);
    const { rows } = await getPool().query<{ user_name: string | null; text: string; posted_at: string }>(
      `SELECT user_name, text, posted_at FROM boss_slack_messages
        WHERE tenant_id = 'default' AND channel_name = 'sales-event-stats'
        ORDER BY posted_at DESC LIMIT $1`,
      [limit],
    );
    const parsed = rows
      .map((r) => { const f = parseEventFunnel(r.text || ''); return { who: r.user_name, postedAt: r.posted_at, name: f.name, date: f.date, stages: f.stages, hasData: f.hasData }; })
      // Only show events with a parseable date — if no date, omit (Kevin's rule).
      .filter((e) => e.hasData && !!e.date);
    const sum = (k: string) => parsed.reduce((n, e) => n + (e.stages[k] ?? 0), 0);
    return reply.send({
      events: parsed.slice(0, 12),
      totals: {
        events: parsed.length,
        start: sum('start'),
        peak: sum('peak'),
        offer: sum('offer'),
        link: sum('link'),
        end: sum('end'),
      },
    });
  });

  server.get<{ Querystring: { channel?: string; limit?: string } }>('/messages', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 200);
    const params: unknown[] = [];
    let where = `tenant_id = 'default'`;
    if (request.query.channel) {
      params.push(request.query.channel);
      where += ` AND (channel_id = $${params.length} OR channel_name = $${params.length})`;
    }
    params.push(limit);
    const { rows } = await getPool().query(
      `SELECT channel_id, channel_name, ts, user_name, text, is_sale, sale_amount, posted_at
         FROM boss_slack_messages
        WHERE ${where}
        ORDER BY posted_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return reply.send({ messages: rows });
  });

  server.post('/poll', async (request, reply) => {
    if (!isAdmin(request)) return reply.status(403).send({ error: 'Forbidden' });
    try {
      const r = await pollSalesChannels();
      return reply.send({ status: 'ok', ...r });
    } catch (err) {
      request.log.error({ err }, 'manual slack feed poll failed');
      return reply.status(500).send({ error: 'poll_failed', message: (err as Error).message });
    }
  });
}
