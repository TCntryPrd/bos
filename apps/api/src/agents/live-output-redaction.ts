/**
 * Redaction for the ephemeral terminal/JSONL viewer.
 *
 * The viewer is intentionally not an audit log, so it is safer to conceal a
 * little too much than to reveal a credential while an agent is working. This
 * module handles both normal terminal text and JSON that has been stringified
 * one or more times by CLI/tool output.
 */

const HIDDEN = '[hidden]';

const SENSITIVE_KEY_WORDS = new Set([
  'accesskey', 'accesstoken', 'apikey', 'apikeys', 'authorization',
  'authentication', 'authtoken', 'bearertoken', 'clientsecret', 'cookie',
  'credentials', 'credential', 'databaseurl', 'dsn', 'idtoken', 'key',
  'password', 'passwd', 'passphrase', 'privatekey', 'proxyauthorization',
  'redisurl', 'refreshtoken', 'secret', 'sessiontoken', 'setcookie',
  'sshkey', 'token', 'webauthntoken',
]);

const SENSITIVE_KEY_PATTERN = [
  'authorization', 'proxy[-_]?authorization', 'authentication',
  'api[-_]?key', 'access[-_]?key', 'access[-_]?token', 'refresh[-_]?token',
  'id[-_]?token', 'auth[-_]?token', 'bearer[-_]?token', 'client[-_]?secret',
  'private[-_]?key', 'ssh[-_]?key', 'session[-_]?token', 'set[-_]?cookie',
  'cookie', 'credential(?:s)?', 'password', 'passwd', 'passphrase', 'secret',
  'token', 'key', 'database[-_]?url', 'redis[-_]?url', 'connection[-_]?string',
  'dsn', 'signature', 'sig', 'x[-_]?amz[-_]?signature', 'x[-_]?goog[-_]?signature',
].join('|');

const PRIVATE_KEY_RE = /-----BEGIN(?: [^-]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [^-]+)? PRIVATE KEY-----/g;
const KNOWN_CREDENTIAL_RE = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{40,})\b/g;
const URI_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi;
const AUTH_SCHEME_RE = /\b((?:proxy[-_ ]?)?authorization|authentication)\s*[:=]\s*(?:bearer|basic|token|apikey|api[-_ ]?key|key)\s+[^\s,;]+/gi;
const RAW_JSON_QUOTED_RE = new RegExp(
  `((?:["'](?:${SENSITIVE_KEY_PATTERN})["'])\\s*:\\s*["'])(?:\\\\.|[^"\\\\\\r\\n])*(["'])`,
  'gi',
);
const ESCAPED_JSON_QUOTED_RE = new RegExp(
  `((?:\\\\+["'](?:${SENSITIVE_KEY_PATTERN})\\\\+["'])\\s*:\\s*\\\\+["'])(?:\\\\.|[^"\\r\\n])*(?=\\\\+["'])`,
  'gi',
);
const RAW_JSON_LITERAL_RE = new RegExp(
  `((?:["'](?:${SENSITIVE_KEY_PATTERN})["'])\\s*:\\s*)(?!["'])(?:[^,}\\]\\s]+)`,
  'gi',
);
const PLAIN_KEY_VALUE_RE = new RegExp(
  `((?:^|[\\s,{;&?])(?:${SENSITIVE_KEY_PATTERN})\\s*(?:=|:)\\s*)(?!\\[hidden\\])(?:["'](?:\\\\.|[^"'\\\\\\r\\n])*["']|[^\\s,;}&\\]]+)`,
  'gi',
);
const BEARER_VALUE_RE = /\b(Bearer\s+)(?!\[hidden\])([A-Za-z0-9._~+/=-]{8,})/gi;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True for property names which should never reveal their value in a live pane. */
export function isSensitiveLiveOutputKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEY_WORDS.has(normalized)) return true;
  return normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('passphrase')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
    || normalized.endsWith('apikey')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('sshkey')
    || normalized.endsWith('signature');
}

/**
 * Mask secrets in arbitrary terminal text. The escaped-JSON pass catches
 * strings such as `{\"api_key\":\"value\"}` emitted by a CLI or nested tool
 * result, while the normal JSON and shell-style passes cover regular panes.
 */
export function redactLiveOutput(value: string): string {
  let redacted = value;
  // Repeating twice handles JSON encoded within a JSON string without
  // expanding or parsing the source text (which could itself be malformed).
  for (let pass = 0; pass < 2; pass += 1) {
    const next = redacted
      .replace(PRIVATE_KEY_RE, '[private key hidden]')
      .replace(URI_CREDENTIAL_RE, '$1[hidden]@')
      .replace(AUTH_SCHEME_RE, '$1: [hidden]')
      .replace(RAW_JSON_QUOTED_RE, `$1${HIDDEN}$2`)
      .replace(ESCAPED_JSON_QUOTED_RE, `$1${HIDDEN}`)
      .replace(RAW_JSON_LITERAL_RE, `$1"${HIDDEN}"`)
      .replace(PLAIN_KEY_VALUE_RE, `$1${HIDDEN}`)
      .replace(BEARER_VALUE_RE, `$1${HIDDEN}`)
      .replace(KNOWN_CREDENTIAL_RE, HIDDEN);
    if (next === redacted) break;
    redacted = next;
  }
  return redacted;
}

/**
 * Recursively scrub a parsed JSONL frame before it is stringified for the
 * browser. It covers structured headers/env maps even when their values do not
 * resemble a known token prefix.
 */
export function redactLiveJson(value: unknown): unknown {
  if (typeof value === 'string') return redactLiveOutput(value);
  if (Array.isArray(value)) return value.map((item) => redactLiveJson(item));
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const namedSecret = ['name', 'key', 'variable', 'env', 'envName']
    .map((field) => source[field])
    .some((field) => typeof field === 'string' && isSensitiveLiveOutputKey(field));
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const valueLabel = ['value', 'content', 'text', 'raw'].includes(key);
    redacted[key] = isSensitiveLiveOutputKey(key) || (namedSecret && valueLabel)
      ? HIDDEN
      : redactLiveJson(child);
  }
  return redacted;
}
