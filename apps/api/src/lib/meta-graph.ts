/**
 * Meta Graph API client + encrypted credential store.
 *
 * One module owns everything Meta:
 *   - boss_meta_credentials table (per-tenant; token fields encrypted at rest)
 *   - storeMetaCreds() / getMetaCreds() — the §6 credential contract from
 *     meta-portal/TEMPLATE-meta-app-onboarding.md
 *   - graphCall() — thin fetch wrapper over graph.facebook.com / graph.threads.net
 *   - product helpers: Facebook Messenger + Page content, Instagram, Threads,
 *     WhatsApp Cloud, Marketing (Ads) insights
 *   - metaStatus() — non-secret connection summary for the dashboard
 *
 * Encryption mirrors the canonical scheme in tools/executor.ts (aes-256-gcm,
 * key BOSS_TOKEN_ENCRYPTION_KEY, stored as `${ivHex}:${authTagHex}:${ct}`).
 * Keep in sync with executor.ts encryptToken/decryptToken if that ever changes.
 *
 * Graph API version is pinned centrally here.
 */
import crypto from 'node:crypto';
import { getPool } from '../db.js';

export const GRAPH_VERSION = 'v21.0';
const FB_BASE = 'https://graph.facebook.com';
const THREADS_BASE = 'https://graph.threads.net';
const THREADS_VERSION = 'v1.0';

