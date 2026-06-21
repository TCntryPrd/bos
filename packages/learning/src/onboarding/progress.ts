/**
 * Onboarding Progress Tracker — tracks % complete per platform, surfaces to UI.
 *
 * Each platform ingester reports item counts and status updates through this tracker.
 * The UI polls `getProgress()` for a live snapshot.
 */

import type { PlatformName } from './sprint.js';

// ── Types ───────────────────────────────────────────────────────────

export type PlatformStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface PlatformProgress {
  platform: PlatformName;
  status: PlatformStatus;
  /** Items processed so far. */
  itemsProcessed: number;
  /** Total items discovered (0 until scan completes). */
  itemsTotal: number;
  /** Percentage 0-100. */
  percentComplete: number;
  /** Human-readable status message. */
  message: string;
  /** Error message if failed. */
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface OnboardingProgress {
  /** Overall percentage across all platforms. */
  overallPercent: number;
  /** Per-platform breakdown. */
  platforms: PlatformProgress[];
  /** Human-readable summary. */
  summary: string;
}

export interface PlatformIngestResult {
  platform: PlatformName;
  itemsProcessed: number;
  /** Key patterns discovered during ingest. */
  patterns: IngestPattern[];
  /** Raw data summary for synthesizer. */
  metadata: Record<string, unknown>;
}

export interface IngestPattern {
  category: string;
  description: string;
  confidence: number;
  evidence: string[];
}

// ── Tracker ─────────────────────────────────────────────────────────

export class ProgressTracker {
  private platforms: Map<PlatformName, PlatformProgress>;

  constructor(platformNames: PlatformName[]) {
    this.platforms = new Map();
    for (const name of platformNames) {
      this.platforms.set(name, {
        platform: name,
        status: 'queued',
        itemsProcessed: 0,
        itemsTotal: 0,
        percentComplete: 0,
        message: 'Queued',
      });
    }
  }

  /** Mark a platform as actively running. */
  markRunning(platform: PlatformName): void {
    const entry = this.getEntry(platform);
    entry.status = 'running';
    entry.message = 'Starting ingest...';
    entry.startedAt = new Date();
  }

  /** Update progress during ingest. */
  updateProgress(
    platform: PlatformName,
    itemsProcessed: number,
    itemsTotal: number,
    message: string,
  ): void {
    const entry = this.getEntry(platform);
    entry.itemsProcessed = itemsProcessed;
    entry.itemsTotal = itemsTotal;
    entry.percentComplete = itemsTotal > 0
      ? Math.round((itemsProcessed / itemsTotal) * 100)
      : 0;
    entry.message = message;
  }

  /** Mark a platform as successfully completed. */
  markComplete(platform: PlatformName, result: PlatformIngestResult): void {
    const entry = this.getEntry(platform);
    entry.status = 'complete';
    entry.itemsProcessed = result.itemsProcessed;
    entry.itemsTotal = result.itemsProcessed;
    entry.percentComplete = 100;
    entry.message = `Done: ${result.itemsProcessed} items analyzed`;
    entry.completedAt = new Date();
  }

  /** Mark a platform as failed. */
  markFailed(platform: PlatformName, error: string): void {
    const entry = this.getEntry(platform);
    entry.status = 'failed';
    entry.error = error;
    entry.message = `Failed: ${error}`;
    entry.completedAt = new Date();
  }

  /** Get a snapshot of overall progress. */
  getProgress(): OnboardingProgress {
    const all = Array.from(this.platforms.values());
    const totalPlatforms = all.length;

    if (totalPlatforms === 0) {
      return { overallPercent: 0, platforms: [], summary: 'No platforms configured' };
    }

    const completed = all.filter((p) => p.status === 'complete').length;
    const failed = all.filter((p) => p.status === 'failed').length;
    const running = all.filter((p) => p.status === 'running');

    // Overall = average of per-platform percentages
    const overallPercent = Math.round(
      all.reduce((sum, p) => sum + p.percentComplete, 0) / totalPlatforms,
    );

    // Build summary string
    const parts: string[] = [];
    parts.push(`Learning your business... ${overallPercent}% complete`);

    for (const p of all) {
      const label = platformLabel(p.platform);
      switch (p.status) {
        case 'complete':
          parts.push(`  Done: ${label} - ${p.itemsProcessed} items analyzed`);
          break;
        case 'running':
          parts.push(`  Working: ${label} - ${p.message}`);
          break;
        case 'failed':
          parts.push(`  Failed: ${label} - ${p.error ?? 'Unknown error'}`);
          break;
        case 'queued':
          parts.push(`  Queued: ${label}`);
          break;
      }
    }

    return {
      overallPercent,
      platforms: all.map((p) => ({ ...p })),
      summary: parts.join('\n'),
    };
  }

  private getEntry(platform: PlatformName): PlatformProgress {
    const entry = this.platforms.get(platform);
    if (!entry) {
      throw new Error(`Unknown platform: ${platform}`);
    }
    return entry;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function platformLabel(name: PlatformName): string {
  const labels: Record<PlatformName, string> = {
    gmail: 'Email',
    calendar: 'Calendar',
    drive: 'Drive',
    tasks: 'Tasks',
    comms: 'Communications',
    financial: 'Financial',
    device: 'Device',
  };
  return labels[name];
}
