/**
 * Historical Precedent Factor — scores based on past similar actions.
 *
 * If BOS has done this exact type of action before and the user approved it
 * (or let it auto-execute without objection), confidence rises. If the user
 * rejected or modified a similar action, confidence falls.
 *
 * Weight: 0.20 — equal to context friction. Precedent matters but shouldn't
 * override preferences or entity signals on its own.
 *
 * Scoring model:
 *   - No history:                        neutral (0.55) — not penalized, just uncertain
 *   - 3+ approvals, no rejections:       high (0.85–0.92)
 *   - Mixed approvals/modifications:     moderate (0.6–0.7)
 *   - Prior rejections:                  low (0.2–0.4)
 *   - Consistent auto-execute history:   high (0.88)
 */

import type { ActionDomain, ActionProposal, FactorResult, HistoricalAction, ScoringFactor, UserContext } from '../types.js';

// ── Signature matching ───────────────────────────────────────────────────────

/**
 * Build a compact signature for the current proposal to match against history.
 * Not cryptographic — just a normalized string for fuzzy matching.
 */
function buildProposalSignature(proposal: ActionProposal): string {
  const entityTypes = proposal.entities.map((e) => e.type).sort().join(',');
  const knownRatio = proposal.entities.length > 0
    ? proposal.entities.filter((e) => e.isKnown).length / proposal.entities.length
    : 1;
  const knownBucket = knownRatio > 0.8 ? 'all_known' : knownRatio > 0.4 ? 'mixed' : 'mostly_unknown';

  return `${proposal.domain}:${entityTypes}:${knownBucket}`;
}

/**
 * Compute similarity between the proposal signature and a historical action.
 * Returns 0.0–1.0.
 */
function computeSimilarity(proposalSig: string, historicalSig: string): number {
  if (proposalSig === historicalSig) return 1.0;

  const pParts = proposalSig.split(':');
  const hParts = historicalSig.split(':');

  // Domain match is the strongest signal
  if (pParts[0] !== hParts[0]) return 0;

  // Entity type match
  const entityMatch = pParts[1] === hParts[1] ? 0.4 : 0;
  // Known ratio bucket match
  const knownMatch = pParts[2] === hParts[2] ? 0.3 : 0;

  return 0.3 + entityMatch + knownMatch;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

interface PrecedentSummary {
  total: number;
  approved: number;
  rejected: number;
  modified: number;
  autoExecuted: number;
  avgSimilarity: number;
}

function summarizePrecedents(
  proposal: ActionProposal,
  history: HistoricalAction[],
  minSimilarity = 0.5,
): PrecedentSummary {
  const sig = buildProposalSignature(proposal);

  const relevant = history
    .filter((h) => h.domain === proposal.domain)
    .map((h) => ({ action: h, similarity: computeSimilarity(sig, h.signature) }))
    .filter((r) => r.similarity >= minSimilarity);

  if (relevant.length === 0) {
    return { total: 0, approved: 0, rejected: 0, modified: 0, autoExecuted: 0, avgSimilarity: 0 };
  }

  const avgSimilarity = relevant.reduce((s, r) => s + r.similarity, 0) / relevant.length;

  let approved = 0;
  let rejected = 0;
  let modified = 0;
  let autoExecuted = 0;

  for (const { action } of relevant) {
    switch (action.outcome) {
      case 'approved': approved++; break;
      case 'rejected': rejected++; break;
      case 'modified': modified++; break;
      case 'auto_executed': autoExecuted++; break;
    }
  }

  return { total: relevant.length, approved, rejected, modified, autoExecuted, avgSimilarity };
}

function computeScoreFromSummary(summary: PrecedentSummary): { score: number; rationale: string } {
  if (summary.total === 0) {
    return {
      score: 0.55,
      rationale: 'No historical precedent for this type of action',
    };
  }

  const positives = summary.approved + summary.autoExecuted;
  const negatives = summary.rejected;
  const neutral = summary.modified;
  const total = summary.total;

  // Rejection carries more weight than approval (asymmetric risk)
  const weightedPositive = positives / total;
  const weightedNegative = (negatives * 1.5) / total;
  const neutralDrag = (neutral * 0.3) / total;

  let score = 0.55 + (weightedPositive * 0.35) - (weightedNegative * 0.45) - neutralDrag;

  // Scale by average similarity — high-similarity matches carry more weight
  const similarityMultiplier = 0.7 + summary.avgSimilarity * 0.3;
  score = 0.55 + (score - 0.55) * similarityMultiplier;

  // Floor/ceiling
  score = Math.max(0.05, Math.min(0.95, score));

  const dominant = positives > negatives
    ? `${positives} approval/auto-execute precedent(s)`
    : `${negatives} rejection(s) in precedent`;

  const rationale = `${total} similar past action(s) found — ${dominant} (avg similarity: ${(summary.avgSimilarity * 100).toFixed(0)}%)`;

  return { score, rationale };
}

// ── Factor Implementation ────────────────────────────────────────────────────

export class HistoricalPrecedentFactor implements ScoringFactor {
  readonly name = 'historical_precedent';
  readonly weight = 0.20;

  async score(proposal: ActionProposal, context: UserContext): Promise<FactorResult> {
    const history = context.recentActions ?? [];

    if (history.length === 0) {
      return {
        factor: this.name,
        score: 0.55,
        weight: this.weight,
        rationale: 'No action history available yet — defaulting to neutral',
        signals: [],
      };
    }

    const summary = summarizePrecedents(proposal, history);
    const { score, rationale } = computeScoreFromSummary(summary);

    const signals: string[] = [];
    if (summary.total > 0) {
      signals.push(`Domain: ${proposal.domain}`);
      signals.push(`Matched ${summary.total} similar past action(s)`);
      if (summary.approved > 0) signals.push(`${summary.approved} approved`);
      if (summary.autoExecuted > 0) signals.push(`${summary.autoExecuted} auto-executed without issue`);
      if (summary.rejected > 0) signals.push(`${summary.rejected} previously rejected`);
      if (summary.modified > 0) signals.push(`${summary.modified} modified before approval`);
    }

    return {
      factor: this.name,
      score: Math.round(score * 1000) / 1000,
      weight: this.weight,
      rationale,
      signals,
    };
  }
}
