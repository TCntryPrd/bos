/**
 * Rollback action — revert the last configuration or code change.
 *
 * Two rollback strategies:
 *   1. Config rollback — restore a previous config file from a backup snapshot
 *   2. Container rollback — redeploy a previous Docker image tag
 *
 * All rollback operations are logged and reversible (rollback of a rollback is supported).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);

export type RollbackStrategy = 'config' | 'container';

export interface RollbackOptions {
  strategy: RollbackStrategy;

  // Config rollback fields
  /** Absolute path to the config file to roll back. */
  configPath?: string;
  /** Absolute path to the backup config to restore from. */
  backupConfigPath?: string;

  // Container rollback fields
  /** Docker container or service name. */
  containerName?: string;
  /** Previous image tag to redeploy. e.g. 'boss-api:2025-03-28' */
  previousImageTag?: string;
  /** Working directory for docker compose (required if useCompose is true). */
  composeCwd?: string;
  useCompose?: boolean;

  timeoutMs?: number;
}

export interface RollbackResult {
  success: boolean;
  strategy: RollbackStrategy;
  message: string;
  /** Snapshot of what was rolled back from, for audit trail. */
  rolledBackFrom?: string;
  durationMs: number;
}

export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  const start = Date.now();

  switch (options.strategy) {
    case 'config':
      return rollbackConfig(options, start);
    case 'container':
      return rollbackContainer(options, start);
  }
}

async function rollbackConfig(options: RollbackOptions, start: number): Promise<RollbackResult> {
  const { configPath, backupConfigPath } = options;

  if (!configPath || !backupConfigPath) {
    return {
      success: false,
      strategy: 'config',
      message: 'Config rollback requires configPath and backupConfigPath',
      durationMs: Date.now() - start,
    };
  }

  if (!existsSync(backupConfigPath)) {
    return {
      success: false,
      strategy: 'config',
      message: `Backup config not found: ${backupConfigPath}`,
      durationMs: Date.now() - start,
    };
  }

  try {
    // Save current config as a "pre-rollback snapshot" alongside the backup
    const snapshotPath = `${configPath}.pre-rollback-${Date.now()}`;
    if (existsSync(configPath)) {
      await copyFile(configPath, snapshotPath);
    }

    // Restore backup
    const backupContent = await readFile(backupConfigPath, 'utf-8');
    await writeFile(configPath, backupContent, 'utf-8');

    return {
      success: true,
      strategy: 'config',
      message: `Config restored from ${backupConfigPath}. Pre-rollback snapshot: ${snapshotPath}`,
      rolledBackFrom: snapshotPath,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      strategy: 'config',
      message: `Config rollback failed: ${message}`,
      durationMs: Date.now() - start,
    };
  }
}

async function rollbackContainer(
  options: RollbackOptions,
  start: number,
): Promise<RollbackResult> {
  const { containerName, previousImageTag, composeCwd, useCompose } = options;

  if (!containerName || !previousImageTag) {
    return {
      success: false,
      strategy: 'container',
      message: 'Container rollback requires containerName and previousImageTag',
      durationMs: Date.now() - start,
    };
  }

  const timeout = options.timeoutMs ?? 60_000;

  try {
    // Capture current image tag for the audit trail
    let currentTag = 'unknown';
    try {
      const { stdout } = await exec(
        'docker',
        ['inspect', '--format', '{{.Config.Image}}', containerName],
        { timeout: 5_000 },
      );
      currentTag = stdout.trim();
    } catch {
      // non-fatal
    }

    if (useCompose && composeCwd) {
      // Update the image tag in compose env and redeploy
      await exec(
        'docker',
        ['compose', 'up', '-d', '--no-deps', '--force-recreate', containerName],
        {
          cwd: composeCwd,
          timeout,
          env: {
            ...process.env,
            BOSS_IMAGE_TAG: previousImageTag,
          },
        },
      );
    } else {
      // Raw docker: stop, remove, start with previous tag
      await exec('docker', ['stop', containerName], { timeout: 20_000 });
      await exec('docker', ['rm', containerName], { timeout: 10_000 });
      await exec('docker', ['run', '-d', '--name', containerName, previousImageTag], { timeout });
    }

    return {
      success: true,
      strategy: 'container',
      message: `Container '${containerName}' rolled back to ${previousImageTag}`,
      rolledBackFrom: currentTag,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      strategy: 'container',
      message: `Container rollback failed: ${message}`,
      durationMs: Date.now() - start,
    };
  }
}
