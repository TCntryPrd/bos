import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Paperclip, X } from 'lucide-react';
import type { CooThread } from './useCooThreads.js';
import { useThreadMessages, type CooMessage } from './useThreadMessages.js';
import { streamCooChat } from './streamCooChat.js';
import { DictationButton } from '../DictationButton';
import { filesToAttachments, toWire, bytesLabel, MAX_ATTACHMENTS, type PendingAttachment } from '../../lib/attachments';

interface Props { thread: CooThread | null; }

function authToken(): string {
  return localStorage.getItem('boss_token') ?? '';
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

export function ChatPane({ thread }: Props) {
  const { messages, append, updateLast, reload, setSending: setSendingInHook } = useThreadMessages(thread?.id ?? null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    void (async () => {
      try {
        const next = await filesToAttachments(files, attachments.length);
        setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
      } catch { /* size errors are non-fatal; ignore the oversized file */ }
      finally { if (fileInputRef.current) fileInputRef.current.value = ''; }
    })();
  }, [attachments.length]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending || !thread) return;
    const outgoing = attachments;
    const msg = text || 'Please review the attached file(s).';
    setSending(true);
    setSendingInHook(true);
    setInput('');
    setAttachments([]);
    setBusy(true);

    const nowIso = new Date().toISOString();
    const userContent = outgoing.length ? `${msg}\n\n📎 ${outgoing.map((a) => a.name).join(', ')}` : msg;
    append({ id: `local-user-${Date.now()}`, role: 'user', content: userContent, tokens_in: null, tokens_out: null, created_at: nowIso });
    append({ id: `local-asst-${Date.now()}`, role: 'assistant', content: '', tokens_in: null, tokens_out: null, created_at: nowIso });

    try {
      await streamCooChat({
        threadId: thread.id,
        message: msg,
        attachments: outgoing.length ? outgoing.map(toWire) : undefined,
        authToken: authToken() || undefined,
        onAssistantText: (aggregate) => updateLast((m) => ({ ...m, content: aggregate })),
        onDone: () => setBusy(false),
        onError: (msg) => {
          updateLast((m) => ({ ...m, content: `${m.content}\n\n[error] ${msg}` }));
          setBusy(false);
        },
      });
      // Reload after stream completes to sync DB state
      setTimeout(() => reload(), 2000);
    } catch (e) {
      updateLast((m) => ({ ...m, content: `${m.content}\n\n[network error] ${String(e)}` }));
    } finally {
      setSending(false);
      setSendingInHook(false);
      setBusy(false);
    }
  }, [input, attachments, sending, thread, append, updateLast, reload, setSendingInHook]);

  if (!thread) {
    return (
      <section className="aios-panel flex items-center justify-center text-text-muted text-[12.5px]">
        Pick or create a thread to start.
      </section>
    );
  }

  return (
    <section
      className="aios-panel overflow-hidden flex flex-col min-h-0 min-w-0"
      style={{ background: 'linear-gradient(180deg, rgba(26,31,48,0.5), rgba(14,18,30,0.75))', backdropFilter: 'blur(18px)' }}
    >
      <header className="px-4 py-2.5 border-b border-border flex items-center gap-3">
        <div
          className="w-7 h-7 rounded-full grid place-items-center"
          style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)', boxShadow: '0 0 14px rgba(181,108,255,0.4)' }}
          aria-hidden
        >
          <span className="block w-2.5 h-2.5 rotate-45 bg-[#0a0c12] rounded-[1px]" />
        </div>
        <div>
          <div className="text-[13px] font-semibold text-text-primary leading-none">{thread.name}</div>
          <div className="vs-mono text-[9.5px] mt-1 leading-none tracking-[0.14em] text-text-muted">
            {thread.workspace_dir}
          </div>
        </div>
        <div className="ml-auto vs-mono text-[10px] text-text-muted tracking-wider">claude · cli · bypass</div>
      </header>

      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-4 space-y-2.5">
        {messages.map((m: CooMessage) => (
          <div key={m.id} className={`flex gap-2.5 min-w-0 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role !== 'user' && (
              <div
                className="w-6 h-6 rounded-md grid place-items-center flex-shrink-0 mt-0.5"
                style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)' }}
                aria-hidden
              >
                <span className="block w-2 h-2 rotate-45 bg-[#0a0c12]" />
              </div>
            )}
            <div className={`max-w-[78%] min-w-0 flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`px-3 py-2 rounded-lg text-[12.5px] leading-relaxed border ${
                  m.role === 'user' ? 'text-white border-accent/40' : 'text-text-primary border-border'
                }`}
                style={{
                  ...(m.role === 'user'
                    ? { background: 'linear-gradient(135deg, rgba(181,108,255,0.25), rgba(92,200,255,0.18))', boxShadow: '0 0 14px rgba(181,108,255,0.15)' }
                    : { background: 'rgba(255,255,255,0.03)' }),
                  overflowWrap: 'anywhere',
                }}
              >
                <div className="whitespace-pre-wrap break-words" style={{ overflowWrap: 'anywhere' }}>{m.content || (busy && m === messages[messages.length - 1] ? '…' : '')}</div>
              </div>
              <span className="vs-mono text-[9.5px] mt-0.5 px-1 text-text-muted">{fmtClock(m.created_at)}</span>
            </div>
          </div>
        ))}
        {busy && (
          <div className="vs-chip purple self-start">
            <span className="dot" style={{ background: '#b56cff', animation: 'vs-pulse 1s infinite' }} />
            thinking…
          </div>
        )}
      </div>

      <footer className="px-3 py-3 border-t border-border flex flex-col gap-2">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <div key={a.id} className="max-w-[240px] h-7 px-2 rounded flex items-center gap-1.5 text-[10.5px] border border-border bg-surface-2/60 text-text-secondary">
                <Paperclip className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{a.name}</span>
                <span className="font-mono text-text-muted flex-shrink-0">{bytesLabel(a.size)}</span>
                <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} disabled={sending} title="Remove" className="h-4 w-4 rounded flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-40">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => attachFiles(e.target.files)} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || attachments.length >= MAX_ATTACHMENTS}
            title="Attach files"
            className="w-10 h-[38px] rounded-md flex items-center justify-center flex-shrink-0 border border-border bg-surface-2/60 text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Talk to BOS"
            rows={1}
            className="flex-1 min-w-0 px-3 py-2 rounded-md bg-surface-2/60 border border-border text-text-primary text-[12.5px] placeholder:text-text-muted focus:outline-none focus:border-accent/60 resize-none leading-relaxed"
            style={{ maxHeight: '160px', overflowY: 'auto', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
            disabled={sending}
          />
          <DictationButton
            compact={false}
            disabled={sending}
            onTranscript={(text) =>
              setInput((prev) => (prev ? `${prev.trimEnd()} ${text}` : text))
            }
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={(!input.trim() && attachments.length === 0) || sending}
            className="px-3.5 py-2 rounded-md text-[12px] font-semibold text-[#0a0c12] disabled:opacity-50 flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)', boxShadow: '0 0 14px rgba(92,200,255,0.3)' }}
          >
            <Send className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Send
          </button>
        </div>
      </footer>
    </section>
  );
}
