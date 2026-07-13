import { useState, useEffect, useRef } from 'react';
import { MessageSquare, X, Send, Sparkles, Trash2, Paperclip } from 'lucide-react';
import { streamOfficeEaChat, type OfficeAttachment } from './officeOrbChat.js';
import { DictationButton } from '../DictationButton.js';

// The Orb accepts up to 4 attachments per message (matches the chat backend).
const MAX_ATTACHMENTS = 4;

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

type OrbPosition = { x: number; y: number };

const ORB_POSITION_KEY = 'boss_chat_orb_position';
const CHAT_LOG_KEY = 'boss_chat_orb_log';
const MAX_STORED_MESSAGES = 100;
const ORB_SIZE = 56;
const ORB_MARGIN = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Composer is FIXED height (h-[78px], ~3 lines, set via className).
// Long text SCROLLS inside the box instead of growing it.
function autosizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = ''; // scrub any stale inline height so the h-[78px] class governs
  el.style.overflowY = 'auto';
}

function defaultOrbPosition(): OrbPosition {
  if (typeof window === 'undefined') return { x: 24, y: 24 };
  return {
    x: window.innerWidth - ORB_SIZE - 24,
    y: window.innerHeight - ORB_SIZE - 24,
  };
}

function readOrbPosition(): OrbPosition {
  const fallback = defaultOrbPosition();
  try {
    const raw = localStorage.getItem(ORB_POSITION_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<OrbPosition>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return fallback;
    return {
      x: clamp(parsed.x, ORB_MARGIN, window.innerWidth - ORB_SIZE - ORB_MARGIN),
      y: clamp(parsed.y, ORB_MARGIN, window.innerHeight - ORB_SIZE - ORB_MARGIN),
    };
  } catch {
    return fallback;
  }
}

// The chat panel is user-resizable (drag the top-left corner). Size persists.
type PanelSize = { w: number; h: number };
const PANEL_SIZE_KEY = 'boss_chat_orb_size';
const MIN_PANEL_W = 300;
const MIN_PANEL_H = 320;
const DEFAULT_PANEL_W = 384;
const DEFAULT_PANEL_H = 640;
function readPanelSize(): PanelSize {
  const fallback = { w: DEFAULT_PANEL_W, h: DEFAULT_PANEL_H };
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PanelSize>;
    if (typeof parsed.w !== 'number' || typeof parsed.h !== 'number') return fallback;
    return { w: parsed.w, h: parsed.h };
  } catch {
    return fallback;
  }
}

