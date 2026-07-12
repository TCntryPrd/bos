/**
 * Publishes health events onto the Redis Stream `boss:events` in the exact
 * field format services/shared/models.py::IR Custom AIOSEvent expects, so the
 * `boss-reactor` consumer group (services/shared/event_bus.py) can consume
 * them without changes.
 * Fire-and-forget: Redis being down must never fail an ingest.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

export const HEALTH_EVENTS_STREAM_KEY = 'boss:events';
const STREAM_KEY = HEALTH_EVENTS_STREAM_KEY;

let client: Redis | null = null;
let warned = false;

export function buildEventEntry(
  type: string,
  tenant: string,
  data: Record<string, unknown>,
): Record<string, string> {
  return {
    id: randomUUID(),
    type,
    source: 'health-api',
    tenant,
    timestamp: new Date().toISOString(),
    data: JSON.stringify(data),
    metadata: '{}',
  };
}

export async function publishHealthEvent(
  type: string,
  tenant: string,
  data: Record<string, unknown>,
): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    client ??= new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false });
    if (client.status === 'wait') await client.connect();
    const entry = buildEventEntry(type, tenant, data);
    await client.xadd(STREAM_KEY, '*', ...Object.entries(entry).flat());
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[health] event publish failed (suppressing further warnings): ${String(err)}`);
    }
  }
}

/** Test/shutdown helper. */
export async function closeHealthEvents(): Promise<void> {
  if (client) { client.disconnect(); client = null; }
  warned = false;
}
