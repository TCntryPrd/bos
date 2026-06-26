/**
 * SystemObserver — monitors CPU load and user activity to feed the ComputeGovernor.
 *
 * Two operating modes:
 *   desktop  — receives user-activity signals over IPC (keyboard/mouse events
 *               forwarded by the Electron main process).
 *   server   — no activity signals available; relies on time-of-day heuristics.
 *
 * Readings are produced on demand via `getReading()`.  The observer does NOT
 * push events; the governor polls it at its own cadence.
 */

import { cpus, loadavg } from 'os';
import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ObserverMode = 'desktop' | 'server';

export interface ActiveHoursConfig {
  /** Hour (0-23, local time) at which the working day starts. Default: 8 */
  startHour: number;
  /** Hour (0-23, local time) at which the working day ends. Default: 20 */
  endHour: number;
  /**
   * Days of the week considered working days (0 = Sunday … 6 = Saturday).
   * Default: [1, 2, 3, 4, 5] (Mon–Fri).
   */
  workDays: number[];
}

export interface ObserverConfig {
  mode?: ObserverMode;
  activeHours?: Partial<ActiveHoursConfig>;
  /**
   * How long (ms) a user-activity signal keeps the "user active" flag set.
   * After this window elapses with no new signal the user is considered idle.
   * Default: 120_000 (2 minutes).
   */
  activityWindowMs?: number;
  /**
   * Interval (ms) at which CPU utilisation is sampled.
   * Shorter = more accurate but marginally more overhead.
   * Default: 5_000 (5 s).
   */
  sampleIntervalMs?: number;
}

export interface SystemReading {
  /** Normalised 1-minute load average divided by logical CPU count (0.0 – ∞). */
  loadRatio: number;
  /** Estimated CPU utilisation across all cores (0.0 – 1.0). */
  cpuUtilisation: number;
  /** True when the current time falls inside configured active hours. */
  isActiveHours: boolean;
  /**
   * True when a desktop activity signal was received within `activityWindowMs`.
   * Always false in server mode.
   */
  userActivityDetected: boolean;
  /** Snapshot timestamp. */
  sampledAt: Date;
}

// ── Default config ───────────────────────────────────────────────────────────

const DEFAULT_ACTIVE_HOURS: ActiveHoursConfig = {
  startHour: 8,
  endHour: 20,
  workDays: [1, 2, 3, 4, 5],
};

const DEFAULT_ACTIVITY_WINDOW_MS = 120_000; // 2 min
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;   // 5 s

// ── CPU snapshot helper ───────────────────────────────────────────────────────

interface CpuTick {
  idle: number;
  total: number;
}

function cpuTicks(): CpuTick {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

// ── SystemObserver ────────────────────────────────────────────────────────────

export class SystemObserver extends EventEmitter {
  private readonly mode: ObserverMode;
  private readonly activeHours: ActiveHoursConfig;
  private readonly activityWindowMs: number;
  private readonly sampleIntervalMs: number;

  private lastActivityAt: number | null = null;
  private prevTick: CpuTick | null = null;
  private cpuUtilisation = 0;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;

  private readonly log = createLogger('throttle:observer');

  constructor(config: ObserverConfig = {}) {
    super();
    this.mode = config.mode ?? 'server';
    this.activeHours = { ...DEFAULT_ACTIVE_HOURS, ...(config.activeHours ?? {}) };
    this.activityWindowMs = config.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
    this.sampleIntervalMs = config.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

    // Warm up the first CPU baseline immediately.
    this.prevTick = cpuTicks();
    this.startSampling();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns a point-in-time snapshot of system state.
   * Cheap to call — CPU utilisation is updated by the background sampler.
   */
  getReading(): SystemReading {
    return {
      loadRatio: this.computeLoadRatio(),
      cpuUtilisation: this.cpuUtilisation,
      isActiveHours: this.isActiveHours(),
      userActivityDetected: this.isUserActive(),
      sampledAt: new Date(),
    };
  }

  /**
   * Called by the Electron main process (or any IPC bridge) when it detects
   * keyboard or mouse input.  In server mode this is a no-op.
   */
  signalUserActivity(): void {
    if (this.mode !== 'desktop') return;
    this.lastActivityAt = Date.now();
    this.log.debug('User activity signal received');
  }

  /** Shut down the background CPU sampler. Call when the process is exiting. */
  destroy(): void {
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.removeAllListeners();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private startSampling(): void {
    this.sampleTimer = setInterval(() => {
      this.updateCpuUtilisation();
    }, this.sampleIntervalMs);

    // Allow Node to exit even if this timer is still running.
    if (this.sampleTimer.unref) this.sampleTimer.unref();
  }

  private updateCpuUtilisation(): void {
    const current = cpuTicks();
    const prev = this.prevTick;

    if (prev !== null) {
      const idleDelta = current.idle - prev.idle;
      const totalDelta = current.total - prev.total;

      if (totalDelta > 0) {
        this.cpuUtilisation = Math.max(0, Math.min(1, 1 - idleDelta / totalDelta));
      }
    }

    this.prevTick = current;
  }

  private computeLoadRatio(): number {
    const [oneMin] = loadavg();
    const logicalCores = cpus().length;
    if (logicalCores === 0) return 0;
    return oneMin / logicalCores;
  }

  private isActiveHours(): boolean {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();

    const isWorkDay = this.activeHours.workDays.includes(dayOfWeek);
    const isWorkHour =
      hour >= this.activeHours.startHour && hour < this.activeHours.endHour;

    return isWorkDay && isWorkHour;
  }

  private isUserActive(): boolean {
    if (this.mode !== 'desktop') return false;
    if (this.lastActivityAt === null) return false;
    return Date.now() - this.lastActivityAt < this.activityWindowMs;
  }
}
