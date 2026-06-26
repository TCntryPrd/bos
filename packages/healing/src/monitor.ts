/**
 * Health monitor — 30-second interval health check scheduler.
 *
 * Checks all services defined in ServiceName from @boss/core.
 * For each service:
 *   1. Run the health check function
 *   2. If healthy — record and continue
 *   3. If unhealthy — retry once (immediate)
 *   4. If still unhealthy after retry — pass to DiagnosticAgent
 *
 * The monitor maintains a status registry accessible to the API layer
 * and emits results via an optional event callback.
 */

import type { ServiceName, HealthCheckResult, HealthStatus, SystemHealth } from '@boss/core';
import type { DiagnosticAgent } from './diagnostics.js';

const CHECK_INTERVAL_MS = 30_000;
const RETRY_DELAY_MS = 3_000;

// ── Service checker type ──────────────────────────────────────

export type ServiceChecker = () => Promise<HealthCheckResult>;

export type HealthEventCallback = (result: HealthCheckResult) => void;

// ── Monitor config ────────────────────────────────────────────

export interface MonitorConfig {
  /** Diagnostic agent to call when a service fails after retry. */
  diagnosticAgent?: DiagnosticAgent;
  /** Interval in ms between full check cycles. Default: 30_000 */
  intervalMs?: number;
  /** Callback fired on every health check result. */
  onHealthEvent?: HealthEventCallback;
}

// ── HealthMonitor ─────────────────────────────────────────────

export class HealthMonitor {
  private checkers = new Map<ServiceName, ServiceChecker>();
  private statusRegistry = new Map<ServiceName, HealthCheckResult>();
  private diagnosticAgent?: DiagnosticAgent;
  private intervalMs: number;
  private onHealthEvent?: HealthEventCallback;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: MonitorConfig = {}) {
    this.diagnosticAgent = config.diagnosticAgent;
    this.intervalMs = config.intervalMs ?? CHECK_INTERVAL_MS;
    this.onHealthEvent = config.onHealthEvent;
  }

  /**
   * Register a health checker for a service.
   * Can be called after start() to add services dynamically.
   */
  register(service: ServiceName, checker: ServiceChecker): void {
    this.checkers.set(service, checker);
  }

  /**
   * Remove a health checker.
   */
  unregister(service: ServiceName): void {
    this.checkers.delete(service);
    this.statusRegistry.delete(service);
  }

  /**
   * Start the monitor. Runs an immediate check cycle, then repeats on the interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(`[HealthMonitor] Starting — ${this.checkers.size} services registered, interval: ${this.intervalMs}ms`);

    // Run immediately, then on schedule
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
  }

  /**
   * Stop the monitor gracefully.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log('[HealthMonitor] Stopped');
  }

  /**
   * Get the current system health snapshot.
   */
  getSystemHealth(): SystemHealth {
    const services = Array.from(this.statusRegistry.values());
    const overall = computeOverallStatus(services);
    return {
      overall,
      services,
      checkedAt: new Date(),
    };
  }

  /**
   * Get the last known health result for a specific service.
   */
  getServiceStatus(service: ServiceName): HealthCheckResult | undefined {
    return this.statusRegistry.get(service);
  }

  /**
   * Run a single check cycle across all registered services.
   */
  private async runCycle(): Promise<void> {
    const services = Array.from(this.checkers.keys());

    await Promise.all(
      services.map((service) => this.checkService(service)),
    );
  }

  /**
   * Run the health check for a single service with one immediate retry on failure.
   */
  private async checkService(service: ServiceName): Promise<void> {
    const checker = this.checkers.get(service);
    if (!checker) return;

    let result: HealthCheckResult;

    try {
      result = await checker();
    } catch (err) {
      result = {
        service,
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }

    if (result.status !== 'healthy') {
      // Retry once before escalating
      await sleep(RETRY_DELAY_MS);

      try {
        const retry = await checker();
        if (retry.status === 'healthy') {
          result = retry;
        }
      } catch {
        // Keep the original failure result
      }
    }

    this.statusRegistry.set(service, result);
    this.onHealthEvent?.(result);

    if (result.status === 'unhealthy' && this.diagnosticAgent) {
      console.warn(`[HealthMonitor] ${service} is unhealthy after retry — dispatching to DiagnosticAgent`);
      this.diagnosticAgent.diagnose(result).catch((err: unknown) => {
        console.error(`[HealthMonitor] DiagnosticAgent error for ${service}:`, err);
      });
    } else if (result.status === 'degraded') {
      console.warn(`[HealthMonitor] ${service} is degraded: ${result.message ?? ''}`);
    }
  }
}

// ── Built-in service checkers ─────────────────────────────────

/**
 * Build a standard set of checkers for all BOS services.
 * Callers can override individual checkers or add custom ones.
 */
