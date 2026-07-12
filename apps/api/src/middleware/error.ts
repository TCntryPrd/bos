/**
 * Global error handler for BOS v2 API.
 *
 * SECURITY:
 * - 5xx errors never expose internal details to clients
 * - Stack traces are logged server-side only, never returned
 * - Validation errors (4xx) return sanitized messages
 * - No system internals (file paths, query details, etc.) in responses
 * - OWASP A09:2021 -- Security Logging and Monitoring Failures
 */

import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';

/** Errors that are safe to show to clients (validation, auth, etc). */
const SAFE_ERROR_CODES = new Set([
  'FST_ERR_VALIDATION',
  'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  'FST_ERR_CTP_BODY_TOO_LARGE',
]);

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const statusCode = error.statusCode || 500;

  // Always log the full error server-side for debugging
  request.log.error({
    err: {
      message: error.message,
      code: error.code,
      statusCode,
      // Stack trace only in server logs, never in response
      stack: error.stack,
    },
    url: request.url,
    method: request.method,
    requestId: request.id,
  });

  // Determine client-facing message
  let clientMessage: string;

  if (statusCode >= 500) {
    // SECURITY: Never expose internal error details for server errors
    clientMessage = 'Internal Server Error';
  } else if (SAFE_ERROR_CODES.has(error.code || '')) {
    // Known framework validation errors are safe to show
    clientMessage = error.message;
  } else if (statusCode >= 400 && statusCode < 500) {
    // Client errors: show the message but strip any file paths or SQL
    clientMessage = sanitizeErrorMessage(error.message);
  } else {
    clientMessage = 'An unexpected error occurred';
  }

  reply.status(statusCode).send({
    error: getErrorName(statusCode),
    message: clientMessage,
    statusCode,
  });
}

/**
 * Remove potentially sensitive information from error messages.
 * Strips file paths, SQL fragments, and stack trace snippets.
 */
function sanitizeErrorMessage(message: string): string {
  if (!message) return 'Bad Request';

  // Remove file paths (Unix and Windows)
  let sanitized = message.replace(/(?:\/[\w.-]+){2,}/g, '[path]');
  sanitized = sanitized.replace(/[A-Z]:\\[\w\\.-]+/gi, '[path]');

  // Remove SQL fragments
  sanitized = sanitized.replace(/\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b.*$/gi, '[query]');

  // Remove stack trace lines
  sanitized = sanitized.replace(/\s+at\s+.+/g, '');

  // Truncate overly long messages
  if (sanitized.length > 256) {
    sanitized = sanitized.slice(0, 256) + '...';
  }

  return sanitized;
}

function getErrorName(statusCode: number): string {
  const names: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    413: 'Payload Too Large',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return names[statusCode] || 'Error';
}