// ── DDL (self-provisioned in server.ts boot block) ──────────────────────────
export const META_CREDENTIALS_DDL = `
CREATE TABLE IF NOT EXISTS boss_meta_credentials (
  tenant_id            TEXT PRIMARY KEY DEFAULT 'default',
  app_id               TEXT,
  app_secret_enc       TEXT,
  webhook_verify_token TEXT,
  system_user_token_enc TEXT,
  fb_page_id           TEXT,
  fb_page_name         TEXT,
  fb_page_token_enc    TEXT,
  ig_business_id       TEXT,
  ig_token_enc         TEXT,
  threads_user_id      TEXT,
  threads_token_enc    TEXT,
  wa_waba_id           TEXT,
  wa_phone_number_id   TEXT,
  wa_display_phone     TEXT,
  wa_token_enc         TEXT,
  ads_account_id       TEXT,
  ads_token_enc        TEXT,
  status               TEXT NOT NULL DEFAULT 'disconnected',
  connected_at         TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS boss_meta_events (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'default',
  object       TEXT,
  event_type   TEXT,
  external_id  TEXT,
  summary      TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meta_events_created ON boss_meta_events (created_at DESC);
CREATE TABLE IF NOT EXISTS boss_fb_threads (
  tenant_id        TEXT NOT NULL DEFAULT 'default',
  conversation_id  TEXT NOT NULL,
  platform         TEXT NOT NULL DEFAULT 'messenger',
  participant_id   TEXT,
  participant_name TEXT,
  last_message_at  TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_from_page BOOLEAN DEFAULT FALSE,
  unread_count     INT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS boss_fb_messages (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  conversation_id TEXT,
  mid           TEXT,
  platform      TEXT NOT NULL DEFAULT 'messenger',
  direction     TEXT NOT NULL,
  sender_id     TEXT,
  sender_name   TEXT,
  body          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mid)
);
-- WhatsApp surface tables. Shared with the WhatsApp bridge (Baileys); this
-- self-provisions them on a fresh box (e.g. a client) so the WhatsApp Cloud
-- webhook fan-out + tile work everywhere. IF NOT EXISTS = no-op where present.
CREATE TABLE IF NOT EXISTS boss_whatsapp_threads (
  tenant_id            TEXT NOT NULL DEFAULT 'default',
  chat_id              TEXT NOT NULL,
  display_name         TEXT,
  phone                TEXT,
  is_group             BOOLEAN NOT NULL DEFAULT false,
  last_message_wa_id   TEXT,
  last_message_at      TIMESTAMPTZ,
  last_message_preview TEXT,
  last_message_from_me BOOLEAN,
  unread_count         INTEGER NOT NULL DEFAULT 0,
  archived             BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chat_id)
);
CREATE TABLE IF NOT EXISTS boss_whatsapp_messages (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              TEXT NOT NULL DEFAULT 'default',
  chat_id                TEXT NOT NULL,
  wa_message_id          TEXT,
  direction              TEXT NOT NULL,
  from_me                BOOLEAN NOT NULL,
  author                 TEXT,
  sender_name            TEXT,
  body                   TEXT,
  message_type           TEXT NOT NULL DEFAULT 'text',
  media_url              TEXT,
  reply_to_wa_message_id TEXT,
  ack_status             TEXT,
  sent_at                TIMESTAMPTZ NOT NULL,
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_wa_id ON boss_whatsapp_messages (tenant_id, wa_message_id) WHERE (wa_message_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_wa_messages_thread ON boss_whatsapp_messages (tenant_id, chat_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_threads_last ON boss_whatsapp_threads (tenant_id, last_message_at DESC) WHERE (archived = false);
CREATE TABLE IF NOT EXISTS boss_whatsapp_contacts (
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  contact_id    TEXT NOT NULL,
  display_name  TEXT, phone TEXT, push_name TEXT, verified_name TEXT,
  is_my_contact BOOLEAN, is_blocked BOOLEAN, is_group BOOLEAN NOT NULL DEFAULT false,
  source_payload JSONB, last_seen_at TIMESTAMPTZ,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id)
);
CREATE TABLE IF NOT EXISTS boss_whatsapp_scheduled (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  chat_id        TEXT NOT NULL, message TEXT NOT NULL,
  send_at        TIMESTAMPTZ NOT NULL, created_by TEXT NOT NULL,
  draft_approved BOOLEAN DEFAULT false, sent_at TIMESTAMPTZ, wa_message_id TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', context JSONB DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Per-app (role) credential columns. The primary row holds the SOCIAL app (#1:
-- FB+IG content). Messaging = the separate Messenger app (#2); wa_app_* = the
-- WhatsApp app (#3). Each carries its own app id + secret so the webhook can
-- verify each app's signature and each agent uses the right app's token.
ALTER TABLE boss_meta_credentials ADD COLUMN IF NOT EXISTS fb_messaging_app_id TEXT;
ALTER TABLE boss_meta_credentials ADD COLUMN IF NOT EXISTS fb_messaging_app_secret_enc TEXT;
ALTER TABLE boss_meta_credentials ADD COLUMN IF NOT EXISTS fb_messaging_token_enc TEXT;
ALTER TABLE boss_meta_credentials ADD COLUMN IF NOT EXISTS wa_app_id TEXT;
ALTER TABLE boss_meta_credentials ADD COLUMN IF NOT EXISTS wa_app_secret_enc TEXT;
`;

// ── Encryption (mirrors executor.ts) ────────────────────────────────────────
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.BOSS_TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error('BOSS_TOKEN_ENCRYPTION_KEY must be set (64-char hex = 32 bytes)');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error(`BOSS_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${key.length}`);
  return key;
}

function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 3) return null;
  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const ct = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── Types (the §6 contract, normalized to camelCase) ────────────────────────
export interface MetaCreds {
  tenant: string;
  appId: string | null;
  appSecret: string | null;
  webhookVerifyToken: string | null;
  systemUserToken: string | null;
  facebook: { pageId: string | null; pageName: string | null; pageAccessToken: string | null };
  messaging: { appId: string | null; appSecret: string | null; pageAccessToken: string | null };
  instagram: { igBusinessAccountId: string | null; accessToken: string | null };
  threads: { threadsUserId: string | null; accessToken: string | null };
  whatsapp: { wabaId: string | null; phoneNumberId: string | null; displayPhone: string | null; accessToken: string | null; appId: string | null; appSecret: string | null };
  ads: { adAccountId: string | null; accessToken: string | null };
  status: string;
}

