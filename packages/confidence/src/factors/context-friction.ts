/**
 * Context Friction Factor — scores based on conflicts with current state.
 *
 * An action that would conflict with existing calendar, open priority tasks, or
 * other in-flight state introduces friction and should be escalated or proposed
 * rather than executed autonomously.
 *
 * Weight: 0.20 — meaningful but lower than preference/entity signals. State
 * conflicts are real risks but sometimes expected (reschedule scenarios).
 *
 * Scoring model:
 *   - No conflicts detected:               high score (0.85)
 *   - Soft conflict (low-priority event):  moderate (0.6)
 *   - Hard conflict (high-priority event): low (0.25)
 *   - Multiple conflicts:                  floor at 0.15
 */

import type {
  ActionProposal,
  CalendarEventSummary,
  FactorResult,
  ScoringFactor,
  UserContext,
} from '../types.js';

// ── Conflict detection ───────────────────────────────────────────────────────

interface ConflictResult {
  severity: 'none' | 'soft' | 'hard';
  description: string;
  penaltyWeight: number;
}

function detectCalendarConflict(
  proposal: ActionProposal,
  event: CalendarEventSummary,
): ConflictResult {
  const intent = proposal.intent.toLowerCase();

  // Check if the proposal is scheduling-related and conflicts with an existing event
  if (proposal.domain !== 'scheduling' && proposal.domain !== 'communication') {
    return { severity: 'none', description: '', penaltyWeight: 0 };
  }

  // Does the proposal involve an attendee that's already in a conflicting event?
  const proposalEntityLabels = proposal.entities.map((e) => e.label.toLowerCase());
  const sharedAttendees = event.attendees.filter((a) =>
    proposalEntityLabels.some((label) => a.toLowerCase().includes(label) || label.includes(a.toLowerCase())),
  );

  if (sharedAttendees.length === 0) {
    return { severity: 'none', description: '', penaltyWeight: 0 };
  }

  // Scheduling intent + shared attendee + high-priority existing event = hard conflict
  if (
    event.priority === 'high' &&
    (intent.includes('schedul') || intent.includes('meeting') || intent.includes('appointment'))
  ) {
    return {
      severity: 'hard',
      description: `Conflict with high-priority event "${event.title}" — shared attendees: ${sharedAttendees.join(', ')}`,
      penaltyWeight: 0.6,
    };
  }

  // Medium/low priority conflict = soft
  return {
    severity: 'soft',
    description: `Potential overlap with "${event.title}" (${event.priority} priority) — shared attendees: ${sharedAttendees.join(', ')}`,
    penaltyWeight: 0.25,
  };
}

function detectContextFlagConflict(
  proposal: ActionProposal,
  flags: string[],
): ConflictResult[] {
  const results: ConflictResult[] = [];
  const intent = proposal.intent.toLowerCase();

  for (const flag of flags) {
    const f = flag.toLowerCase();

    if (f.includes('do_not_disturb') || f.includes('dnd')) {
      results.push({
        severity: 'hard',
        description: `Context flag: Do Not Disturb mode is active`,
        penaltyWeight: 0.5,
      });
      continue;
    }

    if (f.includes('hold_communications')) {
      if (proposal.domain === 'communication') {
        results.push({
          severity: 'hard',
          description: `Context flag: communications are on hold`,
          penaltyWeight: 0.55,
        });
      }
      continue;
    }

    if (f.includes('busy') || f.includes('in_meeting')) {
      results.push({
        severity: 'soft',
        description: `Context flag: user is currently busy (${flag})`,
        penaltyWeight: 0.2,
      });
      continue;
    }

    // Generic flag mention in intent
    if (intent.includes(f.replace(/_/g, ' '))) {
      results.push({
        severity: 'soft',
        description: `Context flag "${flag}" is relevant to this action`,
        penaltyWeight: 0.15,
      });
    }
  }

  return results;
}

// ── Factor Implementation ────────────────────────────────────────────────────

export class ContextFrictionFactor implements ScoringFactor {
  readonly name = 'context_friction';
  readonly weight = 0.20;

  async score(proposal: ActionProposal, context: UserContext): Promise<FactorResult> {
    const state = proposal.currentState;

    // No state provided — can't detect conflicts, assume clean
    if (!state) {
      return {
        factor: this.name,
        score: 0.75,
        weight: this.weight,
        rationale: 'No current state snapshot provided — assuming no conflicts',
        signals: [],
      };
    }

    const signals: string[] = [];
    let totalPenalty = 0;
    let hardConflicts = 0;

    // Calendar conflict checks
    if (state.upcomingEvents && state.upcomingEvents.length > 0) {
      for (const event of state.upcomingEvents) {
        const conflict = detectCalendarConflict(proposal, event);
        if (conflict.severity !== 'none') {
          signals.push(conflict.description);
          totalPenalty += conflict.penaltyWeight;
          if (conflict.severity === 'hard') hardConflicts++;
        }
      }
    }

    // Context flag checks
    if (state.contextFlags && state.contextFlags.length > 0) {
      const flagConflicts = detectContextFlagConflict(proposal, state.contextFlags);
      for (const fc of flagConflicts) {
        if (fc.severity !== 'none') {
          signals.push(fc.description);
          totalPenalty += fc.penaltyWeight;
          if (fc.severity === 'hard') hardConflicts++;
        }
      }
    }

    // Open priority tasks — if this action is unrelated to them, mild positive
    // (user has focus, action is probably routine)
    if (state.openPriorityTasks && state.openPriorityTasks.length > 3) {
      signals.push(`${state.openPriorityTasks.length} open priority tasks — high existing load`);
      totalPenalty += 0.1;
    }

    if (signals.length === 0) {
      return {
        factor: this.name,
        score: 0.85,
        weight: this.weight,
        rationale: 'No conflicts detected in current state',
        signals: [],
      };
    }

    // Apply penalty to base score of 0.85
    // Cap total penalty to prevent going below 0.1 on a single factor
    const clampedPenalty = Math.min(0.75, totalPenalty);
    const rawScore = 0.85 - clampedPenalty;
    const finalScore = Math.max(0.1, rawScore);

    const conflictSummary = hardConflicts > 0
      ? `${hardConflicts} hard conflict(s) detected`
      : 'Soft conflicts detected';

    return {
      factor: this.name,
      score: Math.round(finalScore * 1000) / 1000,
      weight: this.weight,
      rationale: `${conflictSummary} — total friction penalty: ${clampedPenalty.toFixed(2)}`,
      signals,
    };
  }
}
