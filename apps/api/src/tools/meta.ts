/**
 * Meta (Facebook / Instagram / Threads / WhatsApp Cloud / Ads) brain tools.
 *
 * Definitions + execution handlers live together here; executor.ts imports
 * META_TOOL_HANDLERS and spreads it into its TOOL_HANDLERS map, and index.ts
 * pushes ALL_META_TOOLS into the registry when Meta credentials are stored.
 *
 * All Graph calls go through ../lib/meta-graph.js, which reads the per-tenant
 * encrypted credentials from boss_meta_credentials.
 */
import type { BrainTool } from '@boss/brain';
import {
  getMetaCreds, metaStatus,
  fbListConversations, fbGetMessages, fbSendMessage, fbPublishPost,
  igPublishPost, threadsPublish, adsInsights, waCloudSend,
} from '../lib/meta-graph.js';
import { isUnipileConfigured, startUnipileWhatsAppChat } from '../lib/unipile.js';

// ── Definitions ─────────────────────────────────────────────────────────────
export const metaStatusTool: BrainTool = {
  name: 'meta_status',
  description: 'Report which Meta products (Facebook Page, Instagram, Threads, WhatsApp, Ads) are connected for this business. Use before attempting a Meta action to confirm the relevant product is live.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const metaFbListConversationsTool: BrainTool = {
  name: 'meta_fb_list_conversations',
  description: 'List recent Facebook Messenger conversations on the connected Page (most recently updated first), with conversation id, participant, snippet, and unread count.',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Max conversations (1–50). Default 25.' } },
    required: [],
  },
};

export const metaFbGetMessagesTool: BrainTool = {
  name: 'meta_fb_get_messages',
  description: 'Read recent messages in a Facebook Messenger conversation. Returns each message text, sender, and time.',
  parameters: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'The conversation id from meta_fb_list_conversations.' },
      limit: { type: 'number', description: 'Max messages (1–50). Default 25.' },
    },
    required: ['conversation_id'],
  },
};

export const metaFbSendMessageTool: BrainTool = {
  name: 'meta_fb_send_message',
  description: 'Send a Facebook Messenger reply to a user. Only use within the messaging policy window. recipient_id is the user PSID (the participant id from a conversation).',
  parameters: {
    type: 'object',
    properties: {
      recipient_id: { type: 'string', description: 'The recipient PSID (participant id).' },
      text: { type: 'string', description: 'The reply text.' },
    },
    required: ['recipient_id', 'text'],
  },
};

export const metaFbPublishPostTool: BrainTool = {
  name: 'meta_fb_publish_post',
  description: 'Publish a post to the connected Facebook Page feed. Use only when content publishing is explicitly authorized; otherwise draft and seek approval first.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The post text.' },
      link: { type: 'string', description: 'Optional URL to attach.' },
    },
    required: ['message'],
  },
};

export const metaIgPublishPostTool: BrainTool = {
  name: 'meta_ig_publish_post',
  description: 'Publish a single-image post to the connected Instagram Business account. Requires a publicly reachable image URL.',
  parameters: {
    type: 'object',
    properties: {
      image_url: { type: 'string', description: 'Publicly accessible image URL.' },
      caption: { type: 'string', description: 'Optional caption.' },
    },
    required: ['image_url'],
  },
};

export const metaThreadsPublishTool: BrainTool = {
  name: 'meta_threads_publish',
  description: 'Publish a text post to the connected Threads account.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The Threads post text.' } },
    required: ['text'],
  },
};

export const metaAdsInsightsTool: BrainTool = {
  name: 'meta_ads_insights',
  description: 'Read advertising performance insights (spend, impressions, clicks, CPC, CPM, CTR, reach, conversions) for the connected ad account. Read-only — never mutates campaigns.',
  parameters: {
    type: 'object',
    properties: {
      date_preset: { type: 'string', description: 'today | yesterday | last_7d | last_14d | last_30d | this_month | last_month. Default last_7d.' },
      level: { type: 'string', description: 'account | campaign | adset | ad. Default campaign.' },
    },
    required: [],
  },
};

export const metaWaSendTool: BrainTool = {
  name: 'meta_wa_send',
  description: 'Send a WhatsApp text message through the connected Unipile WhatsApp account. to is an E.164 phone number, with or without "+".',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient phone in E.164 without leading +, e.g. 15551234567.' },
      text: { type: 'string', description: 'Message body.' },
    },
    required: ['to', 'text'],
  },
};

export const ALL_META_TOOLS: BrainTool[] = [
  metaStatusTool,
  metaFbListConversationsTool,
  metaFbGetMessagesTool,
  metaFbSendMessageTool,
  metaFbPublishPostTool,
  metaIgPublishPostTool,
  metaThreadsPublishTool,
  metaAdsInsightsTool,
  metaWaSendTool,
];

export const ALL_WHATSAPP_TOOLS: BrainTool[] = [metaWaSendTool];

// ── Handlers ──────────────────────────────────────────────────────────────
type Handler = (args: Record<string, unknown>) => Promise<string>;
const TENANT = 'default';

function str(v: unknown): string | undefined { return typeof v === 'string' && v.trim() ? v.trim() : undefined; }
function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

async function creds() {
  const c = await getMetaCreds(TENANT);
  if (!c || !c.appId) throw new Error('Meta is not connected yet. Register credentials at POST /api/meta/credentials (see the onboarding template).');
  return c;
}