/** The loose snake_case JSON accepted by the register endpoint (TEMPLATE §6). */
export interface MetaCredsInput {
  tenant?: string;
  app_id?: string;
  app_secret?: string;
  webhook_verify_token?: string;
  system_user_token?: string;
  facebook?: { page_id?: string; page_name?: string; page_access_token?: string };
  messaging?: { app_id?: string; app_secret?: string; page_access_token?: string };
  instagram?: { ig_business_account_id?: string; access_token?: string };
  threads?: { threads_user_id?: string; access_token?: string };
  whatsapp?: { waba_id?: string; phone_number_id?: string; display_phone?: string; access_token?: string; app_id?: string; app_secret?: string };
  ads?: { ad_account_id?: string; access_token?: string };
}

// ── Store + fetch ───────────────────────────────────────────────────────────
const credsCache = new Map<string, { creds: MetaCreds; at: number }>();
const CACHE_TTL_MS = 30_000;

export function clearMetaCredsCache(tenant = 'default'): void {
  credsCache.delete(tenant);
}

/** Upsert credentials from the §6 JSON. Token fields are encrypted at rest. */
export async function storeMetaCreds(input: MetaCredsInput): Promise<MetaCreds> {
  const tenant = input.tenant || 'default';
  const sysToken = input.system_user_token ?? null;
  // Product tokens fall back to the system-user token when not given explicitly.
  const pageToken = input.facebook?.page_access_token ?? sysToken;
  const igToken = input.instagram?.access_token ?? sysToken;
  const threadsToken = input.threads?.access_token ?? sysToken;
  const waToken = input.whatsapp?.access_token ?? sysToken;
  const adsToken = input.ads?.access_token ?? sysToken;

  await getPool().query(
    `INSERT INTO boss_meta_credentials (
       tenant_id, app_id, app_secret_enc, webhook_verify_token, system_user_token_enc,
       fb_page_id, fb_page_name, fb_page_token_enc,
       ig_business_id, ig_token_enc,
       threads_user_id, threads_token_enc,
       wa_waba_id, wa_phone_number_id, wa_display_phone, wa_token_enc,
       ads_account_id, ads_token_enc,
       fb_messaging_app_id, fb_messaging_app_secret_enc, fb_messaging_token_enc,
       wa_app_id, wa_app_secret_enc,
       status, connected_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'connected', now(), now()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       app_id = COALESCE(EXCLUDED.app_id, boss_meta_credentials.app_id),
       app_secret_enc = COALESCE(EXCLUDED.app_secret_enc, boss_meta_credentials.app_secret_enc),
       webhook_verify_token = COALESCE(EXCLUDED.webhook_verify_token, boss_meta_credentials.webhook_verify_token),
       system_user_token_enc = COALESCE(EXCLUDED.system_user_token_enc, boss_meta_credentials.system_user_token_enc),
       fb_page_id = COALESCE(EXCLUDED.fb_page_id, boss_meta_credentials.fb_page_id),
       fb_page_name = COALESCE(EXCLUDED.fb_page_name, boss_meta_credentials.fb_page_name),
       fb_page_token_enc = COALESCE(EXCLUDED.fb_page_token_enc, boss_meta_credentials.fb_page_token_enc),
       ig_business_id = COALESCE(EXCLUDED.ig_business_id, boss_meta_credentials.ig_business_id),
       ig_token_enc = COALESCE(EXCLUDED.ig_token_enc, boss_meta_credentials.ig_token_enc),
       threads_user_id = COALESCE(EXCLUDED.threads_user_id, boss_meta_credentials.threads_user_id),
       threads_token_enc = COALESCE(EXCLUDED.threads_token_enc, boss_meta_credentials.threads_token_enc),
       wa_waba_id = COALESCE(EXCLUDED.wa_waba_id, boss_meta_credentials.wa_waba_id),
       wa_phone_number_id = COALESCE(EXCLUDED.wa_phone_number_id, boss_meta_credentials.wa_phone_number_id),
       wa_display_phone = COALESCE(EXCLUDED.wa_display_phone, boss_meta_credentials.wa_display_phone),
       wa_token_enc = COALESCE(EXCLUDED.wa_token_enc, boss_meta_credentials.wa_token_enc),
       ads_account_id = COALESCE(EXCLUDED.ads_account_id, boss_meta_credentials.ads_account_id),
       ads_token_enc = COALESCE(EXCLUDED.ads_token_enc, boss_meta_credentials.ads_token_enc),
       fb_messaging_app_id = COALESCE(EXCLUDED.fb_messaging_app_id, boss_meta_credentials.fb_messaging_app_id),
       fb_messaging_app_secret_enc = COALESCE(EXCLUDED.fb_messaging_app_secret_enc, boss_meta_credentials.fb_messaging_app_secret_enc),
       fb_messaging_token_enc = COALESCE(EXCLUDED.fb_messaging_token_enc, boss_meta_credentials.fb_messaging_token_enc),
       wa_app_id = COALESCE(EXCLUDED.wa_app_id, boss_meta_credentials.wa_app_id),
       wa_app_secret_enc = COALESCE(EXCLUDED.wa_app_secret_enc, boss_meta_credentials.wa_app_secret_enc),
       status = 'connected',
       connected_at = COALESCE(boss_meta_credentials.connected_at, now()),
       updated_at = now()`,
    [
      tenant,
      input.app_id ?? null,
      encryptSecret(input.app_secret),
      input.webhook_verify_token ?? null,
      encryptSecret(sysToken),
      input.facebook?.page_id ?? null,
      input.facebook?.page_name ?? null,
      encryptSecret(pageToken),
      input.instagram?.ig_business_account_id ?? null,
      encryptSecret(igToken),
      input.threads?.threads_user_id ?? null,
      encryptSecret(threadsToken),
      input.whatsapp?.waba_id ?? null,
      input.whatsapp?.phone_number_id ?? null,
      input.whatsapp?.display_phone ?? null,
      encryptSecret(waToken),
      input.ads?.ad_account_id ?? null,
      encryptSecret(adsToken),
      input.messaging?.app_id ?? null,
      encryptSecret(input.messaging?.app_secret),
      encryptSecret(input.messaging?.page_access_token),
      input.whatsapp?.app_id ?? null,
      encryptSecret(input.whatsapp?.app_secret),
    ],
  );
  clearMetaCredsCache(tenant);
  const fresh = await getMetaCreds(tenant);
  if (!fresh) throw new Error('failed to read back stored Meta credentials');
  return fresh;
}

