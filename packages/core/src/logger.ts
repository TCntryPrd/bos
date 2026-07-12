/**
 * BOS v2 — Structured JSON Logger
 *
 * All packages and apps import from this single module. It produces
 * newline-delimited JSON logs that are parseable by Prometheus Loki,
 * Grafana, and any log aggregator expecting structured output.
 *
 * Usage:
 *   import { createLogger } from '@boss/core';
 *   const log = createLogger('voice');
 *   log.info('Pipeline started', { tenantId, deviceId });
 *   log.error('STT failed', { err, durationMs });
 *
 * Fields always present in every log line:
 *   ts        — ISO 8601 timestamp (UTC)
 *   level     — 'debug' | 'info' | 'warn' | 'error'
 *   service   — caller-supplied service label
 *   msg       — human-readable message
 *   ...fields — any extra context passed by caller
 *
 * Error serialization: if a field named 'err' is passed and it is an
 * Error instance, it is expanded to { err_msg, err_stack, err_code }.
 * The original Error object is not serialized as-is to avoid truncation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Context fields that may appear on any log entry. */
export interface LogContext {
  tenantId?: string;
  userId?: string;
  requestId?: string;
  service?: string;
  [key: string]: unknown;
}

/** A single serialized log entry written to stdout. */
export interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  service: string;
  msg: string;
}

/** Options passed to createLogger. */
export interface LoggerOptions {
  /**
   * Minimum level to emit. Defaults to the LOG_LEVEL env var, or 'info'.
   * Levels in ascending severity: debug < info < warn < error.
   */
  level?: LogLevel;
  /**
   * Base context fields merged into every log entry produced by this logger.
   * Useful for setting tenantId, requestId, etc. once at logger creation time.
   */
  baseContext?: LogContext;
}

/** The logger interface returned by createLogger. */
export interface Logger {
  debug(msg: string, fields?: LogContext): void;
  info(msg: string, fields?: LogContext): void;
  warn(msg: string, fields?: LogContext): void;
  error(msg: string, fields?: LogContext): void;
  /**
   * Returns a child logger that merges additional context into every line.
   * Useful for per-request or per-tenant loggers.
   *
   * Example:
   *   const reqLog = log.child({ requestId: req.id, tenantId: ctx.tenantId });
   *   reqLog.info('Request received');  // includes requestId and tenantId
   */
  child(context: LogContext): Logger;
}

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveMinLevel(): LogLevel {
  const env = (process.env['LOG_LEVEL'] ?? '').toLowerCase();
  if (env in LEVELS) return env as LogLevel;
  return 'info';
}

// ---------------------------------------------------------------------------
// Error serialization
// ---------------------------------------------------------------------------

function serializeFields(fields: LogContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(fields)) {
    if (k === 'err' && v instanceof Error) {
      out['err_msg'] = v.message;
      out['err_stack'] = v.stack ?? '';
      // Node errors often have a .code property (ENOENT, ECONNREFUSED, etc.)
      const code = (v as NodeJS.ErrnoException).code;
      if (code !== undefined) {
        out['err_code'] = code;
      }
    } else {
      out[k] = v;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Core write function
// ---------------------------------------------------------------------------

function write(
  service: string,
  level: LogLevel,
  minLevel: LogLevel,
  msg: string,
  fields: LogContext,
): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    service,
    msg,
    ...serializeFields(fields),
  };

  // Write to stdout as a single newline-terminated JSON line.
  // Using process.stdout.write avoids the trailing newline that console.log
  // produces differently across platforms.
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Creates a structured JSON logger bound to a named service.
 *
 * @param service  A short label identifying the calling package/module
 *                 (e.g. 'api', 'voice', 'healing', 'backup').
 * @param options  Optional level override and base context fields.
 */
export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  const minLevel: LogLevel = options.level ?? resolveMinLevel();
  const base: LogContext = { service, ...(options.baseContext ?? {}) };

  const logger: Logger = {
    debug(msg, fields = {}) {
      write(service, 'debug', minLevel, msg, { ...base, ...fields });
    },
    info(msg, fields = {}) {
      write(service, 'info', minLevel, msg, { ...base, ...fields });
    },
    warn(msg, fields = {}) {
      write(service, 'warn', minLevel, msg, { ...base, ...fields });
    },
    error(msg, fields = {}) {
      write(service, 'error', minLevel, msg, { ...base, ...fields });
    },
    child(context) {
      return createLogger(service, {
        level: minLevel,
        baseContext: { ...base, ...context },
      });
    },
  };

  return logger;
}

// ---------------------------------------------------------------------------
// Default root logger
// ---------------------------------------------------------------------------

/**
 * Pre-built root logger. Suitable for quick use in scripts and small modules
 * that don't need per-service labels.
 *
 * For production services, prefer createLogger('your-service-name').
 */
export const logger: Logger = createLogger('boss');
