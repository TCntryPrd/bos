/**
 * Diagnostic agent — read logs, check playbooks, attempt fix. MAX 3 ATTEMPTS before escalation.
 *
 * Protocol (per design doc section 6.2):
 *   1. Read last 5 minutes of logs for the failing service
 *   2. Check if a playbook exists for this failure pattern
 *   3. If playbook exists -> execute known fix -> verify -> done
 *   4. If no playbook -> analyze logs, attempt a fix
 *   5. MAX 3 fix attempts. If fix works on any attempt -> write a new playbook
 *   6. If all 3 attempts fail -> escalate with full diagnostic report
 */

import type { ServiceName, PlaybookSeverity } from '@boss/core';
import type { HealthCheckResult } from '@boss/core';
import type { PlaybookStore } from './playbooks/store.js';
import type { PlaybookMatcher } from './playbooks/matcher.js';
import { PlaybookBuilder } from './playbooks/builder.js';
import type { IncidentRecord } from './playbooks/builder.js';
import { EscalationManager } from './escalation.js';
import type { EscalationReport, AttemptSummary, EscalationConfig } from './escalation.js';
import { restartService, isContainerHealthy } from './actions/restart.js';
import { refreshAuth } from './actions/refresh-auth.js';
import { clearCache } from './actions/clear-cache.js';
import { reconnect } from './actions/reconnect.js';
import type { ReconnectTarget } from './actions/reconnect.js';

const MAX_ATTEMPTS = 3;

// ── Config ────────────────────────────────────────────────────

export interface DiagnosticsConfig {
  playbookStore: PlaybookStore;
  playbookMatcher: PlaybookMatcher;
  escalation: EscalationConfig;
  /** BOS internal API base URL for log retrieval. Default: http://localhost:3000 */
  apiBaseUrl?: string;
  apiKey?: string;
  /** Docker compose working directory for restart actions. */
  composeCwd?: string;
}

// ── Result types ──────────────────────────────────────────────

export type DiagnosticOutcome = 'fixed' | 'escalated' | 'skipped';

export interface DiagnosticResult {
  outcome: DiagnosticOutcome;
  incidentId: string;
  service: ServiceName;
  attemptsUsed: number;
  playbookUsed?: string;
  playbookCreated?: boolean;
  durationMs: number;
}

// ── DiagnosticAgent ───────────────────────────────────────────

export class DiagnosticAgent {
  private store: PlaybookStore;
  private matcher: PlaybookMatcher;
  private builder: PlaybookBuilder;
  private escalator: EscalationManager;
  private config: DiagnosticsConfig;

  constructor(config: DiagnosticsConfig) {
    this.config = config;
    this.store = config.playbookStore;
    this.matcher = config.playbookMatcher;
    this.builder = new PlaybookBuilder(config.playbookStore, config.playbookMatcher);
    this.escalator = new EscalationManager(config.escalation);
  }