export function BossOrb() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() => {
    // Persist the visible chat log so it survives reloads/navigation.
    try {
      const raw = localStorage.getItem(CHAT_LOG_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) return parsed as Message[];
    } catch { /* ignore corrupt log */ }
    return [];
  });
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<OfficeAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [orbPosition, setOrbPosition] = useState<OrbPosition>(readOrbPosition);
  const [panelSize, setPanelSize] = useState<PanelSize>(readPanelSize);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1024 : window.innerWidth,
    h: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const resizeState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist the user's chosen panel size.
  useEffect(() => {
    try { localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSize)); } catch { /* ignore */ }
  }, [panelSize]);

  // Fixed-height composer: scrub any stale inline height so the h-[78px] class
  // governs; long text scrolls inside the textarea rather than growing it.
  useEffect(() => {
    if (textareaRef.current) autosizeTextarea(textareaRef.current);
  }, [input]);

  // Persist the visible chat log (bounded) so it's still here on reload.
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_LOG_KEY, JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
    } catch { /* ignore quota/serialization errors */ }
  }, [messages]);

  // Keep the latest message in view (during streaming and when reopening).
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isOpen]);

  useEffect(() => {
    try { localStorage.setItem(ORB_POSITION_KEY, JSON.stringify(orbPosition)); } catch { /* ignore */ }
  }, [orbPosition]);

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      setOrbPosition((pos) => ({
        x: clamp(pos.x, ORB_MARGIN, window.innerWidth - ORB_SIZE - ORB_MARGIN),
        y: clamp(pos.y, ORB_MARGIN, window.innerHeight - ORB_SIZE - ORB_MARGIN),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Update the last assistant message in place (we stream into it).
  const setLastAssistant = (content: string) =>
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'assistant') { copy[i] = { ...copy[i], content, timestamp: Date.now() }; break; }
      }
      return copy;
    });

  // Turn picked files into attachments: images as base64 dataUrls, everything
  // else as text. Capped at MAX_ATTACHMENTS.
  const onFilesPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // let the same file be re-picked later
    for (const file of files) {
      let next: OfficeAttachment | null = null;
      try {
        if (file.type.startsWith('image/')) {
          next = { name: file.name, mimeType: file.type, dataUrl: await readAsDataURL(file) };
        } else {
          next = { name: file.name, mimeType: file.type || 'text/plain', text: await file.text() };
        }
      } catch { next = null; }
      if (next) setAttachments((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, next!]));
    }
  };

  const removeAttachment = (i: number) =>
    setAttachments((prev) => prev.filter((_, idx) => idx !== i));

  const sendMessage = async (text: string) => {
    if ((!text.trim() && attachments.length === 0) || loading) return;
    const outgoing = attachments;
    const shownText = text.trim() || `📎 ${outgoing.length} attachment${outgoing.length === 1 ? '' : 's'}`;

    // Push the user turn + an empty assistant turn we stream into.
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: shownText, timestamp: Date.now() },
      { role: 'assistant', content: '', timestamp: Date.now() },
    ]);
    setInput('');
    setAttachments([]);
    setLoading(true);

    try {
      let streamed = '';
      await streamOfficeEaChat({
        message: text,
        attachments: outgoing,
        onAssistantText: (agg) => { streamed = agg; setLastAssistant(agg); },
        onError: (m) => setLastAssistant(streamed || `Sorry - ${m}`),
      });
      if (!streamed) setLastAssistant('Done.');
    } catch (err) {
      console.error('Chat error:', err);
      setLastAssistant('Sorry, I encountered an error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const onOrbPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    dragState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: orbPosition.x,
      originY: orbPosition.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onOrbPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    setOrbPosition({
      x: clamp(drag.originX + dx, ORB_MARGIN, viewport.w - ORB_SIZE - ORB_MARGIN),
      y: clamp(drag.originY + dy, ORB_MARGIN, viewport.h - ORB_SIZE - ORB_MARGIN),
    });
  };

  const onOrbPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const panelWidth = clamp(panelSize.w, MIN_PANEL_W, viewport.w - 32);
  const panelHeight = clamp(panelSize.h, MIN_PANEL_H, viewport.h - 32);
  const panelLeft = clamp(orbPosition.x + ORB_SIZE - panelWidth, 16, viewport.w - panelWidth - 16);
  const panelTop = clamp(orbPosition.y - panelHeight - 12, 16, viewport.h - panelHeight - 16);

  // Panel is anchored bottom-right (near the orb), so the resize grip lives at
  // the TOP-LEFT corner: dragging up/left enlarges, down/right shrinks.
  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    resizeState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startW: panelWidth,
      startH: panelHeight,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rs = resizeState.current;
    if (!rs || rs.pointerId !== e.pointerId) return;
    const dx = e.clientX - rs.startX;
    const dy = e.clientY - rs.startY;
    setPanelSize({
      w: clamp(rs.startW - dx, MIN_PANEL_W, viewport.w - 32),
      h: clamp(rs.startH - dy, MIN_PANEL_H, viewport.h - 32),
    });
  };

  const onResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeState.current?.pointerId === e.pointerId) resizeState.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  return (
    <>
      {/* Floating orb button */}
      <button
        onPointerDown={onOrbPointerDown}
        onPointerMove={onOrbPointerMove}
        onPointerUp={onOrbPointerUp}
        onPointerCancel={onOrbPointerUp}
        onClick={() => {
          if (dragState.current?.moved) {
            dragState.current = null;
            return;
          }
          dragState.current = null;
          setIsOpen(!isOpen);
        }}
        className="fixed w-14 h-14 rounded-full text-white shadow-lg hover:shadow-xl transition-transform hover:scale-105 flex items-center justify-center z-50"
        style={{
          left: orbPosition.x,
          top: orbPosition.y,
          touchAction: 'none',
          background: 'radial-gradient(circle at 35% 25%, #ffffff 0%, #9be7ff 10%, #2563eb 42%, #6d28d9 72%, #17143f 100%)',
          boxShadow: isOpen
            ? '0 0 0 1px rgba(255,255,255,0.35), 0 0 28px rgba(80,125,255,0.72), 0 14px 30px rgba(20,20,50,0.38)'
            : '0 0 0 1px rgba(255,255,255,0.28), 0 0 20px rgba(80,125,255,0.48), 0 10px 24px rgba(20,20,50,0.34)',
          cursor: 'grab',
        }}
        aria-label="Open chat"
        title="Chat orb"
      >
        <span className="absolute inset-1 rounded-full border border-white/25" aria-hidden />
        {isOpen ? <X className="w-6 h-6 relative" /> : <Sparkles className="w-6 h-6 relative drop-shadow" />}
      </button>

      {/* Chat panel */}
      {isOpen && (
        <div
          className="fixed bg-surface-1 rounded-2xl shadow-2xl border border-border flex flex-col z-40"
          style={{ left: panelLeft, top: panelTop, width: panelWidth, height: panelHeight }}
        >
          {/* Resize grip (top-left corner) — drag to enlarge/shrink the window */}
          <div
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            className="absolute top-0 left-0 w-5 h-5 z-50 cursor-nwse-resize flex items-start justify-start p-1 group"
            style={{ touchAction: 'none' }}
            title="Drag to resize"
            aria-label="Resize chat window"
          >
            <span className="block w-2.5 h-2.5 border-l-2 border-t-2 border-text-muted/60 group-hover:border-v-blue rounded-tl-sm" />
          </div>

          {/* Header */}
          <div className="p-4 border-b border-border flex items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Office EA</h3>
              <p className="text-sm text-text-secondary">
                Shared Office conversation
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMessages([])}
              disabled={messages.length === 0}
              className="shrink-0 p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Clear chat window"
              aria-label="Clear chat window"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={messagesRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-text-muted py-8">
                <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>Start a conversation</p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] max-h-[260px] overflow-y-auto rounded-xl px-4 py-2 ${
                    msg.role === 'user'
                      ? 'bg-v-blue text-white'
                      : 'bg-surface-2 text-text-primary border border-border'
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-surface-2 border border-border rounded-xl px-4 py-2">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{animationDelay: '0ms'}} />
                    <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{animationDelay: '150ms'}} />
                    <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{animationDelay: '300ms'}} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="p-4 border-t border-border">
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded bg-surface-2 border border-border px-2 py-1 text-xs text-text-secondary max-w-[160px]"
                    title={a.name}
                  >
                    <span className="truncate">{a.name ?? 'file'}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="shrink-0 text-text-muted hover:text-text-primary"
                      aria-label="Remove attachment"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage(input);
              }}
              className="flex gap-2 items-end"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.csv,.json,.log,.yaml,.yml"
                className="hidden"
                onChange={onFilesPicked}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || attachments.length >= MAX_ATTACHMENTS}
                title={attachments.length >= MAX_ATTACHMENTS ? 'Attachment limit reached' : 'Attach files'}
                aria-label="Attach files"
                className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <Paperclip className="w-5 h-5" />
              </button>
              <DictationButton
                compact
                disabled={loading}
                onTranscript={(t) => setInput((prev) => (prev ? `${prev.trimEnd()} ${t}` : t))}
              />
              <textarea
                ref={textareaRef}
                value={input}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline (multi-line compose).
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage(input);
                  }
                }}
                placeholder="Type a message..."
                className="flex-1 h-[78px] resize-none overflow-y-auto leading-5 px-4 py-2 bg-surface-2 border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-v-blue"
                disabled={loading}
              />
              <button
                type="submit"
                disabled={(!input.trim() && attachments.length === 0) || loading}
                className="px-4 py-2 bg-v-blue text-white rounded-lg hover:bg-v-purple transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                <Send className="w-5 h-5" />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
