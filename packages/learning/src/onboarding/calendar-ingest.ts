/**
 * Calendar Ingest — scans 12 months of events, maps recurring meetings,
 * time-block patterns, attendee frequency, and scheduling preferences.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngester, PlatformName } from './sprint.js';
import type { PlatformIngestResult, IngestPattern, ProgressTracker } from './progress.js';

// ── Types ───────────────────────────────────────────────────────────

export interface CalendarIngestConfig {
  /** Months of history to scan. Default 12. */
  lookbackMonths: number;
  /** Batch size for event fetching. Default 100. */
  batchSize?: number;
}

export interface CalendarEventItem {
  id: string;
  title: string;
  startHour: number;
  dayOfWeek: number;
  durationMinutes: number;
  attendees: string[];
  isRecurring: boolean;
  wasCancelled: boolean;
  wasRescheduled: boolean;
  location?: string;
}

// ── Ingester ────────────────────────────────────────────────────────

export class CalendarIngester implements PlatformIngester {
  readonly platform: PlatformName = 'calendar';
  private config: Required<CalendarIngestConfig>;

  constructor(config: Partial<CalendarIngestConfig> = {}) {
    this.config = {
      lookbackMonths: config.lookbackMonths ?? 12,
      batchSize: config.batchSize ?? 100,
    };
  }

  async ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult> {
    tracker.updateProgress('calendar', 0, 0, 'Scanning calendar history...');

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - this.config.lookbackMonths);

    const totalEvents = await this.countEvents(ctx, cutoff);
    tracker.updateProgress('calendar', 0, totalEvents, `Found ${totalEvents} events to analyze`);

    // Accumulators
    const hourDistribution = new Array<number>(24).fill(0);
    const dayDistribution = new Array<number>(7).fill(0);
    const attendeeMap = new Map<string, number>();
    const durations: number[] = [];
    let recurringCount = 0;
    let cancelledCount = 0;
    let rescheduledCount = 0;
    let processed = 0;

    while (processed < totalEvents) {
      const batch = await this.fetchEventBatch(ctx, cutoff, processed, this.config.batchSize);
      if (batch.length === 0) break;

      for (const event of batch) {
        hourDistribution[event.startHour]++;
        dayDistribution[event.dayOfWeek]++;
        durations.push(event.durationMinutes);

        if (event.isRecurring) recurringCount++;
        if (event.wasCancelled) cancelledCount++;
        if (event.wasRescheduled) rescheduledCount++;

        for (const attendee of event.attendees) {
          attendeeMap.set(attendee, (attendeeMap.get(attendee) ?? 0) + 1);
        }
      }

      processed += batch.length;
      tracker.updateProgress('calendar', processed, totalEvents, `Mapped ${processed} of ${totalEvents} events`);
    }

    const patterns = this.buildPatterns(
      hourDistribution,
      dayDistribution,
      attendeeMap,
      durations,
      recurringCount,
      cancelledCount,
      rescheduledCount,
      processed,
    );

    return {
      platform: 'calendar',
      itemsProcessed: processed,
      patterns,
      metadata: {
        lookbackMonths: this.config.lookbackMonths,
        totalEvents: processed,
        recurringCount,
        cancelledCount,
        rescheduledCount,
        uniqueAttendees: attendeeMap.size,
      },
    };
  }

  // ── Connector stubs ───────────────────────────────────────────────

  private async countEvents(_ctx: TenantContext, _since: Date): Promise<number> {
    // TODO: wire to @boss/connectors unified calendar.count()
    return 0;
  }

  private async fetchEventBatch(
    _ctx: TenantContext,
    _since: Date,
    _offset: number,
    _limit: number,
  ): Promise<CalendarEventItem[]> {
    // TODO: wire to @boss/connectors unified calendar.list()
    return [];
  }

  // ── Pattern building ──────────────────────────────────────────────

  private buildPatterns(
    hourDist: number[],
    dayDist: number[],
    attendeeMap: Map<string, number>,
    durations: number[],
    recurringCount: number,
    cancelledCount: number,
    rescheduledCount: number,
    totalEvents: number,
  ): IngestPattern[] {
    const patterns: IngestPattern[] = [];

    // Peak meeting hours
    const peakHours = hourDist
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .filter((h) => h.count > 0);

    if (peakHours.length > 0) {
      patterns.push({
        category: 'scheduling.timing',
        description: 'Peak meeting hours',
        confidence: 0.85,
        evidence: peakHours.map((h) => `Hour ${h.hour}: ${h.count} events`),
      });
    }

    // Busy days
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const busyDays = dayDist
      .map((count, day) => ({ day: dayNames[day], count }))
      .sort((a, b) => b.count - a.count)
      .filter((d) => d.count > 0);

    if (busyDays.length > 0) {
      patterns.push({
        category: 'scheduling.days',
        description: 'Meeting day distribution',
        confidence: 0.85,
        evidence: busyDays.map((d) => `${d.day}: ${d.count} events`),
      });
    }

    // Top attendees
    const topAttendees = Array.from(attendeeMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    if (topAttendees.length > 0) {
      patterns.push({
        category: 'scheduling.contacts',
        description: `Top ${topAttendees.length} meeting contacts`,
        confidence: 0.9,
        evidence: topAttendees.map(([email, count]) => `${email}: ${count} meetings`),
      });
    }

    // Duration patterns
    if (durations.length > 0) {
      const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      patterns.push({
        category: 'scheduling.duration',
        description: `Average meeting duration: ${avg} minutes`,
        confidence: 0.8,
        evidence: [`Based on ${durations.length} events`],
      });
    }

    // Cancellation/reschedule rate
    if (totalEvents > 0) {
      const cancelRate = Math.round((cancelledCount / totalEvents) * 100);
      const rescheduleRate = Math.round((rescheduledCount / totalEvents) * 100);
      patterns.push({
        category: 'scheduling.behavior',
        description: 'Meeting reliability patterns',
        confidence: 0.75,
        evidence: [
          `${recurringCount} recurring events (${Math.round((recurringCount / totalEvents) * 100)}%)`,
          `${cancelRate}% cancellation rate`,
          `${rescheduleRate}% reschedule rate`,
        ],
      });
    }

    return patterns;
  }
}
