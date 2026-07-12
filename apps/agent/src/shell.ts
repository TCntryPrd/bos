/**
 * Native shell execution — runs directly on the host.
 * No Docker socket needed. No container restrictions. Direct access.
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const BOSS_DIR = '/home/tcntryprd/boss-dev';

// Safety: block only truly destructive system commands
const BLOCKED = [
  /\brm\s+-rf\s+\/(?!home|tmp|data)/,  // rm -rf outside safe dirs
  /\bshutdown\b/,
  /\breboot\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
];

export function runSync(command: string, opts?: {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
}): string {
  for (const pattern of BLOCKED) {
    if (pattern.test(command)) {
      throw new Error(`Blocked: ${command} matches safety rule ${pattern.source}`);
    }
  }

  return execSync(command, {
    cwd: opts?.cwd ?? BOSS_DIR,
    timeout: opts?.timeout ?? 120_000,
    maxBuffer: opts?.maxBuffer ?? 2 * 1024 * 1024,
    encoding: 'utf-8',
    env: process.env,
    shell: '/bin/bash',
  });
}

export async function runAsync(command: string, opts?: {
  cwd?: string;
  timeout?: number;
}): Promise<{ stdout: string; stderr: string }> {
  for (const pattern of BLOCKED) {
    if (pattern.test(command)) {
      throw new Error(`Blocked: ${command} matches safety rule ${pattern.source}`);
    }
  }

  return execAsync(command, {
    cwd: opts?.cwd ?? BOSS_DIR,
    timeout: opts?.timeout ?? 120_000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
    shell: '/bin/bash',
  });
}

export { BOSS_DIR };
