/**
 * /zucchi — Hermes CLI command center.
 *
 * Zucchi is intentionally separate from /oc so the Hermes surface does not
 * inherit Gio/Codex route names or session state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, Bot, Box, CheckCircle2, ChevronRight, Clock,
  Database, ExternalLink, FileCode2, FolderGit2, Globe, History, Loader2,
  PanelRightOpen, Paperclip, Radio, RefreshCw, Send, Server, Sparkles, SquareTerminal,
  Workflow, X, XCircle, Zap,
} from 'lucide-react';
import { useVisibilityAwarePolling } from '../lib/visibilityPolling.js';
import { useAgentName, promptRenameAgent } from '../lib/agentNames.js';
import { filesToAttachments, toWire, bytesLabel, MAX_ATTACHMENTS, type PendingAttachment } from '../lib/attachments.js';
import { KanbanBoard } from '../components/kanban/KanbanBoard.js';

const T = {
  bg: '#05060F',
  panel: '#0B0E1D',
  panel2: '#11152E',
  panel3: '#181D3A',
  border: '#232A4D',
  borderSoft: 'rgba(139,92,246,0.16)',
  text: '#F1F4FF',
  textDim: '#AAB3D6',
  textMuted: '#7681A8',
  green: '#22C55E',
  amber: '#F5C542',
  red: '#E84A6A',
  redDim: 'rgba(232,74,106,0.14)',
  cyan: '#8B5CF6',
  cyanDim: 'rgba(139,92,246,0.16)',
};

const SESSION_KEY = 'boss_zucchi_session_id';

type ViewMode = 'workstation' | 'ops' | 'tasks' | 'gateway';
type ActivityKind = 'session' | 'message' | 'error' | 'done' | 'system';

interface OverviewPayload {
  gateway: 'live' | 'down';
  agent: { id: string; model: string | null } | null;
  memoryReady: boolean;
  workspaceReady?: boolean;
  binReady?: boolean;
  workspace?: string;
  lastHeartbeatAt: string | null;
  errors: Array<{ source: string; stderrTail: string }>;
}
interface MemoryFile { name: string; size: number; mtime: number; }
interface MemoryFilesPayload { files: MemoryFile[]; }
interface ChatMsg { id: string; role: 'user' | 'assistant'; text: string; ts: number; }
interface ActivityItem { id: string; kind: ActivityKind; label: string; detail?: string; ts: number; }

function getToken(): string { return localStorage.getItem('boss_token') ?? ''; }
function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function getJson<TValue>(path: string): Promise<TValue> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as TValue;
}
function clock(ts: number | string | null | undefined): string {
  if (!ts) return '--:--';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function ago(ts: string | null | undefined): string {
  if (!ts) return 'unknown';
  const delta = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(delta)) return 'unknown';
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}
function bytes(n: number): string {
  if (n < 1024) return `${n}b`;
  return `${(n / 1024).toFixed(1)}k`;
}

function StatusDot({ status }: { status: 'ok' | 'warn' | 'error' | 'idle' }) {
  const color = status === 'ok' ? T.green : status === 'warn' ? T.amber : status === 'error' ? T.red : T.textMuted;
  return <span className="h-2 w-2 rounded-full" style={{ background: color, boxShadow: status === 'ok' ? `0 0 8px ${color}` : 'none' }} />;
}
function IconButton({ label, active, icon: Icon, onClick }: {
  label: string;
  active: boolean;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} title={label}
      className="h-8 px-2 rounded flex items-center gap-2 text-[11px] font-medium"
      style={{ color: active ? T.text : T.textDim, background: active ? T.panel3 : 'transparent', border: `1px solid ${active ? T.border : T.borderSoft}` }}>
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  );
}
function Panel({ title, icon: Icon, children, action }: {
  title: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="aios-panel min-h-0 flex flex-col">
      <header className="h-9 px-3 flex items-center gap-2 border-b" style={{ borderColor: T.borderSoft }}>
        <Icon className="h-3.5 w-3.5" style={{ color: T.cyan }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: T.text }}>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
function EmptyLine({ text }: { text: string }) {
  return <div className="px-3 py-2 text-[11px]" style={{ color: T.textMuted }}>{text}</div>;
}
function Badge({ text }: { text: string }) {
  return <div className="px-2 py-1.5 rounded text-[11px] font-mono truncate" style={{ color: T.textDim, background: T.panel2, border: `1px solid ${T.borderSoft}` }}>{text}</div>;
}
function SignalRow({ name, detail, ok }: { name: string; detail: string; ok: boolean }) {
  return (
    <div className="px-2 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2 }}>
      <StatusDot status={ok ? 'ok' : 'error'} />
      <span className="text-xs flex-1 truncate" style={{ color: T.text }}>{name}</span>
      <span className="text-[10px] font-mono truncate max-w-[54%]" style={{ color: T.textMuted }}>{detail}</span>
    </div>
  );
}

function TopBar({ overview, loading, mode, setMode }: {
  overview: OverviewPayload | null;
  loading: boolean;
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
}) {
  const backend = overview?.gateway === 'live' ? 'ok' : overview?.gateway === 'down' ? 'error' : 'idle';
  const [hermesName] = useAgentName('hermes');
  return (
    <header className="h-14 px-4 flex items-center gap-3 border-b shrink-0" style={{ background: T.panel, borderColor: T.border }}>
      <div className="h-9 w-9 rounded flex items-center justify-center" style={{ background: T.cyanDim, border: `1px solid ${T.border}` }}>
        <Sparkles className="h-4 w-4" style={{ color: T.cyan }} />
      </div>
      <div className="min-w-0">
        <div
          className="text-sm font-semibold"
          style={{ color: T.text, cursor: 'pointer' }}
          title="Click to rename your chief of staff"
          onClick={() => promptRenameAgent('hermes')}
        >{hermesName}</div>
        <div className="text-[11px] font-mono truncate" style={{ color: T.textMuted }}>{overview?.workspace ?? 'hermes-workspace'}</div>
      </div>
      <div className="ml-2 flex items-center gap-2 text-[11px]">
        <div className="px-2.5 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}>
          <StatusDot status={backend} /><span style={{ color: T.textDim }}>Hermes</span><span style={{ color: T.text }}>{overview?.agent?.model ?? 'hermes-cli'}</span>
        </div>
        <div className="px-2.5 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}>
          <StatusDot status={overview?.memoryReady ? 'ok' : 'warn'} /><span style={{ color: T.textDim }}>Memory</span><span style={{ color: T.text }}>{overview?.memoryReady ? 'ready' : 'check'}</span>
        </div>
        <div className="px-2.5 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" style={{ color: T.textMuted }} /> : <Clock className="h-3 w-3" style={{ color: T.textMuted }} />}
          <span style={{ color: T.textDim }}>Heartbeat</span><span style={{ color: T.text }}>{ago(overview?.lastHeartbeatAt)}</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <IconButton icon={SquareTerminal} label="Workstation" active={mode === 'workstation'} onClick={() => setMode('workstation')} />
        <IconButton icon={Server} label="Ops" active={mode === 'ops'} onClick={() => setMode('ops')} />
        <IconButton icon={Workflow} label="Tasks" active={mode === 'tasks'} onClick={() => setMode('tasks')} />
        <IconButton icon={Zap} label="Gateway" active={mode === 'gateway'} onClick={() => setMode('gateway')} />
      </div>
    </header>
  );
}

function ContextPanel({ overview }: { overview: OverviewPayload | null }) {
  return (
    <div className="space-y-3">
      <Panel title="Workspace" icon={FolderGit2}>
        <div className="p-3 space-y-2 text-[12px]">
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Agent</span><span className="font-mono" style={{ color: T.text }}>chief</span></div>
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Runtime</span><span className="font-mono" style={{ color: T.text }}>Hermes CLI</span></div>
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Workspace</span><span className="font-mono" style={{ color: overview?.workspaceReady ? T.green : T.red }}>{overview?.workspaceReady ? 'ready' : 'missing'}</span></div>
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Executable</span><span className="font-mono" style={{ color: overview?.binReady ? T.green : T.red }}>{overview?.binReady ? 'ready' : 'missing'}</span></div>
          <div className="pt-2 border-t" style={{ borderColor: T.borderSoft }}>
            <div className="text-[10px] uppercase font-mono mb-1" style={{ color: T.textMuted }}>Current root</div>
            <div className="text-[11px] font-mono break-all" style={{ color: T.textDim }}>{overview?.workspace ?? 'hermes-workspace'}</div>
          </div>
        </div>
      </Panel>
      <Panel title="Operator Checklist" icon={CheckCircle2}>
        <div className="p-2 space-y-1.5">
          <SignalRow name="Hermes CLI" ok={!!overview?.binReady} detail={overview?.binReady ? 'executable' : 'set BOSS_ZUCCHI_BIN'} />
          <SignalRow name="Memory context" ok={!!overview?.memoryReady} detail={overview?.memoryReady ? 'MEMORY.md found' : 'workspace memory missing'} />
          <SignalRow name="Workspace root" ok={!!overview?.workspaceReady} detail={overview?.workspace ?? 'hermes-workspace'} />
        </div>
      </Panel>
      <Panel title="Executable From Here" icon={Box}>
        <div className="p-3 space-y-2">
          <Badge text="Send Hermes CLI turns through chat" />
          <Badge text="Inspect memory files" />
          <Badge text="Open scoped task board" />
          <Badge text="Poll Hermes/API status" />
        </div>
      </Panel>
    </div>
  );
}

function MemoryPanel({ files, selected, content, loading, onSelect, onRefresh }: {
  files: MemoryFile[];
  selected: string | null;
  content: string;
  loading: boolean;
  onSelect: (file: string) => void;
  onRefresh: () => void;
}) {
  return (
    <Panel title="Memory" icon={Database} action={<button type="button" onClick={onRefresh} className="h-6 w-6 rounded flex items-center justify-center" style={{ color: T.textMuted }}><RefreshCw className="h-3.5 w-3.5" /></button>}>
      <div className="min-h-0 flex flex-col">
        <div className="max-h-44 overflow-y-auto p-2 space-y-1 border-b" style={{ borderColor: T.borderSoft }}>
          {files.length === 0 && <EmptyLine text="No memory files found." />}
          {files.map((file) => (
            <button key={file.name} type="button" onClick={() => onSelect(file.name)}
              className="w-full px-2 py-1.5 rounded flex items-center gap-2 text-left"
              style={{ background: selected === file.name ? T.cyanDim : T.panel2, border: `1px solid ${selected === file.name ? T.cyan : 'transparent'}` }}>
              <FileCode2 className="h-3.5 w-3.5 shrink-0" style={{ color: T.textMuted }} />
              <span className="text-[11px] font-mono flex-1 truncate" style={{ color: T.text }}>{file.name}</span>
              <span className="text-[10px]" style={{ color: T.textMuted }}>{bytes(file.size)}</span>
            </button>
          ))}
        </div>
        <div className="min-h-[180px] max-h-[300px] overflow-y-auto p-3">
          {loading ? <div className="text-[11px]" style={{ color: T.textMuted }}>Loading memory file...</div>
            : content ? <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono" style={{ color: T.textDim }}>{content}</pre>
              : <EmptyLine text="Select a memory file to inspect it." />}
        </div>
      </div>
    </Panel>
  );
}

function ActivityPanel({ items }: { items: ActivityItem[] }) {
  const iconFor = (kind: ActivityKind) => kind === 'error' ? XCircle : kind === 'done' ? CheckCircle2 : kind === 'session' ? History : Activity;
  return (
    <Panel title="Live Activity" icon={Activity}>
      <div className="min-h-0 max-h-[260px] overflow-y-auto p-2 space-y-1.5">
        {items.length === 0 && <EmptyLine text="Activity will appear here as Hermes works." />}
        {items.map((item) => {
          const Icon = iconFor(item.kind);
          const color = item.kind === 'error' ? T.red : item.kind === 'done' ? T.green : item.kind === 'session' ? T.cyan : T.textMuted;
          return (
            <div key={item.id} className="px-2 py-1.5 rounded flex gap-2" style={{ background: T.panel2 }}>
              <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="text-[11px] font-medium truncate" style={{ color: T.text }}>{item.label}</span><span className="text-[10px] font-mono ml-auto" style={{ color: T.textMuted }}>{clock(item.ts)}</span></div>
                {item.detail && <div className="text-[10.5px] truncate" style={{ color: T.textMuted }}>{item.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

const COMMAND_PRESETS = [
  'Summarize my unread emails and flag anything that needs a reply today.',
  'Give me today\'s schedule and the top 3 things I should focus on.',
  'Summarize the latest AI and industry news I should know about.',
  'Draft a short update to my team on what we shipped this week.',
] as const;

function ChatPane({ disabled, onActivity }: { disabled: boolean; onActivity: (item: Omit<ActivityItem, 'id' | 'ts'>) => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, busy]);
  useEffect(() => {
    const sid = localStorage.getItem(SESSION_KEY);
    if (!sid) return;
    void (async () => {
      try {
        const res = await fetch(`api/zucchi/chat/${sid}`, { headers: authHeaders() });
        if (!res.ok) return;
        const body = (await res.json()) as { turns?: { role: 'user' | 'assistant'; text: string }[] };
        if (body.turns && body.turns.length) {
          setMessages(body.turns.map((t, i) => ({ id: `h-${i}`, role: t.role, text: t.text, ts: Date.now() - (body.turns!.length - i) })));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  const attachFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    void (async () => {
      try {
        const next = await filesToAttachments(files, attachments.length);
        setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
      } catch { /* oversized file ignored */ }
      finally { if (fileInputRef.current) fileInputRef.current.value = ''; }
    })();
  }, [attachments.length]);

  const pushActivity = useCallback((item: Omit<ActivityItem, 'id' | 'ts'>) => onActivity(item), [onActivity]);
  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;
    const outgoing = attachments;
    const msg = text || 'Please review the attached file(s).';
    setSending(true); setBusy(true); setInput(''); setAttachments([]);
    const sessionId = localStorage.getItem(SESSION_KEY) || undefined;
    const now = Date.now();
    const userText = outgoing.length ? `${msg}\n\n📎 ${outgoing.map((a) => a.name).join(', ')}` : msg;
    setMessages((prev) => [...prev, { id: `u-${now}`, role: 'user', text: userText, ts: now }, { id: `a-${now}`, role: 'assistant', text: '', ts: now }]);
    pushActivity({ kind: 'system', label: 'Turn started', detail: msg.slice(0, 140) });
    try {
      const res = await fetch('api/zucchi/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() },
        body: JSON.stringify({ message: msg, sessionId, ...(outgoing.length ? { attachments: outgoing.map(toWire) } : {}) }),
      });
      if (!res.ok) throw new Error(`chat ${res.status}`);
      if (!res.body) throw new Error('no response stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = ''; let done = false; let aggregate = '';
      while (!done) {
        const r = await reader.read(); done = r.done;
        if (!r.value) continue;
        buf += decoder.decode(r.value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, sep); buf = buf.slice(sep + 2);
          let evType = ''; let dataStr = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) evType = line.slice(6).trim();
            if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          const parsed = JSON.parse(dataStr) as Record<string, unknown>;
          if (evType === 'session' && typeof parsed.sessionId === 'string') {
            localStorage.setItem(SESSION_KEY, parsed.sessionId);
            pushActivity({ kind: 'session', label: 'Session attached', detail: parsed.sessionId });
          } else if (evType === 'message' && typeof parsed.text === 'string') {
            aggregate += parsed.text;
            setMessages((prev) => { const next = prev.slice(); next[next.length - 1] = { ...next[next.length - 1], text: aggregate }; return next; });
          } else if (evType === 'error') {
            const detail = String(parsed.message ?? parsed.stderrTail ?? 'unknown error');
            pushActivity({ kind: 'error', label: 'Turn error', detail });
            setMessages((prev) => { const next = prev.slice(); next[next.length - 1] = { ...next[next.length - 1], text: `${next[next.length - 1].text}\n\n[error] ${detail}` }; return next; });
          } else if (evType === 'done') {
            pushActivity({ kind: 'done', label: 'Turn completed', detail: typeof parsed.durationMs === 'number' ? `${parsed.durationMs}ms` : undefined });
            setBusy(false);
          }
        }
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      pushActivity({ kind: 'error', label: 'Network error', detail });
      setMessages((prev) => { const next = prev.slice(); next[next.length - 1] = { ...next[next.length - 1], text: `${next[next.length - 1].text}\n\n[network error] ${detail}` }; return next; });
    } finally { setSending(false); setBusy(false); }
  }, [input, attachments, sending, pushActivity]);

  return (
    <Panel title="Hermes Conversation" icon={Radio} action={<button type="button" onClick={() => { localStorage.removeItem(SESSION_KEY); setMessages([]); pushActivity({ kind: 'system', label: 'New session', detail: 'Browser session cleared' }); }} className="text-[10px] px-2 py-1 rounded" style={{ color: T.textDim, border: `1px solid ${T.borderSoft}` }}>new</button>}>
      <div className="min-h-0 flex-1 flex flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="mt-8 mx-auto max-w-2xl space-y-4">
              <div className="text-center text-xs" style={{ color: T.textMuted }}>Hermes is your Gemini-powered operator. It is live on your key - command it here.</div>
              <div className="grid grid-cols-2 gap-2">
                {COMMAND_PRESETS.map((preset) => (
                  <button key={preset} type="button" onClick={() => setInput(preset)} className="px-3 py-2 rounded text-left text-[11px] leading-snug border" style={{ color: T.textDim, background: T.panel2, borderColor: T.borderSoft }}>
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}><div className="max-w-[82%] px-3 py-2 rounded border whitespace-pre-wrap break-words text-[12.5px] leading-relaxed" style={m.role === 'user' ? { background: T.cyanDim, borderColor: T.cyan, color: T.text } : { background: T.panel2, borderColor: T.borderSoft, color: T.textDim }}>{m.text || (busy ? '...' : '')}</div><span className="text-[10px] mt-0.5" style={{ color: T.textMuted }}>{clock(m.ts)}</span></div>)}
        </div>
        <footer className="p-3 flex flex-col gap-2 border-t" style={{ borderColor: T.borderSoft }}>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <div key={a.id} className="max-w-[240px] h-7 px-2 rounded flex items-center gap-1.5 text-[10.5px] border" style={{ color: T.textDim, background: T.panel2, borderColor: T.borderSoft }}>
                  <Paperclip className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{a.name}</span>
                  <span className="font-mono flex-shrink-0" style={{ color: T.textMuted }}>{bytesLabel(a.size)}</span>
                  <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} disabled={sending} title="Remove" className="h-4 w-4 rounded flex items-center justify-center disabled:opacity-40" style={{ color: T.textMuted }}><X className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => attachFiles(e.target.files)} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled || sending || attachments.length >= MAX_ATTACHMENTS} title="Attach files" className="w-11 rounded flex items-center justify-center disabled:opacity-40" style={{ color: T.textDim, background: T.panel2, border: `1px solid ${T.border}` }}><Paperclip className="h-4 w-4" /></button>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} disabled={disabled || sending} rows={2} placeholder={disabled ? 'Chief of staff backend unavailable' : 'Command your chief of staff...'} className="flex-1 min-w-0 px-3 py-2 rounded text-[12.5px] resize-none" style={{ color: T.text, background: T.panel2, border: `1px solid ${T.border}`, maxHeight: 160 }} />
            <button type="button" onClick={() => void send()} disabled={disabled || sending || (!input.trim() && attachments.length === 0)} className="w-11 rounded flex items-center justify-center disabled:opacity-40" style={{ background: T.cyan, color: '#061016' }}><Send className="h-4 w-4" /></button>
          </div>
        </footer>
      </div>
    </Panel>
  );
}

