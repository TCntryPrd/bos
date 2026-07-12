/**
 * Telegram Bot — Mobile interface to BOS
 *
 * Polls Telegram for incoming messages, routes them through the BOS brain,
 * and sends responses back. Acts as a mobile app replacement.
 *
 * Pairing flow:
 *   1. User sends /start to the bot
 *   2. Bot responds with pairing instructions
 *   3. User sends /pair <code> (code from web UI or admin)
 *   4. Bot links their Telegram chat_id to a BOS user account
 *   5. All subsequent messages are routed to BOS brain as that user
 *
 * Unpaired users get a welcome message with pairing instructions.
 * Admin (Kevin) is auto-paired based on known chat IDs.
 */

import { getPool } from '../db.js';

// ── Config ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000; // 3 seconds — responsive for chat
const TELEGRAM_API = 'https://api.telegram.org/bot';

// ── State ────────────────────────────────────────────────────────────────────

let isRunning = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastUpdateId = 0;

// Paired users cache: telegram chat_id → boss.user_id
const pairedUsers = new Map<number, string>();

// ── Telegram API helpers ─────────────────────────────────────────────────────

function getToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

async function tgFetch(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const token = getToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const url = `${TELEGRAM_API}${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: params ? JSON.stringify(params) : undefined,
  });

  const data = await res.json() as { ok: boolean; result: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram API error: ${data.description || 'unknown'}`);
  return data.result;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  // Try Markdown first, fall back to plain text if it fails
  const trySend = async (chunk: string) => {
    try {
      await tgFetch('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'Markdown' });
    } catch {
      // Markdown parsing failed — send as plain text
      await tgFetch('sendMessage', { chat_id: chatId, text: chunk });
    }
  };

  // Telegram has a 4096 char limit per message
  if (text.length <= 4096) {
    await trySend(text);
    return;
  }

  // Split long messages
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 4096) {
      await trySend(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', 4000);
    if (splitAt < 2000) splitAt = 4000;
    await trySend(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
}

// ── Pairing database ─────────────────────────────────────────────────────────

async function ensurePairingTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boss_telegram_pairs (
      chat_id BIGINT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      paired_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function loadPairings(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ chat_id: string; user_id: string }>(
    'SELECT chat_id, user_id FROM boss_telegram_pairs',
  );
  for (const row of rows) {
    pairedUsers.set(parseInt(row.chat_id, 10), row.user_id);
  }
  console.log(`[telegram-bot] Loaded ${pairedUsers.size} paired users`);
}

async function pairUser(chatId: number, userId: string, username?: string, firstName?: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO boss_telegram_pairs (chat_id, user_id, username, first_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id) DO UPDATE SET user_id = $2, username = $3, first_name = $4`,
    [chatId, userId, username ?? null, firstName ?? null],
  );
  pairedUsers.set(chatId, userId);
}

async function unpairUser(chatId: number): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM boss_telegram_pairs WHERE chat_id = $1', [chatId]);
  pairedUsers.delete(chatId);
}

// ── Generate pairing codes ───────────────────────────────────────────────────

const pendingCodes = new Map<string, { userId: string; expiresAt: number }>();

export function generatePairingCode(userId: string): string {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  pendingCodes.set(code, { userId, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min expiry
  return code;
}

// ── Brain integration ────────────────────────────────────────────────────────

async function routeToBrain(userId: string, message: string): Promise<string> {
  // Call the local BOS brain API
  try {
    const port = process.env.PORT || '8010';
    const res = await fetch(`http://127.0.0.1:${port}/api/brain/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Internal call — use a service token or skip auth for localhost
        'X-BOSS-Internal': 'true',
      },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(120_000), // 2 min timeout for tool chains
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'unknown error');
      return `Sorry, I hit an error processing that: ${err.slice(0, 200)}`;
    }

    const data = await res.json() as { response?: string; error?: string };
    return data.response || data.error || 'I processed that but got no response.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[telegram-bot] Brain call failed:', msg);
    return `I'm having trouble connecting to my brain right now. Error: ${msg}`;
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    date: number;
  };
}

