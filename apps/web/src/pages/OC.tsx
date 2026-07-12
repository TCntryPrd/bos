/**
 * /oc — Codex workstation.
 *
 * Compatibility note: the API routes still live under /api/openclaw/* until
 * the backend/frontend route migration is worth doing. The runtime surface is
 * Codex CLI plus its cognitive-memory-lite workspace.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Activity, AlertTriangle, Bot, Box, CheckCircle2, ChevronRight, Clock,
  Cpu, Database, FileCode2, FolderGit2, History, Loader2, Mail,
  MessageSquareText, PanelRightOpen, Paperclip, PlugZap, Plus, Radio, RefreshCw,
  Send, Server, Sparkles, SquareTerminal, StopCircle, Workflow, XCircle,
} from 'lucide-react';
import { useVisibilityAwarePolling } from '../lib/visibilityPolling.js';
import { useAgentName, promptRenameAgent } from '../lib/agentNames.js';
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
  greenDim: 'rgba(34,197,94,0.14)',
  amber: '#F5C542',
  amberDim: 'rgba(245,197,66,0.14)',
  red: '#E84A6A',
  redDim: 'rgba(232,74,106,0.14)',
  blue: '#0EA5E9',
  blueDim: 'rgba(14,165,233,0.16)',
  violet: '#7C3CFF',
  violetDim: 'rgba(124,60,255,0.16)',
};

const SESSION_KEY = 'boss_oc_session_id';
const SESSION_THREADS_KEY = 'boss_oc_threads_v1';

type ViewMode = 'workstation' | 'ops' | 'tasks';
type ActivityKind = 'session' | 'message' | 'error' | 'done' | 'system';

interface OverviewPayload {
  gateway: 'live' | 'down';
  agent: { id: string; model: string | null } | null;
  channels: Array<{ name: string; transport: string; running: boolean }>;
  memoryReady: boolean;
  lastHeartbeatAt: string | null;
  errors: Array<{ source: string; stderrTail: string }>;
}

interface MemoryFile { name: string; size: number; mtime: number; }
interface MemoryFilesPayload { files: MemoryFile[]; }
interface ChannelsPayload {
  channels: Array<{ name: string; transport: string; accounts: string[] }>;
  providers: Array<{ id: string; mode?: string }>;
}
interface SkillsPayload {
  workspaceDir?: string;
  skills?: Array<{ name: string; description?: string; eligible?: boolean; disabled?: boolean }>;
}
interface HealthPayload {
  overall?: string;
  services?: Array<{ service: string; status: string; message?: string; checkedAt?: string }>;
  checkedAt?: string;
}
interface BrainStatusPayload {
  ready: boolean;
  adapterCount: number;
  adapters: Record<string, string>;
}
interface ConnectorStatus { provider: string; status: string; configuredAt?: string; }
interface AppsStatusPayload { androidInstalled?: boolean; windowsInstalled?: boolean; legacyKnowledgeEnabled?: boolean; }
interface EmailStatusPayload { [key: string]: unknown; }
interface OpsState {
  health: HealthPayload | null;
  brain: BrainStatusPayload | null;
  connectors: ConnectorStatus[];
  apps: AppsStatusPayload | null;
  email: EmailStatusPayload | null;
  error: string | null;
  checkedAt: number | null;
}
interface UsageRecap {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
}
interface ChatMsg { id: string; role: 'user' | 'assistant'; text: string; ts: number; usage?: UsageRecap; }
interface ActivityItem { id: string; kind: ActivityKind; label: string; detail?: string; ts: number; }
interface PendingAttachment { id: string; name: string; mimeType: string; size: number; dataUrl: string; }
interface GioThread {
  localId: string;
  name: string;
  topic: string;
  conversationId?: string;
  newConversation?: boolean;
  messages: ChatMsg[];
  createdAt: number;
  updatedAt: number;
}
interface GioDbMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}
interface GioMessagesPayload {
  conversationId: string;
  sessionId?: string;
  name?: string;
  messages: GioDbMessage[];
}

function getToken(): string { return localStorage.getItem('boss_token') ?? ''; }
function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}
async function getJsonBody<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  const body = (await res.json().catch(() => ({}))) as T;
  if (!res.ok && Object.keys(body as Record<string, unknown>).length === 0) throw new Error(`${path} ${res.status}`);
  return body;
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
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / 1024 / 1024).toFixed(1)}m`;
}
function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}
async function filesToAttachments(files: FileList, existingCount: number): Promise<PendingAttachment[]> {
  const slots = Math.max(0, 4 - existingCount);
  const selected = Array.from(files).slice(0, slots);
  const converted: PendingAttachment[] = [];
  for (const file of selected) {
    const maxBytes = file.type.startsWith('image/') ? 8 * 1024 * 1024 : 512 * 1024;
    if (file.size > maxBytes) throw new Error(`${file.name} is larger than ${bytes(maxBytes)}`);
    converted.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: await readFileDataUrl(file),
    });
  }
  return converted;
}
function firstWords(text: string, maxWords = 6): string {
  const words = text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean).slice(0, maxWords);
  return words.join(' ') || 'Codex session';
}
function makeThread(name = 'Codex conversation', newConversation = false): GioThread {
  const now = Date.now();
  return {
    localId: `gio-${now}-${Math.random().toString(16).slice(2)}`,
    name,
    topic: 'No topic yet',
    newConversation,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}
function readThreads(): GioThread[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_THREADS_KEY) || '[]') as Array<GioThread & { sessionId?: string }>;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((thread) => ({
        ...thread,
        conversationId: thread.conversationId ?? thread.sessionId,
        newConversation: false,
      }));
    }
  } catch { /* ignore corrupt browser state */ }
  return [makeThread()];
}
function saveThreads(threads: GioThread[]): void {
  localStorage.setItem(SESSION_THREADS_KEY, JSON.stringify(threads.slice(0, 12)));
}
function numField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function usageFromDone(parsed: Record<string, unknown>): UsageRecap | undefined {
  const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as Record<string, unknown> : null;
  const recap: UsageRecap = {
    durationMs: numField(parsed, 'durationMs'),
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
  };
  if (usage) {
    recap.inputTokens = numField(usage, 'input_tokens');
    recap.cachedInputTokens = numField(usage, 'cached_input_tokens');
    recap.outputTokens = numField(usage, 'output_tokens');
    recap.reasoningOutputTokens = numField(usage, 'reasoning_output_tokens');
  }
  return Object.values(recap).some((value) => value !== undefined) ? recap : undefined;
}
function usageText(usage: UsageRecap | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens.toLocaleString()}`);
  if (usage.cachedInputTokens !== undefined) parts.push(`cached ${usage.cachedInputTokens.toLocaleString()}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens.toLocaleString()}`);
  if (usage.reasoningOutputTokens !== undefined) parts.push(`reason ${usage.reasoningOutputTokens.toLocaleString()}`);
  if (usage.durationMs !== undefined) parts.push(`${(usage.durationMs / 1000).toFixed(1)}s`);
  if (usage.model) parts.push(usage.model);
  return parts.join(' / ');
}
function dbMessagesToChat(messages: GioDbMessage[]): ChatMsg[] {
  return messages
    .filter((m): m is GioDbMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: m.content,
      ts: new Date(m.createdAt).getTime(),
      usage: {
        inputTokens: m.tokensIn ?? undefined,
        outputTokens: m.tokensOut ?? undefined,
      },
    }));
}

function StatusDot({ status }: { status: 'ok' | 'warn' | 'error' | 'idle' }) {
  const color = status === 'ok' ? T.green : status === 'warn' ? T.amber : status === 'error' ? T.red : T.textMuted;
  return <span className="h-2 w-2 rounded-full" style={{ background: color, boxShadow: status === 'ok' ? `0 0 8px ${color}` : 'none' }} />;
}
function IconButton({ icon: Icon, label, onClick, active = false }: {
  icon: React.ComponentType<{ className?: string; style?: CSSProperties }>;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} title={label}
      className="h-8 px-2 rounded flex items-center gap-2 text-[11px] font-medium transition-colors"
      style={{ color: active ? T.text : T.textDim, background: active ? T.panel3 : 'transparent', border: `1px solid ${active ? T.border : T.borderSoft}` }}>
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  );
}
function Panel({ title, icon: Icon, children, action }: {
  title: string;
  icon: React.ComponentType<{ className?: string; style?: CSSProperties }>;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="aios-panel min-h-0 flex flex-col">
      <header className="h-9 px-3 flex items-center gap-2 border-b" style={{ borderColor: T.borderSoft }}>
        <Icon className="h-3.5 w-3.5" style={{ color: T.violet }} />
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

function TopBar({ overview, loading, mode, setMode }: {
  overview: OverviewPayload | null;
  loading: boolean;
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
}) {
  const backend = overview?.gateway === 'live' ? 'ok' : overview?.gateway === 'down' ? 'error' : 'idle';
  const [codexName] = useAgentName('codex');
  return (
    <header className="h-14 px-4 flex items-center gap-3 border-b shrink-0" style={{ background: T.panel, borderColor: T.border }}>
      <div className="h-9 w-9 rounded flex items-center justify-center" style={{ background: T.violetDim, border: `1px solid ${T.border}` }}>
        <Sparkles className="h-4 w-4" style={{ color: T.violet }} />
      </div>
      <div className="min-w-0">
        <div
          className="text-sm font-semibold"
          style={{ color: T.text, cursor: 'pointer' }}
          title="Click to rename"
          onClick={() => promptRenameAgent('codex')}
        >{codexName}</div>
        <div className="text-[11px] font-mono truncate" style={{ color: T.textMuted }}>Codex CLI · cognitive-memory-lite</div>
      </div>
      <div className="ml-2 flex items-center gap-2 text-[11px]">
        <div className="px-2.5 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}>
          <StatusDot status={backend} /><span style={{ color: T.textDim }}>Codex</span><span style={{ color: T.text }}>{overview?.agent?.model ?? 'codex-cli'}</span>
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
      </div>
    </header>
  );
}

function ContextPanel({ overview, channels, skills }: {
  overview: OverviewPayload | null;
  channels: ChannelsPayload | null;
  skills: SkillsPayload | null;
}) {
  const providerCount = channels?.providers.length ?? 0;
  const skillCount = skills?.skills?.length ?? 0;
  return (
    <div className="space-y-3">
      <Panel title="Workspace" icon={FolderGit2}>
        <div className="p-3 space-y-2 text-[12px]">
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Agent</span><span className="font-mono" style={{ color: T.text }}>{overview?.agent?.id ?? 'codex'}</span></div>
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Runtime</span><span className="font-mono" style={{ color: T.text }}>Codex CLI</span></div>
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Mode</span><span className="font-mono" style={{ color: T.text }}>cognitive-memory-lite</span></div>
          <div className="pt-2 border-t" style={{ borderColor: T.borderSoft }}>
            <div className="text-[10px] uppercase font-mono mb-1" style={{ color: T.textMuted }}>Current root</div>
            <div className="text-[11px] font-mono break-all" style={{ color: T.textDim }}>/home/tcntryprd/outsiders/codex</div>
          </div>
        </div>
      </Panel>
      <Panel title="System Map" icon={Server}>
        <div className="p-2 space-y-1.5">
          {[
            ['Portal', 'web container', 'ok'],
            ['API', 'local health checked', 'ok'],
            ['Weaviate', 'shared vector memory', 'ok'],
            ['Codex', 'Codex CLI', 'ok'],
          ].map(([name, detail, status]) => (
            <div key={name} className="px-2 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2 }}>
              <StatusDot status={status as 'ok' | 'warn' | 'idle'} />
              <span className="text-xs flex-1" style={{ color: T.text }}>{name}</span>
              <span className="text-[10px] font-mono" style={{ color: T.textMuted }}>{detail}</span>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Capabilities" icon={Bot}>
        <div className="grid grid-cols-2 gap-2 p-3">
          <MiniMetric label="Providers" value={String(providerCount || 1)} />
          <MiniMetric label="Skills" value={String(skillCount)} />
          <MiniMetric label="Channels" value={String(channels?.channels.length ?? 0)} />
          <MiniMetric label="Memory" value={overview?.memoryReady ? 'on' : 'check'} />
        </div>
      </Panel>
    </div>
  );
}
function MiniMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded p-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}><div className="text-[10px] uppercase font-mono" style={{ color: T.textMuted }}>{label}</div><div className="text-sm font-semibold" style={{ color: T.text }}>{value}</div></div>;
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
              style={{ background: selected === file.name ? T.violetDim : T.panel2, border: `1px solid ${selected === file.name ? T.violet : 'transparent'}` }}>
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
        {items.length === 0 && <EmptyLine text="Activity will appear here as Codex works." />}
        {items.map((item) => {
          const Icon = iconFor(item.kind);
          const color = item.kind === 'error' ? T.red : item.kind === 'done' ? T.green : item.kind === 'session' ? T.blue : T.textMuted;
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

function ChecklistPanel({ activityCount, memoryReady }: { activityCount: number; memoryReady: boolean }) {
  const rows = [
    ['Chat backend', true, 'Codex CLI responding through portal'],
    ['Memory context', memoryReady, 'Codex workspace has MEMORY.md'],
    ['Activity stream', activityCount > 0, activityCount > 0 ? 'Current session events captured' : 'Starts when you send a turn'],
    ['Task board', true, 'Task Board is available from this surface'],
    ['Health status', true, 'API and Codex overview are polling live'],
  ] as const;
  return (
    <Panel title="Operator Checklist" icon={CheckCircle2}>
      <div className="p-2 space-y-1.5">
        {rows.map(([label, ok, detail]) => (
          <div key={label} className="px-2 py-1.5 rounded flex items-start gap-2" style={{ background: T.panel2 }}>
            {ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5" style={{ color: T.green }} /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5" style={{ color: T.amber }} />}
            <div className="min-w-0"><div className="text-[11px] font-medium" style={{ color: T.text }}>{label}</div><div className="text-[10px]" style={{ color: T.textMuted }}>{detail}</div></div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ToolingPanel({ channels, skills }: { channels: ChannelsPayload | null; skills: SkillsPayload | null }) {
  return (
    <Panel title="Tools & Integrations" icon={Box}>
      <div className="p-3 space-y-3">
        <div>
          <div className="text-[10px] uppercase font-mono mb-1" style={{ color: T.textMuted }}>Providers</div>
          <div className="space-y-1">{(channels?.providers ?? [{ id: 'codex-cli', mode: 'local' }]).map((p) => <Badge key={p.id} text={`${p.id}${p.mode ? ` · ${p.mode}` : ''}`} />)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-mono mb-1" style={{ color: T.textMuted }}>Skills</div>
          {(skills?.skills?.length ?? 0) === 0 ? <EmptyLine text="No Codex skills reported by backend yet." /> : <div className="space-y-1">{skills!.skills!.slice(0, 6).map((s) => <Badge key={s.name} text={s.name} />)}</div>}
        </div>
      </div>
    </Panel>
  );
}
function Badge({ text }: { text: string }) {
  return <div className="px-2 py-1.5 rounded text-[11px] font-mono truncate" style={{ color: T.textDim, background: T.panel2, border: `1px solid ${T.borderSoft}` }}>{text}</div>;
}

function statusKind(status: string | undefined): 'ok' | 'warn' | 'error' | 'idle' {
  const s = (status ?? '').toLowerCase();
  if (['ok', 'ready', 'live', 'healthy', 'configured', 'running', 'true'].includes(s)) return 'ok';
  if (['unhealthy', 'error', 'down', 'failed'].includes(s)) return 'error';
  if (['degraded', 'unknown', 'not_configured', 'check'].includes(s)) return 'warn';
  return 'idle';
}
function kvValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return 'none';
  if (Array.isArray(value)) return `${value.length} items`;
  return 'available';
}
function SignalRow({ name, detail, status }: { name: string; detail?: string; status?: string }) {
  return (
    <div className="px-2 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2 }}>
      <StatusDot status={statusKind(status)} />
      <span className="text-xs flex-1 truncate" style={{ color: T.text }}>{name}</span>
      <span className="text-[10px] font-mono truncate max-w-[54%]" style={{ color: T.textMuted }}>{detail ?? status ?? 'unknown'}</span>
    </div>
  );
}
const LAUNCH_SURFACES = [
  ['/tasks', 'Task Board', 'Work queue'],
  ['/brain', 'Brain Config', 'AI routing'],
  ['/connectors', 'Connectors', 'OAuth status'],
  ['/backup', 'Backup', 'Recovery state'],
  ['/voice', 'Voice Devices', 'Mic layer'],
  ['/agents', 'Employee Agents', 'Your AI staff'],
  ['/coo', 'Claude CLI', 'Operations'],
] as const;
function LaunchPanel() {
  return (
    <Panel title="Launch Surfaces" icon={SquareTerminal}>
      <div className="grid grid-cols-2 gap-2 p-3">
        {LAUNCH_SURFACES.map(([href, label, detail]) => (
          <a key={href} href={href} className="px-2 py-2 rounded border no-underline" style={{ background: T.panel2, borderColor: T.borderSoft }}>
            <div className="text-[11px] font-medium truncate" style={{ color: T.text }}>{label}</div>
            <div className="text-[10px] truncate" style={{ color: T.textMuted }}>{detail}</div>
          </a>
        ))}
      </div>
    </Panel>
  );
}
function OpsOverviewPanel({ ops }: { ops: OpsState }) {
  const services = ops.health?.services ?? [];
  const unhealthy = services.filter((svc) => statusKind(svc.status) === 'error').length;
  const warn = services.filter((svc) => statusKind(svc.status) === 'warn').length;
  return (
    <Panel title="System Overview" icon={Server}>
      <div className="grid grid-cols-2 gap-2 p-3">
        <MiniMetric label="Overall" value={ops.health?.overall ?? 'unknown'} />
        <MiniMetric label="Services" value={String(services.length)} />
        <MiniMetric label="Warnings" value={String(warn)} />
        <MiniMetric label="Errors" value={String(unhealthy)} />
      </div>
      <div className="px-3 pb-3 text-[10px] font-mono" style={{ color: T.textMuted }}>Checked {ops.checkedAt ? clock(ops.checkedAt) : '--:--'}</div>
    </Panel>
  );
}
function ServiceHealthPanel({ health }: { health: HealthPayload | null }) {
  return (
    <Panel title="Service Health" icon={Cpu}>
      <div className="p-2 space-y-1.5">
        {(health?.services ?? []).length === 0 && <EmptyLine text="No detailed health services returned." />}
        {(health?.services ?? []).map((svc) => <SignalRow key={svc.service} name={svc.service} status={svc.status} detail={svc.message ?? svc.status} />)}
      </div>
    </Panel>
  );
}
function BrainOpsPanel({ brain }: { brain: BrainStatusPayload | null }) {
  const adapters = Object.entries(brain?.adapters ?? {});
  return (
    <Panel title="Brain Router" icon={Bot}>
      <div className="p-2 space-y-1.5">
        <SignalRow name="Router" status={brain?.ready ? 'ready' : 'unknown'} detail={brain?.ready ? 'ready' : 'not ready'} />
        <SignalRow name="Adapter count" status={(brain?.adapterCount ?? 0) > 0 ? 'ok' : 'warn'} detail={String(brain?.adapterCount ?? 0)} />
        {adapters.length === 0 && <EmptyLine text="No adapters reported by Brain status." />}
        {adapters.map(([id, status]) => <SignalRow key={id} name={id} status={status} detail={status} />)}
      </div>
    </Panel>
  );
}
function ConnectorsPanel({ connectors, apps }: { connectors: ConnectorStatus[]; apps: AppsStatusPayload | null }) {
  return (
    <Panel title="Connectors & Apps" icon={PlugZap}>
      <div className="p-2 space-y-1.5">
        {connectors.length === 0 && <EmptyLine text="No connector statuses returned." />}
        {connectors.map((conn) => <SignalRow key={conn.provider} name={conn.provider} status={conn.status} detail={conn.configuredAt ? `configured ${clock(conn.configuredAt)}` : conn.status} />)}
        <div className="pt-2 mt-2 border-t space-y-1.5" style={{ borderColor: T.borderSoft }}>
          <SignalRow name="Android app" status={apps?.androidInstalled ? 'ok' : 'idle'} detail={apps?.androidInstalled ? 'installed' : 'not installed'} />
          <SignalRow name="Windows app" status={apps?.windowsInstalled ? 'ok' : 'idle'} detail={apps?.windowsInstalled ? 'installed' : 'not installed'} />
          <SignalRow name="Legacy knowledge" status={apps?.legacyKnowledgeEnabled ? 'ok' : 'idle'} detail={apps?.legacyKnowledgeEnabled ? 'enabled' : 'off'} />
        </div>
      </div>
    </Panel>
  );
}
function EmailOpsPanel({ email }: { email: EmailStatusPayload | null }) {
  const rows = Object.entries(email ?? {}).slice(0, 8);
  return (
    <Panel title="Email Agent" icon={Mail}>
      <div className="p-2 space-y-1.5">
        {rows.length === 0 && <EmptyLine text="No email agent status returned." />}
        {rows.map(([key, value]) => <SignalRow key={key} name={key} status={String(value)} detail={kvValue(value)} />)}
      </div>
    </Panel>
  );
}
function OpsMode({ ops, onRefresh }: { ops: OpsState; onRefresh: () => void }) {
  return (
    <main className="min-h-0 flex-1 grid gap-3 p-3" style={{ gridTemplateColumns: '320px minmax(420px, 1fr) 340px' }}>
      <aside className="min-h-0 overflow-y-auto space-y-3">
        <OpsOverviewPanel ops={ops} />
        <LaunchPanel />
      </aside>
      <section className="min-h-0 overflow-y-auto space-y-3">
        {ops.error && <div className="px-3 py-2 text-[11px] rounded border flex items-center gap-2" style={{ color: T.red, background: T.redDim, borderColor: T.border }}><AlertTriangle className="h-3.5 w-3.5" />{ops.error}</div>}
        <ServiceHealthPanel health={ops.health} />
        <BrainOpsPanel brain={ops.brain} />
      </section>
      <aside className="min-h-0 overflow-y-auto space-y-3">
        <Panel title="Ops Actions" icon={RefreshCw} action={<button type="button" onClick={onRefresh} className="h-6 w-6 rounded flex items-center justify-center" style={{ color: T.textMuted }}><RefreshCw className="h-3.5 w-3.5" /></button>}>
          <div className="p-3 space-y-2">
            <Badge text="Refresh live status endpoints" />
            <Badge text="Use voice control from this surface" />
            <Badge text="Inspect Brain adapter readiness" />
            <Badge text="Review connector/app availability" />
          </div>
        </Panel>
        <ConnectorsPanel connectors={ops.connectors} apps={ops.apps} />
        <EmailOpsPanel email={ops.email} />
      </aside>
    </main>
  );
}

const COMMAND_PRESETS = [
  'Audit the current BOS state and tell me what needs attention first.',
  'Read Codex memory and summarize the operating context I should know right now.',
  'Inspect the repo status and identify risky uncommitted changes without modifying anything.',
  'Help me execute the next safest improvement to this workstation and verify it.',
] as const;

function ChatPane({ disabled, onActivity }: { disabled: boolean; onActivity: (item: Omit<ActivityItem, 'id' | 'ts'>) => void }) {
  const [threads, setThreads] = useState<GioThread[]>(() => readThreads());
  const [activeThreadId, setActiveThreadId] = useState(() => {
    const saved = localStorage.getItem(SESSION_KEY);
    const loaded = readThreads();
    return loaded.find((t) => t.localId === saved || t.conversationId === saved)?.localId ?? loaded[0]?.localId ?? makeThread().localId;
  });
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingInterjectRef = useRef<string | null>(null);
  const threadsRef = useRef<GioThread[]>(threads);
  const activeThread = threads.find((t) => t.localId === activeThreadId) ?? threads[0];
  const messages = activeThread?.messages ?? [];

  useEffect(() => { threadsRef.current = threads; saveThreads(threads); }, [threads]);
  useEffect(() => {
    if (activeThread?.conversationId) localStorage.setItem(SESSION_KEY, activeThread.conversationId);
    else if (activeThread?.localId) localStorage.setItem(SESSION_KEY, activeThread.localId);
  }, [activeThread?.localId, activeThread?.conversationId]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, busy]);

  const pushActivity = useCallback((item: Omit<ActivityItem, 'id' | 'ts'>) => onActivity(item), [onActivity]);

  const updateThread = useCallback((localId: string, updater: (thread: GioThread) => GioThread) => {
    setThreads((prev) => {
      const next = prev.map((thread) => thread.localId === localId ? updater(thread) : thread);
      threadsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activeThread || activeThread.newConversation || sending) return;
    const localId = activeThread.localId;
    const qs = activeThread.conversationId ? `?conversationId=${encodeURIComponent(activeThread.conversationId)}` : '';
    let cancelled = false;
    void (async () => {
      try {
        const payload = await getJson<GioMessagesPayload>(`api/openclaw/chat/messages${qs}`);
        if (cancelled) return;
        updateThread(localId, (current) => {
          const loadedMessages = dbMessagesToChat(payload.messages);
          return {
            ...current,
            conversationId: payload.conversationId,
            newConversation: false,
            name: loadedMessages[0]?.text ? firstWords(loadedMessages[0].text) : (payload.name ?? current.name),
            topic: loadedMessages[loadedMessages.length - 1]?.text ? firstWords(loadedMessages[loadedMessages.length - 1].text, 10) : current.topic,
            messages: loadedMessages,
            updatedAt: Date.now(),
          };
        });
      } catch (e) {
        pushActivity({ kind: 'error', label: 'Conversation load failed', detail: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [activeThread?.localId, activeThread?.conversationId, activeThread?.newConversation, sending, pushActivity, updateThread]);

  const sendText = useCallback(async (text: string, localId: string, outgoingAttachments: PendingAttachment[] = []) => {
    const trimmed = text.trim();
    const thread = threadsRef.current.find((t) => t.localId === localId);
    if (!trimmed || sending || !thread) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true); setBusy(true); setInput('');
    if (outgoingAttachments.length > 0) setAttachments([]);
    const conversationId = thread.conversationId;
    const newConversation = !!thread.newConversation && !conversationId;
    const now = Date.now();
    const nextName = thread.messages.length === 0 ? firstWords(trimmed) : thread.name;
    updateThread(localId, (current) => ({
      ...current,
      name: nextName,
      topic: firstWords(trimmed, 10),
      updatedAt: now,
      messages: [
        ...current.messages,
        { id: `u-${now}`, role: 'user', text: trimmed, ts: now },
        { id: `a-${now}`, role: 'assistant', text: '', ts: now },
      ],
    }));
    const attachmentNames = outgoingAttachments.map((a) => a.name).join(', ');
    pushActivity({
      kind: 'system',
      label: 'Turn started',
      detail: attachmentNames ? `${trimmed.slice(0, 100)} | attached: ${attachmentNames}` : trimmed.slice(0, 140),
    });
    try {
      const res = await fetch('api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() },
        body: JSON.stringify({
          message: trimmed,
          conversationId,
          newConversation,
          attachments: outgoingAttachments.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl })),
        }),
        signal: controller.signal,
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
          if (evType === 'conversation' && typeof parsed.conversationId === 'string') {
            localStorage.setItem(SESSION_KEY, parsed.conversationId);
            updateThread(localId, (current) => ({ ...current, conversationId: parsed.conversationId as string, newConversation: false, updatedAt: Date.now() }));
            pushActivity({ kind: 'session', label: 'Conversation attached', detail: parsed.conversationId });
          } else if (evType === 'message' && typeof parsed.text === 'string') {
            aggregate += parsed.text;
            updateThread(localId, (current) => {
              const next = current.messages.slice();
              next[next.length - 1] = { ...next[next.length - 1], text: aggregate };
              return { ...current, messages: next, updatedAt: Date.now() };
            });
          } else if (evType === 'error') {
            const detail = String(parsed.message ?? parsed.stderrTail ?? 'unknown error');
            pushActivity({ kind: 'error', label: 'Turn error', detail });
            updateThread(localId, (current) => {
              const next = current.messages.slice();
              next[next.length - 1] = { ...next[next.length - 1], text: `${next[next.length - 1].text}\n\n[error] ${detail}` };
              return { ...current, messages: next, updatedAt: Date.now() };
            });
          } else if (evType === 'done') {
            const usage = usageFromDone(parsed);
            const recap = usageText(usage);
            updateThread(localId, (current) => {
              const next = current.messages.slice();
              next[next.length - 1] = { ...next[next.length - 1], usage };
              return { ...current, messages: next, updatedAt: Date.now() };
            });
            pushActivity({ kind: 'done', label: 'Turn completed', detail: recap || (typeof parsed.durationMs === 'number' ? `${parsed.durationMs}ms` : undefined) });
            setBusy(false);
          }
        }
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const interrupted = controller.signal.aborted;
      pushActivity({ kind: interrupted ? 'system' : 'error', label: interrupted ? 'Turn interrupted' : 'Network error', detail });
      updateThread(localId, (current) => {
        const next = current.messages.slice();
        next[next.length - 1] = {
          ...next[next.length - 1],
          text: `${next[next.length - 1].text}\n\n${interrupted ? '[interrupted]' : `[network error] ${detail}`}`,
        };
        return { ...current, messages: next, updatedAt: Date.now() };
      });
    } finally {
      abortRef.current = null;
      setSending(false); setBusy(false);
      const pending = pendingInterjectRef.current;
      pendingInterjectRef.current = null;
      if (pending?.trim()) setTimeout(() => void sendText(pending, localId), 0);
    }
  }, [sending, pushActivity, updateThread]);

  const send = useCallback(() => {
    if (!activeThread) return;
    void sendText(input, activeThread.localId, attachments);
  }, [activeThread, input, attachments, sendText]);

  const attachFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    void (async () => {
      try {
        const next = await filesToAttachments(files, attachments.length);
        setAttachments((prev) => [...prev, ...next].slice(0, 4));
        if (next.length > 0) pushActivity({ kind: 'system', label: 'Files attached', detail: next.map((a) => a.name).join(', ') });
      } catch (e) {
        pushActivity({ kind: 'error', label: 'Attach failed', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    })();
  }, [attachments.length, pushActivity]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const interrupt = useCallback((nextText?: string) => {
    if (nextText?.trim()) pendingInterjectRef.current = nextText.trim();
    abortRef.current?.abort();
  }, []);

  const createSession = useCallback(() => {
    const thread = makeThread('New Codex conversation', true);
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.localId);
    localStorage.removeItem(SESSION_KEY);
    pushActivity({ kind: 'system', label: 'New conversation', detail: thread.name });
  }, [pushActivity]);

  return (
    <Panel title="Codex Conversation" icon={Radio} action={<button type="button" onClick={createSession} className="text-[10px] px-2 py-1 rounded flex items-center gap-1" style={{ color: T.textDim, border: `1px solid ${T.borderSoft}` }}><Plus className="h-3 w-3" />new</button>}>
      <div className="min-h-0 flex-1 grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
        <div className="min-h-0 flex flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="mt-8 mx-auto max-w-2xl space-y-4">
              <div className="text-center text-xs" style={{ color: T.textMuted }}>Codex is ready. Ask for work, review, deploy help, or memory lookup.</div>
              <div className="grid grid-cols-2 gap-2">
                {COMMAND_PRESETS.map((preset) => (
                  <button key={preset} type="button" onClick={() => setInput(preset)} className="px-3 py-2 rounded text-left text-[11px] leading-snug border" style={{ color: T.textDim, background: T.panel2, borderColor: T.borderSoft }}>
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}><div className="max-w-[82%] px-3 py-2 rounded border whitespace-pre-wrap break-words text-[12.5px] leading-relaxed" style={m.role === 'user' ? { background: T.violetDim, borderColor: T.violet, color: T.text } : { background: T.panel2, borderColor: T.borderSoft, color: T.textDim }}>{m.text || (busy ? '...' : '')}</div><div className="flex items-center gap-2 text-[10px] mt-0.5" style={{ color: T.textMuted }}><span>{clock(m.ts)}</span>{m.role === 'assistant' && usageText(m.usage) && <span className="font-mono truncate max-w-[520px]">{usageText(m.usage)}</span>}</div></div>)}
        </div>
        <footer className="p-3 border-t" style={{ borderColor: T.borderSoft }}>
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="max-w-[260px] h-7 px-2 rounded flex items-center gap-1.5 text-[10.5px] border" style={{ color: T.textDim, background: T.panel2, borderColor: T.borderSoft }}>
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="truncate">{attachment.name}</span>
                  <span className="font-mono shrink-0" style={{ color: T.textMuted }}>{bytes(attachment.size)}</span>
                  <button type="button" onClick={() => removeAttachment(attachment.id)} disabled={sending} title="Remove attachment" className="h-5 w-5 rounded flex items-center justify-center disabled:opacity-40" style={{ color: T.textMuted }}><XCircle className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => attachFiles(e.target.files)} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled || sending || attachments.length >= 4} title="Attach files" className="w-11 rounded flex items-center justify-center disabled:opacity-40" style={{ color: T.textDim, background: T.panel2, border: `1px solid ${T.border}` }}><Paperclip className="h-4 w-4" /></button>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sending ? interrupt(input) : void send(); } }} disabled={disabled} rows={2} placeholder={disabled ? 'Codex backend unavailable' : sending ? 'Type an interjection, then press Interject...' : 'Command Codex...'} className="flex-1 min-w-0 px-3 py-2 rounded text-[12.5px] resize-none" style={{ color: T.text, background: T.panel2, border: `1px solid ${T.border}`, maxHeight: 160 }} />
          {sending ? (
            <>
              <button type="button" onClick={() => interrupt(input)} disabled={disabled || !input.trim()} className="px-3 rounded flex items-center gap-1.5 disabled:opacity-40 text-[11px] font-semibold" style={{ background: T.amber, color: '#111' }}><Send className="h-3.5 w-3.5" />Interject</button>
              <button type="button" onClick={() => interrupt()} disabled={disabled} title="Interrupt current Codex turn" className="w-11 rounded flex items-center justify-center disabled:opacity-40" style={{ background: T.redDim, color: T.red, border: `1px solid ${T.red}` }}><StopCircle className="h-4 w-4" /></button>
            </>
          ) : (
            <button type="button" onClick={() => void send()} disabled={disabled || !input.trim()} className="w-11 rounded flex items-center justify-center disabled:opacity-40" style={{ background: T.violet, color: '#fff' }}><Send className="h-4 w-4" /></button>
          )}
          </div>
        </footer>
        </div>
      </div>
    </Panel>
  );
}

export default function OC() {
  const [mode, setMode] = useState<ViewMode>('workstation');
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [channels, setChannels] = useState<ChannelsPayload | null>(null);
  const [skills, setSkills] = useState<SkillsPayload | null>(null);
  const [ops, setOps] = useState<OpsState>({ health: null, brain: null, connectors: [], apps: null, email: null, error: null, checkedAt: null });
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const addActivity = useCallback((item: Omit<ActivityItem, 'id' | 'ts'>) => {
    setActivity((prev) => [{ ...item, id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ts: Date.now() }, ...prev].slice(0, 80));
  }, []);
  const fetchOverview = useCallback(() => { void (async () => { try { const r = await getJson<OverviewPayload>('api/openclaw/overview'); setOverview(r); setOverviewError(null); } catch (e) { setOverviewError(String(e)); } finally { setOverviewLoading(false); } })(); }, []);
  const fetchMemory = useCallback(() => { void (async () => { try { const r = await getJson<MemoryFilesPayload>('api/openclaw/memory/files'); setMemoryFiles(r.files); } catch { /* nonfatal */ } })(); }, []);
  const fetchInventory = useCallback(() => { void (async () => { try { setChannels(await getJson<ChannelsPayload>('api/openclaw/channels')); } catch { /* nonfatal */ } try { setSkills(await getJson<SkillsPayload>('api/openclaw/skills')); } catch { /* nonfatal */ } })(); }, []);
  const fetchOps = useCallback(() => { void (async () => {
    const next: OpsState = { health: null, brain: null, connectors: [], apps: null, email: null, error: null, checkedAt: Date.now() };
    const errors: string[] = [];
    try { next.health = await getJsonBody<HealthPayload>('health/full'); } catch (e) { errors.push(`health: ${String(e)}`); }
    try { next.brain = await getJson<BrainStatusPayload>('api/brain/status'); } catch (e) { errors.push(`brain: ${String(e)}`); }
    try { next.connectors = await getJson<ConnectorStatus[]>('api/connectors/status'); } catch (e) { errors.push(`connectors: ${String(e)}`); }
    try { next.apps = await getJson<AppsStatusPayload>('api/apps/status'); } catch (e) { errors.push(`apps: ${String(e)}`); }
    try { next.email = await getJson<EmailStatusPayload>('api/email/status'); } catch (e) { errors.push(`email: ${String(e)}`); }
    next.error = errors.length ? errors.join(' | ') : null;
    setOps(next);
  })(); }, []);
  useVisibilityAwarePolling(fetchOverview, 10_000, true);
  useVisibilityAwarePolling(fetchMemory, 30_000, true);
  useVisibilityAwarePolling(fetchInventory, 30_000, true);
  useVisibilityAwarePolling(fetchOps, 30_000, true);

  const selectMemory = useCallback((file: string) => { setSelectedMemory(file); setMemoryLoading(true); setMemoryContent(''); void (async () => { try { const r = await getJson<{ content: string }>(`api/openclaw/memory/files/${encodeURIComponent(file)}`); setMemoryContent(r.content); } catch (e) { setMemoryContent(`[error] ${String(e)}`); } finally { setMemoryLoading(false); } })(); }, []);
  const chatDisabled = overview?.gateway === 'down';
  const currentObjective = useMemo(() => activity.find((a) => a.kind === 'system' && a.label === 'Turn started')?.detail ?? 'No active turn. Use chat to start work.', [activity]);

  return (
    <div className="aios-page h-full min-h-0 flex flex-col" style={{ color: T.text }}>
      <TopBar overview={overview} loading={overviewLoading} mode={mode} setMode={setMode} />
      {overviewError && <div className="px-4 py-2 text-[11px] border-b flex items-center gap-2" style={{ color: T.red, background: T.redDim, borderColor: T.border }}><AlertTriangle className="h-3.5 w-3.5" />Overview fetch failed: {overviewError}</div>}
      {mode === 'tasks' ? <div className="aios-page-pad min-h-0 flex-1 overflow-hidden"><div className="aios-workbench h-full"><KanbanBoard scope={{ kind: 'coe' }} /></div></div> : mode === 'ops' ? <OpsMode ops={ops} onRefresh={fetchOps} /> : (
        <main className="aios-page-pad min-h-0 flex-1 grid gap-3" style={{ gridTemplateColumns: '300px minmax(420px, 1fr) 340px' }}>
          <aside className="min-h-0 overflow-y-auto space-y-3"><ContextPanel overview={overview} channels={channels} skills={skills} /><MemoryPanel files={memoryFiles} selected={selectedMemory} content={memoryContent} loading={memoryLoading} onSelect={selectMemory} onRefresh={fetchMemory} /></aside>
          <section className="min-h-0 grid gap-3" style={{ gridTemplateRows: 'minmax(360px, 1fr) 220px' }}><ChatPane disabled={!!chatDisabled} onActivity={addActivity} /><ActivityPanel items={activity} /></section>
          <aside className="min-h-0 overflow-y-auto space-y-3"><Panel title="Current Objective" icon={PanelRightOpen}><div className="p-3 text-[12px] leading-relaxed" style={{ color: T.textDim }}>{currentObjective}</div></Panel><ChecklistPanel activityCount={activity.length} memoryReady={!!overview?.memoryReady} /><LaunchPanel /><ToolingPanel channels={channels} skills={skills} /><Panel title="Executable From Here" icon={Box}><div className="p-3 space-y-2"><Badge text="Send Codex turns through chat" /><Badge text="Inspect Codex memory files" /><Badge text="Open scoped task board" /><Badge text="Poll Codex/API status" /><Badge text="Use live voice control" /><Badge text="Open Ops status console" /><Badge text="Launch other BOS surfaces" /></div></Panel></aside>
        </main>
      )}
    </div>
  );
}
