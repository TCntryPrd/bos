/**
 * Playbook matcher — match a failure signature to a known playbook.
 *
 * Each playbook's `failureSignature` is a regex pattern stored as a string.
 * Matching is done against the failure's error message and/or log excerpt.
 *
 * Matching priority:
 *   1. Most recently used (battle-tested in recent incidents)
 *   2. Highest success_count (most reliably fixes the issue)
 *   3. Most specific pattern (longer regex = more specific)
 */

import type { Playbook, ServiceName } from '@boss/core';
import type { PlaybookStore } from './store.js';

export interface MatchInput {
  /** The service that is failing. */
  service: ServiceName;
  /** Error message or short description of the failure. */
  errorMessage: string;
  /** Optional log excerpt for richer matching. */
  logExcerpt?: string;
}

export interface MatchResult {
  found: boolean;
  playbook?: Playbook;
  matchedOn?: 'errorMessage' | 'logExcerpt';
  score?: number;
}

export class PlaybookMatcher {
  private store: PlaybookStore;

  constructor(store: PlaybookStore) {
    this.store = store;
  }

  /**
   * Find the best matching playbook for a failure.
   * Returns the highest-scored match, or { found: false } if none.
   */
  async match(input: MatchInput): Promise<MatchResult> {
    const candidates = await this.store.list(input.service);

    if (candidates.length === 0) {
      return { found: false };
    }

    type ScoredMatch = {
      playbook: Playbook;
      score: number;
      matchedOn: 'errorMessage' | 'logExcerpt';
    };

    const scored: ScoredMatch[] = [];

    for (const playbook of candidates) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(playbook.failureSignature, 'i');
      } catch {
        // Skip playbooks with invalid regex — log but don't crash
        console.warn(
          `[PlaybookMatcher] Invalid regex in playbook ${playbook.id}: ${playbook.failureSignature}`,
        );
        continue;
      }

      const matchesError = pattern.test(input.errorMessage);
      const matchesLog = input.logExcerpt ? pattern.test(input.logExcerpt) : false;

      if (!matchesError && !matchesLog) continue;

      const score = computeScore(playbook, playbook.failureSignature.length, matchesError);

      scored.push({
        playbook,
        score,
        matchedOn: matchesError ? 'errorMessage' : 'logExcerpt',
      });
    }

    if (scored.length === 0) {
      return { found: false };
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    return {
      found: true,
      playbook: best.playbook,
      matchedOn: best.matchedOn,
      score: best.score,
    };
  }
}

/**
 * Score a playbook match.
 *
 * Weights:
 *   - successCount: higher is better (proven fix)
 *   - lastUsed recency: more recent = higher weight
 *   - patternLength: longer pattern = more specific = higher weight
 *   - errorMessage match: bonus over log-only match
 */
function computeScore(
  playbook: Playbook,
  patternLength: number,
  matchedError: boolean,
): number {
  const now = Date.now();
  const lastUsedMs = playbook.lastUsed instanceof Date
    ? playbook.lastUsed.getTime()
    : new Date(playbook.lastUsed).getTime();

  // Recency: 1.0 (used today) down to 0.0 (not used in 30+ days)
  const daysSinceUse = (now - lastUsedMs) / 86_400_000;
  const recencyScore = Math.max(0, 1 - daysSinceUse / 30);

  const successScore = Math.min(playbook.successCount / 10, 1.0); // cap at 10+ uses
  const specificityScore = Math.min(patternLength / 100, 1.0);    // cap at 100-char patterns
  const errorBonus = matchedError ? 0.2 : 0;

  return successScore * 0.5 + recencyScore * 0.3 + specificityScore * 0.2 + errorBonus;
}
