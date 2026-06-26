/**
 * API client for the BOS Fastify backend.
 * All requests go through /api/ prefix — proxied by Vite in dev.
 */

const BASE = 'api';

class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * Bearer token issued by POST /api/auth/login and stored in localStorage as
 * `boss_token`. Without this, every request() call hits protected routes
 * unauthenticated → 401 → empty/mock data (connectors, WhatsApp, etc.).
 */
function authHeader(): Record<string, string> {
  try {
    const token = localStorage.getItem('boss_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    // localStorage unavailable (SSR / tests) — proceed unauthenticated.
    return {};
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...options.headers,
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiClientError(
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  return body as T;
}

// ─── Health ───────────────────────────────────────────────────────────────────
import type {
  SystemHealth,
  ActivityItem,
  VoiceDevice,
  BrainConfig,
  BrainProvider,
  ConnectedAccount,
  OnboardingProgress,
  LearnedPreference,
  BehaviorPattern,
  Incident,
  Playbook,
  BackupState,
  TenantSettings,
} from '../types/api';

export const healthApi = {
  getSystemHealth: () => request<SystemHealth>('/health'),
};

// ─── Activity ─────────────────────────────────────────────────────────────────
export const activityApi = {
  getRecent: (limit = 20) =>
    request<ActivityItem[]>(`/activity?limit=${limit}`),
};

// ─── Voice Devices ────────────────────────────────────────────────────────────
export const voiceApi = {
  getDevices: () => request<VoiceDevice[]>('/voice/devices'),
  updateDevice: (id: string, patch: Partial<VoiceDevice>) =>
    request<VoiceDevice>(`/voice/devices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

// ─── Brain ────────────────────────────────────────────────────────────────────
export const brainApi = {
  getConfig: () => request<BrainConfig>('/brain/config'),
  configureProvider: (provider: BrainProvider, credentials: Record<string, string>) =>
    request<{ provider: BrainProvider; configured: boolean; status: string }>('/brain/configure', {
      method: 'POST',
      body: JSON.stringify({ provider, credentials }),
    }),
  switchBrain: (provider: BrainProvider, config?: Record<string, string>) =>
    request<BrainConfig>('/brain/config', {
      method: 'PUT',
      body: JSON.stringify({ provider, ...config }),
    }),
};

// ─── Connectors ───────────────────────────────────────────────────────────────
// Full OAuth suite requested on connect. Re-connecting an existing account
// (same provider + email) refreshes its token via the backend's ON CONFLICT
// upsert, so the same call serves both "connect" and "reconnect".
const DEFAULT_OAUTH_SERVICES = ['mail', 'calendar', 'tasks', 'drive', 'contacts'] as const;

export const connectorsApi = {
  getAccounts: () => request<ConnectedAccount[]>('/connectors/accounts'),
  // Backend route is POST /connectors/oauth/:provider/start → { url, state }.
  getOAuthUrl: (
    provider: string,
    services: readonly string[] = DEFAULT_OAUTH_SERVICES,
  ) =>
    request<{ url: string }>(`/connectors/oauth/${provider}/start`, {
      method: 'POST',
      body: JSON.stringify({ provider, services }),
    }),
  // WS2: save the tester's OWN OAuth app credentials (client id/secret) before
  // authorizing. Backend route is POST /connectors/oauth/configure.
  configureOAuthApp: (provider: string, clientId: string, clientSecret: string) =>
    request<{ provider: string; configured: boolean }>('/connectors/oauth/configure', {
      method: 'POST',
      body: JSON.stringify({ provider, clientId, clientSecret }),
    }),
  // Backend route is DELETE /connectors/accounts/:provider/:email.
  disconnect: (provider: 'microsoft' | 'google' | 'linkedin', email: string) =>
    request<void>(
      `/connectors/accounts/${provider}/${encodeURIComponent(email)}`,
      { method: 'DELETE' },
    ),
  // Full 13-connector catalog with configured status (OAuth + API-key).
  getIntegrations: () =>
    request<Array<{
      id: string; name: string; type: 'oauth' | 'apikey';
      configured: boolean; envVar?: string; needsBaseUrl?: boolean; baseUrl?: string;
    }>>('/connectors/integrations'),
  // Save an API key (+ optional base URL / extra keys) for an integration.
  configureIntegration: (
    integration: string,
    apiKey: string,
    opts?: { baseUrl?: string; extraKeys?: Record<string, string> },
  ) =>
    request<{ status: string; integration: string; configured: boolean }>(
      '/connectors/configure',
      {
        method: 'POST',
        body: JSON.stringify({
          integration,
          apiKey,
          ...(opts?.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          ...(opts?.extraKeys ? { extraKeys: opts.extraKeys } : {}),
        }),
      },
    ),
  deleteIntegration: (integration: string) =>
    request<{ status: string; integration: string; configured: boolean }>(
      `/connectors/configure/${integration}`,
      { method: 'DELETE' },
    ),
};

// ─── Learning ─────────────────────────────────────────────────────────────────
export const learningApi = {
  getOnboardingProgress: () =>
    request<OnboardingProgress[]>('/learning/onboarding/progress'),
  getPreferences: () =>
    request<LearnedPreference[]>('/learning/preferences'),
  deletePreference: (id: string) =>
    request<void>(`/learning/preferences/${id}`, { method: 'DELETE' }),
  getBehaviorPatterns: () =>
    request<BehaviorPattern[]>('/learning/patterns'),
  deletePattern: (id: string) =>
    request<void>(`/learning/patterns/${id}`, { method: 'DELETE' }),
};

// ─── Self-Healing ─────────────────────────────────────────────────────────────
export const healingApi = {
  getIncidents: () => request<Incident[]>('/healing/incidents'),
  getPlaybooks: () => request<Playbook[]>('/healing/playbooks'),
  runHealthCheck: () => request<SystemHealth>('/healing/health-check'),
};

// ─── Backup ───────────────────────────────────────────────────────────────────
export const backupApi = {
  getState: () => request<BackupState>('/backup/state'),
  triggerBackup: () => request<{ jobId: string }>('/backup/trigger', { method: 'POST' }),
};

// ─── Settings ─────────────────────────────────────────────────────────────────
export const settingsApi = {
  getSettings: () => request<TenantSettings>('/settings'),
  updateSettings: (patch: Partial<TenantSettings>) =>
    request<TenantSettings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
export interface WhatsappThread {
  chat_id: string;
  display_name: string | null;
  phone: string | null;
  is_group: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_from_me: boolean | null;
  unread_count: number;
  archived: boolean;
}

export interface WhatsappMessage {
  id: string;
  chat_id: string;
  wa_message_id: string | null;
  direction: 'inbound' | 'outbound';
  from_me: boolean;
  author: string | null;
  sender_name: string | null;
  body: string | null;
  message_type: string;
  media_url: string | null;
  ack_status: string | null;
  sent_at: string;
}

export interface WhatsappContact {
  contact_id: string;
  display_name: string | null;
  phone: string | null;
  push_name: string | null;
  verified_name: string | null;
  is_my_contact: boolean | null;
  is_blocked: boolean | null;
  is_group: boolean;
  last_seen_at: string | null;
  synced_at: string;
}

export const whatsappApi = {
  listThreads: () =>
    request<{ threads: WhatsappThread[] }>('/whatsapp/threads'),
  listContacts: () =>
    request<{ contacts: WhatsappContact[] }>('/whatsapp/contacts'),
  syncContacts: () =>
    request<{ ok: boolean; upserted: number; total: number }>(
      '/whatsapp/contacts/sync',
      { method: 'POST' },
    ),
  getMessages: (chatId: string, before?: string) =>
    request<{ chatId: string; messages: WhatsappMessage[] }>(
      `/whatsapp/threads/${encodeURIComponent(chatId)}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  send: (chatId: string, message: string) =>
    request<{ ok: boolean }>(
      `/whatsapp/threads/${encodeURIComponent(chatId)}/send`,
      { method: 'POST', body: JSON.stringify({ message }) },
    ),
  markRead: (chatId: string) =>
    request<{ ok: boolean }>(
      `/whatsapp/threads/${encodeURIComponent(chatId)}/mark-read`,
      { method: 'POST' },
    ),
};

// ─── Employee Agents (headless persistent agents — observability) ───────────────
export interface EmployeeAgentRow {
  id: string;
  name: string;
  status: string;
  cron_expression: string;
  model: string | null;
  last_run_at: string | null;
  run_count: number;
  error_count: number;
  last_result: string;
  runs_24h: string | number;
  cost_24h: string | number;
  cost_7d: string | number;
  tokens_7d: string | number;
  avg_ms_7d: number;
  last_status: string | null;
}

export const employeeAgentsApi = {
  list: () => request<{ agents: EmployeeAgentRow[] }>('/employee-agents'),
};

export { ApiClientError };
