/**
 * Consumes `health.threshold` events from the `boss:events` Redis Stream on a
 * DEDICATED consumer group (`health-alerts` — never steals from boss-reactor)
 * and alerts the admin via Telegram, with a 24h per-tenant-per-metric cooldown
 * persisted in runtime_config so restarts don't re-alert.
 *
 * Delivery semantics: at-least-once for real alerts — an entry is acked only
 * after successful handling, and a periodic XAUTOCLAIM pass reprocesses
 * entries stranded by a crash or a failed Telegram send. The cooldown map
 * suppresses the rare double-send that at-least-once implies. Test events
 * (data.test === true) always send with a "[test] " prefix and neither
 * consult nor update the cooldown, so wiring checks can't mask real breaches.
 *
 * Crash-proof by contract: Redis, Postgres, or Telegram failures log, back
 * off, and retry — they must never take down the API. Known accepted edge:
 * two parallel API instances share the group (no duplicate delivery) but
 * hold independent in-memory cooldowns, so a repeat breach within 24h routed
 * to the other instance can alert twice.
 */
import Redis from 'ioredis';
import { getRuntimeConfig, setRuntimeConfig } from '../config-store.js';

const STREAM_KEY = 'boss:events';
const GROUP = 'health-alerts';
const CONSUMER = 'api';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_RC_KEY = 'health.alerts.last';
const RECLAIM_MIN_IDLE_MS = 5 * 60 * 1000;
const RECLAIM_EVERY_N_LOOPS = 12; // ~1/min at BLOCK 5000
const TELEGRAM_TIMEOUT_MS = 15_000;

const METRIC_LABELS: Record<string, string> = {
  sleep_minutes: 'Sleep (min)',
  resting_hr: 'Resting HR (bpm)',
  steps: 'Steps',
  hrv_rmssd: 'HRV (ms)',
  spo2_avg: 'SpO2 (%)',
};

let running = false;
let client: Redis | null = null;
const lastAlertAt = new Map<string, number>();

function label(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

async function loadCooldowns(): Promise<void> {
  try {
    const raw = await getRuntimeConfig(COOLDOWN_RC_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number') lastAlertAt.set(k, v);
    }
  } catch {
    /* cold start without persisted cooldowns is fine */
  }
}

async function persistCooldowns(): Promise<void> {
  try {
    await setRuntimeConfig(COOLDOWN_RC_KEY, JSON.stringify(Object.fromEntries(lastAlertAt)));
  } catch (err) {
    console.warn(`[health-alerts] cooldown persistence failed (retry on next alert): ${String(err)}`);
  }
}

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[health-alerts] TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID missing — alert skipped');
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: Number(chatId), text }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    console.warn(`[health-alerts] telegram send failed: HTTP ${res.status} ${body.slice(0, 120)}`);
    return false;
  }
  return true;
}

interface ThresholdData {
  metric?: string;
  value?: number;
  threshold?: number;
  direction?: string;
  date?: string;
  test?: boolean;
}

/** Returns true when the entry is fully handled and safe to ack. */
async function handleEntry(fields: Record<string, string>): Promise<boolean> {
  if (fields.type !== 'health.threshold') return true;
  let data: ThresholdData;
  try {
    data = JSON.parse(fields.data ?? '{}') as ThresholdData;
  } catch {
    console.warn('[health-alerts] unparseable event data — skipped');
    return true; // poison entry: ack, never retry
  }
  const metric = data.metric;
  if (!metric || typeof data.value !== 'number') return true;

  const isTest = data.test === true;
  const tenant = fields.tenant || 'default';
  const cooldownKey = `${tenant}|${metric}`;

  if (!isTest) {
    const last = lastAlertAt.get(cooldownKey) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) {
      console.log(`[health-alerts] ${cooldownKey} breach suppressed by 24h cooldown`);
      return true;
    }
  }

  const prefix = isTest ? '[test] ' : '';
  const text = `${prefix}⚠️ Health: ${label(metric)} ${data.value} ${data.direction ?? 'past'} threshold ${data.threshold ?? '?'} for ${data.date ?? 'today'}`;
  const sent = await sendTelegram(text);
  if (sent && !isTest) {
    lastAlertAt.set(cooldownKey, Date.now());
    await persistCooldowns();
    console.log(`[health-alerts] alerted on ${cooldownKey}`);
  }
  return sent; // failed send: leave unacked for the reclaim pass
}

function toFieldMap(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < arr.length; i += 2) out[arr[i]] = arr[i + 1];
  return out;
}

async function processEntries(redis: Redis, entries: [string, string[]][]): Promise<void> {
  for (const [id, fields] of entries) {
    let done = false;
    try {
      done = await handleEntry(toFieldMap(fields ?? []));
    } catch (err) {
      console.warn(`[health-alerts] entry ${id} failed (will reclaim): ${String(err)}`);
    }
    if (done) await redis.xack(STREAM_KEY, GROUP, id);
  }
}

/** Reprocess entries stranded unacked by a crash or failed send. */
async function reclaimPending(redis: Redis): Promise<void> {
  const res = (await redis.xautoclaim(
    STREAM_KEY, GROUP, CONSUMER, RECLAIM_MIN_IDLE_MS, '0-0', 'COUNT', 10,
  )) as [string, [string, string[]][], string[]?];
  const entries = res?.[1] ?? [];
  if (entries.length) {
    console.log(`[health-alerts] reclaiming ${entries.length} stranded entr${entries.length === 1 ? 'y' : 'ies'}`);
    await processEntries(redis, entries.filter(([, f]) => f !== null));
  }
}

export function startHealthAlertConsumer(): void {
  if (running) return;
  if (!process.env.REDIS_URL) {
    console.log('[health-alerts] REDIS_URL not set — consumer disabled');
    return;
  }
  if (process.env.HEALTH_ALERTS_ENABLED === 'false') {
    console.log('[health-alerts] disabled by HEALTH_ALERTS_ENABLED=false');
    return;
  }
  running = true;
  void (async () => {
    try {
      await loadCooldowns();
      client = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
      try {
        await client.xgroup('CREATE', STREAM_KEY, GROUP, '$', 'MKSTREAM');
      } catch (err) {
        if (!String(err).includes('BUSYGROUP')) {
          console.warn(`[health-alerts] xgroup create: ${String(err)}`);
        }
      }
      console.log('[health-alerts] consumer started (stream boss:events, group health-alerts)');
      let loops = 0;
      while (running) {
        try {
          if (loops++ % RECLAIM_EVERY_N_LOOPS === 0) await reclaimPending(client);
          const res = (await client.xreadgroup(
            'GROUP', GROUP, CONSUMER, 'COUNT', 10, 'BLOCK', 5000, 'STREAMS', STREAM_KEY, '>',
          )) as [string, [string, string[]][]][] | null;
          if (!res) continue;
          for (const [, entries] of res) await processEntries(client, entries);
        } catch (err) {
          if (!running) break;
          console.warn(`[health-alerts] read loop error, backing off 5s: ${String(err)}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    } catch (err) {
      // Startup-path failure (e.g. malformed REDIS_URL). Never crash the API.
      console.error(`[health-alerts] consumer disabled after fatal startup error: ${String(err)}`);
      running = false;
    }
  })();
}

export function stopHealthAlertConsumer(): void {
  running = false;
  if (client) {
    client.disconnect();
    client = null;
  }
}