  /**
   * Diagnose and attempt to fix a failed health check.
   * This is the top-level entry point called by the health monitor.
   */
  async diagnose(check: HealthCheckResult): Promise<DiagnosticResult> {
    const start = Date.now();
    const incidentId = `inc-${Date.now()}-${check.service}`;

    console.log(`[DiagnosticAgent] Starting diagnosis for ${check.service} (incident: ${incidentId})`);

    // Step 1: Retrieve logs
    const logExcerpt = await this.fetchLogs(check.service);

    // Step 2: Determine error message
    const errorMessage = check.message ?? `Service ${check.service} is ${check.status}`;

    // Step 3: Check for matching playbook
    const matchResult = await this.matcher.match({
      service: check.service,
      errorMessage,
      logExcerpt,
    });

    const diagnosisSteps: string[] = [
      `Service ${check.service} reported status: ${check.status}`,
      `Error message: ${errorMessage}`,
      `Log excerpt retrieved (${logExcerpt.length} chars)`,
      matchResult.found
        ? `Playbook match found: ${matchResult.playbook!.id} (score: ${matchResult.score?.toFixed(2)})`
        : 'No playbook match found — will attempt heuristic fix',
    ];

    const attempts: AttemptSummary[] = [];

    // ── Attempt loop ─────────────────────────────────────────
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const fixAction = matchResult.found && matchResult.playbook && attempt === 1
        ? describePlaybookFix(matchResult.playbook.fixSteps)
        : describeHeuristicFix(check.service, attempt);

      console.log(`[DiagnosticAgent] Attempt ${attempt}/${MAX_ATTEMPTS}: ${fixAction}`);

      let actionResult: { success: boolean; message: string };

      try {
        actionResult = await this.executeFixAttempt(check, attempt, matchResult.playbook?.fixSteps);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        actionResult = { success: false, message: msg };
      }

      attempts.push({
        attemptNumber: attempt,
        action: fixAction,
        outcome: actionResult.success ? 'Succeeded' : actionResult.message,
      });

      if (actionResult.success) {
        // Verify the service is actually healthy now
        const verified = await this.verifyRecovery(check.service);

        if (verified) {
          console.log(`[DiagnosticAgent] Service ${check.service} recovered on attempt ${attempt}`);

          // Write playbook from this incident
          const severity = deriveSeverity(check.service);
          const incident: IncidentRecord = {
            id: incidentId,
            service: check.service,
            severity,
            errorMessage,
            logExcerpt,
            diagnosisSteps,
            successfulFixSteps: matchResult.playbook?.fixSteps ?? [fixAction],
            verificationMethod: `Service health check returned healthy`,
          };

          let playbookCreated = false;
          try {
            const buildResult = await this.builder.buildFromIncident(incident);
            playbookCreated = buildResult.action === 'created';
          } catch (err) {
            console.warn(`[DiagnosticAgent] Failed to write playbook: ${err}`);
          }

          return {
            outcome: 'fixed',
            incidentId,
            service: check.service,
            attemptsUsed: attempt,
            playbookUsed: matchResult.playbook?.id,
            playbookCreated,
            durationMs: Date.now() - start,
          };
        }

        // Fix appeared to succeed but service is still unhealthy — continue
        attempts[attempts.length - 1].outcome = 'Fix executed but service still unhealthy';
      }
    }

    // ── All attempts exhausted — escalate ────────────────────
    console.error(`[DiagnosticAgent] All ${MAX_ATTEMPTS} attempts failed for ${check.service}. Escalating.`);

    const severity = deriveSeverity(check.service);
    const report: EscalationReport = {
      incidentId,
      service: check.service,
      severity,
      errorSummary: errorMessage,
      attempts,
      recommendedAction: recommendHumanAction(check.service),
      logExcerpt,
      failedAt: new Date(),
    };

    await this.escalator.escalate(report);

