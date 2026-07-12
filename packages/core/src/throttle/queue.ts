/**
 * ThrottledQueue — priority background task queue governed by ComputeGovernor.
 *
 * Priority tiers:
 *   critical  Always runs regardless of throttle level.
 *             Used for sync operations that must complete to maintain consistency.
 *   normal    Runs when throttle level > THROTTLE_ACTIVE_USER (i.e. user is idle).
 *   low       Runs only when throttle level >= THROTTLE_IDLE_LOADED (0.33+).
 *             Used for heavy ingestion, learning, analysis passes.
 *
 * Concurrency scales with the current throttle level:
 *   - Effective concurrency = floor(maxConcurrency * throttleLevel), minimum 1.
 *   - Critical tasks bypass concurrency limits and always get a slot.
 *
 * The queue can be paused/resumed externally (e.g. during backup windows or
 * when the desktop app receives a battery-saver signal).
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';
import type { ComputeGovernor } from './governor.js';
import { THROTTLE_ACTIVE_USER, THROTTLE_IDLE_LOADED } from './governor.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskPriority = 'critical' | 'normal' | 'low';

export type TaskFn = () => Promise<void>;

export interface QueueTask {
  id: string;
  fn: TaskFn;
  priority: TaskPriority;
  /** Set by the queue when the task is enqueued. */
  enqueuedAt: Date;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  paused: boolean;
  currentThrottleLevel: number;
  effectiveConcurrency: number;
}

export interface ThrottledQueueConfig {
  /**
   * Maximum number of concurrently running tasks when throttle level is 1.0.
   * Actual concurrency = floor(maxConcurrency * throttleLevel), min 1.
   * Default: 4.
   */
  maxConcurrency?: number;
  /**
   * How often (ms) the queue ticks to check for runnable work.
   * Default: 2_000 (2 s).
   */
  tickIntervalMs?: number;
}

export interface TaskResult {
  taskId: string;
  priority: TaskPriority;
  durationMs: number;
  success: boolean;
  error?: string;
}

// ── Priority ordering (lower number = higher urgency) ─────────────────────────

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  normal:   1,
  low:      2,
};

// ── ThrottledQueue ────────────────────────────────────────────────────────────

export class ThrottledQueue extends EventEmitter {
  private readonly governor: ComputeGovernor;
  private readonly maxConcurrency: number;
  private readonly tickIntervalMs: number;

  private pending: QueueTask[] = [];
  private runningCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private paused = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private readonly log = createLogger('throttle:queue');

  constructor(governor: ComputeGovernor, config: ThrottledQueueConfig = {}) {
    super();
    this.governor = governor;
    this.maxConcurrency = config.maxConcurrency ?? 4;
    this.tickIntervalMs = config.tickIntervalMs ?? 2_000;

    this.startTicking();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Add a task to the queue.
   *
   * @param id       Stable identifier for logging and deduplication.
   * @param fn       Async function to execute.
   * @param priority Scheduling priority. Default: 'normal'.
   */
  enqueue(id: string, fn: TaskFn, priority: TaskPriority = 'normal'): void {
    const task: QueueTask = { id, fn, priority, enqueuedAt: new Date() };
    this.pending.push(task);

    // Keep the list sorted so the highest-priority tasks drain first.
    this.pending.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    );

    this.log.debug('Task enqueued', { taskId: id, priority, pendingCount: this.pending.length });
    this.emit('enqueued', task);

    // Attempt to drain immediately in case slots are available.
    this.tick();
  }

  /**
   * Suspend processing.  Running tasks complete; no new tasks are started.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.log.info('Queue paused');
    this.emit('paused');
  }

  /**
   * Resume processing after a pause.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.log.info('Queue resumed');
    this.emit('resumed');
    this.tick();
  }

  /**
   * Current queue statistics.
   */
  getStats(): QueueStats {
    const throttleLevel = this.governor.getThrottleLevel();
    return {
      pending: this.pending.length,
      running: this.runningCount,
      completed: this.completedCount,
      failed: this.failedCount,
      paused: this.paused,
      currentThrottleLevel: throttleLevel,
      effectiveConcurrency: this.computeEffectiveConcurrency(throttleLevel),
    };
  }

  /**
   * Drain remaining tasks and stop the tick timer.
   * Call during graceful shutdown.
   */
  destroy(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.removeAllListeners();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private startTicking(): void {
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  private tick(): void {
    if (this.paused) return;
    if (this.pending.length === 0) return;

    const throttleLevel = this.governor.getThrottleLevel();
    const effectiveConcurrency = this.computeEffectiveConcurrency(throttleLevel);

    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (!next) break;

      // Critical tasks always get a slot.
      const isCritical = next.priority === 'critical';

      // Normal tasks require the user to be idle (level above active-user cap).
      const canRunNormal =
        next.priority === 'normal' && throttleLevel > THROTTLE_ACTIVE_USER;

      // Low tasks need at least the idle-loaded tier.
      const canRunLow =
        next.priority === 'low' && throttleLevel >= THROTTLE_IDLE_LOADED;

      if (!isCritical && !canRunNormal && !canRunLow) {
        // Front of queue is blocked by throttle; nothing behind it can run either
        // (queue is priority-sorted, so lower-priority items follow).
        break;
      }

      // Check concurrency ceiling (critical tasks bypass it).
      if (!isCritical && this.runningCount >= effectiveConcurrency) {
        break;
      }

      // Dequeue and run.
      this.pending.shift();
      void this.runTask(next);
    }
  }

  private async runTask(task: QueueTask): Promise<void> {
    this.runningCount++;
    const start = Date.now();

    this.log.debug('Task started', { taskId: task.id, priority: task.priority });
    this.emit('taskStart', task);

    try {
      await task.fn();

      const durationMs = Date.now() - start;
      this.completedCount++;

      const result: TaskResult = {
        taskId: task.id,
        priority: task.priority,
        durationMs,
        success: true,
      };

      this.log.debug('Task completed', { taskId: task.id, durationMs });
      this.emit('taskComplete', result);
    } catch (err) {
      const durationMs = Date.now() - start;
      this.failedCount++;

      const message = err instanceof Error ? err.message : String(err);
      const result: TaskResult = {
        taskId: task.id,
        priority: task.priority,
        durationMs,
        success: false,
        error: message,
      };

      this.log.warn('Task failed', { taskId: task.id, durationMs, err_msg: message });
      this.emit('taskError', result);
    } finally {
      this.runningCount--;
      // Immediately attempt to drain more work now that a slot freed up.
      this.tick();
    }
  }

  /**
   * Effective concurrency = floor(maxConcurrency * throttleLevel), minimum 1.
   * Critical tasks are excluded from this ceiling.
   */
  private computeEffectiveConcurrency(throttleLevel: number): number {
    return Math.max(1, Math.floor(this.maxConcurrency * throttleLevel));
  }
}