export async function getMetaCreds(tenant = 'default'): Promise<MetaCreds | null> {
  const cached = credsCache.get(tenant);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.creds;

  const { rows } = await getPool().query(
    `SELECT * FROM boss_meta_credentials WHERE tenant_id = $1`,
    [tenant],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const creds: MetaCreds = {
    tenant,
    appId: r.app_id ?? null,
    appSecret: decryptSecret(r.app_secret_enc),
    webhookVerifyToken: r.webhook_verify_token ?? null,
    systemUserToken: decryptSecret(r.system_user_token_enc),
    facebook: { pageId: r.fb_page_id ?? null, pageName: r.fb_page_name ?? null, pageAccessToken: decryptSecret(r.fb_page_token_enc) },
    messaging: { appId: r.fb_messaging_app_id ?? null, appSecret: decryptSecret(r.fb_messaging_app_secret_enc), pageAccessToken: decryptSecret(r.fb_messaging_token_enc) },
    instagram: { igBusinessAccountId: r.ig_business_id ?? null, accessToken: decryptSecret(r.ig_token_enc) },
    threads: { threadsUserId: r.threads_user_id ?? null, accessToken: decryptSecret(r.threads_token_enc) },
    whatsapp: { wabaId: r.wa_waba_id ?? null, phoneNumberId: r.wa_phone_number_id ?? null, displayPhone: r.wa_display_phone ?? null, accessToken: decryptSecret(r.wa_token_enc), appId: r.wa_app_id ?? null, appSecret: decryptSecret(r.wa_app_secret_enc) },
    ads: { adAccountId: r.ads_account_id ?? null, accessToken: decryptSecret(r.ads_token_enc) },
    status: r.status ?? 'disconnected',
  };
  credsCache.set(tenant, { creds, at: Date.now() });
  return creds;
}

/** Non-secret connection summary for the dashboard / status route. */
export interface MetaStatus {
  configured: boolean;
  status: string;
  appId: string | null;
  products: {
    facebook: { connected: boolean; pageId: string | null; pageName: string | null };
    messaging: { connected: boolean };
    instagram: { connected: boolean; igBusinessAccountId: string | null };
    threads: { connected: boolean; threadsUserId: string | null };
    whatsapp: { connected: boolean; wabaId: string | null; phoneNumberId: string | null; displayPhone: string | null; goLive: boolean };
    ads: { connected: boolean; adAccountId: string | null };
  };
}

export function metaStatus(creds: MetaCreds | null): MetaStatus {
  const c = creds;
  return {
    configured: !!c && !!c.appId,
    status: c?.status ?? 'disconnected',
    appId: c?.appId ?? null,
    products: {
      facebook: { connected: !!c?.facebook.pageId && !!c?.facebook.pageAccessToken, pageId: c?.facebook.pageId ?? null, pageName: c?.facebook.pageName ?? null },
      messaging: { connected: !!(c?.messaging.pageAccessToken || c?.facebook.pageAccessToken) && !!c?.facebook.pageId },
      instagram: { connected: !!c?.instagram.igBusinessAccountId && !!c?.instagram.accessToken, igBusinessAccountId: c?.instagram.igBusinessAccountId ?? null },
      threads: { connected: !!c?.threads.threadsUserId && !!c?.threads.accessToken, threadsUserId: c?.threads.threadsUserId ?? null },
      whatsapp: {
        // "connected" = WABA known; "goLive" = phone number registered (Kevin's manual step).
        connected: !!c?.whatsapp.wabaId,
        wabaId: c?.whatsapp.wabaId ?? null,
        phoneNumberId: c?.whatsapp.phoneNumberId ?? null,
        displayPhone: c?.whatsapp.displayPhone ?? null,
        goLive: !!c?.whatsapp.phoneNumberId && !!c?.whatsapp.accessToken,
      },
      ads: { connected: !!c?.ads.adAccountId && !!c?.ads.accessToken, adAccountId: c?.ads.adAccountId ?? null },
    },
  };
}

// ── Graph fetch ─────────────────────────────────────────────────────────────
export class MetaGraphError extends Error {
  constructor(message: string, public code?: number, public type?: string, public fbtraceId?: string) {
    super(message);
    this.name = 'MetaGraphError';
  }
}

interface GraphOpts {
  token: string;
  method?: 'GET' | 'POST' | 'DELETE';
  params?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  base?: string;
  version?: string;
}

export async function graphCall<T = Record<string, unknown>>(path: string, opts: GraphOpts): Promise<T> {
  const base = opts.base ?? FB_BASE;
  const version = opts.version ?? GRAPH_VERSION;
  // Encode each path segment so a caller-supplied id can't alter the path/query.
  const cleanPath = path.replace(/^\//, '').split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const url = new URL(`${base}/${version}/${cleanPath}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const method = opts.method ?? 'GET';
  // Token goes in the Authorization header — NOT the query string — so it can
  // never leak into a logged request URL or upstream access log.
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(20_000) };
  if (opts.body && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || (json as { error?: unknown }).error) {
    const err = (json as { error?: { message?: string; code?: number; type?: string; fbtrace_id?: string } }).error;
    throw new MetaGraphError(err?.message || `Graph ${method} ${path} failed (${res.status})`, err?.code, err?.type, err?.fbtrace_id);
  }
  return json as T;
}

function requireToken(token: string | null | undefined, what: string): string {
  if (!token) throw new MetaGraphError(`Meta not connected: missing ${what}. Register credentials at /api/meta/credentials.`);
  return token;
}

/** FB Messenger uses the dedicated Messaging app (#2) token when present,
 *  else falls back to the social Page token. The page id is shared. */
function messagingToken(creds: MetaCreds): string {
  return requireToken(creds.messaging.pageAccessToken ?? creds.facebook.pageAccessToken, 'Facebook Messenger token (app #2 pages_messaging)');
}

// ── Facebook (Messenger + Page) ─────────────────────────────────────────────
export async function fbListConversations(creds: MetaCreds, limit = 25): Promise<unknown[]> {
  const token = messagingToken(creds);
  const pageId = requireToken(creds.facebook.pageId, 'Facebook Page ID');
  const r = await graphCall<{ data?: unknown[] }>(`${pageId}/conversations`, {
    token, params: { platform: 'messenger', fields: 'id,snippet,updated_time,unread_count,participants', limit },
  });
  return r.data ?? [];
}

export async function fbGetMessages(creds: MetaCreds, conversationId: string, limit = 25): Promise<unknown[]> {
  const token = messagingToken(creds);
  const r = await graphCall<{ messages?: { data?: unknown[] } }>(`${conversationId}`, {
    token, params: { fields: `messages.limit(${limit}){message,from,to,created_time}` },
  });
  return r.messages?.data ?? [];
}

export async function fbSendMessage(creds: MetaCreds, recipientId: string, text: string): Promise<{ message_id?: string }> {
  const token = messagingToken(creds);
  const pageId = requireToken(creds.facebook.pageId, 'Facebook Page ID');
  return graphCall(`${pageId}/messages`, {
    token, method: 'POST',
    body: { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } },
  });
}