export interface StandardCheckerConfig {
  postgresUrl?: string;
  redisUrl?: string;
  weaviateUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

export function buildStandardCheckers(
  config: StandardCheckerConfig = {},
): Map<ServiceName, ServiceChecker> {
  const checkers = new Map<ServiceName, ServiceChecker>();

  const apiBase = (config.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  const headers: Record<string, string> = config.apiKey ? { 'x-boss-api-key': config.apiKey } : {};

  checkers.set('postgres', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);

      const url = new URL(config.postgresUrl ?? 'postgresql://localhost:5432/boss');
      const { stdout } = await exec(
        'pg_isready',
        ['-h', url.hostname, '-p', url.port || '5432', '-U', url.username || 'postgres', '-t', '5'],
        { timeout: 10_000 },
      );

      const healthy = stdout.includes('accepting connections');
      return {
        service: 'postgres',
        status: healthy ? 'healthy' : 'unhealthy',
        message: healthy ? undefined : stdout.trim(),
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'postgres',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  checkers.set('redis', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);

      const u = new URL(config.redisUrl ?? 'redis://localhost:6379');
      const args = ['-h', u.hostname, '-p', u.port || '6379', 'PING'];
      if (u.password) args.push('-a', u.password);

      const { stdout } = await exec('redis-cli', args, { timeout: 5_000 });
      const healthy = stdout.trim() === 'PONG';

      return {
        service: 'redis',
        status: healthy ? 'healthy' : 'unhealthy',
        message: healthy ? undefined : `Unexpected PING response: ${stdout.trim()}`,
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'redis',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  checkers.set('weaviate', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    const weaviateUrl = (config.weaviateUrl ?? 'http://localhost:8080').replace(/\/$/, '');
    try {
      const res = await fetch(`${weaviateUrl}/v1/.well-known/ready`, {
        signal: AbortSignal.timeout(5_000),
      });
      return {
        service: 'weaviate',
        status: res.ok ? 'healthy' : 'unhealthy',
        message: res.ok ? undefined : `HTTP ${res.status}`,
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'weaviate',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  checkers.set('brain', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      const res = await fetch(`${apiBase}/internal/brain/ping`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      return {
        service: 'brain',
        status: res.ok ? 'healthy' : 'unhealthy',
        message: res.ok ? undefined : `Brain ping returned HTTP ${res.status}`,
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'brain',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  checkers.set('connector-microsoft', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      const res = await fetch(`${apiBase}/internal/connectors/microsoft/health`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      return {
        service: 'connector-microsoft',
        status: res.ok ? 'healthy' : 'degraded',
        message: res.ok ? undefined : `Microsoft connector health check failed: HTTP ${res.status}`,
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'connector-microsoft',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  checkers.set('connector-google', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      const res = await fetch(`${apiBase}/internal/connectors/google/health`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      return {
        service: 'connector-google',
        status: res.ok ? 'healthy' : 'degraded',
        message: res.ok ? undefined : `Google connector health check failed: HTTP ${res.status}`,
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'connector-google',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  checkers.set('voice', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      const res = await fetch(`${apiBase}/internal/voice/health`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      return {
        service: 'voice',
        status: res.ok ? 'healthy' : 'degraded',
        message: res.ok ? undefined : `Voice health check failed: HTTP ${res.status}`,
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'voice',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  checkers.set('backup', async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      const res = await fetch(`${apiBase}/internal/backup/status`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        return {
          service: 'backup',
          status: 'degraded',
          message: `Backup status endpoint returned HTTP ${res.status}`,
          latencyMs: Date.now() - start,
          checkedAt: new Date(),
        };
      }

      const data = (await res.json()) as { lastBackupAge?: number; intervalMs?: number };

      // Check: last backup age should be less than 2x the configured interval
      if (data.lastBackupAge && data.intervalMs) {
        const tooOld = data.lastBackupAge > data.intervalMs * 2;
        return {
          service: 'backup',
          status: tooOld ? 'degraded' : 'healthy',
          message: tooOld
            ? `Last backup is ${Math.round(data.lastBackupAge / 60000)} minutes old (expected < ${Math.round(data.intervalMs * 2 / 60000)} min)`
            : undefined,
          latencyMs: Date.now() - start,
          checkedAt: new Date(),
        };
      }

      return {
        service: 'backup',
        status: 'healthy',
        latencyMs: Date.now() - start,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        service: 'backup',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  });

  return checkers;
}

// ── Helpers ───────────────────────────────────────────────────

function computeOverallStatus(services: HealthCheckResult[]): HealthStatus {
  if (services.length === 0) return 'unknown';
  if (services.some((s) => s.status === 'unhealthy')) return 'unhealthy';
  if (services.some((s) => s.status === 'degraded')) return 'degraded';
  if (services.every((s) => s.status === 'healthy')) return 'healthy';
  return 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
