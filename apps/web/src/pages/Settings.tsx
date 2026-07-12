import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Bot,
  Brain,
  CheckCircle2,
  Circle,
  Code2,
  Copy,
  DatabaseBackup,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  LogOut,
  Mic,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
  Terminal,
  Trash2,
  type LucideIcon,
  Users,
  Wrench,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Connectors } from './Connectors';
import { BrainConfig } from './BrainConfig';
import { VoiceDevices } from './VoiceDevices';
import { Learning } from './Learning';
import { SelfHealing } from './SelfHealing';
import { BackupStatus } from './BackupStatus';

type SettingsTab = 'overview' | 'mcp' | 'connections' | 'runtimes' | 'voice' | 'learning' | 'healing' | 'backup' | 'admin';
type RuntimeStatus = 'ready' | 'configured' | 'partial' | 'missing' | 'checking' | 'error' | 'external';

interface SettingsState {
  timezone: string;
  locale: string;
  voiceEnabled: boolean;
  backupIntervalMinutes: number;
  backupRetentionDays: number;
  healingEnabled: boolean;
  learningEnabled: boolean;
  mode: 'single' | 'multi';
  brainProvider: string;
  connectorProvider: string;
  theme: string;
  notificationsEnabled: boolean;
  maxConcurrentJobs: number;
  debugLogging: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

interface IntegrationStatus {
  id: string;
  name?: string;
  configured: boolean;
}

interface VoiceStatus {
  configured?: boolean;
  outboundReady?: boolean;
  accountSidConfigured?: boolean;
  apiKeySidConfigured?: boolean;
  allowedCaller?: string | null;
  inboundWebhookPath?: string;
}

interface BrainAdapter {
  id: string;
  name?: string;
  status?: string;
  priority?: number;
  capabilities?: {
    canAccessMCP?: boolean;
    canUseTools?: boolean;
    canChat?: boolean;
    canStream?: boolean;
  };
}

interface OpenClawOverview {
  gateway?: string;
  agent?: { id?: string; model?: string };
  memoryReady?: boolean;
  codexCli?: {
    status?: string;
    lastCheckedAt?: string | null;
    exitCode?: string | null;
  };
  codex?: {
    status?: string;
    lastCheckAt?: string | null;
    exitCode?: string | null;
    stderrTail?: string | null;
  };
  lastHeartbeatAt?: string;
  errors?: string[];
}

type CustomMcpTransport = 'http' | 'sse' | 'stdio';

interface CustomMcpConnection {
  id: string;
  name: string;
  transport: CustomMcpTransport;
  serverUrl?: string;
  command?: string;
  args?: string;
  loginUrl?: string;
  tokenEnv?: string;
  configPath?: string;
  description?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface CustomMcpForm {
  name: string;
  transport: CustomMcpTransport;
  serverUrl: string;
  command: string;
  args: string;
  loginUrl: string;
  tokenEnv: string;
  configPath: string;
  description: string;
  enabled: boolean;
}

interface GlobalMcpStatus {
  id: string;
  name: string;
  scope: string;
  configured: boolean;
  connected: boolean;
  loginRequired: boolean;
  authConfigured: boolean;
  serverUrl: string | null;
  loginUrl: string | null;
  configPath: string;
  configPresent: boolean;
  registryPath?: string;
  registryPresent?: boolean;
  hostRegistryPath?: string;
  codexHome: string;
  claudeHome?: string;
  hermesHome?: string;
  transport: string;
  model: string | null;
  gateway?: {
    name: string;
    owner?: string;
    relationship?: string;
    baseUrl: string;
    publicUrl?: string;
    healthUrl: string;
    chatCompletionsUrl: string;
    modelsUrl: string;
    tokenConfigured: boolean;
    health?: { ok: boolean; detail: string };
  };
  discovery?: {
    statusUrl: string;
    registryPath: string;
    hostRegistryPath?: string;
    configPath: string;
    serverUrlEnv: string;
    configPathEnv: string;
    registryPathEnv: string;
    tokenEnv: string;
    loginUrlEnv: string;
  };
  consumers?: Array<{
    id: string;
    name: string;
    mode: string;
    configPath: string;
    purpose?: string;
    canUseGlobalRegistry: boolean;
  }>;
  customConnections?: CustomMcpConnection[];
  agentInstructions?: string[];
  checkedAt: string;
}

const DEFAULT_SETTINGS: SettingsState = {
  timezone: 'America/Chicago',
  locale: 'en-US',
  voiceEnabled: false,
  backupIntervalMinutes: 60,
  backupRetentionDays: 30,
  healingEnabled: true,
  learningEnabled: true,
  mode: 'single',
  brainProvider: 'claude-code',
  connectorProvider: 'google',
  theme: 'system',
  notificationsEnabled: true,
  maxConcurrentJobs: 4,
  debugLogging: false,
};

const DEFAULT_CUSTOM_MCP_FORM: CustomMcpForm = {
  name: '',
  transport: 'http',
  serverUrl: '',
  command: '',
  args: '',
  loginUrl: '',
  tokenEnv: '',
  configPath: '',
  description: '',
  enabled: true,
};

const SETTINGS_PATCH_KEYS: Array<keyof SettingsState> = [
  'timezone',
  'locale',
  'voiceEnabled',
  'backupIntervalMinutes',
  'backupRetentionDays',
  'healingEnabled',
  'learningEnabled',
  'mode',
  'brainProvider',
  'connectorProvider',
  'theme',
  'notificationsEnabled',
  'maxConcurrentJobs',
  'debugLogging',
];

const STATUS_COLORS: Record<RuntimeStatus, string> = {
  ready: '#20b26b',
  configured: '#20b26b',
  external: '#5cc8ff',
  checking: '#d9a441',
  partial: '#d9a441',
  missing: '#d64f4f',
  error: '#d64f4f',
};

const TABS: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Overview', icon: SettingsIcon },
  { id: 'mcp', label: 'Global MCP', icon: Server },
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'runtimes', label: 'Runtimes', icon: Terminal },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'learning', label: 'Learning', icon: BookOpen },
  { id: 'healing', label: 'Healing', icon: ShieldCheck },
  { id: 'backup', label: 'Backup', icon: DatabaseBackup },
  { id: 'admin', label: 'Admin', icon: Users },
];

