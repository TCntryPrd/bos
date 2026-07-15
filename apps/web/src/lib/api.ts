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
    provider: 'microsoft' | 'google' | 'linkedin',
    services: readonly string[] = DEFAULT_OAUTH_SERVICES,
  ) =>
    request<{ url: string }>(`/connectors/oauth/${provider}/start`, {
      method: 'POST',
      body: JSON.stringify({ provider, services }),
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

// Unipile is LinkedIn-ONLY. WhatsApp runs on the wa-bridge (see whatsappApi below).
export interface UnipileAccountStatus {
  provider: 'LINKEDIN';
  configured: boolean;
  connected: boolean;
  accountId: string | null;
  name: string | null;
  accountType: string | null;
  health: string;
  checkedAt: string;
}

export const unipileApi = {
  getStatus: () =>
    request<{ configured: boolean; accounts: UnipileAccountStatus[]; checkedAt: string; error?: string }>('/unipile/status'),
  getConnectLink: (provider: 'LINKEDIN') =>
    request<{ provider: 'LINKEDIN'; url: string }>('/unipile/connect-link', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
};

// ─── LinkedIn ────────────────────────────────────────────────────────────────
export interface LinkedInStatus {
  connected: boolean;
  email?: string | null;
  expiresAt?: string | null;
  source?: string | null;
  accountId?: string | null;
}

export interface LinkedInPost {
  id: string;
  text: string;
  link?: string | null;
  post_id?: string | null;
  media_kind?: string | null;
  viewUrl?: string | null;
  posted_at: string;
}

export interface LinkedInPostMedia {
  type: 'image' | 'video' | 'document';
  dataBase64: string;
  filename: string;
}

export const linkedinApi = {
  getStatus: () => request<LinkedInStatus>('/linkedin/status'),
  listPosts: (limit = 20) =>
    request<{ posts: LinkedInPost[] }>(`/linkedin/posts?limit=${encodeURIComponent(String(limit))}`),
  publishPost: (body: { text: string; link?: string; media?: LinkedInPostMedia }) =>
    request<{ ok: boolean; id?: string; postId?: string | null }>('/linkedin/post', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ─── LinkedIn System ─────────────────────────────────────────────────────────
export interface LinkedInSystemAccount {
  id?: number;
  unipile_account_id?: string;
  display_name?: string | null;
  public_identifier?: string | null;
  status?: string | null;
  last_status_at?: string | null;
  connections_count?: number | null;
}

export interface LinkedInSystemMedia {
  id?: string | null;
  type: 'image' | 'video' | 'file' | string;
  raw_type?: string | null;
  url?: string | null;
  preview_url?: string | null;
  mimetype?: string | null;
  file_name?: string | null;
  size?: unknown;
  url_expires_at?: string | null;
  source_post_id?: string | null;
}

export interface LinkedInSystemPost {
  id: string;
  source: 'boss' | 'unipile' | string;
  text: string | null;
  link?: string | null;
  post_id?: string | null;
  share_url?: string | null;
  media_kind?: string | null;
  posted_at?: string | null;
  reaction_counter?: number | null;
  comment_counter?: number | null;
  repost_counter?: number | null;
  impressions_counter?: number | null;
  media?: LinkedInSystemMedia[];
}

export interface LinkedInSystemProfile {
  id: number;
  provider_id: string;
  full_name?: string | null;
  headline?: string | null;
  current_company?: string | null;
  profile_url?: string | null;
  public_profile_url?: string | null;
  picture_url?: string | null;
  network_distance?: string | null;
  first_seen_at?: string | null;
  connected_at?: string | null;
  stage?: string | null;
  next_action?: string | null;
  next_action_at?: string | null;
}

export interface LinkedInSystemInvitation {
  id: number;
  provider_id: string;
  direction: string;
  status: string;
  has_note?: boolean | null;
  sent_at?: string | null;
  responded_at?: string | null;
  created_at?: string | null;
  full_name?: string | null;
  profile_url?: string | null;
}

export interface LinkedInSystemWebhook {
  source: string;
  event_type: string;
  count: number;
  pending: number;
  last_received_at?: string | null;
  last_processed_at?: string | null;
}

export interface LinkedInSystemAction {
  id: number;
  action_type: string;
  status: string;
  payload?: {
    draft_title?: string;
    profile_full_name?: string;
    profile_provider_id?: string;
    text?: string;
    source?: string;
    media?: LinkedInSystemMedia[];
    approval_note?: string;
    external_link?: string;
    link?: string;
    source_posts?: Array<{
      social_id?: string;
      share_url?: string;
      text?: string;
      parsed_datetime?: string | null;
      media?: LinkedInSystemMedia[];
    }>;
    email_context?: {
      source?: string;
      query?: string;
      themes?: string[];
      messages?: Array<{
        id?: string;
        subject?: string;
        from?: string;
        date?: string;
        angle?: string;
        context?: string;
      }>;
    } | null;
    content_series?: {
      name?: string;
      promise?: string;
      trust_message?: string;
      messy_middle?: boolean;
    } | null;
  } | null;
  priority?: number;
  not_before?: string | null;
  attempts?: number;
  last_error?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  executed_at?: string | null;
}

export interface LinkedInSystemBudget {
  action_type: string;
  day: string;
  count: number;
  cap: number;
  updated_at?: string | null;
}

export interface LinkedInSystemOverview {
  configured: boolean;
  sync_error?: string | null;
  checked_at?: string | null;
  account?: LinkedInSystemAccount | null;
  agent: {
    running: boolean;
    last_heartbeat_at?: string | null;
    status: string;
  };
  proof?: {
    owner_public_identifier?: string | null;
    account_display_name?: string | null;
    posts_loaded: number;
    posts_visible: number;
    posts_with_media: number;
    latest_post_at?: string | null;
    last_posts_sync_at?: string | null;
    latest_media_url?: string | null;
    pending_draft_id?: number | null;
  };
  stats: {
    posts: number;
    connections_found: number;
    connections_connected: number;
    requests_sent: number;
    requests_pending: number;
    requests_accepted: number;
    messages: number;
    queued_actions: number;
    review_actions: number;
    failed_actions: number;
    webhooks_last_24h: number;
  };
  post_accept_message: {
    campaign_id?: number | null;
    message: string;
    auto_send: boolean;
    status: string;
  };
  posts: LinkedInSystemPost[];
  pending_draft?: LinkedInSystemAction | null;
  connections: {
    stage_counts: Record<string, number>;
    recent: LinkedInSystemProfile[];
  };
  invitations: {
    recent: LinkedInSystemInvitation[];
  };
  webhooks: LinkedInSystemWebhook[];
  queue: {
    status_counts: Record<string, number>;
    ready: number;
    budgets: LinkedInSystemBudget[];
    recent: LinkedInSystemAction[];
  };
}

export const linkedinSystemApi = {
  getOverview: () => request<LinkedInSystemOverview>('/linkedin-system/overview'),
  sync: () => request<{ ok: boolean; upserted?: number; draft?: LinkedInSystemAction | null; owner?: unknown }>('/linkedin-system/sync', { method: 'POST' }),
  updatePostAcceptMessage: (body: { message: string; auto_send: boolean }) =>
    request<{ ok: boolean; post_accept_message: LinkedInSystemOverview['post_accept_message'] }>(
      '/linkedin-system/post-accept-message',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  approveAction: (id: number) =>
    request<{ ok: boolean; action: LinkedInSystemAction }>(`/linkedin-system/actions/${encodeURIComponent(String(id))}/approve`, { method: 'POST' }),
  cancelAction: (id: number) =>
    request<{ ok: boolean; action: LinkedInSystemAction }>(`/linkedin-system/actions/${encodeURIComponent(String(id))}/cancel`, { method: 'POST' }),
};

// ─── Social Media ────────────────────────────────────────────────────────────
export interface SocialFacebookPost {
  id: string;
  message?: string;
  story?: string;
  type?: string;
  created_time?: string;
  permalink_url?: string;
  reactions: number;
  comments_count: number;
  shares: number;
  comments: Array<{ from: string; message: string; created_time?: string }>;
}

export interface SocialInstagramMedia {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count: number;
  comments_count: number;
  comments: Array<{ username: string; text: string }>;
}

export interface SocialData {
  facebook: null | {
    pageName: string | null;
    followers: number;
    postCount: number;
    unreadMessages: number;
    totals: { reactions: number; comments: number };
    posts: SocialFacebookPost[];
  };
  instagram: null | {
    username: string | null;
    followers: number;
    mediaCount: number;
    totals: { likes: number; comments: number };
    media: SocialInstagramMedia[];
  };
}

export const socialApi = {
  getActivity: () => request<SocialData>('/meta/social'),
  publishFacebook: (body: { message: string; link?: string }) =>
    request<{ ok: boolean; id?: string }>('/meta/fb/post', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  publishInstagram: (body: { imageUrl: string; caption?: string }) =>
    request<{ ok: boolean; id?: string }>('/meta/ig/post', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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

// ─── WhatsApp (wa-bridge / Baileys) ───────────────────────────────────────────
// WhatsApp runs on a self-hosted Baileys (@whiskeysockets/baileys) session — an
// unofficial multi-device linked device. Pairing happens on the WhatsApp page
// (disclaimer → QR scan), NOT in Settings/Connections.
export interface WhatsappSessionStatus {
  // 'not_configured' = env missing on this box; 'unreachable' = env set but the
  // wa-bridge container did not answer (transient). Both are sent by the API.
  status: 'ready' | 'scan_qr' | 'starting' | 'error' | 'not_configured' | 'unreachable';
  phone?: string | null;
}

/** No `qr` means no code to show yet — `reason` says why (never an error). */
export type WhatsappQrReason = 'pending' | 'already_paired';

export interface WhatsappQr {
  qr: string | null;
  reason: WhatsappQrReason | null;
}

export interface WhatsappStatus {
  provider: 'baileys';
  configured: boolean;
  paired: boolean;
  session: WhatsappSessionStatus;
  disclaimerAcceptedAt: string | null;
  /** True once a history import has completed — the page stops offering it. */
  historyImported: boolean;
  historyImportedAt: string | null;
}

export interface WhatsappImportSummary {
  chats: number;
  threadsUpserted: number;
  messagesInserted: number;
  messagesSkipped: number;
  mediaFetched: number;
  errors: string[];
}

/** Progress of the background history import (in-process on the API — resets on restart). */
export interface WhatsappImportStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { chatsDone: number; chatsTotal: number; messagesInserted: number };
  lastError: string | null;
  summary: WhatsappImportSummary | null;
}

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
  reply_to_wa_message_id: string | null;
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
  getStatus: () =>
    request<WhatsappStatus>('/whatsapp/status'),
  getQr: () =>
    request<WhatsappQr>('/whatsapp/qr'),
  ackDisclaimer: () =>
    request<{ ok: boolean; disclaimerAcceptedAt: string }>(
      '/whatsapp/disclaimer-ack',
      { method: 'POST' },
    ),
  logout: () =>
    request<{ ok: boolean }>(
      '/whatsapp/logout',
      { method: 'POST' },
    ),
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
  startConversation: (phone: string, message: string) =>
    request<{ ok: boolean; chatId: string | null; messageId: string | null }>(
      '/whatsapp/start-conversation',
      { method: 'POST', body: JSON.stringify({ phone, message }) },
    ),
  /**
   * Kick off the bulk import of the history WhatsApp pushed to the bridge at
   * pairing time. Returns as soon as the background job starts (409 if one is
   * already running) — poll getImportStatus() for progress.
   */
  importHistory: (opts?: { chatLimit?: number; perChatLimit?: number; media?: boolean }) =>
    request<{ started: boolean }>(
      '/whatsapp/import-history',
      { method: 'POST', body: JSON.stringify(opts ?? {}) },
    ),
  getImportStatus: () =>
    request<WhatsappImportStatus>('/whatsapp/import-history/status'),
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
