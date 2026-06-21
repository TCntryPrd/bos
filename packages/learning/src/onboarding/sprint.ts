/**
 * Onboarding Sprint — orchestrates full historical ingest across all connected platforms.
 *
 * Runs each platform ingester via ThrottledQueue so that background ingest
 * work respects CPU load and user-activity signals rather than running
 * unbounded.  Each ingester is submitted as a 'low' priority task; the
 * governor will only execute them when the user is idle and the system has
 * headroom.
 */

import type { TenantContext } from '@boss/core';
import {
  SystemObserver,
  ComputeGovernor,
  ThrottledQueue,
} from '@boss/core';

import type { OnboardingProgress, PlatformIngestResult } from './progress.js';
import { ProgressTracker } from './progress.js';
import { GmailIngester } from './gmail-ingest.js';
import { CalendarIngester } from './calendar-ingest.js';
import { DriveIngester } from './drive-ingest.js';
import { TasksIngester } from './tasks-ingest.js';
import { CommsIngester } from './comms-ingest.js';
import { FinancialIngester } from './financial-ingest.js';
import { DeviceIngester } from './device-ingest.js';
import { ProfileSynthesizer } from './synthesizer.js';
import type { LearningProfile } from '../profile.js';

// ── Types ───────────────────────────────────────────────────────────

export interface SprintConfig {
  /** Platforms to ingest. Defaults to all connected. */
  platforms?: PlatformName[];
  /**
   * Maximum concurrency for parallel ingest when no ThrottledQueue is provided.
   * When a ThrottledQueue is supplied this value is ignored — the governor
   * controls concurrency dynamically.
   * @deprecated Pass a ThrottledQueue via `queue` instead.
   */
  concurrency?: number;
  /** Gmail/Outlook lookback in months. Default 6. */
  emailMonths?: number;
  /** Calendar lookback in months. Default 12. */
  calendarMonths?: number;
  /**
   * Optional ThrottledQueue to use for ingest tasks.
   * When provided each ingester runs as a 'low' priority task so that ingest
   * work yields to interactive workloads.
   *
   * If omitted the sprint creates a private queue backed by a default
   * SystemObserver + ComputeGovernor in 'server' mode.
   */
  queue?: ThrottledQueue;
}

export type PlatformName =
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'tasks'
  | 'comms'
  | 'financial'
  | 'device';

export interface SprintResult {
  profile: LearningProfile;
  progress: OnboardingProgress;
  durationMs: number;
  errors: Array<{ platform: PlatformName; error: string }>;
}

export interface PlatformIngester {
  readonly platform: PlatformName;
  ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult>;
}

// ── Default Config ──────────────────────────────────────────────────

const DEFAULT_PLATFORMS: PlatformName[] = [
  'gmail', 'calendar', 'drive', 'tasks', 'comms', 'financial', 'device',
];

// ── Sprint Runner ───────────────────────────────────────────────────

export class OnboardingSprint {
  private readonly platforms: PlatformName[];
  private readonly emailMonths: number;
  private readonly calendarMonths: number;
  private readonly queue: ThrottledQueue;
  /** True when this sprint owns the queue and should tear it down after run(). */
  private readonly ownsQueue: boolean;

  private tracker: ProgressTracker;
  private ingesters: Map<PlatformName, PlatformIngester>;

  constructor(config: SprintConfig = {}) {
    this.platforms = config.platforms ?? DEFAULT_PLATFORMS;
    this.emailMonths = config.emailMonths ?? 6;
    this.calendarMonths = config.calendarMonths ?? 12;
    this.tracker = new ProgressTracker(this.platforms);
    this.ingesters = new Map();

    if (config.queue) {
      this.queue = config.queue;
      this.ownsQueue = false;
    } else {
      // Create a private throttle stack for callers that don't supply one.
      const observer = new SystemObserver({ mode: 'server' });
      const governor = new ComputeGovernor(observer);
      this.queue = new ThrottledQueue(governor, {
        maxConcurrency: config.concurrency ?? 3,
      });
      this.ownsQueue = true;
    }

    this.registerDefaultIngesters();
  }

  /** Replace or add a custom ingester for a platform. */
  registerIngester(ingester: PlatformIngester): void {
    this.ingesters.set(ingester.platform, ingester);
  }

  /** Get live progress snapshot. */
  getProgress(): OnboardingProgress {
    return this.tracker.getProgress();
  }

  /**
   * Run the full onboarding sprint.
   *
   * Each platform ingester is submitted to the ThrottledQueue as a 'low'
   * priority task.  The governor decides when each task actually executes
   * based on CPU load and user-activity signals.  The method returns once
   * all tasks have completed (or failed) and the profile is synthesized.
   */
  async run(ctx: TenantContext): Promise<SprintResult> {
    const startTime = Date.now();
    const errors: SprintResult['errors'] = [];
    const results: PlatformIngestResult[] = [];

    const platforms = this.platforms.filter((p) => this.ingesters.has(p));

    // Submit each ingester to the throttled queue and collect a Promise for each.
    const taskPromises = platforms.map((platform) => {
      return new Promise<void>((resolve) => {
        const ingester = this.ingesters.get(platform)!;

        this.queue.enqueue(
          `onboarding:${platform}`,
          async () => {
            this.tracker.markRunning(platform);
            try {
              const result = await ingester.ingest(ctx, this.tracker);
              results.push(result);
              this.tracker.markComplete(platform, result);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              errors.push({ platform, error: message });
              this.tracker.markFailed(platform, message);
            }
          },
          'low',
        );

        // Resolve this promise when the queue emits completion or error for
        // this task, so we can await all platforms finishing.
        const onDone = (ev: { taskId: string }) => {
          if (ev.taskId === `onboarding:${platform}`) {
            this.queue.removeListener('taskComplete', onDone);
            this.queue.removeListener('taskError', onDone);
            resolve();
          }
        };

        this.queue.on('taskComplete', onDone);
        this.queue.on('taskError', onDone);
      });
    });

    await Promise.all(taskPromises);

    // Tear down the private stack if we created it.
    if (this.ownsQueue) {
      this.queue.destroy();
    }

    // Synthesize profile from all successful results
    const synthesizer = new ProfileSynthesizer();
    const profile = await synthesizer.synthesize(ctx, results);

    return {
      profile,
      progress: this.tracker.getProgress(),
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  // ── Internal ──────────────────────────────────────────────

  private registerDefaultIngesters(): void {
    const emailMonths = this.emailMonths;
    const calendarMonths = this.calendarMonths;

    const defaults: PlatformIngester[] = [
      new GmailIngester({ lookbackMonths: emailMonths }),
      new CalendarIngester({ lookbackMonths: calendarMonths }),
      new DriveIngester(),
      new TasksIngester(),
      new CommsIngester(),
      new FinancialIngester(),
      new DeviceIngester(),
    ];

    for (const ingester of defaults) {
      this.ingesters.set(ingester.platform, ingester);
    }
  }
}