function handleSignOut() {
  localStorage.removeItem('boss_token');
  localStorage.removeItem('boss_refresh_token');
  localStorage.removeItem('boss_user');
  localStorage.removeItem('vasari_token');
  localStorage.removeItem('vasari_user');
  window.location.assign('/login');
}

function authHeaders(json = false): Record<string, string> {
  const token = localStorage.getItem('boss_token') ?? localStorage.getItem('vasari_token') ?? '';
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getUser(): { displayName?: string; name?: string; role?: string; email?: string } {
  try {
    return JSON.parse(localStorage.getItem('boss_user') ?? localStorage.getItem('vasari_user') ?? '{}') as {
      displayName?: string;
      name?: string;
      role?: string;
      email?: string;
    };
  } catch {
    return {};
  }
}

function formatDate(value?: string | null): string {
  if (!value) return 'Not checked';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function runtimeStatus(value?: string | null): RuntimeStatus {
  const normalized = (value ?? '').toLowerCase();
  if (['ready', 'ok', 'live', 'connected', 'healthy'].includes(normalized)) return 'ready';
  if (['configured', 'enabled'].includes(normalized)) return 'configured';
  if (['checking', 'pending'].includes(normalized)) return 'checking';
  if (['error', 'down', 'failed', 'unhealthy'].includes(normalized)) return 'error';
  return 'missing';
}

function StatusBadge({ label, status }: { label: string; status: RuntimeStatus }) {
  const hue = STATUS_COLORS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] text-text-secondary"
      style={{ borderColor: `${hue}55`, background: `${hue}14` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: hue, boxShadow: `0 0 6px ${hue}77` }} />
      <span className="vs-mono uppercase tracking-[0.14em]">{label}</span>
    </span>
  );
}

function Panel({
  title,
  subtitle,
  icon: Icon,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="aios-panel overflow-hidden">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-text-primary">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border/50 py-2 last:border-b-0 sm:grid-cols-[154px_1fr]">
      <div className="vs-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</div>
      <div className="min-w-0 break-words text-sm text-text-secondary">{value}</div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${checked ? 'bg-accent' : 'bg-surface-4'}`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`}
        aria-hidden
      />
    </button>
  );
}

function ActionButton({ icon: Icon, label, onClick, disabled = false }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="btn-secondary justify-center text-sm disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon className="h-4 w-4 text-accent" aria-hidden />
      {label}
    </button>
  );
}

function pickPatch(settings: SettingsState): Partial<SettingsState> {
  const body: Partial<SettingsState> = {};
  for (const key of SETTINGS_PATCH_KEYS) {
    body[key] = settings[key] as never;
  }
  return body;
}

