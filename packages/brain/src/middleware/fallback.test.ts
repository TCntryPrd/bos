/**
 * Unit tests — FallbackTracker and createFallbackMiddleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FallbackTracker, createFallbackMiddleware } from './fallback.js';
import type { BrainRequest } from '../types.js';

function makeRequest(overrides: Partial<BrainRequest> = {}): BrainRequest {
  return {
    id: 'req-1',
    type: 'chat',
    tenantId: 'tenant-1',
    userId: 'user-1',
    prompt: 'test',
    ...overrides,
  };
}

describe('FallbackTracker', () => {
  let tracker: FallbackTracker;

  beforeEach(() => {
    tracker = new FallbackTracker({ failureThreshold: 3, cooldownMs: 60_000 });
  });

  it('returns "ready" for an adapter with no recorded events', () => {
    expect(tracker.getStatus('unknown-adapter')).toBe('ready');
  });

  it('returns "ready" after a success is recorded', () => {
    tracker.recordFailure('a1');
    tracker.recordSuccess('a1');
    expect(tracker.getStatus('a1')).toBe('ready');
  });

  it('returns "degraded" after a single failure (below threshold)', () => {
    tracker.recordFailure('a1');
    expect(tracker.getStatus('a1')).toBe('degraded');
  });

  it('returns "degraded" when failures are below threshold', () => {
    tracker.recordFailure('a1');
    tracker.recordFailure('a1');
    // threshold is 3 — 2 failures is still degraded
    expect(tracker.getStatus('a1')).toBe('degraded');
  });

  it('returns "unavailable" after failures reach threshold', () => {
    tracker.recordFailure('a1');
    tracker.recordFailure('a1');
    const status = tracker.recordFailure('a1');
    expect(status).toBe('unavailable');
    expect(tracker.getStatus('a1')).toBe('unavailable');
  });

  it('resets consecutive failure count on success', () => {
    tracker.recordFailure('a1');
    tracker.recordFailure('a1');
    tracker.recordSuccess('a1');
    tracker.recordFailure('a1');
    // Only 1 failure after reset — should be degraded, not unavailable
    expect(tracker.getStatus('a1')).toBe('degraded');
  });

  it('transitions from "unavailable" to "degraded" after cooldown elapses', async () => {
    const fastTracker = new FallbackTracker({
      failureThreshold: 1,
      cooldownMs: 50,
    });
    fastTracker.recordFailure('a1');
    expect(fastTracker.getStatus('a1')).toBe('unavailable');

    await new Promise((r) => setTimeout(r, 100));
    expect(fastTracker.getStatus('a1')).toBe('degraded');
  });

  it('tracks multiple adapters independently', () => {
    tracker.recordFailure('a1');
    tracker.recordFailure('a1');
    tracker.recordFailure('a1');
    tracker.recordFailure('b1');

    expect(tracker.getStatus('a1')).toBe('unavailable');
    expect(tracker.getStatus('b1')).toBe('degraded');
  });

  it('returns the new status from recordFailure()', () => {
    const s1 = tracker.recordFailure('x');
    expect(s1).toBe('degraded');
    tracker.recordFailure('x');
    const s3 = tracker.recordFailure('x');
    expect(s3).toBe('unavailable');
  });

  it('exposes a health map copy via getHealthMap()', () => {
    tracker.recordFailure('a1');
    tracker.recordSuccess('b1');
    const map = tracker.getHealthMap();
    expect(map.has('a1')).toBe(true);
    expect(map.has('b1')).toBe(true);
  });

  it('getHealthMap returns an independent copy — mutations do not affect tracker', () => {
    tracker.recordFailure('a1');
    const map = tracker.getHealthMap();
    map.delete('a1');
    // tracker still has 'a1'
    expect(tracker.getHealthMap().has('a1')).toBe(true);
  });
});

describe('createFallbackMiddleware', () => {
  it('creates a BrainMiddleware with name "fallback" and phase "pre"', () => {
    const tracker = new FallbackTracker();
    const mw = createFallbackMiddleware(tracker);
    expect(mw.name).toBe('fallback');
    expect(mw.phase).toBe('pre');
  });

  it('passes the request through unchanged (pre-middleware pass-through)', async () => {
    const tracker = new FallbackTracker();
    const mw = createFallbackMiddleware(tracker);
    const req = makeRequest({ prompt: 'original' });
    const result = await mw.execute(req, { adapterId: 'a1', startTime: Date.now(), attempt: 0 });
    expect(result).toBe(req);
  });
});
