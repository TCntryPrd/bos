/**
 * WhatsApp tile — threads list + thread view + reply textbox.
 *
 * Phase 1 (Kevin 2026-05-20): manual replies only. Dally draft-review
 * panel comes when she's wired up.
 *
 * Layout: two columns. Left = threads list (sorted by last_message_at,
 * unread badge on each row). Right = selected thread message history
 * with reply box at bottom. Polls every 5s for new messages on the
 * active thread + every 10s for the threads list.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { whatsappApi, type WhatsappThread, type WhatsappMessage, type WhatsappContact } from '../lib/api';

const FMT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function relTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return FMT_DATE.format(d);
}

function threadTitle(t: WhatsappThread): string {
  return t.display_name || t.phone || t.chat_id;
}

function contactTitle(c: WhatsappContact): string {
  return c.display_name || c.push_name || c.phone || c.contact_id;
}

export default function WhatsApp() {
  const [threads, setThreads] = useState<WhatsappThread[]>([]);
  const [contacts, setContacts] = useState<WhatsappContact[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsappMessage[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [leftView, setLeftView] = useState<'threads' | 'contacts'>('threads');
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // Initial + interval poll for threads list
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.listThreads();
        if (alive) setThreads(res.threads);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Initial + interval poll for contact list
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.listContacts();
        if (alive) setContacts(res.contacts);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Load messages on thread select + poll every 5s
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.getMessages(selected);
        if (alive) setMessages(res.messages);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    // Mark read on select
    void whatsappApi.markRead(selected).catch(() => { /* best effort */ });
    const t = setInterval(load, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, [selected]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.chat_id === selected) || null,
    [threads, selected],
  );

  const send = async () => {
    if (!selected || !reply.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await whatsappApi.send(selected, reply.trim());
      setReply('');
      // Refresh messages immediately
      const res = await whatsappApi.getMessages(selected);
      setMessages(res.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const syncContacts = async () => {
    if (syncingContacts) return;
    setSyncingContacts(true);
    setError(null);
    try {
      await whatsappApi.syncContacts();
      const res = await whatsappApi.listContacts();
      setContacts(res.contacts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingContacts(false);
    }
  };

  return (
    <div className="flex h-full bg-base text-text-primary">
      {/* Threads list */}
      <aside className="w-80 flex-shrink-0 border-r border-border overflow-y-auto bg-surface-1">
        <header className="sticky top-0 bg-surface-1/95 backdrop-blur px-4 py-3 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-success uppercase tracking-wide">WhatsApp</h2>
              <p className="text-xs text-text-muted mt-0.5">
                {leftView === 'threads' ? `${threads.length} threads` : `${contacts.length} contacts`}
              </p>
            </div>
            {leftView === 'contacts' && (
              <button
                onClick={() => void syncContacts()}
                disabled={syncingContacts}
                className="text-xs px-2 py-1 text-text-secondary hover:text-text-primary border border-border rounded disabled:opacity-50"
              >
                {syncingContacts ? 'syncing' : 'sync'}
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 rounded border border-border overflow-hidden text-xs bg-surface-2">
            <button
              onClick={() => setLeftView('threads')}
              className={`px-2 py-1 ${leftView === 'threads' ? 'bg-success text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              Threads
            </button>
            <button
              onClick={() => setLeftView('contacts')}
              className={`px-2 py-1 ${leftView === 'contacts' ? 'bg-success text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              Contacts
            </button>
          </div>
        </header>
        {leftView === 'threads' && threads.length === 0 && (
          <div className="px-4 py-8 text-center text-text-muted text-sm">
            No threads yet. Messages appear as they arrive.
          </div>
        )}
        {leftView === 'contacts' && contacts.length === 0 && (
          <div className="px-4 py-8 text-center text-text-muted text-sm">
            No contacts synced yet.
          </div>
        )}
        {leftView === 'threads' ? (
          <ul>
            {threads.map((t) => (
            <li key={t.chat_id}>
              <button
                onClick={() => setSelected(t.chat_id)}
                className={`w-full text-left px-4 py-3 border-b border-border hover:bg-success-muted transition-colors ${
                  selected === t.chat_id ? 'bg-success-muted' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{threadTitle(t)}</span>
                      {t.is_group && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-info-muted text-info">group</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted truncate mt-0.5">
                      {t.last_message_from_me && <span className="text-success">you: </span>}
                      {t.last_message_preview || '(no preview)'}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-[10px] text-text-muted">{relTime(t.last_message_at)}</span>
                    {t.unread_count > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-success text-white font-semibold min-w-[18px] text-center">
                        {t.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
            ))}
          </ul>
        ) : (
          <ul>
            {contacts.map((c) => (
              <li key={c.contact_id}>
                <button
                  onClick={() => {
                    const thread = threads.find((t) => t.chat_id === c.contact_id);
                    if (thread) setSelected(thread.chat_id);
                  }}
                  className="w-full text-left px-4 py-3 border-b border-border hover:bg-success-muted transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{contactTitle(c)}</span>
                        {c.is_group && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-info-muted text-info">group</span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted truncate mt-0.5">
                        {c.phone || c.contact_id}
                      </p>
                    </div>
                    {c.is_my_contact && (
                      <span className="text-[10px] text-success flex-shrink-0">saved</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Thread view */}
      <main className="flex-1 flex flex-col min-w-0">
        {!selectedThread ? (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
            Select a thread to view messages.
          </div>
        ) : (
          <>
            <header className="px-6 py-3 border-b border-border bg-surface-1/95">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-semibold">{threadTitle(selectedThread)}</h1>
                  <p className="text-xs text-text-muted mt-0.5">
                    {selectedThread.phone || selectedThread.chat_id}
                    {selectedThread.is_group && ' · group chat'}
                  </p>
                </div>
                <button
                  onClick={() => void whatsappApi.markRead(selectedThread.chat_id)}
                  className="text-xs px-2 py-1 text-text-secondary hover:text-text-primary border border-border rounded"
                >
                  mark read
                </button>
              </div>
            </header>

            <div ref={messagesRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {messages.length === 0 ? (
                <p className="text-center text-text-muted text-sm">No messages yet.</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex ${m.from_me ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                        m.from_me
                          ? 'bg-success text-white'
                          : 'bg-surface-1 text-text-primary border border-border'
                      }`}
                    >
                      {selectedThread.is_group && !m.from_me && (m.sender_name || m.author) && (
                        <p className="mb-1 text-[11px] font-medium text-info">
                          {m.sender_name || m.author}
                        </p>
                      )}
                      {m.message_type !== 'text' && !m.body ? (
                        <p className={`italic ${m.from_me ? 'text-white/70' : 'text-text-muted'}`}>[{m.message_type}]</p>
                      ) : (
                        <p className="whitespace-pre-wrap">{m.body}</p>
                      )}
                      <p className={`text-[10px] mt-1 ${m.from_me ? 'text-green-100' : 'text-text-muted'}`}>
                        {FMT_DATE.format(new Date(m.sent_at))}
                        {m.from_me && m.ack_status && ` · ${m.ack_status}`}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {error && (
              <div className="px-6 py-2 bg-danger-muted text-danger text-xs">{error}</div>
            )}

            <footer className="p-4 border-t border-border bg-surface-1/95">
              <div className="flex gap-2">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Type a reply… (Cmd/Ctrl+Enter to send)"
                  rows={2}
                  className="flex-1 bg-surface-2 border border-border rounded px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-success resize-none"
                />
                <button
                  onClick={() => void send()}
                  disabled={!reply.trim() || sending}
                  className="px-4 py-2 bg-success hover:bg-green-600 disabled:bg-surface-3 disabled:text-text-muted text-white rounded font-medium text-sm"
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
