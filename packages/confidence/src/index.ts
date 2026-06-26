/**
 * @boss/confidence — Confidence Threshold Engine
 *
 * Sits between the brain router's response and action execution.
 * Every proposed action is scored and assigned an autonomy tier:
 *
 *   Tier 1 (autonomous)  — High confidence. Executes + logs automatically.
 *   Tier 2 (propose)     — Medium confidence. Drafts action for human approval.
 *   Tier 3 (escalate)    — Low confidence or conflict. Surfaces directly to user.
 *
 * Usage:
 *
 *   import { ConfidenceEngine } from '@boss/confidence';
 *
 *   const engine = new ConfidenceEngine();
 *   const decision = await engine.evaluate(actionProposal, userContext);
 *
 *   if (decision.tier === 'autonomous') executeAction(action);
 *   else if (decision.tier === 'propose') queueForApproval(action, decision.reasoning);
 *   else escalateToHuman(action, decision.reasoning);
 */

// Engine
export { ConfidenceEngine } from './engine.js';
export type { EngineConfig } from './engine.js';

// Scorer
export { ConfidenceScorer } from './scorer.js';
export type { ScorerResult } from './scorer.js';

// Thresholds
export {
  DEFAULT_THRESHOLDS,
  buildThresholds,
  resolveToTier,
  validateThresholds,
} from './thresholds.js';
export type { ThresholdConfig } from './thresholds.js';

// Alpha mode
export { applyAlphaMode, alphaModeWouldOverride, ALPHA_MODE_REASON } from './alpha-mode.js';

// Scoring factors
export { PreferencesFactor } from './factors/preferences.js';
export { EntityPriorityFactor } from './factors/entity-priority.js';
export { ContextFrictionFactor } from './factors/context-friction.js';
export { HistoricalPrecedentFactor } from './factors/historical-precedent.js';

// Types
export type {
  // Core domain
  ActionProposal,
  ActionDecision,
  ConfidenceTier,
  ActionDomain,
  // Entities and state
  ActionEntity,
  CurrentState,
  CalendarEventSummary,
  TaskSummary,
  // User context
  UserContext,
  HistoricalAction,
  // Scoring
  ScoringFactor,
  FactorResult,
} from './types.js';
