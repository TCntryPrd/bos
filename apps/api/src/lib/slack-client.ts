/**
 * Slack Web API client — thin fetch wrapper around the bot token.
 *
 * Tokens come from runtime_config (loaded into process.env at boot):
 *   SLACK_BOT_TOKEN — xoxb-...   (used for ALL outbound calls; bot identity)
 *   SLACK_USER_TOKEN — xoxp-...  (NOT used here — bot speaks for itself)
 *   SLACK_APP_TOKEN — xapp-...   (Socket Mode only; see slack-socket.ts)
 *
 * All methods return the parsed JSON body. Slack returns 200 even on
 * application errors with `{ok: false, error: "..."}`, so callers must
 * check `.ok`.
 */

const SLACK_API = 'https://slack.com/api';

export interface SlackOk {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

function botToken(): string {
  const t = process.env.SLACK_BOT_TOKEN;
  if (!t) throw new Error('SLACK_BOT_TOKEN not configured in runtime_config');
  return t;
}

async function call<T extends SlackOk = SlackOk>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as T;
}

// ── Identity ──────────────────────────────────────────────────────────────────

export async function authTest(): Promise<SlackOk> {
  return call('auth.test');
}

// ── Messages ──────────────────────────────────────────────────────────────────

export interface PostMessageInput {
  channel: string;          // C..., D..., G..., or @username
  text: string;
  threadTs?: string;        // reply in thread
  blocks?: unknown[];       // Block Kit
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
  username?: string;        // requires chat:write.customize
  iconEmoji?: string;       // requires chat:write.customize
  iconUrl?: string;         // requires chat:write.customize
}

export async function postMessage(input: PostMessageInput): Promise<SlackOk> {
  const body: Record<string, unknown> = {
    channel: input.channel,
    text: input.text,
  };
  if (input.threadTs) body.thread_ts = input.threadTs;
  if (input.blocks) body.blocks = input.blocks;
  if (input.unfurlLinks !== undefined) body.unfurl_links = input.unfurlLinks;
  if (input.unfurlMedia !== undefined) body.unfurl_media = input.unfurlMedia;
  if (input.username) body.username = input.username;
  if (input.iconEmoji) body.icon_emoji = input.iconEmoji;
  if (input.iconUrl) body.icon_url = input.iconUrl;
  return call('chat.postMessage', body);
}

export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[],
): Promise<SlackOk> {
  return call('chat.update', { channel, ts, text, blocks });
}

export async function getPermalink(channel: string, messageTs: string): Promise<SlackOk> {
  // GET-style call but Slack accepts POST too with auth header
  const res = await fetch(
    `${SLACK_API}/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(messageTs)}`,
    {
      headers: { Authorization: `Bearer ${botToken()}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  return (await res.json()) as SlackOk;
}

// ── Reactions ─────────────────────────────────────────────────────────────────

export async function addReaction(channel: string, ts: string, name: string): Promise<SlackOk> {
  return call('reactions.add', { channel, timestamp: ts, name });
}

export async function removeReaction(channel: string, ts: string, name: string): Promise<SlackOk> {
  return call('reactions.remove', { channel, timestamp: ts, name });
}

// ── Conversations ─────────────────────────────────────────────────────────────

export async function repliesInThread(
  channel: string,
  threadTs: string,
  limit = 50,
): Promise<SlackOk> {
  const url = new URL(`${SLACK_API}/conversations.replies`);
  url.searchParams.set('channel', channel);
  url.searchParams.set('ts', threadTs);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken()}` },
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as SlackOk;
}

// ── Users ─────────────────────────────────────────────────────────────────────

const USER_CACHE = new Map<string, { name: string; cachedAt: number }>();
const USER_TTL_MS = 5 * 60_000; // 5 min

export async function lookupUser(userId: string): Promise<{ id: string; name: string }> {
  const cached = USER_CACHE.get(userId);
  if (cached && Date.now() - cached.cachedAt < USER_TTL_MS) {
    return { id: userId, name: cached.name };
  }
  const url = `${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as SlackOk & {
    user?: { id: string; real_name?: string; profile?: { display_name?: string } };
  };
  let name = userId;
  if (body.ok && body.user) {
    name = body.user.profile?.display_name?.trim() || body.user.real_name || userId;
  }
  USER_CACHE.set(userId, { name, cachedAt: Date.now() });
  return { id: userId, name };
}

// ── Channels (helper) ─────────────────────────────────────────────────────────

export async function conversationsInfo(channel: string): Promise<SlackOk> {
  const url = `${SLACK_API}/conversations.info?channel=${encodeURIComponent(channel)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as SlackOk;
}
