import type { FastifyInstance } from 'fastify';
import { getRuntimeConfig } from '../config-store.js';

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

export async function revenueRoutes(server: FastifyInstance) {
  server.get('/overview', async (_request, reply) => {
    const key = process.env.STRIPE_SECRET_KEY ?? (await getRuntimeConfig('STRIPE_SECRET_KEY'));
    if (!key) return reply.status(503).send({ error: 'stripe_not_configured' });

    const now = new Date();
    const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const lastMonthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) / 1000);

    let charges: Charge[];
    try {
      charges = await listCharges(key, lastMonthStart);
    } catch (err) {
      return reply.status(502).send({ error: 'stripe_error', message: (err as Error).message });
    }

    const ok = charges.filter((c) => c.status === 'succeeded');
    const sum = (arr: Charge[]) => arr.reduce((s, c) => s + c.amount, 0);
    const thisMonthCents = sum(ok.filter((c) => c.created >= monthStart));
    const lastMonthCents = sum(ok.filter((c) => c.created >= lastMonthStart && c.created < monthStart));
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
      pctChange,
      series,
      recent,
    };
  });
}
