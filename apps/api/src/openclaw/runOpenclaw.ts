import { spawn } from 'node:child_process';

export interface RunOpenclawOptions {
  timeoutMs?: number;  // default 30_000
  // Some subcommands (backup create, memory index, daemon restart) don't
  // emit JSON. Pass `appendJson: false` to skip the auto-appended `--json`
  // and `parseJson: false` to receive raw stdout instead of parsed data.
  appendJson?: boolean; // default true
  parseJson?: boolean;  // default true
}

export interface OpenclawResult<T = unknown> {
  ok: true;
  data: T;
  durationMs: number;
}

export interface OpenclawError {
  ok: false;
  exitCode: number | null;
  stderrTail: string;
  stdoutTail: string;
  durationMs: number;
}

/**
 * Spawn `openclaw <args...> --json`, capture stdout, parse as JSON.
 * --json is appended automatically; do not pass it in args.
 *
 * Returns either {ok:true, data, durationMs} on success or
 * {ok:false, exitCode, stderrTail, stdoutTail, durationMs} on failure.
 *
 * Four error paths produce {ok:false}:
 *   1. Non-zero exit code           → exitCode = the code
 *   2. Timeout (default 30s)        → exitCode = null, child SIGKILLed
 *   3. Spawn error (binary missing) → exitCode = null, stderrTail = "spawn error: ..."
 *   4. JSON parse failure           → exitCode = 0, stderrTail starts with "JSON parse failed:"
 *
 * Caller decides how to surface the error to the client.
 */
export async function runOpenclaw<T = unknown>(
  args: string[],
  opts: RunOpenclawOptions = {},
): Promise<OpenclawResult<T> | OpenclawError> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const appendJson = opts.appendJson ?? true;
  const parseJson = opts.parseJson ?? true;
  const start = Date.now();

  return await new Promise((resolve) => {
    const finalArgs = appendJson ? [...args, '--json'] : [...args];
    const child = spawn('openclaw', finalArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result: OpenclawResult<T> | OpenclawError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({
        ok: false,
        exitCode: null,
        stderrTail: stderr.slice(-2000),
        stdoutTail: stdout.slice(-2000),
        durationMs: Date.now() - start,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (err) => {
      settle({
        ok: false,
        exitCode: null,
        stderrTail: `spawn error: ${err.message}`,
        stdoutTail: stdout.slice(-2000),
        durationMs: Date.now() - start,
      });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - start;
      if (code !== 0) {
        return settle({
          ok: false,
          exitCode: code,
          stderrTail: stderr.slice(-2000),
          stdoutTail: stdout.slice(-2000),
          durationMs,
        });
      }
      if (!parseJson) {
        settle({ ok: true, data: { stdout, stderr } as unknown as T, durationMs });
        return;
      }
      try {
        const data = JSON.parse(stdout) as T;
        settle({ ok: true, data, durationMs });
      } catch (err) {
        settle({
          ok: false,
          exitCode: code,
          stderrTail: `JSON parse failed: ${(err as Error).message}\n--- stderr ---\n${stderr.slice(-1500)}`,
          stdoutTail: stdout.slice(-2000),
          durationMs,
        });
      }
    });
  });
}
