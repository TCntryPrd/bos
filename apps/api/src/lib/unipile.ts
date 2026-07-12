export type UnipileProvider = 'LINKEDIN' | 'WHATSAPP';

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

export interface UnipileChat {
  id: string;
  account_id?: string;
  account_type?: string;
  provider_id?: string;
  attendee_provider_id?: string;
  attendee?: Record<string, unknown> | null;
  attendees?: Array<Record<string, unknown>>;
  name?: string | null;
  subject?: string | null;
  timestamp?: string | null;
  unread_count?: number;
  archived?: number | boolean;
  type?: number | string | null;
}

export interface UnipileMessage {
  id?: string;
  message_id?: string | null;
  account_id?: string;
  chat_id?: string;
  sender_id?: string;
  sender?: Record<string, unknown> | null;
  attendee?: Record<string, unknown> | null;
  sender_name?: string | null;
  sender_full_name?: string | null;
  text?: string | null;
  timestamp?: string;
  is_sender?: number | boolean;
  message_type?: string;
  attachments?: unknown[];
  delivered?: number | boolean;
  seen?: number | boolean;
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

export function getUnipileConfig(): UnipileConfig | null {
  const baseUrl = normalizeBaseUrl(envValue(['UNIPILE_BASE_URL', 'UNIPILE_API_URL', 'UNIPILE_DSN']));
  const apiKey = envValue(['UNIPILE_API_KEY', 'UNIPILE_TOKEN']);
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

export function isUnipileConfigured(): boolean {
  return Boolean(getUnipileConfig());
}

async function unipileFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getUnipileConfig();
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

function preferredAccountId(provider: UnipileProvider): string {
  return provider === 'LINKEDIN'
    ? envValue(['UNIPILE_LINKEDIN_ACCOUNT_ID'])
    : envValue(['UNIPILE_WHATSAPP_ACCOUNT_ID']);
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
  const preferred = preferredAccountId(provider);
  if (preferred) {
    const match = accounts.find((account) => account.id === preferred);
    if (match) return match;
    return { id: preferred, type: provider, name: null };
  }
  return accounts.find((account) => accountMatches(account, provider)) ?? null;
}

export async function getUnipileConnectionStatus(provider: UnipileProvider): Promise<UnipileConnectionStatus> {
  const configured = isUnipileConfigured();
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
  if (!isUnipileConfigured()) {
    return {
      configured: false,
      checkedAt,
      accounts: [
        await getUnipileConnectionStatus('LINKEDIN'),
        await getUnipileConnectionStatus('WHATSAPP'),
      ],
    };
  }

  const accounts = await listUnipileAccounts();
  const statusFor = (provider: UnipileProvider): UnipileConnectionStatus => {
    const preferred = preferredAccountId(provider);
    const account = preferred
      ? accounts.find((item) => item.id === preferred) ?? { id: preferred, type: provider, name: null }
      : accounts.find((item) => accountMatches(item, provider)) ?? null;
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
  };

  return {
    configured: true,
    checkedAt,
    accounts: [statusFor('LINKEDIN'), statusFor('WHATSAPP')],
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
  const config = getUnipileConfig();
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

export async function listUnipileChats(provider: UnipileProvider, limit = 100): Promise<UnipileChat[]> {
  const account = await findUnipileAccount(provider);
  if (!account?.id) return [];
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
  const params = new URLSearchParams({
    limit: String(safeLimit),
    account_id: account.id,
    account_type: provider,
  });
  const data = await unipileFetch<{ items?: UnipileChat[] }>(`/api/v1/chats?${params.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function listUnipileChatMessages(chatId: string, limit = 50): Promise<UnipileMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const data = await unipileFetch<{ items?: UnipileMessage[] }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/messages?${params.toString()}`,
  );
  const messages = Array.isArray(data.items) ? data.items : [];
  return messages.sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
}

export async function sendUnipileChatMessage(chatId: string, text: string, accountId?: string): Promise<{ messageId: string | null }> {
  const form = new FormData();
  form.set('text', text);
  if (accountId) form.set('account_id', accountId);
  const data = await unipileFetch<{ message_id?: string | null }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    { method: 'POST', body: form },
  );
  return { messageId: data.message_id ?? null };
}

export async function startUnipileWhatsAppChat(phone: string, text: string): Promise<{ chatId: string | null; messageId: string | null; accountId: string }> {
  const account = await findUnipileAccount('WHATSAPP');
  if (!account?.id) throw new Error('Unipile WhatsApp is not connected.');
  const digits = phone.replace(/\D/g, '');
  if (!digits) throw new Error('A phone number is required.');
  const form = new FormData();
  form.set('account_id', account.id);
  form.set('text', text);
  form.append('attendees_ids', `${digits}@s.whatsapp.net`);
  const data = await unipileFetch<{ chat_id?: string | null; message_id?: string | null }>('/api/v1/chats', {
    method: 'POST',
    body: form,
  });
  return { chatId: data.chat_id ?? null, messageId: data.message_id ?? null, accountId: account.id };
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
