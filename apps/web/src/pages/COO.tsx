/**
 * COO — Claude CLI command center.
 *
 * "COO" in the v2 design IS BOS's Claude surface (this operator). This page is
 * the Claude version of the Codex workstation (/oc): the same workstation
 * chrome — status pills, three-column layout, Workstation / Ops / Tasks modes —
 * but wired to Claude. Each thread is a resumable Claude Code session running
 * with bypass-mode tool access inside a per-thread workspace, streamed through
 * the local Claude subscription gateway (port 65138).
 *
 * Ops mode is richer than the chat surface: it polls the real shared status
 * endpoints (health/full, api/brain/status, api/connectors/status,
 * api/apps/status, api/email/status) for a live operations console.
 */

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import {
  Activity, AlertTriangle, Bot, Box, CheckCircle2, ChevronRight, Clock,
  Cpu, FolderGit2, History, Loader2, Mail, PanelRightOpen, PlugZap,
  Radio, RefreshCw, Server, SquareTerminal, Workflow,
} from 'lucide-react';
import { useVisibilityAwarePolling } from '../lib/visibilityPolling.js';
import { useAgentName, promptRenameAgent } from '../lib/agentNames.js';
import { KanbanBoard } from '../components/kanban/KanbanBoard.js';
import { ThreadList } from '../components/coo/ThreadList.js';
import { NewThreadModal } from '../components/coo/NewThreadModal.js';
import { ChatPane } from '../components/coo/ChatPane.js';
import { useCooThreads } from '../components/coo/useCooThreads.js';

// Claude-accented variant of the Codex workstation palette.
const T = {
  bg: '#05060F',
  panel: '#0B0E1D',
  panel2: 'var(--aios-frost-dark, #11152E)',
  panel3: '#181D3A',
  border: '#232A4D',
  borderSoft: 'rgba(181,108,255,0.16)',
  text: '#F1F4FF',
  textDim: '#AAB3D6',
  textMuted: '#8B95BC',
  green: '#22C55E',
  greenDim: 'rgba(34,197,94,0.14)',
  amber: '#F5C542',
  amberDim: 'rgba(245,197,66,0.14)',
  red: '#E84A6A',
  redDim: 'rgba(232,74,106,0.14)',
  blue: '#0EA5E9',
  blueDim: 'rgba(14,165,233,0.16)',
  claude: '#B56CFF',
  claudeDim: 'rgba(181,108,255,0.16)',
  sky: '#5CC8FF',
};

const GATEWAY_PORT = 65138;

type ViewMode = 'workstation' | 'ops' | 'tasks';

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

function getToken(): string { return localStorage.getItem('boss_token') ?? ''; }
function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function getJson<T2>(path: string): Promise<T2> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T2;
}
async function getJsonBody<T2>(path: string): Promise<T2> {
  const res = await fetch(path, { headers: authHeaders() });
  const body = (await res.json().catch(() => ({}))) as T2;
  if (!res.ok && Object.keys(body as Record<string, unknown>).length === 0) throw new Error(`${path} ${res.status}`);
  return body;
}
function clock(ts: number | string | null | undefined): string {
  if (!ts) return '--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function ago(ts: string | number | null | undefined): string {
  if (!ts) return 'idle';
  const delta = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(delta)) return 'idle';
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

