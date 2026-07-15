/**
 * Unipile client — LinkedIn ONLY.
 *
 * WhatsApp was removed from Unipile entirely (2026-07): WhatsApp now runs on
 * the WhatsApp bridge (lib/wa-bridge.ts). Unipile serves exactly one provider here —
 * LINKEDIN — for connection status, hosted-auth links, and post publishing.
 * Do not reintroduce chat/messaging helpers or a WHATSAPP provider.
 *
 * Credentials on this box come from the environment only (UNIPILE_BASE_URL /
 * UNIPILE_API_KEY). There is no runtime_config fallback here — do not add one
 * without also adding lib/unipile-config.ts.
 */
export type UnipileProvider = 'LINKEDIN';

export interface UnipileAccount {
  id: string;
  type?: string;
  name?: string | null;
  created_at?: string | null;
  last_fetched_at?: string | null;
  sources?: Array<{ id?: string; status?: unknown }>;
  connection_params?: Record<string, unknown>;
}

export interface UnipileConnectionStatus {
  provider: UnipileProvider;
  configured: boolean;
  connected: boolean;
  accountId: string | null;
  name: string | null;
  accountType: string | null;
  health: string;
  checkedAt: string;
}

export interface UnipilePostMedia {
  type: 'image' | 'video' | 'document';
  url?: string;
  dataBase64?: string;
  filename?: string;
  mimeType?: string;
}

interface UnipileConfig {
  baseUrl: string;
  apiKey: string;
}

