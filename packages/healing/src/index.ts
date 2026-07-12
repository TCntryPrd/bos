// @boss/healing — Self-healing engine, diagnostics, playbooks, escalation

// Monitor
export { HealthMonitor, buildStandardCheckers } from './monitor.js';
export type {
  MonitorConfig,
  ServiceChecker,
  HealthEventCallback,
  StandardCheckerConfig,
} from './monitor.js';

// Diagnostics
export { DiagnosticAgent } from './diagnostics.js';
export type { DiagnosticsConfig, DiagnosticResult, DiagnosticOutcome } from './diagnostics.js';

// Actions
export { restartService, isContainerHealthy } from './actions/restart.js';
export type { RestartOptions, RestartResult } from './actions/restart.js';

export { refreshAuth } from './actions/refresh-auth.js';
export type {
  RefreshAuthOptions,
  RefreshAuthResult,
  OAuthProvider,
} from './actions/refresh-auth.js';

export { clearCache } from './actions/clear-cache.js';
export type { ClearCacheOptions, ClearCacheResult, ClearCacheScope } from './actions/clear-cache.js';

export { reconnect } from './actions/reconnect.js';
export type {
  ReconnectOptions,
  ReconnectResult,
  ReconnectTarget,
} from './actions/reconnect.js';

export { rollback } from './actions/rollback.js';
export type {
  RollbackOptions,
  RollbackResult,
  RollbackStrategy,
} from './actions/rollback.js';

// Playbooks
export { PlaybookStore } from './playbooks/store.js';
export type {
  PlaybookStoreConfig,
  CreatePlaybookInput,
} from './playbooks/store.js';

export { PlaybookMatcher } from './playbooks/matcher.js';
export type { MatchInput, MatchResult } from './playbooks/matcher.js';

export { PlaybookBuilder } from './playbooks/builder.js';
export type { IncidentRecord, BuildPlaybookResult } from './playbooks/builder.js';

// Escalation
export { EscalationManager } from './escalation.js';
export type {
  EscalationReport,
  EscalationResult,
  EscalationConfig,
  AttemptSummary,
} from './escalation.js';