// Claude is "live" when the router reports a non-error claude adapter (the
// subscription gateway is the path the Claude Code threads stream through).
function claudeGateway(brain: BrainStatusPayload | null): 'ok' | 'warn' | 'error' | 'idle' {
  if (!brain) return 'idle';
  const entries = Object.entries(brain.adapters ?? {});
  const claude = entries.find(([id]) => /claude/i.test(id));
  if (claude) return /error|down|fail/i.test(claude[1]) ? 'error' : 'ok';
  return brain.ready ? 'ok' : 'warn';
}
function claudeModel(brain: BrainStatusPayload | null): string {
  const entries = Object.entries(brain?.adapters ?? {});
  const claude = entries.find(([id]) => /claude/i.test(id));
  return claude ? claude[0] : 'claude-code';
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
// Per-panel collapse state, persisted by title so it survives reloads.
const PANEL_COLLAPSE_KEY = 'boss_coo_panel_collapsed';
function readCollapsedMap(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(PANEL_COLLAPSE_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
}
function Panel({ title, icon: Icon, children, action, collapsible = true }: {
  title: string;
  icon: React.ComponentType<{ className?: string; style?: CSSProperties }>;
  children: React.ReactNode;
  action?: React.ReactNode;
  collapsible?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => !!readCollapsedMap()[title]);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    const map = readCollapsedMap();
    map[title] = next;
    try { localStorage.setItem(PANEL_COLLAPSE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
    return next;
  });
  return (
    <section className="aios-frost-surface--dark aios-panel min-h-0 min-w-0 flex flex-col">
      <header
        className={`h-9 px-3 flex items-center gap-2 shrink-0 ${collapsible ? 'cursor-pointer' : ''}`}
        style={{ borderBottom: collapsed ? 'none' : `1px solid ${T.borderSoft}` }}
        onClick={collapsible ? toggle : undefined}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: T.claude }} />
        <h2 className="text-xs font-semibold flex-1 truncate" style={{ color: T.text }}>{title}</h2>
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
        {collapsible && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggle(); }}
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            className="h-6 w-6 rounded flex items-center justify-center shrink-0 hover:bg-white/5"
            style={{ color: T.textMuted }}
          >
            <ChevronRight className="h-3.5 w-3.5" style={{ transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform 0.15s' }} />
          </button>
        )}
      </header>
      {!collapsed && children}
    </section>
  );
}
function EmptyLine({ text }: { text: string }) {
  return <div className="px-3 py-2 text-[11px]" style={{ color: T.textMuted }}>{text}</div>;
}

function ClaudeMark() {
  return (
    <div className="h-9 w-9 rounded flex items-center justify-center" style={{ background: T.claudeDim, border: `1px solid ${T.border}` }}>
      <span className="block h-3 w-3 rotate-45 rounded-[2px]" style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)', boxShadow: '0 0 10px rgba(181,108,255,0.5)' }} />
    </div>
  );
}