function GatewayPane() {
  const url = 'https://gateway.vasari.starrpartners.ai';
  return (
    <main className="min-h-0 flex-1 flex flex-col">
      <div className="h-10 px-3 flex items-center gap-2 border-b shrink-0" style={{ borderColor: T.border, background: T.panel }}>
        <span className="text-[11px] font-medium" style={{ color: T.text }}>Hermes Agent — config & chat</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded" style={{ color: T.textDim, background: T.panel2, border: '1px solid ' + T.borderSoft }}>
          <ExternalLink className="h-3 w-3" /> Open in new tab
        </a>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden" style={{ background: '#0b0b0f' }}>
        <iframe title="Hermes Agent" src={url} className="w-full h-full" style={{ border: 'none', background: '#0b0b0f' }} allow="clipboard-read; clipboard-write; microphone" />
      </div>
    </main>
  );
}

function OpsMode({ overview }: { overview: OverviewPayload | null }) {
  return (
    <main className="min-h-0 flex-1 grid gap-3 p-3" style={{ gridTemplateColumns: '320px minmax(420px, 1fr)' }}>
      <aside className="min-h-0 overflow-y-auto space-y-3"><ContextPanel overview={overview} /></aside>
      <section className="min-h-0 overflow-y-auto space-y-3">
        <Panel title="Hermes Runtime" icon={Server}>
          <div className="p-2 space-y-1.5">
            <SignalRow name="Gateway" ok={overview?.gateway === 'live'} detail={overview?.gateway ?? 'unknown'} />
            <SignalRow name="Hermes binary" ok={!!overview?.binReady} detail={overview?.binReady ? 'ready' : 'missing'} />
            <SignalRow name="Workspace" ok={!!overview?.workspaceReady} detail={overview?.workspace ?? 'hermes-workspace'} />
            {(overview?.errors ?? []).map((err) => <SignalRow key={err.source} name={err.source} ok={false} detail={err.stderrTail} />)}
          </div>
        </Panel>
      </section>
    </main>
  );
}

