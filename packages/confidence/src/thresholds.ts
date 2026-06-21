/**
 * Threshold configuration for the Confidence Engine.
 *
 * Boundaries determine which tier a composite score maps to:
 *   score < escalateBelow           -> Tier 3 (escalate)
 *   escalateBelow <= score < autonomousAbove -> Tier 2 (propose)
 *   score >= autonomousAbove        -> Tier 1 (autonomous)
 *
 * Defaults: <0.4 escalate | 0.4–0.75 propose | >0.75 autonomous
 */

import type { ConfidenceTier } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ThresholdConfig {
  /**
   * Scores below this value are escalated to the user.
   * Default: 0.4
   */
  escalateBelow: number;

  /**
   * Scores at or above this value are executed autonomously.
   * Must be greater than escalateBelow.
   * Default: 0.75
   */
  autonomousAbove: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  escalateBelow: 0.4,
  autonomousAbove: 0.75,
};

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve a composite score to a confidence tier using the given thresholds.
 */
export function resolveToTier(score: number, config: ThresholdConfig = DEFAULT_THRESHOLDS): ConfidenceTier {
  if (score >= config.autonomousAbove) {
    return 'autonomous';
  }
  if (score >= config.escalateBelow) {
    return 'propose';
  }
  return 'escalate';
}

/**
 * Validate that a ThresholdConfig is internally consistent.
 * Throws if the configuration is invalid.
 */
export function validateThresholds(config: ThresholdConfig): void {
  if (config.escalateBelow < 0 || config.escalateBelow > 1) {
    throw new Error(
      `ThresholdConfig.escalateBelow must be between 0 and 1 (got ${config.escalateBelow})`,
    );
  }
  if (config.autonomousAbove < 0 || config.autonomousAbove > 1) {
    throw new Error(
      `ThresholdConfig.autonomousAbove must be between 0 and 1 (got ${config.autonomousAbove})`,
    );
  }
  if (config.escalateBelow >= config.autonomousAbove) {
    throw new Error(
      `ThresholdConfig.escalateBelow (${config.escalateBelow}) must be less than autonomousAbove (${config.autonomousAbove})`,
    );
  }
}

/**
 * Merge partial threshold overrides with the defaults.
 * Validates the result before returning.
 */
export function buildThresholds(overrides?: Partial<ThresholdConfig>): ThresholdConfig {
  const config: ThresholdConfig = {
    ...DEFAULT_THRESHOLDS,
    ...overrides,
  };
  validateThresholds(config);
  return config;
}
