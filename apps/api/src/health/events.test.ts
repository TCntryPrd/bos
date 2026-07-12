import { describe, it, expect } from 'vitest';
import { buildEventEntry, HEALTH_EVENTS_STREAM_KEY } from './events.js';

describe('HEALTH_EVENTS_STREAM_KEY', () => {
  it('targets this fork\'s real event bus stream/consumer group (boss:events / boss-reactor), not vasari:events', () => {
    // services/shared/event_bus.py defines STREAM_KEY = "boss:events" and
    // CONSUMER_GROUP = "boss-reactor" for this fork. If this ever drifts back
    // to "vasari:events", health events land on an orphan stream with no
    // consumer and reactor-driven automations silently never fire.
    expect(HEALTH_EVENTS_STREAM_KEY).toBe('boss:events');
  });
});

describe('buildEventEntry', () => {
  it('matches the IR Custom AIOSEvent stream field format (all string values)', () => {
    const entry = buildEventEntry('health.synced', 'default', { days: ['2026-07-01'] });
    expect(entry.type).toBe('health.synced');
    expect(entry.source).toBe('health-api');
    expect(entry.tenant).toBe('default');
    expect(typeof entry.id).toBe('string');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(entry.data)).toEqual({ days: ['2026-07-01'] });
    expect(entry.metadata).toBe('{}');
    for (const v of Object.values(entry)) expect(typeof v).toBe('string');
  });
});
