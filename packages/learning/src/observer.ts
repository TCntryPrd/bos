/**
 * Behavioral Observer — passive pattern extraction from all user interactions.
 *
 * Observes actions without requiring explicit input. Builds behavioral
 * embeddings and pattern records over time.
 */

import type { TenantContext } from '@boss/core';
import type { IngestPattern } from './onboarding/progress.js';

// ── Types ───────────────────────────────────────────────────────────

export type ObservationCategory =
  | 'communication'
  | 'scheduling'
  | 'task_management'
  | 'file_management'
  | 'delegation'
  | 'productivity';

export interface Observation {
  id: string;
  tenantId: string;
  userId: string;
  category: ObservationCategory;
  action: string;
  context: Record<string, unknown>;
  timestamp: Date;
}

export interface BehavioralPattern {
  id: string;
  tenantId: string;
  userId: string;
  category: ObservationCategory;
  description: string;
  confidence: number;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  evidence: string[];
}

export interface ObserverConfig {
  /** Minimum observations before surfacing a pattern. Default 5. */
  minOccurrences?: number;
  /** Minimum confidence to surface a pattern. Default 0.6. */
  minConfidence?: number;
  /** How many observations to keep in memory before flushing. Default 100. */
  bufferSize?: number;
}

// ── Observer ────────────────────────────────────────────────────────

export class BehavioralObserver {
  private config: Required<ObserverConfig>;
  private buffer: Observation[] = [];
  private patterns: Map<string, BehavioralPattern> = new Map();

  constructor(config: ObserverConfig = {}) {
    this.config = {
      minOccurrences: config.minOccurrences ?? 5,
      minConfidence: config.minConfidence ?? 0.6,
      bufferSize: config.bufferSize ?? 100,
    };
  }

  /**
   * Record an observation. When the buffer is full, patterns are extracted.
   */
  async observe(observation: Observation): Promise<void> {
    this.buffer.push(observation);

    if (this.buffer.length >= this.config.bufferSize) {
      await this.flush();
    }
  }

  /**
   * Process buffered observations and update patterns.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const observations = [...this.buffer];
    this.buffer = [];

    // Group by category + action signature
    const groups = new Map<string, Observation[]>();
    for (const obs of observations) {
      const key = `${obs.category}:${obs.action}`;
      const group = groups.get(key) ?? [];
      group.push(obs);
      groups.set(key, group);
    }

    // Update patterns
    for (const [key, group] of groups) {
      const existing = this.patterns.get(key);
      if (existing) {
        existing.occurrences += group.length;
        existing.lastSeen = group[group.length - 1].timestamp;
        existing.confidence = this.calculateConfidence(existing.occurrences);
        existing.evidence = this.mergeEvidence(existing.evidence, group);
      } else {
        const first = group[0];
        this.patterns.set(key, {
          id: `bp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          tenantId: first.tenantId,
          userId: first.userId,
          category: first.category,
          description: `Repeated: ${first.action}`,
          confidence: this.calculateConfidence(group.length),
          occurrences: group.length,
          firstSeen: first.timestamp,
          lastSeen: group[group.length - 1].timestamp,
          evidence: group.slice(0, 5).map((o) => JSON.stringify(o.context)),
        });
      }
    }

    // Persist patterns that meet threshold
    await this.persistPatterns();
  }

  /**
   * Get all patterns that meet minimum thresholds.
   */
  getActivePatterns(): BehavioralPattern[] {
    return Array.from(this.patterns.values()).filter(
      (p) =>
        p.occurrences >= this.config.minOccurrences &&
        p.confidence >= this.config.minConfidence,
    );
  }

  /**
   * Convert active patterns to IngestPattern format for profile synthesis.
   */
  toIngestPatterns(): IngestPattern[] {
    return this.getActivePatterns().map((p) => ({
      category: `behavioral.${p.category}`,
      description: p.description,
      confidence: p.confidence,
      evidence: p.evidence,
    }));
  }

  /**
   * Get observation count pending in buffer.
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private calculateConfidence(occurrences: number): number {
    // Confidence grows logarithmically, capped at 0.95
    return Math.min(0.95, 0.3 + Math.log2(occurrences) * 0.1);
  }

  private mergeEvidence(existing: string[], newObs: Observation[]): string[] {
    const combined = [
      ...existing,
      ...newObs.slice(0, 3).map((o) => JSON.stringify(o.context)),
    ];
    // Keep most recent 10 pieces of evidence
    return combined.slice(-10);
  }

  /**
   * Persist patterns to Postgres.
   * Placeholder — will be wired to data layer.
   */
  private async persistPatterns(): Promise<void> {
    // TODO: wire to Postgres data layer
    // INSERT/UPSERT patterns into learning.behavioral_patterns table
  }
}