export async function fbPublishPost(creds: MetaCreds, message: string, link?: string): Promise<{ id?: string }> {
  const token = requireToken(creds.facebook.pageAccessToken, 'Facebook Page token');
  const pageId = requireToken(creds.facebook.pageId, 'Facebook Page ID');
  const body: Record<string, unknown> = { message };
  if (link) body.link = link;
  return graphCall(`${pageId}/feed`, { token, method: 'POST', body });
}

/** A "notifications" view of the Page: recent posts (with comment/reaction
 *  counts) + unread Messenger count. Polled by the Facebook dashboard tile. */
export interface FbActivity {
  pageName: string | null;
  unreadMessages: number;
  posts: Array<{ id?: string; message?: string; story?: string; created_time?: string; permalink_url?: string; comments?: number; reactions?: number }>;
}
export async function fbPageActivity(creds: MetaCreds, limit = 10): Promise<FbActivity> {
  const token = requireToken(creds.facebook.pageAccessToken, 'Facebook Page token');
  const pageId = requireToken(creds.facebook.pageId, 'Facebook Page ID');
  const feed = await graphCall<{ data?: Array<Record<string, unknown>> }>(`${pageId}/feed`, {
    token,
    params: { fields: 'message,story,created_time,permalink_url,comments.summary(true).limit(0),reactions.summary(true).limit(0)', limit },
  });
  let unreadMessages = 0;
  try {
    const conv = await graphCall<{ data?: Array<{ unread_count?: number }> }>(`${pageId}/conversations`, {
      token: messagingToken(creds), params: { fields: 'unread_count', limit: 50 },
    });
    unreadMessages = (conv.data ?? []).reduce((n, c) => n + (c.unread_count ?? 0), 0);
  } catch { /* messaging may not be connected yet */ }
  const posts = (feed.data ?? []).map((p) => ({
    id: p.id as string | undefined,
    message: p.message as string | undefined,
    story: p.story as string | undefined,
    created_time: p.created_time as string | undefined,
    permalink_url: p.permalink_url as string | undefined,
    comments: (p.comments as { summary?: { total_count?: number } } | undefined)?.summary?.total_count ?? 0,
    reactions: (p.reactions as { summary?: { total_count?: number } } | undefined)?.summary?.total_count ?? 0,
  }));
  return { pageName: creds.facebook.pageName, unreadMessages, posts };
}