async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const username = msg.from?.username;
  const firstName = msg.from?.first_name;

  console.log(`[telegram-bot] Message from chat_id=${chatId} user=${firstName}(@${username}): ${text.slice(0, 50)}`);

  // ── Commands ──────────────────────────────────────────────
  if (text === '/start') {
    let isPaired = pairedUsers.has(chatId);

    // Auto-pair: if no users are paired yet, first /start becomes admin
    if (!isPaired && pairedUsers.size === 0) {
      console.log(`[telegram-bot] First user! Auto-pairing chat_id=${chatId} as admin (${firstName})`);
      await pairUser(chatId, 'admin', username, firstName);
      // Save the chat ID for future auto-pair
      try {
        const { setRuntimeConfig: setRC } = await import('../config-store.js');
        await setRC('TELEGRAM_ADMIN_CHAT_ID', String(chatId), 'default');
        process.env.TELEGRAM_ADMIN_CHAT_ID = String(chatId);
      } catch { /* non-critical */ }
      isPaired = true;
    }

    // Also auto-pair if this is the known admin chat
    if (!isPaired) {
      const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
      if (adminChatId && chatId === parseInt(adminChatId, 10)) {
        await pairUser(chatId, 'admin', username, firstName);
        isPaired = true;
      }
    }

    if (isPaired) {
      await sendMessage(chatId,
        `Welcome back! You're paired as ${pairedUsers.get(chatId)}.\n\nJust send me a message and I'll process it.\n\nCommands:\n/unpair - disconnect\n/status - check connection`,
      );
    } else {
      await sendMessage(chatId,
        `I'm BOS, an AI Operating System.\n\nTo connect, get a pairing code from the BOS dashboard and send:\n/pair YOUR_CODE\n\nOr ask your admin to pair you.`,
      );
    }
    return;
  }

  if (text.startsWith('/pair ')) {
    const code = text.slice(6).trim().toUpperCase();
    const pending = pendingCodes.get(code);

    if (!pending || pending.expiresAt < Date.now()) {
      await sendMessage(chatId, 'Invalid or expired pairing code. Get a new one from the dashboard.');
      return;
    }

    await pairUser(chatId, pending.userId, username, firstName);
    pendingCodes.delete(code);
    await sendMessage(chatId,
      `✅ Paired successfully as *${pending.userId}*!\n\n` +
      `You can now send me messages and I'll handle them through BOS.\n` +
      `Try: "What's on my calendar today?"`,
    );
    return;
  }

  if (text === '/unpair') {
    if (pairedUsers.has(chatId)) {
      await unpairUser(chatId);
      await sendMessage(chatId, 'Unpaired. Send /start to reconnect.');
    } else {
      await sendMessage(chatId, "You're not paired. Send /start to begin.");
    }
    return;
  }

  if (text === '/status') {
    const isPaired = pairedUsers.has(chatId);
    await sendMessage(chatId,
      `*Status:*\n` +
      `Paired: ${isPaired ? `Yes (${pairedUsers.get(chatId)})` : 'No'}\n` +
      `Chat ID: ${chatId}\n` +
      `Bot: Online`,
    );
    return;
  }

  // ── Regular messages — route to brain ─────────────────────
  let userId = pairedUsers.get(chatId);

  // Auto-pair: if no users paired and this is the first message, pair as admin
  if (!userId && pairedUsers.size === 0) {
    console.log(`[telegram-bot] First message! Auto-pairing chat_id=${chatId} as admin (${firstName})`);
    await pairUser(chatId, 'admin', username, firstName);
    userId = 'admin';
  }

  // Also auto-pair if this is the known admin chat
  if (!userId) {
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminChatId && chatId === parseInt(adminChatId, 10)) {
      await pairUser(chatId, 'admin', username, firstName);
      userId = 'admin';
    }
  }

  if (!userId) {
    await sendMessage(chatId,
      "I don't recognize this chat. Send /start to set up pairing.",
    );
    return;
  }

  // Check if the brain is waiting for a reply via send_and_wait
  // If so, push to the reply queue and DON'T route to brain (avoids double-response)
  try {
    const { pushTelegramReply, isTelegramWaiting } = await import('../tools/executor.js');
    if (isTelegramWaiting(String(chatId))) {
      pushTelegramReply(String(chatId), text, firstName ?? username ?? 'unknown');
      console.log(`[telegram-bot] Reply queued for send_and_wait (chat ${chatId}): ${text.slice(0, 50)}`);
      return; // Don't route to brain — the tool will handle it
    }
  } catch { /* non-critical — fall through to normal brain routing */ }

  // Normal message — route to brain
  await tgFetch('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const response = await routeToBrain(userId, text);
  await sendMessage(chatId, response);
}

// ── Polling loop ─────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  if (!getToken()) return;

  try {
    const updates = await tgFetch('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 1, // Short poll — we're on an interval
      allowed_updates: ['message'],
    }) as TgUpdate[];

    for (const update of updates) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      try {
        await handleUpdate(update);
      } catch (err) {
        console.error('[telegram-bot] Error handling update:', err);
      }
    }
  } catch (err) {
    // Log poll failures (throttled to avoid spam on persistent errors)
    if (Math.random() < 0.1) {
      console.error('[telegram-bot] Poll error:', err);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startTelegramBot(): Promise<void> {
  const token = getToken();
  if (!token) {
    console.log('[telegram-bot] No TELEGRAM_BOT_TOKEN configured. Bot disabled.');
    return;
  }

  try {
    await ensurePairingTable();
    await loadPairings();

    // Auto-pair Kevin if we know his chat ID
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminChatId && !pairedUsers.has(parseInt(adminChatId, 10))) {
      await pairUser(parseInt(adminChatId, 10), 'admin', undefined, 'Kevin');
      console.log(`[telegram-bot] Auto-paired admin chat ${adminChatId}`);
    }
  } catch (err) {
    console.error('[telegram-bot] Init error:', err);
  }

  console.log(`[telegram-bot] Starting Telegram bot (polling every ${POLL_INTERVAL_MS}ms)`);
  intervalHandle = setInterval(() => void poll(), POLL_INTERVAL_MS);

  // Run first poll immediately
  void poll();
  isRunning = true;
}

export function stopTelegramBot(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    isRunning = false;
    console.log('[telegram-bot] Stopped');
  }
}

export function getTelegramBotStatus(): {
  running: boolean;
  paired_users: number;
  token_configured: boolean;
} {
  return {
    running: isRunning,
    paired_users: pairedUsers.size,
    token_configured: !!getToken(),
  };
}
