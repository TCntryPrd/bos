import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setRuntimeConfig } from '../config-store.js';

const CODEX_BIN = process.env.BOSS_GIO_BIN ?? 'codex';
const CODEX_HOME = process.env.CODEX_HOME ?? '/home/boss/.codex';
const SMOKE_PROMPT = 'Reply with exactly: BOSS_CODEX_OK';

interface SmokeResult {
  ok: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

function runCodexSmoke(apiKey: string): Promise<SmokeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      CODEX_BIN,
      ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', SMOKE_PROMPT],
      {
        cwd: tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENAI_API_KEY: apiKey,
          CODEX_HOME,
        },
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({
        ok: false,
        exitCode: null,
        stdoutTail: stdout.slice(-2000),
        stderrTail: 'codex smoke timed out after 45000ms',
      });
    }, 45_000);
    timer.unref();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdoutTail: stdout.slice(-2000),
        stderrTail: `spawn error: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && stdout.includes('BOSS_CODEX_OK'),
        exitCode: code,
        stdoutTail: stdout.slice(-2000),
        stderrTail: stderr.slice(-2000),
      });
    });
  });
}

function runCodexLogin(apiKey: string): Promise<SmokeResult> {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, ['login', '--with-api-key'], {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME,
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({
        ok: false,
        exitCode: null,
        stdoutTail: stdout.slice(-2000),
        stderrTail: 'codex login timed out after 30000ms',
      });
    }, 30_000);
    timer.unref();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin?.end(`${apiKey}\n`);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdoutTail: stdout.slice(-2000),
        stderrTail: `spawn error: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdoutTail: stdout.slice(-2000),
        stderrTail: stderr.slice(-2000),
      });
    });
  });
}

export async function verifyCodexCliInBackground(apiKey: string, tenantId = 'default'): Promise<void> {
  if (!apiKey) return;
  await mkdir(CODEX_HOME, { recursive: true }).catch(() => undefined);
  await setRuntimeConfig('CODEX_CLI_STATUS', 'checking', tenantId);
  await setRuntimeConfig('CODEX_CLI_LAST_CHECK_AT', new Date().toISOString(), tenantId);

  void runCodexLogin(apiKey)
    .then(async (loginResult) => {
      if (!loginResult.ok) return loginResult;
      return runCodexSmoke(apiKey);
    })
    .then(async (result) => {
      await setRuntimeConfig('CODEX_CLI_STATUS', result.ok ? 'ready' : 'error', tenantId);
      await setRuntimeConfig('CODEX_CLI_LAST_CHECK_AT', new Date().toISOString(), tenantId);
      await setRuntimeConfig('CODEX_CLI_EXIT_CODE', String(result.exitCode ?? ''), tenantId);
      await setRuntimeConfig('CODEX_CLI_STDERR_TAIL', result.stderrTail, tenantId);
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await setRuntimeConfig('CODEX_CLI_STATUS', 'error', tenantId);
      await setRuntimeConfig('CODEX_CLI_LAST_CHECK_AT', new Date().toISOString(), tenantId);
      await setRuntimeConfig('CODEX_CLI_STDERR_TAIL', message.slice(-2000), tenantId);
    });
}
