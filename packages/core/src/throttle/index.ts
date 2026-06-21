/**
 * @boss/core/throttle — Dynamic Compute Throttling
 *
 * Exports the three-layer throttle stack:
 *
 *   SystemObserver    — samples CPU, load, time-of-day, desktop activity
 *   ComputeGovernor   — translates readings into a throttle level (0.0 – 1.0)
 *   ThrottledQueue    — background task queue that respects the governor
 *
 * Typical usage:
 *
 *   import { SystemObserver, ComputeGovernor, ThrottledQueue } from '@boss/core';
 *
 *   const observer = new SystemObserver({ mode: 'server' });
 *   const governor = new ComputeGovernor(observer);
 *   const queue    = new ThrottledQueue(governor, { maxConcurrency: 4 });
 *
 *   queue.enqueue('ingest-gmail', async () => { ... }, 'low');
 *   queue.enqueue('sync-calendar', async () => { ... }, 'critical');
 */

export { SystemObserver } from './observer.js';
export type {
  ObserverMode,
  ObserverConfig,
  ActiveHoursConfig,
  SystemReading,
} from './observer.js';

export { ComputeGovernor, THROTTLE_ACTIVE_USER, THROTTLE_IDLE_LOADED, THROTTLE_IDLE_FREE } from './governor.js';
export type { GovernorConfig, ThrottleChangeEvent } from './governor.js';

export { ThrottledQueue } from './queue.js';
export type {
  TaskPriority,
  TaskFn,
  QueueTask,
  QueueStats,
  ThrottledQueueConfig,
  TaskResult,
} from './queue.js';
