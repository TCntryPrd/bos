/**
 * Profile Synthesizer — combines all ingested platform data into
 * a unified initial user profile for the learning engine.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngestResult, IngestPattern } from './progress.js';
import type { LearningProfile, CommunicationProfile, SchedulingProfile, WorkProfile, BusinessProfile } from '../profile.js';

// ── Types ───────────────────────────────────────────────────────────

export interface SynthesisConfig {
  /** Minimum confidence threshold for pattern inclusion. Default 0.5. */
  minConfidence?: number;
}

// ── Synthesizer ─────────────────────────────────────────────────────

export class ProfileSynthesizer {
  private minConfidence: number;

  constructor(config: SynthesisConfig = {}) {
    this.minConfidence = config.minConfidence ?? 0.5;
  }

  /**
   * Combine all platform ingest results into a unified learning profile.
   */
  async synthesize(
    ctx: TenantContext,
    results: PlatformIngestResult[],
  ): Promise<LearningProfile> {
    // Collect all patterns above confidence threshold
    const allPatterns = results
      .flatMap((r) => r.patterns)
      .filter((p) => p.confidence >= this.minConfidence);

    // Group patterns by category prefix
    const grouped = this.groupByCategory(allPatterns);

    const communication = this.synthesizeCommunication(grouped);
    const scheduling = this.synthesizeScheduling(grouped);
    const work = this.synthesizeWork(grouped);
    const business = this.synthesizeBusiness(grouped);

    const profile: LearningProfile = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      communication,
      scheduling,
      work,
      business,
      patterns: allPatterns,
      metadata: {
        platformsIngested: results.map((r) => r.platform),
        totalItemsProcessed: results.reduce((sum, r) => sum + r.itemsProcessed, 0),
        patternCount: allPatterns.length,
        synthesizedAt: new Date().toISOString(),
      },
    };

    return profile;
  }

  // ── Category synthesis ────────────────────────────────────────────

  private synthesizeCommunication(
    grouped: Map<string, IngestPattern[]>,
  ): CommunicationProfile {
    const contactPatterns = [
      ...(grouped.get('communication.contacts') ?? []),
    ];
    const timingPatterns = grouped.get('communication.timing') ?? [];
    const stylePatterns = [
      ...(grouped.get('communication.style') ?? []),
    ];
    const tonePatterns = grouped.get('communication.tone') ?? [];

    // Extract top contacts across email and comms
    const topContacts = contactPatterns
      .flatMap((p) => p.evidence)
      .slice(0, 20);

    // Extract peak hours
    const peakHours = timingPatterns
      .flatMap((p) => p.evidence)
      .map((e) => {
        const match = /Hour (\d+)/.exec(e);
        return match ? parseInt(match[1], 10) : -1;
      })
      .filter((h) => h >= 0)
      .slice(0, 5);

    return {
      topContacts,
      peakHours,
      avgMessageLength: this.extractNumber(stylePatterns, /(\d+) (?:characters|words)/),
      toneIndicators: tonePatterns.flatMap((p) => p.evidence).slice(0, 10),
      responseSpeed: this.categorizeResponseSpeed(grouped),
    };
  }

  private synthesizeScheduling(
    grouped: Map<string, IngestPattern[]>,
  ): SchedulingProfile {
    const timingPatterns = grouped.get('scheduling.timing') ?? [];
    const daysPatterns = grouped.get('scheduling.days') ?? [];
    const durationPatterns = grouped.get('scheduling.duration') ?? [];

    const peakMeetingHours = timingPatterns
      .flatMap((p) => p.evidence)
      .map((e) => {
        const match = /Hour (\d+)/.exec(e);
        return match ? parseInt(match[1], 10) : -1;
      })
      .filter((h) => h >= 0);

    const busyDays = daysPatterns
      .flatMap((p) => p.evidence)
      .map((e) => {
        const match = /^(\w+):/.exec(e);
        return match ? match[1] : '';
      })
      .filter(Boolean);

    return {
      peakMeetingHours,
      busyDays,
      avgMeetingDuration: this.extractNumber(durationPatterns, /(\d+) minutes/),
      protectedTimeBlocks: [], // Filled by explicit preferences later
      noGoTimes: [], // Filled by explicit preferences later
    };
  }

  private synthesizeWork(
    grouped: Map<string, IngestPattern[]>,
  ): WorkProfile {
    const completionPatterns = grouped.get('tasks.completion') ?? [];
    const velocityPatterns = grouped.get('tasks.velocity') ?? [];
    const filePatterns = [
      ...(grouped.get('files.structure') ?? []),
      ...(grouped.get('files.naming') ?? []),
    ];

    return {
      taskCompletionRate: this.extractNumber(completionPatterns, /(\d+)%/),
      avgTaskCompletionHours: this.extractNumber(velocityPatterns, /(\d+) (?:hours|days)/),
      fileOrganizationStyle: filePatterns.flatMap((p) => p.evidence).slice(0, 10),
      peakProductivityHours: [], // Refined by observer over time
    };
  }

  private synthesizeBusiness(
    grouped: Map<string, IngestPattern[]>,
  ): BusinessProfile {
    const revenuePatterns = grouped.get('financial.revenue') ?? [];
    const trendPatterns = grouped.get('financial.trend') ?? [];
    const customerPatterns = grouped.get('financial.customers') ?? [];

    return {
      revenueMix: revenuePatterns.flatMap((p) => p.evidence),
      monthlyTrend: trendPatterns.flatMap((p) => p.evidence),
      topCustomers: customerPatterns.flatMap((p) => p.evidence).slice(0, 10),
      riskIndicators: (grouped.get('financial.risk') ?? []).flatMap((p) => p.evidence),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private groupByCategory(patterns: IngestPattern[]): Map<string, IngestPattern[]> {
    const grouped = new Map<string, IngestPattern[]>();
    for (const pattern of patterns) {
      const existing = grouped.get(pattern.category) ?? [];
      existing.push(pattern);
      grouped.set(pattern.category, existing);
    }
    return grouped;
  }

  private extractNumber(patterns: IngestPattern[], regex: RegExp): number {
    for (const p of patterns) {
      const match = regex.exec(p.description);
      if (match) return parseInt(match[1], 10);
      for (const e of p.evidence) {
        const eMatch = regex.exec(e);
        if (eMatch) return parseInt(eMatch[1], 10);
      }
    }
    return 0;
  }

  private categorizeResponseSpeed(
    grouped: Map<string, IngestPattern[]>,
  ): 'fast' | 'normal' | 'slow' {
    const responsiveness = grouped.get('communication.responsiveness') ?? [];
    for (const p of responsiveness) {
      const match = /(\d+) minutes/.exec(p.description);
      if (match) {
        const minutes = parseInt(match[1], 10);
        if (minutes < 15) return 'fast';
        if (minutes < 60) return 'normal';
        return 'slow';
      }
    }
    return 'normal';
  }
}
