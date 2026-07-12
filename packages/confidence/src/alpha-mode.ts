/**
 * Alpha Mode Override — enforces Tier 2 minimum during the Alpha phase.
 *
 * When alpha mode is active, BOS never executes actions fully autonomously.
 * The highest tier available is 'propose' — every action goes to the user for
 * review before execution.
 *
 * This is a safety rail during early deployment when the system hasn't yet
 * accumulated enough history and preference data to be trusted fully.
 *
 * When the user explicitly exits alpha mode (via settings), this override is
 * lifted and the normal tier resolution applies.
 */

import type { ActionDecision, ConfidenceTier } from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const ALPHA_MODE_REASON =
  'Alpha mode is active — autonomous execution is disabled until beta graduation. ' +
  'All actions require human approval.';

// ── Override ─────────────────────────────────────────────────────────────────

/**
 * Apply alpha mode to a partially-constructed ActionDecision.
 *
 * If alpha mode is active AND the raw tier is 'autonomous', downgrade to
 * 'propose' and record the override details.
 *
 * The 'escalate' tier is never upgraded — low confidence still escalates.
 * Alpha mode only blocks the *autonomous* tier from being used.
 */
export function applyAlphaMode(
  decision: ActionDecision,
  alphaMode: boolean,
): ActionDecision {
  if (!alphaMode) return decision;

  if (decision.tier !== 'autonomous') {
    // Already propose or escalate — alpha mode has no additional effect
    return decision;
  }

  return {
    ...decision,
    tier: 'propose',
    alphaModeOverride: {
      rawTier: 'autonomous',
      rawScore: decision.score,
      reason: ALPHA_MODE_REASON,
    },
    reasoning: buildAlphaReasoning(decision.reasoning, decision.score),
  };
}

/**
 * Whether alpha mode would change the outcome for a given raw tier.
 * Useful for logging and telemetry.
 */
export function alphaModeWouldOverride(rawTier: ConfidenceTier, alphaMode: boolean): boolean {
  return alphaMode && rawTier === 'autonomous';
}

// ── Internal ─────────────────────────────────────────────────────────────────

function buildAlphaReasoning(originalReasoning: string, score: number): string {
  return (
    `[Alpha Mode] ${ALPHA_MODE_REASON}\n\n` +
    `Confidence score was ${score.toFixed(3)} (above autonomous threshold), but ` +
    `action has been queued for approval instead of auto-executing.\n\n` +
    `Original reasoning: ${originalReasoning}`
  );
}