    return {
      outcome: 'escalated',
      incidentId,
      service: check.service,
      attemptsUsed: MAX_ATTEMPTS,
      playbookUsed: matchResult.playbook?.id,
      playbookCreated: false,
      durationMs: Date.now() - start,
    };
  }

  // ── Fix execution ─────────────────────────────────────────

  private async executeFixAttempt(
    check: HealthCheckResult,
    attempt: number,
    playbookSteps?: string[],
  ): Promise<{ success: boolean; message: string }> {
    const composeCwd = this.config.composeCwd;

    // Attempt 1: use playbook fix steps if available, else service-specific default
    // Attempt 2: clear cache + reconnect
    // Attempt 3: full restart

    if (attempt === 1 && playbookSteps && playbookSteps.length > 0) {
      return this.executePlaybookSteps(check.service, playbookSteps);
    }

    switch (check.service) {
      case 'postgres':
      case 'weaviate':
      case 'redis': {
        if (attempt <= 2) {
          return reconnect({
            target: check.service as ReconnectTarget,
            maxAttempts: 2,
          });
        }
        return restartService({
          target: check.service,
          useCompose: true,
          composeCwd,
        });
      }

      case 'connector-microsoft':
      case 'connector-google': {
        if (attempt === 1) {
          const provider = check.service === 'connector-microsoft' ? 'microsoft' : 'google';
          return refreshAuth({
            tenantId: 'default',
            provider,
            apiBaseUrl: this.config.apiBaseUrl,
            apiKey: this.config.apiKey,
          });
        }
        return reconnect({
          target: check.service as ReconnectTarget,
          apiBaseUrl: this.config.apiBaseUrl,
          apiKey: this.config.apiKey,
        });
      }

      case 'brain': {
        if (attempt === 1) {
          return clearCache({
            scope: 'brain',
            redisUrl: 'redis://localhost:6379',
          });
        }
        return restartService({
          target: 'api',
          useCompose: true,
          composeCwd,
        });
      }

      case 'voice': {
        if (attempt === 1) {
          return clearCache({ scope: 'voice' });
        }
        return restartService({ target: 'api', useCompose: true, composeCwd });
      }

      case 'backup': {
        // Backup failures don't need a restart — clear stale state and reschedule
        return clearCache({ scope: 'pattern', pattern: 'backup:*' });
      }

      default: {
        return restartService({
          target: check.service,
          useCompose: true,
          composeCwd,
        });
      }
    }
  }

  private async executePlaybookSteps(
    service: ServiceName,
    steps: string[],
  ): Promise<{ success: boolean; message: string }> {
    // Playbook steps are human-readable strings mapped to actions.
    // Parse common patterns and dispatch accordingly.
    for (const step of steps) {
      const lower = step.toLowerCase();
      if (lower.includes('restart')) {
        const result = await restartService({
          target: service,
          useCompose: true,
          composeCwd: this.config.composeCwd,
        });
        if (!result.success) return result;
      } else if (lower.includes('clear cache') || lower.includes('flush')) {
        const result = await clearCache({ scope: 'all' });
        if (!result.success) return result;
      } else if (lower.includes('refresh') && lower.includes('token')) {
        // Cannot determine provider from step alone — fall through to heuristic
        return { success: false, message: `Cannot auto-execute token refresh from playbook step: ${step}` };
      }
    }
    return { success: true, message: 'Playbook steps executed' };
  }

  // ── Verification ──────────────────────────────────────────

  private async verifyRecovery(service: ServiceName): Promise<boolean> {
    // Give the service 5 seconds to stabilize after the fix
    await sleep(5_000);

    switch (service) {
      case 'postgres':
        return isContainerHealthy('postgres');
      case 'redis':
        return isContainerHealthy('redis');
      case 'weaviate':
        return isContainerHealthy('weaviate');
      default:
        return isContainerHealthy(service);
    }
  }

  // ── Log retrieval ─────────────────────────────────────────

  private async fetchLogs(service: ServiceName): Promise<string> {
    try {
      const baseUrl = (this.config.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
      const res = await fetch(
        `${baseUrl}/internal/logs/${service}?minutes=5`,
        {
          headers: this.config.apiKey ? { 'x-boss-api-key': this.config.apiKey } : {},
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) return '';
      const data = (await res.json()) as { logs: string };
      return data.logs ?? '';
    } catch {
      return '';
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────

function deriveSeverity(service: ServiceName): PlaybookSeverity {
  switch (service) {
    case 'postgres': return 'critical';
    case 'redis':    return 'high';
    case 'weaviate': return 'medium';
    case 'brain':    return 'high';
    case 'connector-microsoft':
    case 'connector-google': return 'medium';
    case 'voice':    return 'medium';
    case 'backup':   return 'low';
    default:         return 'medium';
  }
}

function describePlaybookFix(steps: string[]): string {
  return steps.length > 0 ? steps[0] : 'Apply playbook fix';
}

function describeHeuristicFix(service: ServiceName, attempt: number): string {
  if (attempt === 2) return `Clear cache and reconnect ${service}`;
  if (attempt === 3) return `Restart ${service} container`;
  return `Service-specific recovery for ${service}`;
}

function recommendHumanAction(service: ServiceName): string {
  switch (service) {
    case 'postgres':
      return 'Check disk space and Postgres logs. Verify the data volume is mounted correctly.';
    case 'redis':
      return 'Check Redis memory usage and configuration. The container may need more memory.';
    case 'weaviate':
      return 'Check Weaviate cluster status and disk space. Verify the schema is intact.';
    case 'brain':
      return 'Check the brain adapter configuration and API key. Verify network access to the brain endpoint.';
    case 'connector-microsoft':
    case 'connector-google':
      return 'The OAuth tokens may be permanently revoked. Re-authorize the connector from the BOS settings.';
    case 'voice':
      return 'Check the voice server logs and verify the STT/TTS services are reachable.';
    case 'backup':
      return 'Check backup storage credentials and available space. Review the backup scheduler logs.';
    default:
      return `Manually inspect the ${service} service logs and restart if needed.`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
