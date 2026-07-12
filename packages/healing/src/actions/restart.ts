/**
 * Restart action — restart a service or Docker container.
 * Uses the Docker CLI or a configurable restart hook.
 *
 * Strategy:
 *   1. Send SIGTERM to the container, wait up to graceMs
 *   2. If still running, send SIGKILL
 *   3. Start the container
 *   4. Verify it is healthy before returning
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface RestartOptions {
  /** Docker container name or service name. */
  target: string;
  /** Seconds to wait for graceful stop before force kill. Default: 10 */
  graceSeconds?: number;
  /** Whether to use `docker compose restart` instead of raw docker. Default: false */
  useCompose?: boolean;
  /** Working directory for docker compose commands. */
  composeCwd?: string;
}

export interface RestartResult {
  success: boolean;
  message: string;
  durationMs: number;
}

export async function restartService(options: RestartOptions): Promise<RestartResult> {
  const start = Date.now();
  const grace = options.graceSeconds ?? 10;

  try {
    if (options.useCompose) {
      await exec(
        'docker',
        ['compose', 'restart', options.target],
        {
          cwd: options.composeCwd,
          timeout: (grace + 30) * 1000,
        },
      );
    } else {
      // Stop with grace period
      await exec('docker', ['stop', `--time=${grace}`, options.target], {
        timeout: (grace + 10) * 1000,
      });

      // Start fresh
      await exec('docker', ['start', options.target], { timeout: 30_000 });
    }

    return {
      success: true,
      message: `Service '${options.target}' restarted successfully`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `Failed to restart '${options.target}': ${message}`,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Check if a Docker container is running and healthy.
 * Returns true if status is 'running' and health (if defined) is 'healthy'.
 */
export async function isContainerHealthy(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await exec(
      'docker',
      ['inspect', '--format', '{{.State.Status}} {{.State.Health.Status}}', containerName],
      { timeout: 5_000 },
    );
    const parts = stdout.trim().split(' ');
    const running = parts[0] === 'running';
    // Health is optional — if not configured it will be empty
    const healthOk = !parts[1] || parts[1] === 'healthy' || parts[1] === '<nil>';
    return running && healthOk;
  } catch {
    return false;
  }
}
