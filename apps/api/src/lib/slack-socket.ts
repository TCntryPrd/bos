/**
 * Slack Socket Mode listener.
 *
 * The `xapp-` token (SLACK_APP_TOKEN, scope `connections:write`) lets us
 * open a WebSocket from us → Slack and receive events without a public
 * HTTP webhook. Slack pushes envelopes; we ack each one within ~3s or
 * the event is redelivered.
 *
 * Events that matter for v1:
 *   - message.im / message.mpim — DMs to the bot
 *   - app_mention — @ Sodapop in channels he's invited to
 *
 * On every relevant inbound message, we resolve the sender, write to
 * slack_attention (status='open'), and ack the envelope. The BOS UI
 * polls slack_attention via /api/slack/attention; browser notifications
 * fire via the existing dashboard refresh loop.
 *
 * This module exports a single startSlackSocketMode() that should be
 * called once during server boot AFTER loadRuntimeConfig().
 */

import { getPool } from '../db.js';
import { lookupUser, getPermalink } from './slack-client.js';

const APPS_CONNECTIONS_OPEN = 'https://slack.com/api/apps.connections.open';

// Events we react to
const HANDLED_TYPES = new Set([
  'message',          // DMs (channel_type=im) and mpim
  'app_mention',      // @sodapop in channels
]);

// Reasons text for slack_attention.reason
const REASON: Record<string, string> = {
  im: 'direct message',
  mpim: 'group DM',
  app_mention: 'mentioned the bot',
  channel: 'channel message',
};

interface Envelope {
  envelope_id?: string;
  type: string;                       // 'events_api' | 'hello' | 'disconnect' | ...
  payload?: { event?: SlackEvent; team_id?: string };
  reason?: string;                    // for 'disconnect'
}

interface SlackEvent {
  type: string;
  channel?: string;
  channel_type?: string;              // 'im' | 'mpim' | 'channel' | 'group'
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;                   // 'bot_message' etc — usually ignore
}

interface ConnectionsOpen {
  ok: boolean;
  url?: string;
  error?: string;
}

let ws: WebSocket | null = null;
let stopped = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = 1_000;
const MAX_BACKOFF_MS = 60_000;

async function fetchWsUrl(): Promise<string | null> {
  const token = process.env.SLACK_APP_TOKEN;
  if (!token) {
    console.warn('[slack-socket] SLACK_APP_TOKEN missing — Socket Mode disabled');
    return null;
  }
  const res = await fetch(APPS_CONNECTIONS_OPEN, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as ConnectionsOpen;
  if (!body.ok || !body.url) {
    console.error('[slack-socket] apps.connections.open failed:', body.error);
    return null;
  }
  // append ?debug_reconnects=true on staging if you want forced disconnects
  return body.url;
}

async function recordAttention(ev: SlackEvent, teamId?: string): Promise<void> {
  if (!ev.channel || !ev.ts) return;

  // Skip the bot's own messages
  if (ev.bot_id || ev.subtype === 'bot_message') return;
  // Skip message edits / deletions / channel-join etc — only fresh user messages
  if (ev.subtype && ev.subtype !== 'file_share') return;

  const channelType = ev.channel_type ?? (ev.type === 'app_mention' ? 'channel' : 'im');
  const reason =
    ev.type === 'app_mention' ? REASON.app_mention :
    channelType === 'im' ? REASON.im :
    channelType === 'mpim' ? REASON.mpim : REASON.channel;

  let userName = ev.user ?? 'unknown';
  if (ev.user) {
    try {
      userName = (await lookupUser(ev.user)).name;
    } catch (e) {
      console.warn('[slack-socket] user lookup failed for', ev.user, e);
    }
  }

  let permalink: string | null = null;
  try {
    const p = await getPermalink(ev.channel, ev.ts) as { ok: boolean; permalink?: string };
    if (p.ok && p.permalink) permalink = p.permalink;
  } catch {
    // best-effort only
  }

  const preview = (ev.text ?? '').slice(0, 280);
  const tenantId = process.env.SLACK_TENANT_ID || 'd05cde41-4754-4f1f-ae13-ecb0be8b6fad';

  try {
    await getPool().query(
      `INSERT INTO slack_attention
         (tenant_id, flagged_by, source_channel, source_ts, source_user, source_user_name,
          preview, reason, permalink)
       VALUES ($1, 'slack', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, source_channel, source_ts) DO NOTHING`,
      [tenantId, ev.channel, ev.ts, ev.user ?? null, userName, preview, reason, permalink],
    );
    console.log(`[slack-socket] flagged: ${userName} in ${ev.channel} — "${preview.slice(0, 60)}"`);
  } catch (e) {
    console.error('[slack-socket] failed to insert slack_attention row:', e);
  }
  void teamId; // reserved for multi-workspace
}

async function handleEnvelope(env: Envelope): Promise<void> {
  if (env.type === 'hello') {
    console.log('[slack-socket] connected');
    backoffMs = 1_000;
    return;
  }
  if (env.type === 'disconnect') {
    console.log('[slack-socket] server requested disconnect:', env.reason);
    // socket will close; reconnection handled in onclose
    return;
  }
  if (env.type !== 'events_api') return;
  const ev = env.payload?.event;
  if (!ev || !HANDLED_TYPES.has(ev.type)) return;
  await recordAttention(ev, env.payload?.team_id);
}

function ack(envelopeId: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ envelope_id: envelopeId }));
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  console.log(`[slack-socket] reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (stopped) return;
  const url = await fetchWsUrl();
  if (!url) {
    scheduleReconnect();
    return;
  }
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[slack-socket] WebSocket construct failed:', e);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    console.log('[slack-socket] websocket open');
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    let env: Envelope;
    try {
      env = JSON.parse(String(event.data)) as Envelope;
    } catch (e) {
      console.warn('[slack-socket] non-JSON frame:', event.data);
      return;
    }
    // Ack first (within 3s SLA), then process
    if (env.envelope_id) ack(env.envelope_id);
    void handleEnvelope(env).catch((e) => {
      console.error('[slack-socket] envelope handler error:', e);
    });
  });

  ws.addEventListener('close', (event) => {
    const ce = event as { code?: number; reason?: string };
    console.log(`[slack-socket] closed (code=${ce.code ?? '?'} reason="${ce.reason ?? ''}")`);
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener('error', (event) => {
    const ee = event as { message?: string };
    console.error('[slack-socket] error:', ee.message ?? event);
  });
}

export async function startSlackSocketMode(): Promise<void> {
  if (!process.env.SLACK_APP_TOKEN) {
    console.log('[slack-socket] SLACK_APP_TOKEN not set — skipping');
    return;
  }
  stopped = false;
  await connect();
}

export function stopSlackSocketMode(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(1000, 'shutdown'); } catch { /* noop */ }
    ws = null;
  }
}
