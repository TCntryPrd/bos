import type { FastifyInstance } from 'fastify';
import { getRuntimeConfig } from '../config-store.js';
import { executeEraTool } from '../tools/era.js';

/** Sum Industry Rockstar bank deposits (ERA) dated in the given year. Best-effort. */
async function irRevenueYtd(year: number): Promise<number> {
  try {
    const raw = await executeEraTool('boss_era_search_transactions', { query: 'Industry Rockstar' });
    const txns = (JSON.parse(raw) as { transactions?: any[] }).transactions ?? [];
    const y = String(year);
    let sum = 0;
    for (const t of txns) {
      const d = String(t.date ?? t.transaction_date ?? '');
      if ((t.amount ?? 0) > 0 && d.startsWith(y)) sum += t.amount;
    }
    return sum;
  } catch {
    return 0;
  }
}

const STRIPE_API = 'https://api.stripe.com/v1';

interface Charge { amount: number; created: number; status: string; currency: string; description: string | null; }

async function stripeGet(path: string, key: string): Promise<{ data: Charge[]; has_more: boolean }> {
  const res = await fetch(STRIPE_API + path, { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) throw new Error('stripe ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json() as Promise<{ data: Charge[]; has_more: boolean }>;
}

async function listCharges(key: string, sinceTs: number): Promise<Charge[]> {
  const out: Charge[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ 'created[gte]': String(sinceTs), limit: '100' });
    if (after) q.set('starting_after', after);
    const data = await stripeGet('/charges?' + q.toString(), key);
    out.push(...data.data);
    if (!data.has_more || data.data.length === 0) break;
    after = (data.data[data.data.length - 1] as Charge & { id: string }).id;
  }
  return out;
}

async function stripePost(path: string, key: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(STRIPE_API + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('stripe ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json() as Promise<Record<string, unknown>>;
}

export async function revenueRoutes(server: FastifyInstance) {
  server.post('/payment-link', async (_request, reply) => {
    const key = process.env.STRIPE_SECRET_KEY ?? (await getRuntimeConfig('STRIPE_SECRET_KEY'));
    if (!key) return reply.status(503).send({ error: 'stripe_not_configured' });
    try {
      const existingProds = await fetch(STRIPE_API + '/products/search?query=metadata%5B%22slug%22%5D%3A%22strategy-retainer-500%22', {
        headers: { Authorization: 'Bearer ' + key },
      }).then((r) => r.json()) as { data: Array<{ id: string }> };
      let productId: string;
      if (existingProds.data?.length > 0) {
        productId = existingProds.data[0].id;
      } else {
        const prod = await stripePost('/products', key, {
          name: 'Operations Strategy Retainer',
          description: '2 x 90-min sessions/month — assessment + brainstorming/planning. Execution tasks between sessions.',
          'metadata[slug]': 'strategy-retainer-500',
        });
        productId = prod.id as string;
      }
      const existingPrices = await fetch(STRIPE_API + `/prices?product=${productId}&active=true&limit=10`, {
        headers: { Authorization: 'Bearer ' + key },
      }).then((r) => r.json()) as { data: Array<{ id: string; unit_amount: number; recurring?: { interval: string } }> };
      let priceId: string;
      const p500 = existingPrices.data?.find((p) => p.unit_amount === 50000 && p.recurring?.interval === 'month');
      if (p500) {
        priceId = p500.id;
      } else {
        const pr = await stripePost('/prices', key, {
          product: productId,
          unit_amount: '50000',
          currency: 'usd',
          'recurring[interval]': 'month',
        });
        priceId = pr.id as string;
      }
      const link = await stripePost('/payment_links', key, {
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'after_completion[type]': 'hosted_confirmation',
        'after_completion[hosted_confirmation][custom_message]': "You're in! Kevin will reach out within 24 hours to schedule your first session.",
        'metadata[purpose]': 'strategy-retainer',
      });
      return reply.status(200).send({ url: link.url, productId, priceId, paymentLinkId: link.id });
    } catch (err) {
      return reply.status(502).send({ error: 'stripe_error', message: (err as Error).message });
    }
  });

  server.get('/overview', async (_request, reply) => {
    const key = process.env.STRIPE_SECRET_KEY ?? (await getRuntimeConfig('STRIPE_SECRET_KEY'));
    if (!key) return reply.status(503).send({ error: 'stripe_not_configured' });

    const now = new Date();
    const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const lastMonthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) / 1000);
    const yearStart = Math.floor(Date.UTC(now.getUTCFullYear(), 0, 1) / 1000);

    let charges: Charge[];
    try {
      // Fetch from Jan 1 so we can total the year-to-date as well as the month.
      charges = await listCharges(key, yearStart);
    } catch (err) {
      return reply.status(502).send({ error: 'stripe_error', message: (err as Error).message });
    }

    const ok = charges.filter((c) => c.status === 'succeeded');
    const sum = (arr: Charge[]) => arr.reduce((s, c) => s + c.amount, 0);
    const thisMonthCents = sum(ok.filter((c) => c.created >= monthStart));
    const lastMonthCents = sum(ok.filter((c) => c.created >= lastMonthStart && c.created < monthStart));
    const irYtdDollars = await irRevenueYtd(now.getUTCFullYear()); // Industry Rockstar bank deposits YTD
    const ytdCents = sum(ok) + Math.round(irYtdDollars * 100); // Stripe charges + IR payments since Jan 1
    const pctChange = lastMonthCents > 0 ? Math.round(((thisMonthCents - lastMonthCents) / lastMonthCents) * 1000) / 10 : null;

    const days = now.getUTCDate();
    const series: { day: number; amount: number }[] = [];
    for (let d = 1; d <= days; d++) {
      const ds = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d) / 1000);
      series.push({ day: d, amount: Math.round(sum(ok.filter((c) => c.created >= ds && c.created < ds + 86400)) / 100) });
    }

    const recent = [...ok].sort((a, b) => b.created - a.created).slice(0, 6)
      .map((c) => ({ amount: Math.round(c.amount / 100), description: c.description ?? 'Payment received', created: c.created }));

    return {
      currency: 'usd',
      thisMonth: Math.round(thisMonthCents / 100),
      lastMonth: Math.round(lastMonthCents / 100),
      ytd: Math.round(ytdCents / 100),
      ytdStripe: Math.round(sum(ok) / 100),
      ytdIr: Math.round(irYtdDollars),
      year: now.getUTCFullYear(),
      pctChange,
      series,
      recent,
    };
  });
}