export default function ChiefOfStaff() {
  const [mode, setMode] = useState<ViewMode>('workstation');
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const addActivity = useCallback((item: Omit<ActivityItem, 'id' | 'ts'>) => {
    setActivity((prev) => [{ ...item, id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ts: Date.now() }, ...prev].slice(0, 80));
  }, []);
  const fetchOverview = useCallback(() => { void (async () => { try { const r = await getJson<OverviewPayload>('api/zucchi/overview'); setOverview(r); setOverviewError(null); } catch (e) { setOverviewError(String(e)); } finally { setOverviewLoading(false); } })(); }, []);
  const fetchMemory = useCallback(() => { void (async () => { try { const r = await getJson<MemoryFilesPayload>('api/zucchi/memory/files'); setMemoryFiles(r.files); } catch { /* nonfatal */ } })(); }, []);
  useVisibilityAwarePolling(fetchOverview, 10_000, true);
  useVisibilityAwarePolling(fetchMemory, 30_000, true);

  const selectMemory = useCallback((file: string) => {
    setSelectedMemory(file);
    setMemoryLoading(true);
    setMemoryContent('');
    void (async () => {
      try {
        const r = await getJson<{ content: string }>(`api/zucchi/memory/files/${encodeURIComponent(file)}`);
        setMemoryContent(r.content);
      } catch (e) {
        setMemoryContent(`[error] ${String(e)}`);
      } finally {
        setMemoryLoading(false);
      }
    })();
  }, []);

  const currentObjective = useMemo(() => activity.find((a) => a.kind === 'system' && a.label === 'Turn started')?.detail ?? 'No active turn. Use chat to start work.', [activity]);
  const chatDisabled = overview?.gateway === 'down';

  return (
    <div className="aios-page h-full min-h-0 flex flex-col" style={{ color: T.text }}>
      <TopBar overview={overview} loading={overviewLoading} mode={mode} setMode={setMode} />
      {overviewError && <div className="px-4 py-2 text-[11px] border-b flex items-center gap-2" style={{ color: T.red, background: T.redDim, borderColor: T.border }}><AlertTriangle className="h-3.5 w-3.5" />Overview fetch failed: {overviewError}</div>}
      {mode === 'tasks' ? <div className="aios-page-pad min-h-0 flex-1 overflow-hidden"><div className="aios-workbench h-full"><KanbanBoard scope={{ kind: 'outsider', handle: 'zucchi' }} /></div></div> : mode === 'gateway' ? <GatewayPane /> : mode === 'ops' ? <OpsMode overview={overview} /> : (
        <main className="aios-page-pad min-h-0 flex-1 grid gap-3" style={{ gridTemplateColumns: '300px minmax(420px, 1fr) 340px' }}>
          <aside className="min-h-0 overflow-y-auto space-y-3"><ContextPanel overview={overview} /><MemoryPanel files={memoryFiles} selected={selectedMemory} content={memoryContent} loading={memoryLoading} onSelect={selectMemory} onRefresh={fetchMemory} /></aside>
          <section className="min-h-0 grid gap-3" style={{ gridTemplateRows: 'minmax(360px, 1fr) 220px' }}><ChatPane disabled={!!chatDisabled} onActivity={addActivity} /><ActivityPanel items={activity} /></section>
          <aside className="min-h-0 overflow-y-auto space-y-3"><Panel title="Current Objective" icon={PanelRightOpen}><div className="p-3 text-[12px] leading-relaxed" style={{ color: T.textDim }}>{currentObjective}</div></Panel><Panel title="Launch Surfaces" icon={SquareTerminal}><div className="grid grid-cols-2 gap-2 p-3"><a href="/kanban" className="px-2 py-2 rounded border no-underline" style={{ background: T.panel2, borderColor: T.borderSoft }}><div className="text-[11px] font-medium truncate" style={{ color: T.text }}>Task Board</div><div className="text-[10px] truncate" style={{ color: T.textMuted }}>Work queue</div></a><a href="/agents" className="px-2 py-2 rounded border no-underline" style={{ background: T.panel2, borderColor: T.borderSoft }}><div className="text-[11px] font-medium truncate" style={{ color: T.text }}>Employee Agents</div><div className="text-[10px] truncate" style={{ color: T.textMuted }}>Agent roster</div></a></div></Panel><ContextPanel overview={overview} /></aside>
        </main>
      )}
    </div>
  );
}
