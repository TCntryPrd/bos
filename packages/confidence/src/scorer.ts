/**
 * ConfidenceScorer — computes a single composite confidence score from
 * multiple weighted factors.
 *
 * The scorer is stateless: it takes a proposal + context, runs all factors in
 * parallel, and returns a normalized composite. It does not apply thresholds
 * or alpha-mode logic — those live in the engine.
 */

import type { ActionProposal, FactorResult, ScoringFactor, UserContext } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScorerResult {
  /** Composite weighted score — 0.0 to 1.0. */
  composite: number;
  /** Per-factor detail for audit/reasoning. */
  factors: FactorResult[];
}

// ── Scorer ───────────────────────────────────────────────────────────────────

export class ConfidenceScorer {
  private readonly factors: ScoringFactor[];

  constructor(factors: ScoringFactor[]) {
    if (factors.length === 0) {
      throw new Error('ConfidenceScorer requires at least one scoring factor');
    }
    this.factors = factors;
  }

  /**
   * Score a proposal against all registered factors.
   *
   * Runs all factors concurrently. If an individual factor throws, it is
   * caught and replaced with a neutral 0.5 score so one bad factor cannot
   * crash the entire scoring run.
   *
   * Returns the weighted composite and the full factor breakdown.
   */
  async score(proposal: ActionProposal, context: UserContext): Promise<ScorerResult> {
    // Run all factors in parallel
    const factorResults = await Promise.all(
      this.factors.map((factor) => this.runFactor(factor, proposal, context)),
    );

    const composite = this.computeWeightedAverage(factorResults);

    return { composite, factors: factorResults };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Run a single factor with error isolation.
   * A factor that throws produces a neutral result rather than failing the run.
   */
  private async runFactor(
    factor: ScoringFactor,
    proposal: ActionProposal,
    context: UserContext,
  ): Promise<FactorResult> {
    try {
      return await factor.score(proposal, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        factor: factor.name,
        score: 0.5,
        weight: factor.weight,
        rationale: `Factor evaluation failed — defaulting to neutral (error: ${message})`,
        signals: [],
      };
    }
  }

  /**
   * Compute the weighted average of all factor scores.
   * Weights are normalized so they don't need to sum to 1.0 externally.
   */
  private computeWeightedAverage(results: FactorResult[]): number {
    const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);

    if (totalWeight === 0) return 0.5; // Degenerate case — all weights zero

    const weightedSum = results.reduce((sum, r) => sum + r.score * r.weight, 0);
    const raw = weightedSum / totalWeight;

    // Clamp and round to 3 decimal places
    return Math.round(Math.max(0, Math.min(1, raw)) * 1000) / 1000;
  }
}