/** Rich Facebook + Instagram activity for the social tiles: posts/media with
 *  commenters, reactions/likes, types, shares, plus follower/engagement totals. */
export interface SocialActivity {
  facebook: null | {
    pageName: string | null; followers: number; postCount: number; unreadMessages: number;
    totals: { reactions: number; comments: number };
    posts: Array<{ id?: string; message?: string; story?: string; type?: string; created_time?: string; permalink_url?: string; reactions: number; comments_count: number; shares: number; comments: Array<{ from: string; message: string; created_time?: string }> }>;
  };
  instagram: null | {
    username: string | null; followers: number; mediaCount: number;
    totals: { likes: number; comments: number };
    media: Array<{ id?: string; caption?: string; media_type?: string; permalink?: string; timestamp?: string; like_count: number; comments_count: number; comments: Array<{ username: string; text: string }> }>;
  };
}

export async function socialActivity(creds: MetaCreds, limit = 8): Promise<SocialActivity> {
  const out: SocialActivity = { facebook: null, instagram: null };

  if (creds.facebook.pageId && creds.facebook.pageAccessToken) {
    const token = creds.facebook.pageAccessToken;
    const pageId = creds.facebook.pageId;
    try {
      const page = await graphCall<{ name?: string; fan_count?: number; followers_count?: number }>(pageId, { token, params: { fields: 'name,fan_count,followers_count' } });
      const feed = await graphCall<{ data?: Array<Record<string, unknown>> }>(`${pageId}/feed`, {
        token,
        params: { fields: 'message,story,status_type,created_time,permalink_url,shares,comments.summary(true).limit(5){from{name},message,created_time},reactions.summary(true).limit(0)', limit },
      });
      let unread = 0;
      try {
        const conv = await graphCall<{ data?: Array<{ unread_count?: number }> }>(`${pageId}/conversations`, { token: messagingToken(creds), params: { fields: 'unread_count', limit: 50 } });
        unread = (conv.data ?? []).reduce((n, c) => n + (c.unread_count ?? 0), 0);
      } catch { /* messaging optional */ }
      let totR = 0, totC = 0;
      const posts = (feed.data ?? []).map((p) => {
        const reactions = (p.reactions as { summary?: { total_count?: number } } | undefined)?.summary?.total_count ?? 0;
        const cObj = p.comments as { summary?: { total_count?: number }; data?: Array<{ from?: { name?: string }; message?: string; created_time?: string }> } | undefined;
        const comments_count = cObj?.summary?.total_count ?? 0;
        totR += reactions; totC += comments_count;
        return {
          id: p.id as string | undefined, message: p.message as string | undefined, story: p.story as string | undefined,
          type: p.status_type as string | undefined, created_time: p.created_time as string | undefined, permalink_url: p.permalink_url as string | undefined,
          reactions, comments_count, shares: (p.shares as { count?: number } | undefined)?.count ?? 0,
          comments: (cObj?.data ?? []).map((cm) => ({ from: cm.from?.name ?? 'unknown', message: cm.message ?? '', created_time: cm.created_time })),
        };
      });
      out.facebook = { pageName: page.name ?? creds.facebook.pageName, followers: page.followers_count ?? page.fan_count ?? 0, postCount: posts.length, unreadMessages: unread, totals: { reactions: totR, comments: totC }, posts };
    } catch {
      out.facebook = { pageName: creds.facebook.pageName, followers: 0, postCount: 0, unreadMessages: 0, totals: { reactions: 0, comments: 0 }, posts: [] };
    }
  }

  if (creds.instagram.igBusinessAccountId && creds.instagram.accessToken) {
    const token = creds.instagram.accessToken;
    const igId = creds.instagram.igBusinessAccountId;
    try {
      const acct = await graphCall<{ username?: string; followers_count?: number; media_count?: number }>(igId, { token, params: { fields: 'username,followers_count,media_count' } });
      const media = await graphCall<{ data?: Array<Record<string, unknown>> }>(`${igId}/media`, { token, params: { fields: 'caption,media_type,permalink,timestamp,like_count,comments_count,comments.limit(5){username,text}', limit } });
      let totL = 0, totC = 0;
      const mediaArr = (media.data ?? []).map((m) => {
        const like_count = (m.like_count as number) ?? 0;
        const comments_count = (m.comments_count as number) ?? 0;
        totL += like_count; totC += comments_count;
        const cObj = m.comments as { data?: Array<{ username?: string; text?: string }> } | undefined;
        return { id: m.id as string | undefined, caption: m.caption as string | undefined, media_type: m.media_type as string | undefined, permalink: m.permalink as string | undefined, timestamp: m.timestamp as string | undefined, like_count, comments_count, comments: (cObj?.data ?? []).map((c) => ({ username: c.username ?? 'unknown', text: c.text ?? '' })) };
      });
      out.instagram = { username: acct.username ?? null, followers: acct.followers_count ?? 0, mediaCount: acct.media_count ?? 0, totals: { likes: totL, comments: totC }, media: mediaArr };
    } catch {
      out.instagram = { username: null, followers: 0, mediaCount: 0, totals: { likes: 0, comments: 0 }, media: [] };
    }
  }

  return out;
}

