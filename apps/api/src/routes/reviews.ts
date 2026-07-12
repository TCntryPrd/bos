/**
 * Reviews routes — /api/reviews
 *
 * Serves the latest customer-review snapshot (boss_reviews_snapshot) for the
 * dashboard's Client Satisfaction card. Refreshable via xAI Grok's Agent Tools
 * API (web search), which checks Google Business + Trustpilot for D. Caine
 * Solutions. No fabricated numbers — the card shows exactly what was found.
 *
 *   GET  /api/reviews/snapshot — latest { overall_rating, total_reviews, sources, summary, created_at }
 *   POST /api/reviews/refresh  — re-fetch ratings via xAI web search + store a new snapshot
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../db.js';
import { getGoogleApiKey, logGoogleUsage } from '../lib/google-registry.js';

interface ReviewSource { name: string; rating: number | null; count: number }
interface ReviewData {
  overall_rating: number | null;
  total_reviews: number;
  sources: ReviewSource[];
  summary: string;
}

async function getXaiKey(): Promise<string | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ secret: string }>(
    `SELECT secret FROM boss_vault WHERE service = 'xAI Grok' ORDER BY updated_at DESC LIMIT 1`,
  );
  return rows[0]?.secret ?? null;
}

// D. Caine Solutions' Google Business Profile place_id (from the GBP write-review link).
const GOOGLE_PLACE_ID = 'ChIJd9Y3coAjtmURqlsOA4r_Sj0';

/** Live Google rating + review count via Places API (New) Place Details. */
async function fetchGooglePlace(): Promise<{ rating: number | null; count: number } | null> {
  // Steward registry resolves the correct key (places_new → the right project's key).
  const key = await getGoogleApiKey('places_new');
  if (!key) return null;
  const res = await fetch(`https://places.googleapis.com/v1/places/${GOOGLE_PLACE_ID}`, {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'rating,userRatingCount' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  await logGoogleUsage('places_new', 1, 0.017, 'reviews-refresh'); // Place Details ≈ $0.017/call
  const d = (await res.json()) as { rating?: number; userRatingCount?: number };
  return { rating: typeof d.rating === 'number' ? d.rating : null, count: Number(d.userRatingCount) || 0 };
}

const REVIEW_QUERY =
  (process.env.REVIEW_QUERY_INTRO || 'Find the customer review ratings for ' + (process.env.REVIEW_BUSINESS_NAME || 'this business') + ', a US ') +
  'business-automation consulting firm run by Kevin Starr. Check BOTH its Google Business ' +
  ('Profile / Google Maps listing AND Trustpilot' + (process.env.REVIEW_TRUSTPILOT_SLUG ? ' (trustpilot.com/review/' + process.env.REVIEW_TRUSTPILOT_SLUG + ')' : '') + '. ') +
  'Reply ONLY with compact JSON, no prose: ' +
  '{"overall_rating":number_or_null,"total_reviews":number,' +
  '"sources":[{"name":string,"rating":number_or_null,"count":number}],"summary":"one sentence"}';

/** Pull the current review ratings via xAI Grok web search. Returns null on failure. */
async function fetchReviewsViaXai(): Promise<ReviewData | null> {
  const key = await getXaiKey();
  if (!key) return null;
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'grok-4-fast', tools: [{ type: 'web_search' }], input: REVIEW_QUERY }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    output_text?: string;
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  let txt = data.output_text;
  if (!txt && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (c.type === 'output_text' || c.type === 'text') txt = c.text;
      }
    }
  }
  if (!txt) return null;
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<ReviewData>;
    return {
      overall_rating: typeof parsed.overall_rating === 'number' ? parsed.overall_rating : null,
      total_reviews: Number(parsed.total_reviews) || 0,
      sources: Array.isArray(parsed.sources) ? (parsed.sources as ReviewSource[]) : [],
      summary: String(parsed.summary ?? ''),
    };
  } catch {
    return null;
  }
}

export async function reviewsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/snapshot', async (_req: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT overall_rating, total_reviews, sources, summary, created_at
         FROM boss_reviews_snapshot ORDER BY created_at DESC LIMIT 1`,
    );
    if (rows.length === 0) {
      return reply.send({ overall_rating: null, total_reviews: 0, sources: [], summary: null, created_at: null });
    }
    return reply.send(rows[0]);
  });

  // Re-fetch live and store a combined snapshot: Google rating via the Places API
  // (authoritative, cheap) + Trustpilot via xAI web search. Overall is weighted by
  // review count. Meant for a daily/weekly refresh (cron or an agent), not per-load.
  server.post('/refresh', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [google, xai] = await Promise.all([fetchGooglePlace(), fetchReviewsViaXai()]);
    const sources: ReviewSource[] = [];
    if (google && google.count > 0) sources.push({ name: 'Google', rating: google.rating, count: google.count });
    if (xai) {
      for (const s of xai.sources) {
        if (/trustpilot/i.test(s.name) && s.count > 0) sources.push({ name: 'Trustpilot', rating: s.rating, count: s.count });
      }
    }
    if (sources.length === 0) return reply.status(502).send({ error: 'No reviews found' });

    let wSum = 0;
    let cSum = 0;
    for (const s of sources) if (s.rating != null && s.count > 0) { wSum += s.rating * s.count; cSum += s.count; }
    const overall = cSum > 0 ? Math.round((wSum / cSum) * 10) / 10 : null;
    const total = sources.reduce((a, s) => a + (s.count || 0), 0);
    const summary = sources.map((s) => `${s.name}: ${s.rating ?? '?'}/5 (${s.count})`).join('; ');

    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO boss_reviews_snapshot (overall_rating, total_reviews, sources, summary)
       VALUES ($1,$2,$3,$4)
       RETURNING overall_rating, total_reviews, sources, summary, created_at`,
      [overall, total, JSON.stringify(sources), summary],
    );
    return reply.send(rows[0]);
  });
}

export default reviewsRoutes;
