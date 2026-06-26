/**
 * ComputeGovernor — translates SystemObserver readings into a throttle level.
 *
 * Throttle level semantics (0.0 – 1.0):
 *   0.05   User is actively working (desktop signal OR inside active/business hours)
 *   0.33   User idle but system is loaded  (loadRatio > HIGH_LOAD_THRESHOLD)
 *   0.66   User idle and system idle        (nights, weekends, quiet periods)
 *
 * The governor emits a `'change'` event whenever the level shifts between
 * tiers, carrying `{ previous: number, current: number }` in the payload.
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';
import type { SystemObserver, SystemReading } from './observer.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** loadRatio above this value is treated as "system loaded". */
const HIGH_LOAD_THRESHOLD = 0.70;

/** CPU utilisation above this value reinforces the "system loaded" decision. */
const HIGH_CPU_THRESHOLD = 0.70;

/** Minimum delta between old and new level to emit a `change` event. */
const CHANGE_THRESHOLD = 0.01;

// ── Throttle level constants (exported for consumers) ─────────────────────────

export const THROTTLE_ACTIVE_USER = 0.05;
export const THROTTLE_IDLE_LOADED = 0.33;
export const THROTTLE_IDLE_FREE   = 0.66;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GovernorConfig {
  /**
   * How often (ms) the governor polls the observer and recalculates the level.
   * Default: 10_000 (10 s).
   */
  pollIntervalMs?: number;
}

export interface ThrottleChangeEvent {
  previous: number;
  current: number;
  reading: SystemReading;
}

// ── ComputeGovernor ───────────────────────────────────────────────────────────

export class ComputeGovernor extends EventEmitter {
  private readonly observer: SystemObserver;
  private readonly pollIntervalMs: number;
  private throttleLevel: number = THROTTLE_IDLE_FREE;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly log = createLogger('throttle:governor');

  constructor(observer: SystemObserver, config: GovernorConfig = {}) {
    super();
    this.observer = observer;
    this.pollIntervalMs = config.pollIntervalMs ?? 10_000;

    // Run immediately to get a valid initial level before the first tick.
    this.recalculate();
    this.startPolling();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Current throttle level (0.0 – 1.0).
   * Higher = more compute budget allowed for background work.
   */
  getThrottleLevel(): number {
    return this.throttleLevel;
  }

  /**
   * Returns true when background heavy tasks are permitted to run.
   * Heavy tasks are allowed at any level above the minimum active-user cap.
   */
  canRunHeavyTask(): boolean {
    return this.throttleLevel > THROTTLE_ACTIVE_USER;
  }

  /** Force an immediate re-evaluation outside of the polling schedule. */
  evaluate(): number {
    this.recalculate();
    return this.throttleLevel;
  }

  /** Stop polling. Call when the application is shutting down. */
  destroy(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.removeAllListeners();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.recalculate();
    }, this.pollIntervalMs);

    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private recalculate(): void {
    const reading = this.observer.getReading();
    const newLevel = this.computeLevel(reading);
    const previous = this.throttleLevel;

    this.throttleLevel = newLevel;

    if (Math.abs(newLevel - previous) >= CHANGE_THRESHOLD) {
      const payload: ThrottleChangeEvent = { previous, current: newLevel, reading };
      this.emit('change', payload);
      this.log.info('Throttle level changed', {
        previous,
        current: newLevel,
        loadRatio: reading.loadRatio,
        cpuUtilisation: reading.cpuUtilisation,
        isActiveHours: reading.isActiveHours,
        userActivityDetected: reading.userActivityDetected,
      });
    }
  }

  private computeLevel(reading: SystemReading): number {
    // Priority 1: user is demonstrably present — absolute minimum budget.
    if (reading.userActivityDetected || reading.isActiveHours) {
      return THROTTLE_ACTIVE_USER;
    }

    // Priority 2: user is away but machine is under load.
    const systemLoaded =
      reading.loadRatio > HIGH_LOAD_THRESHOLD ||
      reading.cpuUtilisation > HIGH_CPU_THRESHOLD;

    if (systemLoaded) {
      return THROTTLE_IDLE_LOADED;
    }

    // Priority 3: user is away and system is quiet — open the budget.
    return THROTTLE_IDLE_FREE;
  }
}
