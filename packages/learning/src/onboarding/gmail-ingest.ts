/**
 * Gmail / Outlook Ingest — scans 6-12 months of sent mail,
 * extracts communication patterns, contact frequency, tone, and style.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngester, PlatformName } from './sprint.js';
import type { PlatformIngestResult, IngestPattern } from './progress.js';
import type { ProgressTracker } from './progress.js';

// ── Types ───────────────────────────────────────────────────────────

export interface GmailIngestConfig {
  /** How many months of sent mail to scan. Default 6. */
  lookbackMonths: number;
  /** Max emails to process per batch. Default 50. */
  batchSize?: number;
}

export interface EmailPattern {
  /** Most-contacted addresses ranked by frequency. */
  topContacts: Array<{ email: string; count: number; avgResponseTimeHours: number }>;
  /** Average email length in characters. */
  avgEmailLength: number;
  /** Typical response time distribution. */
  responseTimeDistribution: { fast: number; normal: number; slow: number; ignored: number };
  /** Active sending hours (0-23). */
  peakSendingHours: number[];
  /** Labels/folders in use. */
  organizationSystem: string[];
  /** Detected tone keywords. */
  toneIndicators: string[];
}

// ── Ingester ────────────────────────────────────────────────────────

export class GmailIngester implements PlatformIngester {
  readonly platform: PlatformName = 'gmail';
  private config: Required<GmailIngestConfig>;

  constructor(config: Partial<GmailIngestConfig> = {}) {
    this.config = {
      lookbackMonths: config.lookbackMonths ?? 6,
      batchSize: config.batchSize ?? 50,
    };
  }

  async ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult> {
    tracker.updateProgress('gmail', 0, 0, 'Discovering emails...');

    // Phase 1: Count total emails in lookback window
    const cutoffDate = this.getCutoffDate();
    const totalEmails = await this.countEmails(ctx, cutoffDate);
    tracker.updateProgress('gmail', 0, totalEmails, `Found ${totalEmails} emails to analyze`);

    // Phase 2: Process emails in batches
    const contactMap = new Map<string, { count: number; responseTimes: number[] }>();
    const sendingHours = new Array<number>(24).fill(0);
    const lengths: number[] = [];
    const toneWords = new Map<string, number>();
    let processed = 0;

    while (processed < totalEmails) {
      const batch = await this.fetchEmailBatch(ctx, cutoffDate, processed, this.config.batchSize);
      if (batch.length === 0) break;

      for (const email of batch) {
        // Track contacts
        for (const recipient of email.recipients) {
          const existing = contactMap.get(recipient) ?? { count: 0, responseTimes: [] };
          existing.count++;
          if (email.responseTimeHours !== undefined) {
            existing.responseTimes.push(email.responseTimeHours);
          }
          contactMap.set(recipient, existing);
        }

        // Track sending hours
        sendingHours[email.sentHour]++;

        // Track email length
        lengths.push(email.bodyLength);

        // Track tone indicators
        for (const word of email.toneWords) {
          toneWords.set(word, (toneWords.get(word) ?? 0) + 1);
        }
      }

      processed += batch.length;
      tracker.updateProgress('gmail', processed, totalEmails, `Analyzed ${processed} of ${totalEmails} emails`);
    }

    // Phase 3: Extract labels/folders
    const labels = await this.fetchLabels(ctx);

    // Phase 4: Build patterns
    const patterns = this.buildPatterns(contactMap, sendingHours, lengths, toneWords, labels);

    return {
      platform: 'gmail',
      itemsProcessed: processed,
      patterns,
      metadata: {
        lookbackMonths: this.config.lookbackMonths,
        cutoffDate: cutoffDate.toISOString(),
        topContactCount: contactMap.size,
        labelCount: labels.length,
      },
    };
  }

  // ── Internal: Connector calls (to be wired to @boss/connectors) ──

  /**
   * Count emails in the lookback window.
   * Placeholder — will call unified mail connector.
   */
  private async countEmails(_ctx: TenantContext, _since: Date): Promise<number> {
    // TODO: wire to @boss/connectors unified mail.count()
    return 0;
  }

  /**
   * Fetch a batch of email metadata.
   * Placeholder — will call unified mail connector.
   */
  private async fetchEmailBatch(
    _ctx: TenantContext,
    _since: Date,
    _offset: number,
    _limit: number,
  ): Promise<EmailBatchItem[]> {
    // TODO: wire to @boss/connectors unified mail.list()
    return [];
  }

  /**
   * Fetch labels/folders.
   * Placeholder — will call unified mail connector.
   */
  private async fetchLabels(_ctx: TenantContext): Promise<string[]> {
    // TODO: wire to @boss/connectors unified mail.labels()
    return [];
  }

  // ── Internal: Pattern building ────────────────────────────────────

  private getCutoffDate(): Date {
    const d = new Date();
    d.setMonth(d.getMonth() - this.config.lookbackMonths);
    return d;
  }

  private buildPatterns(
    contactMap: Map<string, { count: number; responseTimes: number[] }>,
    sendingHours: number[],
    lengths: number[],
    toneWords: Map<string, number>,
    labels: string[],
  ): IngestPattern[] {
    const patterns: IngestPattern[] = [];

    // Top contacts pattern
    const topContacts = Array.from(contactMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20);

    if (topContacts.length > 0) {
      patterns.push({
        category: 'communication.contacts',
        description: `Top ${topContacts.length} email contacts identified`,
        confidence: 0.9,
        evidence: topContacts.map(([email, data]) => `${email}: ${data.count} emails`),
      });
    }

    // Peak sending hours
    const peakHours = sendingHours
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .filter((h) => h.count > 0);

    if (peakHours.length > 0) {
      patterns.push({
        category: 'communication.timing',
        description: 'Email sending time patterns',
        confidence: 0.8,
        evidence: peakHours.map((h) => `Hour ${h.hour}: ${h.count} emails`),
      });
    }

    // Email length pattern
    if (lengths.length > 0) {
      const avg = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
      patterns.push({
        category: 'communication.style',
        description: `Average email length: ${avg} characters`,
        confidence: 0.85,
        evidence: [`Analyzed ${lengths.length} emails`],
      });
    }

    // Tone pattern
    const topTone = Array.from(toneWords.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topTone.length > 0) {
      patterns.push({
        category: 'communication.tone',
        description: 'Detected communication tone indicators',
        confidence: 0.7,
        evidence: topTone.map(([word, count]) => `"${word}": ${count} occurrences`),
      });
    }

    // Organization pattern
    if (labels.length > 0) {
      patterns.push({
        category: 'organization.email',
        description: `${labels.length} email labels/folders in use`,
        confidence: 0.95,
        evidence: labels.slice(0, 20),
      });
    }

    return patterns;
  }
}

// ── Internal Types ──────────────────────────────────────────────────

interface EmailBatchItem {
  id: string;
  recipients: string[];
  sentHour: number;
  bodyLength: number;
  responseTimeHours?: number;
  toneWords: string[];
}