export function Settings() {
  const navigate = useNavigate();
  const user = useMemo(() => getUser(), []);
  const [activeTab, setActiveTab] = useState<SettingsTab>('overview');
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [mcp, setMcp] = useState<GlobalMcpStatus | null>(null);
  const [connectors, setConnectors] = useState<IntegrationStatus[]>([]);
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [adapters, setAdapters] = useState<BrainAdapter[]>([]);
  const [overview, setOverview] = useState<OpenClawOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [twoFactorSetup, setTwoFactorSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorMessage, setTwoFactorMessage] = useState<string | null>(null);
  const [twoFactorError, setTwoFactorError] = useState<string | null>(null);
  const [showCustomMcpForm, setShowCustomMcpForm] = useState(false);
  const [customMcpForm, setCustomMcpForm] = useState<CustomMcpForm>(DEFAULT_CUSTOM_MCP_FORM);
  const [customMcpSaving, setCustomMcpSaving] = useState(false);
  const [customMcpDeletingId, setCustomMcpDeletingId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchJson<SettingsState>('api/settings'),
      fetchJson<GlobalMcpStatus>('api/mcp/global'),
      fetchJson<IntegrationStatus[]>('api/connectors/integrations'),
      fetchJson<VoiceStatus>('api/voice/twilio/status'),
      fetchJson<BrainAdapter[]>('api/brain/adapters'),
      fetchJson<OpenClawOverview>('api/openclaw/overview'),
    ])
      .then(([nextSettings, nextMcp, nextConnectors, nextVoice, nextAdapters, nextOverview]) => {
        if (nextSettings) setSettings({ ...DEFAULT_SETTINGS, ...nextSettings });
        setMcp(nextMcp);
        setConnectors(Array.isArray(nextConnectors) ? nextConnectors : []);
        setVoice(nextVoice);
        setAdapters(Array.isArray(nextAdapters) ? nextAdapters : []);
        setOverview(nextOverview);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to refresh settings'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const token = localStorage.getItem('boss_token') ?? localStorage.getItem('vasari_token');
    if (!token) return;
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setTwoFactorEnabled(Boolean(data?.twoFactorEnabled)))
      .catch(() => undefined);
  }, []);

  const updateSetting = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('api/settings', {
        method: 'PATCH',
        headers: authHeaders(true),
        body: JSON.stringify(pickPatch(settings)),
      });
      if (!res.ok) throw new Error(`Save failed with HTTP ${res.status}`);
      const next = (await res.json()) as SettingsState;
      setSettings({ ...DEFAULT_SETTINGS, ...next });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save settings');
    } finally {
      setSaving(false);
    }
  };

  const startTwoFactorSetup = async () => {
    setTwoFactorError(null);
    setTwoFactorMessage(null);
    const res = await fetch('/api/auth/2fa/setup', { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setTwoFactorError(data?.error || 'Unable to start two-factor setup.');
      return;
    }
    setTwoFactorSetup(data);
  };

  const enableTwoFactor = async () => {
    setTwoFactorError(null);
    setTwoFactorMessage(null);
    const res = await fetch('/api/auth/2fa/enable', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ code: twoFactorCode }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setTwoFactorError(data?.error || 'Invalid Authenticator code.');
      return;
    }
    setTwoFactorEnabled(true);
    setTwoFactorSetup(null);
    setTwoFactorCode('');
    setTwoFactorMessage('Google Authenticator is enabled for this login.');
  };

  const copyAgentInstructions = () => {
    const text = [
      'Global MCP discovery for Vasari-BOS agents:',
      `Status API: ${mcp?.discovery?.statusUrl ?? '/api/mcp/global'}`,
      `Registry path: ${mcp?.registryPath ?? mcp?.discovery?.registryPath ?? 'not set'}`,
      `Host registry path: ${mcp?.hostRegistryPath ?? mcp?.discovery?.hostRegistryPath ?? 'not set'}`,
      `Config path: ${mcp?.configPath ?? 'not set'}`,
      `Server URL: ${mcp?.serverUrl ?? 'not set'}`,
      `Custom MCP entries: ${(mcp?.customConnections ?? []).map((item) => item.name).join(', ') || 'none'}`,
      '',
      ...(mcp?.agentInstructions ?? [
        'Use the Global MCP registry or server URL for discovery.',
        'Each runtime keeps its own internal MCP session and secrets.',
      ]),
    ].join('\n');
    void navigator.clipboard?.writeText(text);
  };

  const openMcpLogin = () => {
    const target = mcp?.loginUrl ?? mcp?.serverUrl;
    if (!target) return;
    const opened = window.open(target, '_blank', 'noopener,noreferrer');
    if (!opened) window.location.assign(target);
  };

  const openHermesGateway = async () => {
    try {
      await fetch('api/gw/grant', { method: 'POST', headers: authHeaders() });
    } catch {
      // The gateway may still be reachable if the cookie is already valid.
    }
    const target = mcp?.gateway?.publicUrl ?? 'https://gateway.vasari.starrpartners.ai';
    const opened = window.open(target, '_blank', 'noopener,noreferrer');
    if (!opened) window.location.assign(target);
  };

  const updateCustomMcpForm = <K extends keyof CustomMcpForm>(key: K, value: CustomMcpForm[K]) => {
    setCustomMcpForm((prev) => ({ ...prev, [key]: value }));
  };

  const saveCustomMcpConnection = async () => {
    const name = customMcpForm.name.trim();
    const needsCommand = customMcpForm.transport === 'stdio';
    if (!name) {
      setError('Custom MCP name is required.');
      return;
    }
    if (needsCommand && !customMcpForm.command.trim()) {
      setError('Command is required for stdio MCP connections.');
      return;
    }
    if (!needsCommand && !customMcpForm.serverUrl.trim()) {
      setError('Server URL is required for http and sse MCP connections.');
      return;
    }

    setCustomMcpSaving(true);
    setError(null);
    try {
      const res = await fetch('api/mcp/global/connections', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(customMcpForm),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Save failed with HTTP ${res.status}`);
      setCustomMcpForm(DEFAULT_CUSTOM_MCP_FORM);
      setShowCustomMcpForm(false);
      setSaved(true);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save custom MCP connection');
    } finally {
      setCustomMcpSaving(false);
    }
  };

  const deleteCustomMcpConnection = async (id: string) => {
    setCustomMcpDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`api/mcp/global/connections/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Remove failed with HTTP ${res.status}`);
      setSaved(true);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove custom MCP connection');
    } finally {
      setCustomMcpDeletingId(null);
    }
  };

  const openCustomMcpLogin = (connection: CustomMcpConnection) => {
    const target = connection.loginUrl ?? connection.serverUrl;
    if (!target) return;
    const opened = window.open(target, '_blank', 'noopener,noreferrer');
    if (!opened) window.location.assign(target);
  };

  const connectorCount = connectors.length;
  const configuredConnectors = connectors.filter((item) => item.configured).length;
  const codexStatus = runtimeStatus(overview?.codexCli?.status ?? overview?.codex?.status ?? overview?.gateway);
  const claudeAdapter = adapters.find((adapter) => adapter.id === 'claude-code');
  const claudeStatus = runtimeStatus(claudeAdapter?.status);
  const mcpStatus: RuntimeStatus = !mcp ? 'missing' : mcp.connected ? 'ready' : mcp.configured ? 'partial' : 'missing';
  const gatewayStatus: RuntimeStatus = mcp?.gateway?.health ? (mcp.gateway.health.ok ? 'ready' : 'error') : mcp?.gateway ? 'external' : 'missing';
  const customMcpConnections = mcp?.customConnections ?? [];

  const runtimeRows = [
    {
      id: 'codex-cli',
      name: 'Codex CLI',
      status: codexStatus,
      detail: 'Used by Gio, employee agents, code work, repository operations, and builder tasks.',
      path: mcp?.consumers?.find((item) => item.id === 'codex')?.configPath ?? mcp?.codexHome,
    },
    {
      id: 'claude-code-cli',
      name: 'Claude Code CLI',
      status: claudeStatus,
      detail: 'Used for builder flows and deep code work that need Claude Code semantics and MCP access.',
      path: mcp?.consumers?.find((item) => item.id === 'claude')?.configPath ?? mcp?.claudeHome,
    },
    {
      id: 'hermes',
      name: 'Hermes',
      status: gatewayStatus,
      detail: 'Hermes-owned runtime. Vasari-BOS can access it where wired, but it is not a BOS-owned page.',
      path: mcp?.consumers?.find((item) => item.id === 'hermes')?.configPath ?? mcp?.hermesHome,
    },
  ];

  const summaryTiles = [
    { label: 'Global MCP', value: `${customMcpConnections.length} custom · ${mcp?.connected ? 'connected' : mcp?.configured ? 'needs auth' : 'not configured'}`, status: mcpStatus, icon: Server },
    { label: 'Connections', value: `${configuredConnectors}/${connectorCount || 0} ready`, status: configuredConnectors ? 'ready' as RuntimeStatus : 'missing' as RuntimeStatus, icon: Plug },
    { label: 'Codex CLI', value: overview?.codexCli?.status ?? overview?.gateway ?? 'Unknown', status: codexStatus, icon: Code2 },
    { label: 'Hermes Gateway', value: mcp?.gateway?.health?.detail ?? 'Not checked', status: gatewayStatus, icon: Bot },
    { label: 'Voice', value: voice?.outboundReady ? 'Outbound ready' : voice?.configured ? 'Configured' : 'Not configured', status: voice?.outboundReady ? 'ready' as RuntimeStatus : voice?.configured ? 'configured' as RuntimeStatus : 'missing' as RuntimeStatus, icon: Mic },
    { label: 'Admin Role', value: user.role ?? 'user', status: ['admin', 'owner'].includes(user.role ?? '') ? 'ready' as RuntimeStatus : 'partial' as RuntimeStatus, icon: Users },
  ];

  return (
    <div className="aios-page aios-page-pad mx-auto flex w-full max-w-[1360px] flex-col gap-4">
      <div className="aios-command-hero flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1">
          <div className="vs-mono mb-1 text-[10px] uppercase tracking-[0.22em] text-text-muted">Control Center</div>
          <h1 className="text-2xl font-semibold text-text-primary">Settings</h1>
          <p className="mt-1 max-w-3xl text-sm text-text-muted">
            BOS configuration, admin controls, connections, Global MCP discovery, and internal runtime wiring in one place.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton icon={RefreshCw} label={loading ? 'Refreshing' : 'Refresh'} onClick={refresh} disabled={loading} />
          <ActionButton icon={LogOut} label="Sign Out" onClick={handleSignOut} />
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving}
            className="btn-primary text-sm disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Save className="h-4 w-4" aria-hidden />
            {saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </div>

      <div className="aios-control-bar flex gap-2 overflow-x-auto px-2 py-2" role="tablist" aria-label="Settings sections">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex flex-shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                active
                  ? 'border-accent/60 bg-accent/10 text-text-primary'
                  : 'border-border bg-surface-1/50 text-text-secondary hover:border-border-strong'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>

      {(error || saved) && (
        <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${error ? 'border-[#d64f4f55] bg-[#d64f4f14] text-text-secondary' : 'border-[#20b26b55] bg-[#20b26b14] text-text-secondary'}`}>
          {error ? <AlertTriangle className="h-4 w-4 text-[#d64f4f]" aria-hidden /> : <CheckCircle2 className="h-4 w-4 text-[#20b26b]" aria-hidden />}
          {error ?? 'Settings saved'}
        </div>
      )}

      {activeTab === 'overview' && (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {summaryTiles.map((tile) => {
              const Icon = tile.icon;
              return (
                <button
                  key={tile.label}
                  type="button"
                  onClick={() => {
                    if (tile.label === 'Connections') setActiveTab('connections');
                    else if (tile.label === 'Global MCP') setActiveTab('mcp');
                    else if (tile.label === 'Voice') setActiveTab('voice');
                    else if (tile.label === 'Admin Role') setActiveTab('admin');
                    else setActiveTab('runtimes');
                  }}
                  className="aios-panel p-4 text-left hover:border-accent/50"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Icon className="h-4 w-4 text-accent" aria-hidden />
                    <StatusBadge label={tile.status} status={tile.status} />
                  </div>
                  <div className="mt-3 text-sm font-medium text-text-primary">{tile.label}</div>
                  <div className="mt-1 text-xs text-text-muted">{tile.value}</div>
                </button>
              );
            })}
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.75fr)]">
            <SystemSettingsPanel settings={settings} voice={voice} updateSetting={updateSetting} />
            <BuilderAccessPanel onNavigate={navigate} openHermesGateway={openHermesGateway} />
          </div>
        </div>
      )}

      {activeTab === 'mcp' && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(380px,0.85fr)]">
          <Panel
            title="Global MCP"
            subtitle="Shared discovery for agents. Each runtime still manages its own MCP session and secrets."
            icon={Server}
            action={<StatusBadge label={mcpStatus} status={mcpStatus} />}
          >
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                <ActionButton icon={ExternalLink} label="Open MCP Login" onClick={openMcpLogin} disabled={!mcp?.loginUrl && !mcp?.serverUrl} />
                <ActionButton icon={Copy} label="Copy Agent Instructions" onClick={copyAgentInstructions} />
                <ActionButton icon={Bot} label="Open Hermes Gateway" onClick={openHermesGateway} />
              </div>
              <div className="rounded-md border border-border/70 bg-surface-2/40 px-3">
                <FactRow label="Scope" value={mcp?.scope ?? 'Vasari-VPS'} />
                <FactRow label="Registry" value={mcp?.registryPath ?? 'Not set'} />
                <FactRow label="Host Registry" value={mcp?.hostRegistryPath ?? 'Not set'} />
                <FactRow label="Registry Present" value={mcp?.registryPresent ? 'Yes' : 'No'} />
                <FactRow label="Config" value={mcp?.configPath ?? 'Not set'} />
                <FactRow label="Config Present" value={mcp?.configPresent ? 'Yes' : 'No'} />
                <FactRow label="Server URL" value={mcp?.serverUrl ?? 'Not set'} />
                <FactRow label="Login URL" value={mcp?.loginUrl ?? 'Not set'} />
                <FactRow label="Auth" value={mcp?.authConfigured ? 'Configured' : 'Not configured'} />
                <FactRow label="Transport" value={mcp?.transport ?? 'Unknown'} />
                <FactRow label="Checked" value={formatDate(mcp?.checkedAt)} />
              </div>
              {mcp?.loginRequired && (
                <div className="flex gap-2 rounded-md border border-[#d9a44155] bg-[#d9a44114] p-3 text-sm text-text-secondary">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#d9a441]" aria-hidden />
                  <span>Global MCP is discoverable, but the VPS does not report an active shared auth token.</span>
                </div>
              )}
            </div>
          </Panel>
          <Panel
            title="Hermes Gateway Access"
            subtitle="Hermes-owned gateway. Vasari-BOS is wired to access it, not to own it."
            icon={Bot}
            action={<StatusBadge label={gatewayStatus} status={gatewayStatus} />}
          >
            <div className="rounded-md border border-border/70 bg-surface-2/40 px-3">
              <FactRow label="Owner" value={mcp?.gateway?.owner ?? 'Hermes'} />
              <FactRow label="Relationship" value={mcp?.gateway?.relationship ?? 'wired-for-access'} />
              <FactRow label="Public URL" value={mcp?.gateway?.publicUrl ?? 'https://gateway.vasari.starrpartners.ai'} />
              <FactRow label="Base URL" value={mcp?.gateway?.baseUrl ?? 'Not reported'} />
              <FactRow label="Health" value={mcp?.gateway?.health?.detail ?? 'Not checked'} />
              <FactRow label="Token" value={mcp?.gateway?.tokenConfigured ? 'Configured' : 'Not configured'} />
            </div>
          </Panel>
          <div className="xl:col-span-2">
            <Panel
              title="Custom MCP Connections"
              subtitle="Saved to the Global MCP registry for Codex CLI, Claude Code CLI, Hermes, and agent instructions."
              icon={Plug}
              action={
                <ActionButton
                  icon={Plus}
                  label={showCustomMcpForm ? 'Close Form' : 'Add Custom MCP'}
                  onClick={() => setShowCustomMcpForm((open) => !open)}
                />
              }
            >
              <div className="grid gap-4">
                {showCustomMcpForm && (
                  <div className="rounded-md border border-border/70 bg-surface-2/40 p-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="grid gap-1.5">
                        <span className="text-xs font-medium text-text-secondary">Name</span>
                        <input
                          className="input"
                          value={customMcpForm.name}
                          onChange={(event) => updateCustomMcpForm('name', event.target.value)}
                          placeholder="Example MCP"
                        />
                      </label>
                      <label className="grid gap-1.5">
                        <span className="text-xs font-medium text-text-secondary">Transport</span>
                        <select
                          className="input"
                          value={customMcpForm.transport}
                          onChange={(event) => updateCustomMcpForm('transport', event.target.value as CustomMcpTransport)}
                        >
                          <option value="http">HTTP</option>
                          <option value="sse">SSE</option>
                          <option value="stdio">stdio</option>
                        </select>
                      </label>
                      {customMcpForm.transport === 'stdio' ? (
                        <>
                          <label className="grid gap-1.5">
                            <span className="text-xs font-medium text-text-secondary">Command</span>
                            <input
                              className="input"
                              value={customMcpForm.command}
                              onChange={(event) => updateCustomMcpForm('command', event.target.value)}
                              placeholder="npx"
                            />
                          </label>
                          <label className="grid gap-1.5">
                            <span className="text-xs font-medium text-text-secondary">Arguments</span>
                            <input
                              className="input"
                              value={customMcpForm.args}
                              onChange={(event) => updateCustomMcpForm('args', event.target.value)}
                              placeholder="-y @scope/mcp-server"
                            />
                          </label>
                        </>
                      ) : (
                        <label className="grid gap-1.5 md:col-span-2">
                          <span className="text-xs font-medium text-text-secondary">Server URL</span>
                          <input
                            className="input"
                            value={customMcpForm.serverUrl}
                            onChange={(event) => updateCustomMcpForm('serverUrl', event.target.value)}
                            placeholder="https://example.com/mcp"
                          />
                        </label>
                      )}
                      <label className="grid gap-1.5">
                        <span className="text-xs font-medium text-text-secondary">Login URL</span>
                        <input
                          className="input"
                          value={customMcpForm.loginUrl}
                          onChange={(event) => updateCustomMcpForm('loginUrl', event.target.value)}
                          placeholder="https://example.com/login"
                        />
                      </label>
                      <label className="grid gap-1.5">
                        <span className="text-xs font-medium text-text-secondary">Token Env Var</span>
                        <input
                          className="input"
                          value={customMcpForm.tokenEnv}
                          onChange={(event) => updateCustomMcpForm('tokenEnv', event.target.value)}
                          placeholder="EXAMPLE_MCP_TOKEN"
                        />
                      </label>
                      <label className="grid gap-1.5 md:col-span-2">
                        <span className="text-xs font-medium text-text-secondary">Config Path</span>
                        <input
                          className="input"
                          value={customMcpForm.configPath}
                          onChange={(event) => updateCustomMcpForm('configPath', event.target.value)}
                          placeholder="/home/boss/.codex/config.toml"
                        />
                      </label>
                      <label className="grid gap-1.5 md:col-span-2">
                        <span className="text-xs font-medium text-text-secondary">Description</span>
                        <textarea
                          className="input min-h-[82px] resize-y"
                          value={customMcpForm.description}
                          onChange={(event) => updateCustomMcpForm('description', event.target.value)}
                          placeholder="What this MCP gives agents access to"
                        />
                      </label>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <ToggleSwitch
                          checked={customMcpForm.enabled}
                          onChange={(next) => updateCustomMcpForm('enabled', next)}
                          label="Custom MCP enabled"
                        />
                        <span className="text-sm text-text-secondary">Enabled</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            setCustomMcpForm(DEFAULT_CUSTOM_MCP_FORM);
                            setShowCustomMcpForm(false);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={saveCustomMcpConnection}
                          disabled={customMcpSaving}
                        >
                          {customMcpSaving ? 'Saving...' : 'Save MCP'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid gap-3">
                  {customMcpConnections.length === 0 ? (
                    <div className="rounded-md border border-border/70 bg-surface-2/40 p-3 text-sm text-text-muted">
                      No custom MCP connections saved.
                    </div>
                  ) : customMcpConnections.map((connection) => (
                    <div key={connection.id} className="rounded-md border border-border/70 bg-surface-2/40 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-medium text-text-primary">{connection.name}</div>
                            <StatusBadge label={connection.transport} status="external" />
                            <StatusBadge label={connection.enabled ? 'enabled' : 'disabled'} status={connection.enabled ? 'ready' : 'partial'} />
                          </div>
                          {connection.description && (
                            <p className="mt-1 text-xs text-text-muted">{connection.description}</p>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ActionButton
                            icon={ExternalLink}
                            label="Open Login"
                            onClick={() => openCustomMcpLogin(connection)}
                            disabled={!connection.loginUrl && !connection.serverUrl}
                          />
                          <button
                            type="button"
                            onClick={() => deleteCustomMcpConnection(connection.id)}
                            disabled={customMcpDeletingId === connection.id}
                            className="inline-flex items-center justify-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger hover:border-danger disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                            {customMcpDeletingId === connection.id ? 'Removing' : 'Remove'}
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 rounded-md border border-border/60 bg-surface-1/50 px-3">
                        <FactRow label={connection.transport === 'stdio' ? 'Command' : 'Server URL'} value={connection.transport === 'stdio' ? [connection.command, connection.args].filter(Boolean).join(' ') : connection.serverUrl ?? 'Not set'} />
                        <FactRow label="Login URL" value={connection.loginUrl ?? 'Not set'} />
                        <FactRow label="Token Env" value={connection.tokenEnv ?? 'Not set'} />
                        <FactRow label="Config Path" value={connection.configPath ?? 'Not set'} />
                        <FactRow label="Updated" value={formatDate(connection.updatedAt)} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {activeTab === 'connections' && <Connectors />}

      {activeTab === 'runtimes' && (
        <div className="grid gap-4">
          <Panel title="Internal Runtimes" subtitle="These stay available to BOS and builders, but they are not standalone navigation pages." icon={Terminal}>
            <div className="grid gap-3 xl:grid-cols-3">
              {runtimeRows.map((runtime) => (
                <div key={runtime.id} className="rounded-md border border-border/70 bg-surface-2/40 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-text-primary">{runtime.name}</div>
                    <StatusBadge label={runtime.status} status={runtime.status} />
                  </div>
                  <p className="mt-1 text-xs text-text-muted">{runtime.detail}</p>
                  <div className="mt-2 truncate text-xs text-text-secondary">{runtime.path ?? 'Path not reported'}</div>
                </div>
              ))}
            </div>
          </Panel>
          <BrainConfig />
        </div>
      )}

      {activeTab === 'voice' && (
        <div className="grid gap-4">
          <Panel title="Login Security" subtitle="Google Authenticator two-factor login." icon={KeyRound}>
            <div className="space-y-4">
              {twoFactorMessage && (
                <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{twoFactorMessage}</div>
              )}
              {twoFactorError && (
                <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{twoFactorError}</div>
              )}
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {twoFactorEnabled ? 'Authenticator enabled' : 'Authenticator not enabled'}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Returning logins use password plus a 6-digit Google Authenticator code when enabled.
                  </p>
                </div>
                {!twoFactorEnabled && (
                  <ActionButton icon={KeyRound} label="Set Up 2FA" onClick={startTwoFactorSetup} />
                )}
              </div>
              {twoFactorSetup && (
                <div className="grid grid-cols-1 gap-4 rounded-md border border-border bg-surface-2/50 p-4 md:grid-cols-[180px_1fr]">
                  <div className="bg-white rounded p-3 w-fit">
                    <QRCodeSVG value={twoFactorSetup.otpauthUrl} size={156} />
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium text-text-primary">Scan with Google Authenticator</p>
                      <p className="text-xs text-text-muted mt-1">
                        Manual key: <span className="font-mono text-text-secondary">{twoFactorSetup.secret}</span>
                      </p>
                    </div>
                    <div className="flex gap-3 flex-wrap">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={twoFactorCode}
                        onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="123456"
                        className="input max-w-[150px] tracking-[0.25em] text-center font-mono"
                        autoComplete="one-time-code"
                      />
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={enableTwoFactor}
                        disabled={twoFactorCode.length !== 6}
                      >
                        Verify and Enable
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Panel>
          <VoiceDevices />
        </div>
      )}

      {activeTab === 'learning' && <Learning />}
      {activeTab === 'healing' && <SelfHealing />}
      {activeTab === 'backup' && <BackupStatus />}

      {activeTab === 'admin' && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.75fr)]">
          <Panel title="Admin Scope" subtitle="Admin is part of Settings, not a separate page." icon={Users}>
            <div className="rounded-md border border-border/70 bg-surface-2/40 px-3">
              <FactRow label="Name" value={user.displayName ?? user.name ?? 'User'} />
              <FactRow label="Role" value={user.role ?? 'user'} />
              <FactRow label="Email" value={user.email ?? 'Not stored locally'} />
              <FactRow label="Mode" value={settings.mode} />
              <FactRow label="Max Jobs" value={settings.maxConcurrentJobs} />
              <FactRow label="Updated" value={formatDate(settings.updatedAt)} />
            </div>
          </Panel>
          <BuilderAccessPanel onNavigate={navigate} openHermesGateway={openHermesGateway} />
          <SystemSettingsPanel settings={settings} voice={voice} updateSetting={updateSetting} />
        </div>
      )}
    </div>
  );
}

function SystemSettingsPanel({
  settings,
  voice,
  updateSetting,
}: {
  settings: SettingsState;
  voice: VoiceStatus | null;
  updateSetting: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
}) {
  return (
    <Panel title="System Settings" subtitle="Tenant, voice, backup, learning, healing, and runtime controls." icon={SettingsIcon}>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Timezone</span>
          <input className="input" value={settings.timezone} onChange={(event) => updateSetting('timezone', event.target.value)} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Locale</span>
          <input className="input" value={settings.locale} onChange={(event) => updateSetting('locale', event.target.value)} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Backup Interval Minutes</span>
          <input className="input" type="number" min={15} max={10080} value={settings.backupIntervalMinutes} onChange={(event) => updateSetting('backupIntervalMinutes', Number(event.target.value))} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Backup Retention Days</span>
          <input className="input" type="number" min={1} max={365} value={settings.backupRetentionDays} onChange={(event) => updateSetting('backupRetentionDays', Number(event.target.value))} />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Brain Provider</span>
          <select className="input" value={settings.brainProvider} onChange={(event) => updateSetting('brainProvider', event.target.value)}>
            <option value="claude-code">Claude Code</option>
            <option value="openclaw">OpenClaw</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Connector Provider</span>
          <select className="input" value={settings.connectorProvider} onChange={(event) => updateSetting('connectorProvider', event.target.value)}>
            <option value="google">Google</option>
            <option value="microsoft">Microsoft</option>
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Mode</span>
          <select className="input" value={settings.mode} onChange={(event) => updateSetting('mode', event.target.value as SettingsState['mode'])}>
            <option value="single">Single tenant</option>
            <option value="multi">Multi tenant</option>
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Max Concurrent Jobs</span>
          <input className="input" type="number" min={1} max={32} value={settings.maxConcurrentJobs} onChange={(event) => updateSetting('maxConcurrentJobs', Number(event.target.value))} />
        </label>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {[
          { key: 'voiceEnabled' as const, label: 'Voice', icon: Mic, checked: settings.voiceEnabled, note: voice?.outboundReady ? 'Outbound ready' : 'Configure voice credentials if needed' },
          { key: 'learningEnabled' as const, label: 'Learning', icon: BookOpen, checked: settings.learningEnabled, note: 'Preference capture and adaptive behavior' },
          { key: 'healingEnabled' as const, label: 'Self-Healing', icon: Shield, checked: settings.healingEnabled, note: 'Incident detection and recovery playbooks' },
          { key: 'notificationsEnabled' as const, label: 'Notifications', icon: Bell, checked: settings.notificationsEnabled, note: 'Escalations and critical alerts' },
          { key: 'debugLogging' as const, label: 'Debug Logging', icon: Code2, checked: settings.debugLogging, note: 'Verbose diagnostics for troubleshooting' },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.key} className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-surface-2/40 p-3">
              <div className="flex min-w-0 gap-2">
                <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" aria-hidden />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary">{item.label}</div>
                  <div className="text-xs text-text-muted">{item.note}</div>
                </div>
              </div>
              <ToggleSwitch checked={item.checked} onChange={(next) => updateSetting(item.key, next)} label={`${item.label} toggle`} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function BuilderAccessPanel({
  onNavigate,
  openHermesGateway,
}: {
  onNavigate: (path: string) => void;
  openHermesGateway: () => void;
}) {
  return (
    <Panel title="Builder Access" subtitle="Shown here as internal tools used by builders and agents." icon={Wrench}>
      <div className="grid gap-2">
        <ActionButton icon={LockKeyhole} label="Claude Auth Builder" onClick={() => onNavigate('/setup/claude-auth')} />
        <ActionButton icon={Bot} label="Hermes Setup Builder" onClick={() => onNavigate('/setup/hermes')} />
        <ActionButton icon={ExternalLink} label="Hermes Gateway" onClick={openHermesGateway} />
        <ActionButton icon={Brain} label="Gio Workspace" onClick={() => onNavigate('/oc')} />
        <ActionButton icon={Users} label="Employee Agents" onClick={() => onNavigate('/agents')} />
      </div>
      <div className="mt-4 rounded-md border border-border/70 bg-surface-2/40 px-3">
        <FactRow label="Codex" value="Runtime capability, not a public page" />
        <FactRow label="Claude Code" value="Runtime/builder capability, not a settings page" />
        <FactRow label="Hermes" value="Hermes-owned capability wired into BOS access" />
      </div>
    </Panel>
  );
}
