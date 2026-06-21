/**
 * Reconnect action — re-establish dropped connections.
 *
 * Covers three connection categories:
 *   1. Database (Postgres) — verify connectivity, attempt reconnect
 *   2. Vector DB (Weaviate) — verify connectivity, attempt reconnect
 *   3. Connector (Microsoft / Google) — re-initialize the connector client
 *
 * Each reconnect attempt uses exponential backoff with jitter.
 */

export type ReconnectTarget = 'postgres' | 'weaviate' | 'redis' | 'connector-microsoft' | 'connector-google';

export interface ReconnectOptions {
  target: ReconnectTarget;
  /** Max reconnect attempts. Default: 3 */
  maxAttempts?: number;
  /** Initial backoff in ms. Doubles on each attempt. Default: 500 */
  initialBackoffMs?: number;
  /** BOS internal API base URL for connector reconnect. Default: http://localhost:3000 */
  apiBaseUrl?: string;
  apiKey?: string;
  /** Direct connection strings for DB targets. */
  postgresUrl?: string;
  weaviateUrl?: string;
  redisUrl?: string;
}

export interface ReconnectResult {
  success: boolean;
  target: ReconnectTarget;
  attempts: number;
  message: string;
  durationMs: number;
}

export async function reconnect(options: ReconnectOptions): Promise<ReconnectResult> {
  const start = Date.now();
  const maxAttempts = options.maxAttempts ?? 3;
  const initialBackoff = options.initialBackoffMs ?? 500;

  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ok = await attemptReconnect(options);
      if (ok) {
        return {
          success: true,
          target: options.target,
          attempts: attempt,
          message: `Reconnected to '${options.target}' on attempt ${attempt}`,
          durationMs: Date.now() - start,
        };
      }
      lastError = 'Connectivity check failed after reconnect';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxAttempts) {
      const backoff = initialBackoff * Math.pow(2, attempt - 1) + Math.random() * 100;
      await sleep(backoff);
    }
  }

  return {
    success: false,
    target: options.target,
    attempts: maxAttempts,
    message: `Failed to reconnect to '${options.target}' after ${maxAttempts} attempts. Last error: ${lastError}`,
    durationMs: Date.now() - start,
  };
}

async function attemptReconnect(options: ReconnectOptions): Promise<boolean> {
  switch (options.target) {
    case 'postgres':
      return checkPostgres(options.postgresUrl ?? 'postgresql://localhost:5432/boss');

    case 'weaviate':
      return checkHttp((options.weaviateUrl ?? 'http://localhost:8080') + '/v1/.well-known/ready');

    case 'redis':
      return checkRedis(options.redisUrl ?? 'redis://localhost:6379');

    case 'connector-microsoft':
    case 'connector-google': {
      const provider = options.target === 'connector-microsoft' ? 'microsoft' : 'google';
      return reconnectConnectorViaApi(provider, options);
    }
  }
}

async function checkPostgres(connectionString: string): Promise<boolean> {
  // Use pg_isready via subprocess to avoid pulling in a Postgres client
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const url = new URL(connectionString);
  const args = [
    '-h', url.hostname,
    '-p', url.port || '5432',
    '-U', url.username || 'postgres',
    '-d', url.pathname.slice(1) || 'boss',
    '-t', '5',
  ];

  try {
    const { stdout } = await exec('pg_isready', args, { timeout: 10_000 });
    return stdout.includes('accepting connections');
  } catch {
    return false;
  }
}

async function checkHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

async function checkRedis(redisUrl: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const u = new URL(redisUrl);
  const args = ['-h', u.hostname, '-p', u.port || '6379', 'PING'];
  if (u.password) args.push('-a', u.password);

  try {
    const { stdout } = await exec('redis-cli', args, { timeout: 5_000 });
    return stdout.trim() === 'PONG';
  } catch {
    return false;
  }
}

async function reconnectConnectorViaApi(
  provider: string,
  options: ReconnectOptions,
): Promise<boolean> {
  const baseUrl = (options.apiBaseUrl ?? 'http://localhost:3000').replace(/\/$/, '');

  const res = await fetch(`${baseUrl}/internal/connectors/${provider}/reconnect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { 'x-boss-api-key': options.apiKey } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });

  return res.ok;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
