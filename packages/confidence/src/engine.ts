/**
 * ConfidenceEngine — the main entry point for the Confidence Threshold Engine.
 *
 * Orchestrates the full evaluation pipeline:
 *   1. Runs the ConfidenceScorer across all registered factors
 *   2. Applies threshold boundaries to resolve a tier
 *   3. Applies alpha mode override if active
 *   4. Assembles and returns the final ActionDecision with full reasoning
 *
 * Usage:
 *
 *   const engine = new ConfidenceEngine();
 *   const decision = await engine.evaluate(actionProposal, userContext);
 *
 *   if (decision.tier === 'autonomous') executeAction(action);
 *   else if (decision.tier === 'propose') queueForApproval(action, decision.reasoning);
 *   else escalateToHuman(action, decision.reasoning);
 */

import { ConfidenceScorer } from './scorer.js';
import { buildThresholds, resolveToTier } from './thresholds.js';
import { applyAlphaMode } from './alpha-mode.js';
import { PreferencesFactor } from './factors/preferences.js';
import { EntityPriorityFactor } from './factors/entity-priority.js';
import { ContextFrictionFactor } from './factors/context-friction.js';
import { HistoricalPrecedentFactor } from './factors/historical-precedent.js';
import type { ActionDecision, ActionProposal, ScoringFactor, UserContext } from './types.js';
import type { ThresholdConfig } from './thresholds.js';

// ── Config ───────────────────────────────────────────────────────────────────

export interface EngineConfig {
  /**
   * Threshold overrides. Defaults to: escalateBelow=0.4, autonomousAbove=0.75
   */
  thresholds?: Partial<ThresholdConfig>;

  /**
   * Override the default factor set with a custom list.
   * Useful for testing or domain-specific tuning.
   */
  factors?: ScoringFactor[];
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class ConfidenceEngine {
  private readonly scorer: ConfidenceScorer;
  private readonly thresholds: ThresholdConfig;

  constructor(config: EngineConfig = {}) {
    const factors = config.factors ?? buildDefaultFactors();
    this.scorer = new ConfidenceScorer(factors);
    this.thresholds = buildThresholds(config.thresholds);
  }

  /**
   * Evaluate an action proposal and return a fully-resolved ActionDecision.
   *
   * The decision includes:
   * - tier: 'autonomous' | 'propose' | 'escalate'
   * - score: 0.0–1.0 composite confidence
   * - factors: per-factor breakdown for full auditability
   * - reasoning: human-readable explanation
   * - alphaModeOverride: set if alpha mode changed the tier
   */
  async evaluate(proposal: ActionProposal, context: UserContext): Promise<ActionDecision> {
    // Step 1: Score across all factors
    const { composite, factors } = await this.scorer.score(proposal, context);

    // Step 2: Resolve to tier via thresholds
    const rawTier = resolveToTier(composite, this.thresholds);

    // Step 3: Assemble initial decision
    const reasoning = buildReasoning(proposal, composite, rawTier, factors);
    const rawDecision: ActionDecision = {
      proposalId: proposal.id,
      tier: rawTier,
      score: composite,
      factors,
      reasoning,
      decidedAt: new Date().toISOString(),
    };

    // Step 4: Apply alpha mode override
    const finalDecision = applyAlphaMode(rawDecision, context.alphaMode);

    return finalDecision;
  }
}

// ── Default factor set ───────────────────────────────────────────────────────

/**
 * Build the standard four-factor set with their default weights:
 *   preferences         0.35  — explicit user direction
 *   entity_priority     0.25  — contact importance and familiarity
 *   context_friction    0.20  — conflicts with current state
 *   historical_precedent 0.20 — past similar action outcomes
 */
function buildDefaultFactors(): ScoringFactor[] {
  return [
    new PreferencesFactor(),
    new EntityPriorityFactor(),
    new ContextFrictionFactor(),
    new HistoricalPrecedentFactor(),
  ];
}

// ── Reasoning builder ────────────────────────────────────────────────────────

const TIER_LABELS: Record<string, string> = {
  autonomous: 'Tier 1 (Autonomous)',
  propose:    'Tier 2 (Draft & Propose)',
  escalate:   'Tier 3 (Escalate)',
};

const TIER_DESCRIPTIONS: Record<string, string> = {
  autonomous: 'Confidence is high — action will execute automatically and be logged.',
  propose:    'Confidence is moderate — a draft has been generated and queued for your approval.',
  escalate:   'Confidence is low or a conflict was detected — this requires your direct input.',
};

function buildReasoning(
  proposal: ActionProposal,
  composite: number,
  tier: string,
  factors: ActionDecision['factors'],
): string {
  const lines: string[] = [];

  lines.push(`Action: "${proposal.intent}"`);
  lines.push(`Score: ${composite.toFixed(3)} → ${TIER_LABELS[tier] ?? tier}`);
  lines.push(TIER_DESCRIPTIONS[tier] ?? '');
  lines.push('');
  lines.push('Factor breakdown:');

  for (const f of factors) {
    const contribution = (f.score * f.weight).toFixed(3);
    lines.push(`  ${f.factor} (weight ${f.weight.toFixed(2)}): ${f.score.toFixed(3)} → ${f.rationale}`);
    if (f.signals && f.signals.length > 0) {
      for (const signal of f.signals) {
        lines.push(`    - ${signal}`);
      }
    }
  }

  return lines.join('\n');
}