function envValue(keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return '';
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Async only so call sites read the same as the boxes that resolve Unipile
 * credentials from runtime_config. Here it is a pure environment read.
 */
export async function getUnipileConfig(): Promise<UnipileConfig | null> {
  const baseUrl = normalizeBaseUrl(envValue(['UNIPILE_BASE_URL', 'UNIPILE_API_URL', 'UNIPILE_DSN']));
  const apiKey = envValue(['UNIPILE_API_KEY', 'UNIPILE_TOKEN']);
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

export function isUnipileConfigured(): boolean {
  const baseUrl = normalizeBaseUrl(envValue(['UNIPILE_BASE_URL', 'UNIPILE_API_URL', 'UNIPILE_DSN']));
  const apiKey = envValue(['UNIPILE_API_KEY', 'UNIPILE_TOKEN']);
  return Boolean(baseUrl && apiKey);
}

async function unipileFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = await getUnipileConfig();
  if (!config) throw new Error('Unipile is not configured.');

  const headers = new Headers(init.headers);
  headers.set('X-API-KEY', config.apiKey);
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const detail = typeof body === 'object' && body && 'message' in body
      ? String((body as { message?: unknown }).message)
      : text.slice(0, 300);
    throw new Error(`Unipile HTTP ${res.status}: ${detail}`);
  }
  return body as T;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function accountType(account: UnipileAccount): string {
  return String(account.type ?? '').toUpperCase();
}

function accountMatches(account: UnipileAccount, provider: UnipileProvider): boolean {
  const type = accountType(account);
  return type === provider || type.includes(provider);
}

function preferredAccountId(): string {
  return envValue(['UNIPILE_LINKEDIN_ACCOUNT_ID']);
}

function accountHealth(account: UnipileAccount | null): string {
  if (!account) return 'not_connected';
  const statuses = (account.sources ?? [])
    .map((source) => {
      const status = source.status;
      if (typeof status === 'string') return status;
      if (typeof status === 'number') return String(status);
      if (status && typeof status === 'object' && 'status' in status) {
        return String((status as { status?: unknown }).status);
      }
      return '';
    })
    .filter(Boolean);
  return statuses.length > 0 ? statuses.join(', ') : 'connected';
}

export async function listUnipileAccounts(limit = 250): Promise<UnipileAccount[]> {
  const data = await unipileFetch<{ items?: UnipileAccount[] }>(`/api/v1/accounts?limit=${limit}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function findUnipileAccount(provider: UnipileProvider): Promise<UnipileAccount | null> {
  const accounts = await listUnipileAccounts();
  const preferred = preferredAccountId();
  if (preferred) {
    const match = accounts.find((account) => account.id === preferred);
    if (match) return match;
    return { id: preferred, type: provider, name: null };
  }
  return accounts.find((account) => accountMatches(account, provider)) ?? null;
}

export async function getUnipileConnectionStatus(provider: UnipileProvider): Promise<UnipileConnectionStatus> {
  const configured = Boolean(await getUnipileConfig());
  const checkedAt = new Date().toISOString();
  if (!configured) {
    return {
      provider,
      configured: false,
      connected: false,
      accountId: null,
      name: null,
      accountType: null,
      health: 'not_configured',
      checkedAt,
    };
  }
  const account = await findUnipileAccount(provider);
  return {
    provider,
    configured: true,
    connected: Boolean(account?.id),
    accountId: account?.id ?? null,
    name: account?.name ?? null,
    accountType: account?.type ?? null,
    health: accountHealth(account),
    checkedAt,
  };
}

export async function getUnipileStatus(): Promise<{ configured: boolean; accounts: UnipileConnectionStatus[]; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  if (!await getUnipileConfig()) {
    return {
      configured: false,
      checkedAt,
      accounts: [await getUnipileConnectionStatus('LINKEDIN')],
    };
  }

  const accounts = await listUnipileAccounts();
  const preferred = preferredAccountId();
  const account = preferred
    ? accounts.find((item) => item.id === preferred) ?? { id: preferred, type: 'LINKEDIN', name: null }
    : accounts.find((item) => accountMatches(item, 'LINKEDIN')) ?? null;

  return {
    configured: true,
    checkedAt,
    accounts: [{
      provider: 'LINKEDIN',
      configured: true,
      connected: Boolean(account?.id),
      accountId: account?.id ?? null,
      name: account?.name ?? null,
      accountType: account?.type ?? null,
      health: accountHealth(account),
      checkedAt,
    }],
  };
}

export async function createUnipileHostedAuthLink(
  provider: UnipileProvider,
  options: {
    successRedirectUrl?: string;
    failureRedirectUrl?: string;
    notifyUrl?: string;
    name?: string;
    expiresOn?: string;
  } = {},
): Promise<{ url: string }> {
  const config = await getUnipileConfig();
  if (!config) throw new Error('Unipile is not configured.');
  const expiresOn = options.expiresOn ?? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const body = {
    type: 'create',
    providers: [provider],
    expiresOn,
    api_url: config.baseUrl,
    name: options.name ?? `vasari-bos-${provider.toLowerCase()}`,
    bypass_success_screen: true,
    ...(options.successRedirectUrl ? { success_redirect_url: options.successRedirectUrl } : {}),
    ...(options.failureRedirectUrl ? { failure_redirect_url: options.failureRedirectUrl } : {}),
    ...(options.notifyUrl ? { notify_url: options.notifyUrl } : {}),
  };
  const data = await unipileFetch<{ url?: string }>('/api/v1/hosted/accounts/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!data.url) throw new Error('Unipile did not return a hosted auth URL.');
  return { url: data.url };
}

async function mediaToBlob(media: UnipilePostMedia): Promise<{ blob: Blob; filename: string }> {
  const filename = media.filename ?? `upload.${media.type === 'image' ? 'jpg' : media.type === 'video' ? 'mp4' : 'pdf'}`;
  const mimeType = media.mimeType
    ?? (media.type === 'image' ? 'image/jpeg' : media.type === 'video' ? 'video/mp4' : 'application/pdf');
  if (media.dataBase64) {
    const b64 = media.dataBase64.includes(',') ? media.dataBase64.slice(media.dataBase64.indexOf(',') + 1) : media.dataBase64;
    return { blob: new Blob([Buffer.from(b64, 'base64')], { type: mimeType }), filename };
  }
  if (media.url) {
    const res = await fetch(media.url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Could not fetch media for Unipile post (${res.status})`);
    const contentType = res.headers.get('content-type') ?? mimeType;
    return { blob: new Blob([await res.arrayBuffer()], { type: contentType }), filename };
  }
  throw new Error('media requires a url or dataBase64');
}

export async function createUnipileLinkedInPost(
  text: string,
  options: { link?: string; media?: UnipilePostMedia } = {},
): Promise<{ postId: string | null; accountId: string }> {
  const account = await findUnipileAccount('LINKEDIN');
  if (!account?.id) throw new Error('Unipile LinkedIn is not connected.');
  const form = new FormData();
  form.set('account_id', account.id);
  form.set('text', text);
  if (options.link) form.set('external_link', options.link);
  if (options.media) {
    const { blob, filename } = await mediaToBlob(options.media);
    form.append('attachments', blob, filename);
  }
  const data = await unipileFetch<{ post_id?: string | null }>('/api/v1/posts', {
    method: 'POST',
    body: form,
  });
  return { postId: data.post_id ?? null, accountId: account.id };
}
