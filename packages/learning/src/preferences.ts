/**
 * Preference Store — explicit user preferences that override behavioral patterns.
 *
 * When a user says "never do X" or "always do Y", those corrections are
 * stored here with higher weight than observed behavior.
 */

import type { PreferenceCategory, PreferenceSource } from '@boss/core';

// ── Types ───────────────────────────────────────────────────────────

export interface Preference {
  id: string;
  userId: string;
  tenantId: string;
  category: PreferenceCategory;
  key: string;
  value: string;
  source: PreferenceSource;
  /** 0.0 - 1.0. Explicit preferences start at 1.0. */
  confidence: number;
  /** Whether this preference is currently active. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PreferenceQuery {
  userId: string;
  tenantId: string;
  category?: PreferenceCategory;
  source?: PreferenceSource;
  activeOnly?: boolean;
}

export interface PreferenceUpdate {
  key: string;
  value: string;
  category: PreferenceCategory;
  source: PreferenceSource;
}

// ── Store ───────────────────────────────────────────────────────────

export class PreferenceStore {
  private preferences: Map<string, Preference> = new Map();

  /**
   * Set or update a preference. Explicit sources always override behavioral.
   */
  async set(
    userId: string,
    tenantId: string,
    update: PreferenceUpdate,
  ): Promise<Preference> {
    const existingKey = this.makeKey(tenantId, userId, update.category, update.key);
    const existing = this.preferences.get(existingKey);

    // Explicit preferences always override
    if (existing && existing.source === 'explicit' && update.source !== 'explicit') {
      return existing; // Don't downgrade explicit to behavioral
    }

    const confidence = update.source === 'explicit' ? 1.0
      : update.source === 'onboarding' ? 0.8
      : 0.6;

    const preference: Preference = {
      id: existing?.id ?? `pref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      tenantId,
      category: update.category,
      key: update.key,
      value: update.value,
      source: update.source,
      confidence,
      active: true,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };

    this.preferences.set(existingKey, preference);

    // Persist to database
    await this.persist(preference);

    return preference;
  }

  /**
   * Get a specific preference value.
   */
  async get(
    userId: string,
    tenantId: string,
    category: PreferenceCategory,
    key: string,
  ): Promise<Preference | undefined> {
    const lookupKey = this.makeKey(tenantId, userId, category, key);
    return this.preferences.get(lookupKey);
  }

  /**
   * Query preferences with filters.
   */
  async query(query: PreferenceQuery): Promise<Preference[]> {
    let results = Array.from(this.preferences.values()).filter(
      (p) => p.userId === query.userId && p.tenantId === query.tenantId,
    );

    if (query.category) {
      results = results.filter((p) => p.category === query.category);
    }
    if (query.source) {
      results = results.filter((p) => p.source === query.source);
    }
    if (query.activeOnly !== false) {
      results = results.filter((p) => p.active);
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Deactivate a preference (user deletes it).
   */
  async deactivate(
    userId: string,
    tenantId: string,
    category: PreferenceCategory,
    key: string,
  ): Promise<boolean> {
    const lookupKey = this.makeKey(tenantId, userId, category, key);
    const pref = this.preferences.get(lookupKey);
    if (!pref) return false;

    pref.active = false;
    pref.updatedAt = new Date();
    await this.persist(pref);
    return true;
  }

  /**
   * Get all preferences for profile building.
   * Returns only active preferences sorted by confidence descending.
   */
  async getForProfile(userId: string, tenantId: string): Promise<Preference[]> {
    return this.query({ userId, tenantId, activeOnly: true });
  }

  /**
   * Bulk import preferences from onboarding.
   */
  async importFromOnboarding(
    userId: string,
    tenantId: string,
    prefs: Array<{ category: PreferenceCategory; key: string; value: string }>,
  ): Promise<number> {
    let imported = 0;
    for (const p of prefs) {
      await this.set(userId, tenantId, {
        category: p.category,
        key: p.key,
        value: p.value,
        source: 'onboarding',
      });
      imported++;
    }
    return imported;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private makeKey(
    tenantId: string,
    userId: string,
    category: PreferenceCategory,
    key: string,
  ): string {
    return `${tenantId}:${userId}:${category}:${key}`;
  }

  /**
   * Persist preference to Postgres.
   * Placeholder — will be wired to data layer.
   */
  private async persist(_preference: Preference): Promise<void> {
    // TODO: wire to Postgres data layer
    // UPSERT into learning.preferences table
  }
}