function TopBar({ brain, loading, lastActivity, mode, setMode }: {
  brain: BrainStatusPayload | null;
  loading: boolean;
  lastActivity: string | number | null;
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
}) {
  const gw = claudeGateway(brain);
  const [claudeName] = useAgentName('claude');
  return (
    <header className="aios-frost-surface--dark h-14 px-4 flex items-center gap-3 border-b shrink-0" style={{ background: T.panel, borderColor: T.border }}>
      <ClaudeMark />
      <div className="min-w-0">
        <div
          className="text-sm font-semibold"
          style={{ color: T.text, cursor: 'pointer' }}
          title="Click to rename"
          onClick={() => promptRenameAgent('claude')}
        >{claudeName}</div>
        <div className="text-[11px] font-mono truncate" style={{ color: T.textMuted }}>Claude Code · bypass mode</div>
      </div>
      <div className="ml-2 flex items-center gap-2 text-[11px]">
        <div className="px-2.5 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}>
          <StatusDot status={gw} /><span style={{ color: T.textDim }}>Gateway</span><span style={{ color: T.text }}>:{GATEWAY_PORT}</span>
        </div>
        <div className="px-2.5 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}>
          <StatusDot status={brain?.ready ? 'ok' : 'warn'} /><span style={{ color: T.textDim }}>Claude</span><span style={{ color: T.text }}>{claudeModel(brain)}</span>
        </div>
        <div className="px-2.5 py-1.5 rounded flex items-center gap-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" style={{ color: T.textMuted }} /> : <Clock className="h-3 w-3" style={{ color: T.textMuted }} />}
          <span style={{ color: T.textDim }}>Last turn</span><span style={{ color: T.text }}>{ago(lastActivity)}</span>
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

function ContextPanel({ brain, threadCount }: {
  brain: BrainStatusPayload | null;
  threadCount: number;
}) {
  return (
    <div className="space-y-3">
      <Panel title="Workspace" icon={FolderGit2}>
        <div className="p-3 space-y-2 text-[12px]">
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Operator</span><span className="font-mono" style={{ color: T.text }}>BOS · Claude</span></div>
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Runtime</span><span className="font-mono" style={{ color: T.text }}>Claude Code CLI</span></div>
          <div className="flex items-center justify-between gap-3"><span style={{ color: T.textMuted }}>Mode</span><span className="font-mono" style={{ color: T.text }}>bypass</span></div>
          <div className="pt-2 border-t" style={{ borderColor: T.borderSoft }}>
            <div className="text-[10px] uppercase font-mono mb-1" style={{ color: T.textMuted }}>Subscription gateway</div>
            <div className="text-[11px] font-mono break-all" style={{ color: T.textDim }}>127.0.0.1:{GATEWAY_PORT}</div>
          </div>
        </div>
      </Panel>
      <Panel title="System Map" icon={Server}>
        <div className="p-2 space-y-1.5">
          {[
            ['Portal', 'web container', 'ok'],
            ['API', 'local health checked', 'ok'],
            ['Weaviate', 'shared vector memory', 'ok'],
            ['Claude', 'Claude Code CLI', 'ok'],
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
          <MiniMetric label="Threads" value={String(threadCount)} />
          <MiniMetric label="Adapters" value={String(brain?.adapterCount ?? 0)} />
          <MiniMetric label="Router" value={brain?.ready ? 'ready' : 'check'} />
          <MiniMetric label="Tools" value="bypass" />
        </div>
      </Panel>
    </div>
  );
}
function MiniMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded p-2" style={{ background: T.panel2, border: `1px solid ${T.borderSoft}` }}><div className="text-[10px] uppercase font-mono" style={{ color: T.textMuted }}>{label}</div><div className="text-sm font-semibold" style={{ color: T.text }}>{value}</div></div>;
}

function ActivityPanel({ threads }: { threads: Array<{ id: string; name: string; updated_at: string; last_message_preview: string | null }> }) {
  const items = threads.slice(0, 8);
  return (
    <Panel title="Recent Sessions" icon={Activity}>
      <div className="min-h-0 max-h-[260px] overflow-y-auto p-2 space-y-1.5">
        {items.length === 0 && <EmptyLine text="Sessions appear here as you work with Claude." />}
        {items.map((t) => (
          <div key={t.id} className="px-2 py-1.5 rounded flex gap-2" style={{ background: T.panel2 }}>
            <History className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: T.claude }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="text-[11px] font-medium truncate" style={{ color: T.text }}>{t.name}</span><span className="text-[10px] font-mono ml-auto" style={{ color: T.textMuted }}>{clock(t.updated_at)}</span></div>
              {t.last_message_preview && <div className="text-[10.5px] truncate" style={{ color: T.textMuted }}>{t.last_message_preview}</div>}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ChecklistPanel({ threadCount, brainReady }: { threadCount: number; brainReady: boolean }) {
  const rows = [
    ['Claude gateway', brainReady, 'Subscription gateway responding on :65138'],
    ['Active threads', threadCount > 0, threadCount > 0 ? `${threadCount} resumable session(s)` : 'Create a thread to start'],
    ['Tool access', true, 'Bypass mode — full tool access (Kevin authorization)'],
    ['Task board', true, 'Task Board is available from this surface'],
    ['Health status', true, 'API and Brain status are polling live'],
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
  ['/oc', 'Codex', 'Coding agent'],
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
    <main className="min-h-0 min-w-0 flex-1 grid gap-3 p-3 overflow-x-hidden" style={{ gridTemplateColumns: '320px minmax(0, 1fr) 340px' }}>
      <aside className="min-h-0 min-w-0 overflow-y-auto space-y-3">
        <OpsOverviewPanel ops={ops} />
        <LaunchPanel />
      </aside>
      <section className="min-h-0 min-w-0 overflow-y-auto space-y-3">
        {ops.error && <div className="px-3 py-2 text-[11px] rounded border flex items-center gap-2" style={{ color: T.red, background: T.redDim, borderColor: T.border }}><AlertTriangle className="h-3.5 w-3.5" />{ops.error}</div>}
        <ServiceHealthPanel health={ops.health} />
        <BrainOpsPanel brain={ops.brain} />
      </section>
      <aside className="min-h-0 min-w-0 overflow-y-auto space-y-3">
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

export default function COO() {
  const { threads, isLoading, create, rename, remove } = useCooThreads();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<ViewMode>('workstation');

  const [brain, setBrain] = useState<BrainStatusPayload | null>(null);
  const [brainLoading, setBrainLoading] = useState(true);
  const [ops, setOps] = useState<OpsState>({ health: null, brain: null, connectors: [], apps: null, email: null, error: null, checkedAt: null });

  const active = threads.find((t) => t.id === activeId) ?? null;

  const fetchBrain = useCallback(() => { void (async () => {
    try { setBrain(await getJson<BrainStatusPayload>('api/brain/status')); } catch { /* nonfatal */ } finally { setBrainLoading(false); }
  })(); }, []);
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
  useVisibilityAwarePolling(fetchBrain, 15_000, true);
  useVisibilityAwarePolling(fetchOps, 30_000, true);

  const lastActivity = useMemo(() => {
    const latest = threads.map((t) => new Date(t.updated_at).getTime()).filter((n) => Number.isFinite(n)).sort((a, b) => b - a)[0];
    return latest ?? null;
  }, [threads]);
  const currentObjective = active?.last_message_preview || active?.name || 'No active thread. Pick or create one to start.';

  const handleDelete = async (id: string) => {
    await remove(id);
    if (id === activeId) setActiveId(null);
  };

  return (
    <div className="aios-page h-full min-h-0 flex flex-col" style={{ color: T.text }}>
      <TopBar brain={brain} loading={brainLoading} lastActivity={lastActivity} mode={mode} setMode={setMode} />
      {mode === 'tasks' ? (
        <div className="aios-page-pad min-h-0 flex-1 overflow-hidden"><div className="aios-workbench h-full"><KanbanBoard scope={{ kind: 'coo' }} /></div></div>
      ) : mode === 'ops' ? (
        <OpsMode ops={ops} onRefresh={fetchOps} />
      ) : (
        <main className="aios-page-pad min-h-0 min-w-0 flex-1 grid gap-3 overflow-x-hidden" style={{ gridTemplateColumns: '300px minmax(0, 1fr) 340px' }}>
          <aside className="min-h-0 min-w-0 overflow-y-auto space-y-3">
            <ContextPanel brain={brain} threadCount={threads.length} />
            <Panel title="Threads" icon={Radio}>
              <div className="min-h-0 max-h-[340px] overflow-hidden flex flex-col p-2">
                <ThreadList
                  threads={threads}
                  activeId={activeId}
                  isLoading={isLoading}
                  onPick={setActiveId}
                  onRename={rename}
                  onDelete={handleDelete}
                  onNew={() => setModalOpen(true)}
                />
              </div>
            </Panel>
          </aside>
          <section className="min-h-0 min-w-0 grid gap-3" style={{ gridTemplateRows: 'minmax(360px, 1fr) 220px' }}>
            <ChatPane thread={active} />
            <ActivityPanel threads={threads} />
          </section>
          <aside className="min-h-0 min-w-0 overflow-y-auto space-y-3">
            <Panel title="Current Objective" icon={PanelRightOpen}><div className="p-3 text-[12px] leading-relaxed" style={{ color: T.textDim }}>{currentObjective}</div></Panel>
            <ChecklistPanel threadCount={threads.length} brainReady={!!brain?.ready} />
            <LaunchPanel />
            <Panel title="Executable From Here" icon={Box}>
              <div className="p-3 space-y-2">
                <Badge text="Resume any Claude Code thread" />
                <Badge text="Run with full bypass tool access" />
                <Badge text="Open scoped task board" />
                <Badge text="Inspect Claude gateway / brain status" />
                <Badge text="Use live voice control" />
                <Badge text="Open Ops status console" />
                <Badge text="Launch other BOS surfaces" />
              </div>
            </Panel>
          </aside>
        </main>
      )}
      <NewThreadModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={async (name, workspace_dir) => {
          const t = await create(name, workspace_dir);
          setActiveId(t.id);
        }}
      />
    </div>
  );
}