// ── Instagram ───────────────────────────────────────────────────────────────
export async function igPublishPost(creds: MetaCreds, imageUrl: string, caption?: string): Promise<{ id?: string }> {
  const token = requireToken(creds.instagram.accessToken, 'Instagram token');
  const igId = requireToken(creds.instagram.igBusinessAccountId, 'Instagram Business account ID');
  const container = await graphCall<{ id?: string }>(`${igId}/media`, {
    token, method: 'POST', body: { image_url: imageUrl, caption: caption ?? '' },
  });
  if (!container.id) throw new MetaGraphError('Instagram media container creation returned no id');
  return graphCall(`${igId}/media_publish`, { token, method: 'POST', body: { creation_id: container.id } });
}

// ── Threads ─────────────────────────────────────────────────────────────────
export async function threadsPublish(creds: MetaCreds, text: string): Promise<{ id?: string }> {
  const token = requireToken(creds.threads.accessToken, 'Threads token');
  const userId = requireToken(creds.threads.threadsUserId, 'Threads user ID');
  const container = await graphCall<{ id?: string }>(`${userId}/threads`, {
    token, method: 'POST', base: THREADS_BASE, version: THREADS_VERSION,
    body: { media_type: 'TEXT', text },
  });
  if (!container.id) throw new MetaGraphError('Threads container creation returned no id');
  return graphCall(`${userId}/threads_publish`, {
    token, method: 'POST', base: THREADS_BASE, version: THREADS_VERSION, body: { creation_id: container.id },
  });
}

// ── WhatsApp Cloud (built; parked until phone number registered) ────────────
export async function waCloudSend(creds: MetaCreds, to: string, text: string): Promise<{ messages?: unknown[] }> {
  const token = requireToken(creds.whatsapp.accessToken, 'WhatsApp token');
  const phoneId = requireToken(creds.whatsapp.phoneNumberId, 'WhatsApp phone number ID');
  return graphCall(`${phoneId}/messages`, {
    token, method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } },
  });
}

// ── Ads / Marketing insights ────────────────────────────────────────────────
export async function adsInsights(creds: MetaCreds, datePreset = 'last_7d', level = 'account'): Promise<unknown[]> {
  const token = requireToken(creds.ads.accessToken, 'Ads token');
  const acct = requireToken(creds.ads.adAccountId, 'Ad account ID');
  const r = await graphCall<{ data?: unknown[] }>(`${acct}/insights`, {
    token, params: {
      date_preset: datePreset, level,
      fields: 'campaign_name,spend,impressions,clicks,cpc,cpm,ctr,reach,actions,cost_per_action_type',
    },
  });
  return r.data ?? [];
}
