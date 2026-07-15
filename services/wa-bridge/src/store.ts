/**
 * Bounded, disk-backed rolling stores for the wa-bridge.
 *
 * Baileys is a socket client, not a browser: there is NO server-side
 * "give me the last 50 messages of this chat" call. Everything this bridge can
 * answer about history is what it has SEEN — live messages plus whatever the
 * on-connect history sync (`messaging-history.set`) hands us. So we keep a
 * rolling window per chat on disk and serve /channels/:chatId/messages from it.
 *
 * Two stores:
 *   MessageStore  — normalized (BOS-shaped) messages, persisted to
 *                   <dataDir>/messages.json, capped per chat and globally.
 *   ContactStore  — normalized contacts, persisted to <dataDir>/contacts.json.
 *
 * Writes are debounced (flush at most once per second) so a history-sync burst
 * doesn't hammer the disk. Both stores are best-effort: a corrupt/missing file
 * is treated as empty, never fatal.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredMessage {
  id: string;
  chatId: string;
  from?: string;
  to?: string;
  fromMe: boolean;
  author?: string;
  sender?: string;
  senderName?: string;
  pushName?: string;
  notifyName?: string;
  verifiedName?: string;
  formattedName?: string;
  body: string;
  type: string;
  hasMedia: boolean;
  quotedMsgId?: string;
  /** seconds since epoch */
  timestamp: number;
  isGroupMsg: boolean;
  ack?: number;
}

/** One row of the chat index derived from the message store (see MessageStore.listChats). */
export interface StoredChatSummary {
  chatId: string;
  messageCount: number;
  /** seconds since epoch — newest message in the chat; 0 when the chat is empty */
  lastMessageAt: number;
}

export interface StoredContact {
  id: string;
  name?: string;
  pushname?: string;
  pushName?: string;
  formattedName?: string;
  verifiedName?: string;
  shortName?: string;
  number?: string;
  isMyContact?: boolean;
  isBlocked?: boolean;
  isBusiness?: boolean;
  isGroup: boolean;
}

/** Hard ceiling on messages retained (and therefore servable) per chat. */
export const PER_CHAT_CAP = 500;
const TOTAL_CHAT_CAP = 1_000;
const FLUSH_DEBOUNCE_MS = 1_000;

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

/** Rolling per-chat message window, persisted as a flat { chatId: Message[] } map. */
export class MessageStore {
  private readonly path: string;
  private readonly chats = new Map<string, StoredMessage[]>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, private readonly onError: (msg: string, err: unknown) => void) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'messages.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, StoredMessage[]>;
      for (const [chatId, msgs] of Object.entries(raw)) {
        if (Array.isArray(msgs)) this.chats.set(chatId, msgs.slice(-PER_CHAT_CAP));
      }
    } catch {
      // No store yet (or unreadable) — start empty. Not an error.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  flush(): void {
    try {
      atomicWrite(this.path, JSON.stringify(Object.fromEntries(this.chats)));
    } catch (err) {
      this.onError('message store flush failed', err);
    }
  }

  /** Insert or merge by message id, keeping each chat sorted by timestamp ascending. */
  upsert(msg: StoredMessage): void {
    if (!msg.chatId || !msg.id) return;
    const list = this.chats.get(msg.chatId) ?? [];
    const existing = list.findIndex((m) => m.id === msg.id);
    if (existing >= 0) {
      list[existing] = { ...list[existing], ...msg };
    } else {
      list.push(msg);
      list.sort((a, b) => a.timestamp - b.timestamp);
      if (list.length > PER_CHAT_CAP) list.splice(0, list.length - PER_CHAT_CAP);
    }
    this.chats.set(msg.chatId, list);
    this.evictChats();
    this.scheduleFlush();
  }

  /** Patch an already-stored message (ack updates, revokes). No-op if unseen. */
  patch(chatId: string, id: string, patch: Partial<StoredMessage>): void {
    const list = this.chats.get(chatId);
    if (!list) return;
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], ...patch };
    this.scheduleFlush();
  }

  /** Newest `limit` messages for a chat, oldest-first. Unknown chat → []. Never throws. */
  list(chatId: string, limit: number): StoredMessage[] {
    return (this.chats.get(chatId) ?? []).slice(-limit);
  }

  /**
   * Every chat the store knows about, newest-active first. This is the ONLY
   * chat enumeration the bridge has — there is no server-side chat list in
   * Baileys, so "which conversations exist" is exactly "which conversations
   * this store has seen" (live traffic + the on-connect history sync).
   * Lists are kept timestamp-ascending by upsert(), so the last element is
   * the newest.
   */
  listChats(): StoredChatSummary[] {
    const out: StoredChatSummary[] = [];
    for (const [chatId, msgs] of this.chats) {
      if (!msgs.length) continue;
      out.push({
        chatId,
        messageCount: msgs.length,
        lastMessageAt: msgs[msgs.length - 1]?.timestamp ?? 0,
      });
    }
    out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return out;
  }

  private evictChats(): void {
    if (this.chats.size <= TOTAL_CHAT_CAP) return;
    // Drop the least-recently-active chats (by newest message timestamp).
    const ranked = [...this.chats.entries()]
      .map(([chatId, msgs]) => [chatId, msgs[msgs.length - 1]?.timestamp ?? 0] as const)
      .sort((a, b) => a[1] - b[1]);
    for (const [chatId] of ranked.slice(0, this.chats.size - TOTAL_CHAT_CAP)) {
      this.chats.delete(chatId);
    }
  }
}

/** Contacts learned from contacts.upsert / contacts.update / message pushNames. */
export class ContactStore {
  private readonly path: string;
  private readonly contacts = new Map<string, StoredContact>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, private readonly onError: (msg: string, err: unknown) => void) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'contacts.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoredContact[];
      if (Array.isArray(raw)) for (const c of raw) if (c?.id) this.contacts.set(c.id, c);
    } catch {
      // Empty start.
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  flush(): void {
    try {
      atomicWrite(this.path, JSON.stringify([...this.contacts.values()]));
    } catch (err) {
      this.onError('contact store flush failed', err);
    }
  }

  /** Merge — later, better-quality names must not be clobbered by empty ones. */
  upsert(contact: StoredContact): void {
    if (!contact.id) return;
    const prev = this.contacts.get(contact.id);
    const merged: StoredContact = { ...prev, ...contact, id: contact.id, isGroup: contact.isGroup };
    for (const key of ['name', 'pushname', 'pushName', 'formattedName', 'verifiedName', 'shortName'] as const) {
      if (!merged[key] && prev?.[key]) merged[key] = prev[key];
    }
    this.contacts.set(contact.id, merged);
    this.scheduleFlush();
  }

  get(id: string): StoredContact | undefined {
    return this.contacts.get(id);
  }

  all(): StoredContact[] {
    return [...this.contacts.values()];
  }
}
