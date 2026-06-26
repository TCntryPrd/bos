/**
 * Entity Priority Factor — scores based on contact importance and frequency.
 *
 * Actions involving VIP or frequently-contacted entities are better understood
 * by BOS. Actions involving unknown entities introduce uncertainty.
 *
 * Weight: 0.25 — second-highest. Who you're dealing with matters a lot.
 *
 * Scoring model:
 *   - Unknown entity with no history: low base (0.3)
 *   - Known entity in top contacts: high base (0.85+)
 *   - VIP / flagged contact: signals caution, drops to propose tier
 *   - Mix of known + unknown: interpolated
 */

import type { ActionEntity, ActionProposal, FactorResult, ScoringFactor, UserContext } from '../types.js';

// ── Scoring helpers ──────────────────────────────────────────────────────────

function scoreEntity(entity: ActionEntity, context: UserContext): { score: number; signal: string } {
  if (!entity.isKnown) {
    return {
      score: 0.3,
      signal: `Unknown ${entity.type}: "${entity.label}" — no history with this entity`,
    };
  }

  // Check if this entity appears in the user's learning profile
  const profile = context.learningProfile;

  if (entity.type === 'contact') {
    const label = entity.label.toLowerCase();

    // Top contacts from communication profile — high familiarity
    const isTopContact = profile.communication.topContacts.some(
      (c) => c.toLowerCase().includes(label) || label.includes(c.toLowerCase()),
    );
    if (isTopContact) {
      return {
        score: 0.9,
        signal: `"${entity.label}" is in top contacts — high familiarity`,
      };
    }

    // Business profile — top customers
    const isTopCustomer = profile.business.topCustomers.some(
      (c) => c.toLowerCase().includes(label) || label.includes(c.toLowerCase()),
    );
    if (isTopCustomer) {
      return {
        score: 0.85,
        signal: `"${entity.label}" is a tracked top customer`,
      };
    }

    // Known but not in top contacts — moderate score
    return {
      score: 0.65,
      signal: `"${entity.label}" is a known contact but not frequently contacted`,
    };
  }

  // Calendar events, files, tasks — if known, moderate-high
  if (entity.type === 'calendar_event') {
    return {
      score: 0.7,
      signal: `Calendar event "${entity.label}" is a known event`,
    };
  }

  if (entity.type === 'file') {
    return {
      score: 0.7,
      signal: `File "${entity.label}" is a known file`,
    };
  }

  if (entity.type === 'task') {
    return {
      score: 0.72,
      signal: `Task "${entity.label}" is a known task`,
    };
  }

  return {
    score: 0.6,
    signal: `Entity "${entity.label}" (${entity.type}) is known`,
  };
}

// ── Factor Implementation ────────────────────────────────────────────────────

export class EntityPriorityFactor implements ScoringFactor {
  readonly name = 'entity_priority';
  readonly weight = 0.25;

  async score(proposal: ActionProposal, context: UserContext): Promise<FactorResult> {
    const { entities } = proposal;

    // No entities — neutral, nothing to flag
    if (!entities || entities.length === 0) {
      return {
        factor: this.name,
        score: 0.7,
        weight: this.weight,
        rationale: 'No entities referenced in this action',
        signals: [],
      };
    }

    const results = entities.map((e) => scoreEntity(e, context));
    const scores = results.map((r) => r.score);
    const signals = results.map((r) => r.signal);

    // Composite: weighted toward the lowest score (unknown entity drags down)
    // Use harmonic mean to punish mixed known/unknown sets more than arithmetic
    const harmonicMean =
      scores.length / scores.reduce((sum, s) => sum + 1 / Math.max(0.01, s), 0);

    // Also compute arithmetic mean for a softer fallback
    const arithmeticMean = scores.reduce((a, b) => a + b, 0) / scores.length;

    // Weight 60% toward harmonic (penalizes unknowns), 40% arithmetic
    const composite = 0.6 * harmonicMean + 0.4 * arithmeticMean;
    const finalScore = Math.max(0, Math.min(1, composite));

    const unknownCount = entities.filter((e) => !e.isKnown).length;
    const knownCount = entities.length - unknownCount;

    const rationale = unknownCount > 0
      ? `${knownCount} known, ${unknownCount} unknown entity/entities — unknown entities reduce confidence`
      : `All ${knownCount} entity/entities are known`;

    return {
      factor: this.name,
      score: Math.round(finalScore * 1000) / 1000,
      weight: this.weight,
      rationale,
      signals,
    };
  }
}
