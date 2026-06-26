/**
 * Shared BrainRouter singleton.
 *
 * Extracted into its own module so both the brain route handler and the
 * agent tool handlers can reference the same router instance without
 * creating a circular import dependency.
 *
 * brain.ts  →  router-singleton.ts  (no circular dep)
 * executor.ts  →  router-singleton.ts  (no circular dep)
 */

import { BrainRouter } from '@boss/brain';

let _router: BrainRouter | null = null;

/**
 * Return the shared BrainRouter, creating it on first call.
 *
 * The router starts with no adapters registered — callers must bootstrap
 * adapters before routing requests. This matches the existing lazy-init
 * behaviour in brain.ts.
 */
export function getSharedRouter(): BrainRouter {
  if (!_router) {
    _router = new BrainRouter({
      maxFallbackAttempts: 2,
      adapterTimeoutMs: 30_000,
      preferStreaming: false,
    });
  }
  return _router;
}
