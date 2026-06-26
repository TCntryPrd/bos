/**
 * Fallback middleware — handles adapter failures with graceful degradation.
 * This is a pre-middleware that tags the request with fallback metadata,
 * and a utility the router uses internally. The actual fallback logic
 * lives in router.ts (candidate selection + retry loop).
 *
 * This middleware provides:
 * - Adapter health tracking (failure counts, cooldown)
 * - Circuit breaker pattern to avoid hammering a failing adapter
 */

import type {
  BrainMiddleware,
  BrainRequest,
  BrainResponse,
  MiddlewareContext,
  AdapterStatus,
} from '../types.js';

export interface FallbackConfig {
  /** Number of consecutive failures before marking an adapter as unavailable. */
  failureThreshold: number;
  /** Cooldown in ms before retrying an unavailable adapter. */
  cooldownMs: number;
}

const DEFAULT_CONFIG: FallbackConfig = {
  failureThreshold: 3,
  cooldownMs: 60_000,
};

interface AdapterHealthRecord {
  consecutiveFailures: number;
  lastFailure: number;
  status: AdapterStatus;
}

export class FallbackTracker {
  private health = new Map<string, AdapterHealthRecord>();
  private config: FallbackConfig;

  constructor(config: Partial<FallbackConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  recordSuccess(adapterId: string): void {
    this.health.set(adapterId, {
      consecutiveFailures: 0,
      lastFailure: 0,
      status: 'ready',
    });
  }

  recordFailure(adapterId: string): AdapterStatus {
    const record = this.health.get(adapterId) ?? {
      consecutiveFailures: 0,
      lastFailure: 0,
      status: 'ready' as AdapterStatus,
    };

    record.consecutiveFailures++;
    record.lastFailure = Date.now();

    if (record.consecutiveFailures >= this.config.failureThreshold) {
      record.status = 'unavailable';
    } else {
      record.status = 'degraded';
    }

    this.health.set(adapterId, record);
    return record.status;
  }

  getStatus(adapterId: string): AdapterStatus {
    const record = this.health.get(adapterId);
    if (!record) return 'ready';

    // Check if cooldown has elapsed for unavailable adapters
    if (
      record.status === 'unavailable' &&
      Date.now() - record.lastFailure > this.config.cooldownMs
    ) {
      record.status = 'degraded'; // Allow retry
      record.consecutiveFailures = 0;
    }

    return record.status;
  }

  getHealthMap(): Map<string, AdapterHealthRecord> {
    return new Map(this.health);
  }
}

/**
 * Creates a pre-middleware that checks adapter health via the FallbackTracker
 * and annotates the request. The router should query the tracker before
 * selecting candidates.
 */
export function createFallbackMiddleware(tracker: FallbackTracker): BrainMiddleware {
  return {
    name: 'fallback',
    phase: 'pre',
    async execute(
      input: BrainRequest | BrainResponse,
      _ctx: MiddlewareContext,
    ): Promise<BrainRequest | BrainResponse> {
      // Pre-middleware pass-through — the tracker is consulted by the router directly
      return input;
    },
  };
}
