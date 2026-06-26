/**
 * Slack sales feed — polls configured sales channels and persists messages,
 * flagging likely sales (dollar amounts + sale keywords) so the dashboard
 * Sales tile shows live, real numbers captured by the team in-channel.
 *
 * Why poll instead of Socket Mode events: reading channel history only needs
 * the bot token + channels:history + bot membership (already in use by the
 * /api/services tiles block). It does NOT require subscribing message.channels
 * in the Slack app config, so it works today with no out-of-band setup. The
 * @-mention tile is separate and is fed live by Socket Mode app_mention events
 * into slack_attention.
 *
 * Config (runtime_config → process.env):
 *   SLACK_BOT_TOKEN       — xoxb- (required)
 *   SLACK_SALES_CHANNELS  — comma-separated channel IDs or names (e.g. "C123,#sales").
 *                           If unset, auto-discovers channels whose name contains "sales".
 */
import { getPool } from '../db.js';

const SLACK_API = 'https://slack.com/api';
const TENANT = 'default';
const POLL_INTERVAL_MS = 60_000;
const HISTORY_LIMIT = 40;

export const SLACK_FEED_DDL = `
CREATE TABLE IF NOT EXISTS boss_slack_messages (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'default',
  channel_id   TEXT NOT NULL,
  channel_name TEXT,
  ts           TEXT NOT NULL,
  user_id      TEXT,
  user_name    TEXT,
  text         TEXT,
  thread_ts    TEXT,
  is_sale      BOOLEAN NOT NULL DEFAULT FALSE,
  sale_amount  NUMERIC,
  permalink    TEXT,
  posted_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_slack_messages_sale ON boss_slack_messages (is_sale, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON boss_slack_messages (channel_id, posted_at DESC);
`;

function botToken(): string | null {
  return process.env.SLACK_BOT_TOKEN ?? null;
}

async function slackGet<T = Record<string, unknown>>(method: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken()}` },
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as T;
}

// ── Sale detection ──────────────────────────────────────────────────────────
// A sale is recognized by a POSITIVE dollar amount in the message. Keyword-only
// chatter ("closed the ticket", "big deal") and "$0" are intentionally NOT
// counted, so the tile's roll-up reflects real money.
export function detectSale(text: string): { isSale: boolean; amount: number | null } {
  if (!text) return { isSale: false, amount: null };
  const m = text.match(/\$\s?([\d][\d,]*(?:\.\d{1,2})?)/);
  const amount = m ? parseFloat(m[1].replace(/,/g, '')) : null;
  const isSale = amount !== null && amount > 0;
  return { isSale, amount };
}

// ── Channel + user resolution (cached) ──────────────────────────────────────
interface ChannelRef { id: string; name: string }
let channelCache: ChannelRef[] | null = null;
let channelCacheAt = 0;
const userNameCache = new Map<string, string>();

async function listChannels(): Promise<ChannelRef[]> {
  if (channelCache && Date.now() - channelCacheAt < 300_000) return channelCache;
  const out: ChannelRef[] = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const res = await slackGet<{ ok: boolean; channels?: Array<{ id: string; name: string }>; response_metadata?: { next_cursor?: string } }>(
      'conversations.list',
      { limit: 200, exclude_archived: 'true', types: 'public_channel,private_channel', ...(cursor ? { cursor } : {}) },
    );
    if (!res.ok || !res.channels) break;
    for (const c of res.channels) out.push({ id: c.id, name: c.name });
    cursor = res.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  channelCache = out;
  channelCacheAt = Date.now();
  return out;
}

async function resolveSalesChannels(): Promise<ChannelRef[]> {
  const configured = (process.env.SLACK_SALES_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const all = await listChannels();
  const byId = new Map(all.map((c) => [c.id, c]));
  const byName = new Map(all.map((c) => [c.name.toLowerCase(), c]));

  if (configured.length > 0) {
    const refs: ChannelRef[] = [];
    for (const token of configured) {
      if (/^[CG][A-Z0-9]+$/.test(token)) {
        refs.push(byId.get(token) ?? { id: token, name: token });
      } else {
        const name = token.replace(/^#/, '').toLowerCase();
        const hit = byName.get(name);
        if (hit) refs.push(hit);
      }
    }
    return refs;
  }
  // Auto-discover: any channel whose name contains "sales".
  return all.filter((c) => c.name.toLowerCase().includes('sales'));
}

async function userName(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  const res = await slackGet<{ ok: boolean; user?: { real_name?: string; profile?: { display_name?: string } } }>(
    'users.info', { user: userId },
  );
  const name = res.ok ? (res.user?.profile?.display_name?.trim() || res.user?.real_name || userId) : userId;
  userNameCache.set(userId, name);
  return name;
}

// ── Poll ────────────────────────────────────────────────────────────────────
export async function pollSalesChannels(): Promise<{ channels: number; upserted: number }> {
  if (!botToken()) return { channels: 0, upserted: 0 };
  const pool = getPool();
  const channels = await resolveSalesChannels();
  let upserted = 0;

  for (const ch of channels) {
    const res = await slackGet<{ ok: boolean; messages?: Array<{ ts: string; user?: string; text?: string; thread_ts?: string; subtype?: string; bot_id?: string }> }>(
      'conversations.history', { channel: ch.id, limit: HISTORY_LIMIT },
    );
    if (!res.ok || !res.messages) continue;
    for (const m of res.messages) {
      if (m.subtype === 'channel_join' || m.subtype === 'channel_leave') continue;
      const text = m.text ?? '';
      const { isSale, amount } = detectSale(text);
      const postedAt = new Date(parseFloat(m.ts) * 1000);
      const uname = await userName(m.user);
      const r = await pool.query(
        `INSERT INTO boss_slack_messages
           (tenant_id, channel_id, channel_name, ts, user_id, user_name, text, thread_ts, is_sale, sale_amount, posted_at)
         VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, channel_id, ts) DO UPDATE SET
           text = EXCLUDED.text, is_sale = EXCLUDED.is_sale, sale_amount = EXCLUDED.sale_amount,
           user_name = COALESCE(EXCLUDED.user_name, boss_slack_messages.user_name)`,
        [ch.id, ch.name, m.ts, m.user ?? null, uname, text, m.thread_ts ?? null, isSale, amount, postedAt],
      );
      if ((r.rowCount ?? 0) > 0) upserted++;
    }
  }
  return { channels: channels.length, upserted };
}

let timer: NodeJS.Timeout | null = null;

export function startSlackFeedPoller(log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }): void {
  if (timer) return;
  if (!botToken()) { log?.info({}, 'Slack feed poller: no SLACK_BOT_TOKEN, not starting'); return; }
  const tick = () => {
    pollSalesChannels()
      .then((r) => { if (r.upserted > 0) log?.info(r, 'Slack feed poll'); })
      .catch((err) => log?.warn({ err }, 'Slack feed poll failed'));
  };
  // First run after 20s (let boot settle), then every minute.
  setTimeout(tick, 20_000);
  timer = setInterval(tick, POLL_INTERVAL_MS);
}
