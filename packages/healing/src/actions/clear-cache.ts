/**
 * Clear-cache action — flush Redis cache or specific key namespaces.
 *
 * Used when stale cache state is causing incorrect responses or
 * blocking recovery (e.g. a cached auth token that's now invalid,
 * a stuck session, or a corrupted pipeline state).
 */

export type ClearCacheScope =
  | 'all'              // FLUSHDB — all keys in the database (destructive, use carefully)
  | 'session'          // Keys matching session:*
  | 'connector'        // Keys matching connector:*
  | 'brain'            // Keys matching brain:*
  | 'voice'            // Keys matching voice:*
  | 'pattern';         // Custom key pattern

export interface ClearCacheOptions {
  /** Redis connection URL. Default: redis://localhost:6379 */
  redisUrl?: string;
  /** What to clear. */
  scope: ClearCacheScope;
  /** Key pattern (required when scope is 'pattern'). */
  pattern?: string;
  /** Tenant ID prefix, injected before the pattern when set. */
  tenantId?: string;
  timeoutMs?: number;
}

export interface ClearCacheResult {
  success: boolean;
  keysDeleted: number;
  message: string;
  durationMs: number;
}

const SCOPE_PATTERNS: Record<Exclude<ClearCacheScope, 'all' | 'pattern'>, string> = {
  session: 'session:*',
  connector: 'connector:*',
  brain: 'brain:*',
  voice: 'voice:*',
};

/**
 * Clear Redis cache using the redis-cli (avoids pulling in a full Redis client dependency).
 * For production use, wire this up to the shared Redis client from the BOS infra layer.
 */
export async function clearCache(options: ClearCacheOptions): Promise<ClearCacheResult> {
  const start = Date.now();

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const redisUrl = options.redisUrl ?? 'redis://localhost:6379';
  const urlParts = parseRedisUrl(redisUrl);
  const cliBase = ['-h', urlParts.host, '-p', urlParts.port];
  if (urlParts.password) {
    cliBase.push('-a', urlParts.password);
  }

  try {
    if (options.scope === 'all') {
      await exec('redis-cli', [...cliBase, 'FLUSHDB'], { timeout: options.timeoutMs ?? 10_000 });
      return {
        success: true,
        keysDeleted: -1, // unknown — FLUSHDB doesn't return a count
        message: 'Redis FLUSHDB executed — all keys cleared',
        durationMs: Date.now() - start,
      };
    }

    const basePattern =
      options.scope === 'pattern'
        ? (options.pattern ?? '*')
        : SCOPE_PATTERNS[options.scope];

    const pattern = options.tenantId ? `${options.tenantId}:${basePattern}` : basePattern;

    // SCAN for matching keys, then DEL in batches
    const { stdout: keysRaw } = await exec(
      'redis-cli',
      [...cliBase, '--scan', '--pattern', pattern],
      { timeout: options.timeoutMs ?? 10_000 },
    );

    const keys = keysRaw
      .split('\n')
      .map((k) => k.trim())
      .filter(Boolean);

    if (keys.length === 0) {
      return {
        success: true,
        keysDeleted: 0,
        message: `No keys matching '${pattern}' found`,
        durationMs: Date.now() - start,
      };
    }

    // Delete in batches of 100
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      await exec('redis-cli', [...cliBase, 'DEL', ...batch], {
        timeout: options.timeoutMs ?? 10_000,
      });
      deleted += batch.length;
    }

    return {
      success: true,
      keysDeleted: deleted,
      message: `Cleared ${deleted} keys matching '${pattern}'`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      keysDeleted: 0,
      message: `Cache clear failed: ${message}`,
      durationMs: Date.now() - start,
    };
  }
}

function parseRedisUrl(url: string): { host: string; port: string; password?: string } {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || 'localhost',
      port: u.port || '6379',
      password: u.password || undefined,
    };
  } catch {
    return { host: 'localhost', port: '6379' };
  }
}