async function handleMetaStatus(): Promise<string> {
  const c = await getMetaCreds(TENANT);
  const s = metaStatus(c);
  if (!s.configured) return 'Meta is not connected. No app credentials are stored yet.';
  const p = s.products;
  const lines = [
    `Meta connection: ${s.status} (app ${s.appId})`,
    `• Facebook: ${p.facebook.connected ? `connected — ${p.facebook.pageName ?? p.facebook.pageId}` : 'not connected'}`,
    `• Instagram: ${p.instagram.connected ? `connected (${p.instagram.igBusinessAccountId})` : 'not connected'}`,
    `• Threads: ${p.threads.connected ? `connected (${p.threads.threadsUserId})` : 'not connected'}`,
    `• WhatsApp: ${p.whatsapp.goLive ? `LIVE (${p.whatsapp.displayPhone ?? p.whatsapp.phoneNumberId})` : p.whatsapp.connected ? 'WABA linked — phone number not yet registered (parked)' : 'not connected'}`,
    `• Ads: ${p.ads.connected ? `connected (${p.ads.adAccountId})` : 'not connected'}`,
  ];
  return lines.join('\n');
}

async function handleFbListConversations(args: Record<string, unknown>): Promise<string> {
  const c = await creds();
  const convos = await fbListConversations(c, num(args.limit, 25, 1, 50)) as Array<Record<string, unknown>>;
  if (convos.length === 0) return 'No Facebook Messenger conversations found.';
  return convos.map((cv) => {
    const parts = (cv.participants as { data?: Array<{ name?: string; id?: string }> } | undefined)?.data ?? [];
    const other = parts.find((x) => x.id !== c.facebook.pageId) ?? parts[0];
    return `- [${cv.id}] ${other?.name ?? other?.id ?? 'unknown'} · unread ${cv.unread_count ?? 0} · "${String(cv.snippet ?? '').slice(0, 80)}" (${cv.updated_time ?? ''})`;
  }).join('\n');
}

async function handleFbGetMessages(args: Record<string, unknown>): Promise<string> {
  const c = await creds();
  const cid = str(args.conversation_id);
  if (!cid) return 'Error: conversation_id is required.';
  const msgs = await fbGetMessages(c, cid, num(args.limit, 25, 1, 50)) as Array<Record<string, unknown>>;
  if (msgs.length === 0) return 'No messages in that conversation.';
  return msgs.map((m) => {
    const from = (m.from as { name?: string; id?: string } | undefined);
    return `[${m.created_time ?? ''}] ${from?.name ?? from?.id ?? '?'}: ${String(m.message ?? '').slice(0, 240)}`;
  }).reverse().join('\n');
}

async function handleFbSendMessage(args: Record<string, unknown>): Promise<string> {
  const c = await creds();
  const rid = str(args.recipient_id);
  const text = str(args.text);
  if (!rid || !text) return 'Error: recipient_id and text are required.';
  const r = await fbSendMessage(c, rid, text);
  return `Sent Facebook Messenger reply to ${rid} (message_id ${r.message_id ?? 'n/a'}).`;
}

async function handleFbPublishPost(args: Record<string, unknown>): Promise<string> {
  const c = await creds();
  const message = str(args.message);
  if (!message) return 'Error: message is required.';
  const r = await fbPublishPost(c, message, str(args.link));
  return `Published Facebook Page post (id ${r.id ?? 'n/a'}).`;
}

async function handleIgPublishPost(args: Record<string, unknown>): Promise<string> {
  const c = await creds();
  const imageUrl = str(args.image_url);
  if (!imageUrl) return 'Error: image_url is required.';
  const r = await igPublishPost(c, imageUrl, str(args.caption));
  return `Published Instagram post (media id ${r.id ?? 'n/a'}).`;
}

async function handleThreadsPublish(args: Record<string, unknown>): Promise<string> {
  const c = await creds();
  const text = str(args.text);
  if (!text) return 'Error: text is required.';
  const r = await threadsPublish(c, text);
  return `Published Threads post (id ${r.id ?? 'n/a'}).`;
}

async function handleAdsInsights(args: Record<string, unknown>): Promise<string> {
  const c = await creds();
  const rows = await adsInsights(c, str(args.date_preset) ?? 'last_7d', str(args.level) ?? 'campaign') as Array<Record<string, unknown>>;
  if (rows.length === 0) return 'No ad insights for that period (no active campaigns or no spend).';
  return rows.slice(0, 25).map((r) => {
    const name = r.campaign_name ?? 'account';
    return `- ${name}: spend $${r.spend ?? 0}, impr ${r.impressions ?? 0}, clicks ${r.clicks ?? 0}, CTR ${r.ctr ?? 0}%, CPC $${r.cpc ?? 0}, reach ${r.reach ?? 0}`;
  }).join('\n');
}

async function handleWaSend(args: Record<string, unknown>): Promise<string> {
  const to = str(args.to);
  const text = str(args.text);
  if (!to || !text) return 'Error: to and text are required.';
  if (isUnipileConfigured()) {
    const sent = await startUnipileWhatsAppChat(to, text);
    return `Sent WhatsApp message via Unipile to ${to}${sent.messageId ? ` (message_id ${sent.messageId})` : ''}.`;
  }

  const c = await creds();
  if (!c.whatsapp.phoneNumberId || !c.whatsapp.accessToken) {
    return 'WhatsApp is not connected through Unipile yet. Connect WhatsApp in Settings -> Connections first.';
  }
  await waCloudSend(c, to.replace(/^\+/, ''), text);
  return `Sent WhatsApp Cloud message to ${to}.`;
}

export const META_TOOL_HANDLERS: Record<string, Handler> = {
  meta_status: handleMetaStatus,
  meta_fb_list_conversations: handleFbListConversations,
  meta_fb_get_messages: handleFbGetMessages,
  meta_fb_send_message: handleFbSendMessage,
  meta_fb_publish_post: handleFbPublishPost,
  meta_ig_publish_post: handleIgPublishPost,
  meta_threads_publish: handleThreadsPublish,
  meta_ads_insights: handleAdsInsights,
  meta_wa_send: handleWaSend,
};
