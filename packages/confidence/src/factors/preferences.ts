/**
 * Preferences Factor — scores based on explicit user preferences.
 *
 * Explicit preferences carry the highest weight in the confidence model.
 * If a user has said "never do X" and this action matches X, the score drops
 * hard. If a preference directly supports the action, the score rises.
 *
 * Weight: 0.35 — highest of all factors, reflecting the primacy of explicit
 * user direction over all other signals.
 */

import type { ActionDomain, ActionProposal, FactorResult, ScoringFactor, UserContext } from '../types.js';
import type { Preference } from '@boss/learning';

// ── Preference matching ──────────────────────────────────────────────────────

/**
 * Check whether a preference key/value pair is relevant to the proposed action.
 * Returns a signal strength: 1.0 = strong match, 0 = not relevant.
 */
function matchPreferenceToProposal(
  pref: Preference,
  proposal: ActionProposal,
): { relevant: boolean; supports: boolean; strength: number; description: string } {
  const noOp = { relevant: false, supports: false, strength: 0, description: '' };

  // Only consider active preferences
  if (!pref.active) return noOp;

  // Domain alignment check
  const domainAligned = isDomainAligned(pref.category as ActionDomain, proposal.domain);
  if (!domainAligned) return noOp;

  // Pattern matching on known preference keys
  const key = pref.key.toLowerCase();
  const value = pref.value.toLowerCase();
  const intent = proposal.intent.toLowerCase();

  // Negative preference patterns — these reduce confidence
  if (
    key.includes('never') ||
    key.includes('block') ||
    key.includes('reject') ||
    key.includes('avoid') ||
    value === 'false' ||
    value === 'never' ||
    value === 'no'
  ) {
    // Check if the action matches the subject of the preference
    const subject = key.replace(/^(never|block|reject|avoid)_/, '');
    if (subject.length > 0 && intent.includes(subject)) {
      return {
        relevant: true,
        supports: false,
        strength: pref.confidence,
        description: `Preference "${pref.key}: ${pref.value}" restricts this action`,
      };
    }
    return noOp;
  }

  // Positive preference patterns — these raise confidence
  if (
    key.includes('always') ||
    key.includes('prefer') ||
    key.includes('default') ||
    value === 'true' ||
    value === 'always' ||
    value === 'yes'
  ) {
    const subject = key.replace(/^(always|prefer|default)_/, '');
    if (subject.length > 0 && intent.includes(subject)) {
      return {
        relevant: true,
        supports: true,
        strength: pref.confidence,
        description: `Preference "${pref.key}: ${pref.value}" supports this action`,
      };
    }
  }

  // Contact-specific preference: if entities mention a flagged contact
  if (key.includes('flag_contact') || key.includes('vip_contact') || key.includes('priority_contact')) {
    const entityMatch = proposal.entities.some(
      (e) => e.type === 'contact' && e.label.toLowerCase().includes(value),
    );
    if (entityMatch) {
      return {
        relevant: true,
        supports: true,
        strength: pref.confidence,
        description: `Preference "${pref.key}" matches a contact involved in this action`,
      };
    }
  }

  return noOp;
}

function isDomainAligned(prefCategory: ActionDomain | string, actionDomain: ActionDomain): boolean {
  if (prefCategory === actionDomain) return true;
  if (prefCategory === 'general') return true;
  // communication preferences also apply to contacts
  if (prefCategory === 'communication' && actionDomain === 'contacts') return true;
  return false;
}

// ── Factor Implementation ────────────────────────────────────────────────────

export class PreferencesFactor implements ScoringFactor {
  readonly name = 'preferences';
  readonly weight = 0.35;

  async score(proposal: ActionProposal, context: UserContext): Promise<FactorResult> {
    const { preferences } = context;

    if (!preferences || preferences.length === 0) {
      // No preferences on record — neutral score, slightly positive since there
      // is nothing explicitly blocking the action
      return {
        factor: this.name,
        score: 0.6,
        weight: this.weight,
        rationale: 'No explicit preferences on record — defaulting to neutral',
        signals: [],
      };
    }

    const signals: string[] = [];
    let supportScore = 0;
    let blockScore = 0;
    let totalStrength = 0;

    for (const pref of preferences) {
      const match = matchPreferenceToProposal(pref, proposal);
      if (!match.relevant) continue;

      signals.push(match.description);
      totalStrength += match.strength;

      if (match.supports) {
        supportScore += match.strength;
      } else {
        blockScore += match.strength;
      }
    }

    // No relevant preferences found — neutral
    if (totalStrength === 0) {
      return {
        factor: this.name,
        score: 0.65,
        weight: this.weight,
        rationale: 'No preferences relevant to this action domain',
        signals: [],
      };
    }

    // Net preference score: support outweighs block -> higher score
    // A strong block (explicit "never") can push score close to 0
    const netSupport = supportScore - blockScore;
    const normalizedNet = netSupport / totalStrength; // -1.0 to +1.0
    const score = Math.max(0, Math.min(1, 0.5 + normalizedNet * 0.5));

    const dominant = blockScore > supportScore ? 'restricting' : 'supporting';
    const rationale = `${signals.length} preference(s) found — ${dominant} this action (net: ${netSupport >= 0 ? '+' : ''}${netSupport.toFixed(2)})`;

    return {
      factor: this.name,
      score: Math.round(score * 1000) / 1000,
      weight: this.weight,
      rationale,
      signals,
    };
  }
}
