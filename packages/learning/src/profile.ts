/**
 * Unified User Profile — combines behavioral patterns, explicit preferences,
 * and business intelligence into a single queryable profile.
 *
 * This is what the brain middleware injects into every request so the brain
 * has full context about the user's patterns and preferences.
 */

import type { PreferenceCategory } from '@boss/core';
import type { IngestPattern } from './onboarding/progress.js';
import type { PlatformName } from './onboarding/sprint.js';
import type { BehavioralPattern } from './observer.js';
import type { Preference } from './preferences.js';

// ── Profile Types ───────────────────────────────────────────────────

export interface LearningProfile {
  tenantId: string;
  userId: string;
  /** Profile schema version for migration support. */
  version: number;
  createdAt: Date;
  updatedAt: Date;

  communication: CommunicationProfile;
  scheduling: SchedulingProfile;
  work: WorkProfile;
  business: BusinessProfile;

  /** All discovered patterns. */
  patterns: IngestPattern[];
  /** Metadata about the profile generation. */
  metadata: ProfileMetadata;
}

export interface CommunicationProfile {
  topContacts: string[];
  peakHours: number[];
  avgMessageLength: number;
  toneIndicators: string[];
  responseSpeed: 'fast' | 'normal' | 'slow';
}

export interface SchedulingProfile {
  peakMeetingHours: number[];
  busyDays: string[];
  avgMeetingDuration: number;
  protectedTimeBlocks: TimeBlock[];
  noGoTimes: TimeBlock[];
}

export interface TimeBlock {
  label: string;
  dayOfWeek?: number;
  startHour: number;
  endHour: number;
}

export interface WorkProfile {
  taskCompletionRate: number;
  avgTaskCompletionHours: number;
  fileOrganizationStyle: string[];
  peakProductivityHours: number[];
}

export interface BusinessProfile {
  revenueMix: string[];
  monthlyTrend: string[];
  topCustomers: string[];
  riskIndicators: string[];
}

export interface ProfileMetadata {
  platformsIngested: PlatformName[];
  totalItemsProcessed: number;
  patternCount: number;
  synthesizedAt: string;
}

// ── Profile Manager ─────────────────────────────────────────────────

export interface ProfileSnapshot {
  profile: LearningProfile;
  preferences: Preference[];
  behavioralPatterns: BehavioralPattern[];
  generatedAt: Date;
}

export class ProfileManager {
  private profiles: Map<string, LearningProfile> = new Map();

  /**
   * Store or update a profile.
   */
  async save(profile: LearningProfile): Promise<void> {
    const key = this.makeKey(profile.tenantId, profile.userId);
    profile.updatedAt = new Date();
    this.profiles.set(key, profile);
    await this.persist(profile);
  }

  /**
   * Load a profile.
   */
  async load(tenantId: string, userId: string): Promise<LearningProfile | undefined> {
    const key = this.makeKey(tenantId, userId);
    let profile = this.profiles.get(key);

    if (!profile) {
      profile = await this.loadFromDb(tenantId, userId);
      if (profile) {
        this.profiles.set(key, profile);
      }
    }

    return profile;
  }

  /**
   * Generate a full snapshot for brain context injection.
   * Combines profile + active preferences + behavioral patterns.
   */
  async getSnapshot(
    tenantId: string,
    userId: string,
    preferences: Preference[],
    behavioralPatterns: BehavioralPattern[],
  ): Promise<ProfileSnapshot | undefined> {
    const profile = await this.load(tenantId, userId);
    if (!profile) return undefined;

    return {
      profile,
      preferences,
      behavioralPatterns,
      generatedAt: new Date(),
    };
  }

  /**
   * Apply preference corrections to the profile.
   * Explicit preferences override pattern-derived values.
   */
  async applyPreferences(
    tenantId: string,
    userId: string,
    preferences: Preference[],
  ): Promise<void> {
    const profile = await this.load(tenantId, userId);
    if (!profile) return;

    for (const pref of preferences) {
      if (!pref.active) continue;
      this.applyPreferenceToProfile(profile, pref);
    }

    profile.updatedAt = new Date();
    await this.save(profile);
  }

  /**
   * Provide a human-readable summary of what BOS knows.
   * Supports the "what do you know about me?" query.
   */
  async getSummary(tenantId: string, userId: string): Promise<string> {
    const profile = await this.load(tenantId, userId);
    if (!profile) return 'No profile data available yet.';

    const lines: string[] = [];
    lines.push(`Profile for user ${userId} (version ${profile.version})`);
    lines.push(`Last updated: ${profile.updatedAt.toISOString()}`);
    lines.push('');

    lines.push('Communication:');
    lines.push(`  Response speed: ${profile.communication.responseSpeed}`);
    lines.push(`  Peak hours: ${profile.communication.peakHours.join(', ') || 'Unknown'}`);
    lines.push(`  Top contacts: ${profile.communication.topContacts.length} tracked`);
    lines.push('');

    lines.push('Scheduling:');
    lines.push(`  Busy days: ${profile.scheduling.busyDays.join(', ') || 'Unknown'}`);
    lines.push(`  Avg meeting: ${profile.scheduling.avgMeetingDuration} min`);
    lines.push(`  Protected blocks: ${profile.scheduling.protectedTimeBlocks.length}`);
    lines.push('');

    lines.push('Work:');
    lines.push(`  Task completion rate: ${profile.work.taskCompletionRate}%`);
    lines.push(`  File org patterns: ${profile.work.fileOrganizationStyle.length} detected`);
    lines.push('');

    lines.push('Business:');
    lines.push(`  Top customers: ${profile.business.topCustomers.length} tracked`);
    lines.push(`  Risk indicators: ${profile.business.riskIndicators.length}`);
    lines.push('');

    lines.push(`Total patterns: ${profile.patterns.length}`);
    lines.push(`Platforms ingested: ${profile.metadata.platformsIngested.join(', ')}`);

    return lines.join('\n');
  }

  /**
   * Delete all profile data for a user (privacy support).
   */
  async delete(tenantId: string, userId: string): Promise<void> {
    const key = this.makeKey(tenantId, userId);
    this.profiles.delete(key);
    await this.deleteFromDb(tenantId, userId);
  }

  // ── Internal ──────────────────────────────────────────────────────

  private makeKey(tenantId: string, userId: string): string {
    return `${tenantId}:${userId}`;
  }

  private applyPreferenceToProfile(profile: LearningProfile, pref: Preference): void {
    switch (pref.category) {
      case 'scheduling': {
        if (pref.key === 'no_meetings_before') {
          const hour = parseInt(pref.value, 10);
          if (!isNaN(hour)) {
            profile.scheduling.noGoTimes.push({
              label: `No meetings before ${hour}`,
              startHour: 0,
              endHour: hour,
            });
          }
        }
        break;
      }
      case 'communication': {
        if (pref.key === 'tone') {
          profile.communication.toneIndicators = [pref.value];
        }
        break;
      }
      // Other categories handled as patterns grow
      default:
        break;
    }
  }

  private async persist(_profile: LearningProfile): Promise<void> {
    // TODO: wire to Postgres data layer
  }

  private async loadFromDb(
    _tenantId: string,
    _userId: string,
  ): Promise<LearningProfile | undefined> {
    // TODO: wire to Postgres data layer
    return undefined;
  }

  private async deleteFromDb(_tenantId: string, _userId: string): Promise<void> {
    // TODO: wire to Postgres data layer
  }
}
