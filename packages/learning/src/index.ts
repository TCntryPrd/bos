/**
 * @boss/learning — Observer, preferences, onboarding sprint, and cleanup agent.
 * Phase 5 implementation.
 */

// Onboarding
export { OnboardingSprint } from './onboarding/sprint.js';
export type { SprintConfig, SprintResult, PlatformName, PlatformIngester } from './onboarding/sprint.js';
export { ProgressTracker } from './onboarding/progress.js';
export type {
  OnboardingProgress,
  PlatformProgress,
  PlatformStatus,
  PlatformIngestResult,
  IngestPattern,
} from './onboarding/progress.js';
export { GmailIngester } from './onboarding/gmail-ingest.js';
export type { GmailIngestConfig, EmailPattern } from './onboarding/gmail-ingest.js';
export { CalendarIngester } from './onboarding/calendar-ingest.js';
export type { CalendarIngestConfig } from './onboarding/calendar-ingest.js';
export { DriveIngester } from './onboarding/drive-ingest.js';
export type { DriveIngestConfig } from './onboarding/drive-ingest.js';
export { TasksIngester } from './onboarding/tasks-ingest.js';
export { CommsIngester } from './onboarding/comms-ingest.js';
export { FinancialIngester } from './onboarding/financial-ingest.js';
export { DeviceIngester } from './onboarding/device-ingest.js';
export type { DeviceIngestConfig, DeviceFileEntry } from './onboarding/device-ingest.js';
export { ProfileSynthesizer } from './onboarding/synthesizer.js';

// Core learning modules
export { BehavioralObserver } from './observer.js';
export type { Observation, ObservationCategory, BehavioralPattern, ObserverConfig } from './observer.js';
export { PreferenceStore } from './preferences.js';
export type { Preference, PreferenceQuery, PreferenceUpdate } from './preferences.js';
export { ProfileManager } from './profile.js';
export type {
  LearningProfile,
  CommunicationProfile,
  SchedulingProfile,
  WorkProfile,
  BusinessProfile,
  TimeBlock,
  ProfileSnapshot,
  ProfileMetadata,
} from './profile.js';
export { EmbeddingStore } from './embeddings.js';
export type {
  BehavioralEmbedding,
  EmbeddingQuery,
  EmbeddingSearchResult,
  EmbeddingStoreConfig,
} from './embeddings.js';
export { StyleModel } from './style.js';
export type { StyleProfile, StyleVocabulary, StyleAnalysisInput } from './style.js';
export { FeedbackProcessor } from './feedback.js';
export type {
  FeedbackEntry,
  FeedbackSignal,
  FeedbackStats,
  FeedbackConfig,
  FeedbackListener,
} from './feedback.js';

// Cleanup agent
export { CleanupPlanner } from './cleanup/planner.js';
export type {
  CleanupProposal,
  CleanupItem,
  CleanupAudit,
  CleanupCategory,
  CleanupAction,
  CleanupPlannerConfig,
} from './cleanup/planner.js';
export { CleanupExecutor } from './cleanup/executor.js';
export type { ExecutionResult, ExecutionLog, ExecutorConfig } from './cleanup/executor.js';
export { FileRulesEngine } from './cleanup/rules.js';
export type {
  FileRule,
  RuleCondition,
  RuleActionConfig,
  RuleAction,
  RuleTrigger,
  RuleFrequency,
  FileMetadata,
  SuggestablePattern,
} from './cleanup/rules.js';
