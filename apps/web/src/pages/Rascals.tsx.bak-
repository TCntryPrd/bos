/**
 * Rascals — agent surface. Per-client rascals + staff outsiders in one
 * unified card grid, each card tagged with its kind. Rascal cards open the
 * rascal workspace (/rascals/:handle); outsider cards open the outsider
 * workspace (/agents/:handle).
 *
 * (Outsiders were folded into this surface 2026-06-15. The separate
 * "Employee Agents" surface is reserved for a future agent type.)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  RefreshCw,
  CheckCircle2,
  CircleOff,
  Bot,
  Terminal,
  Plus,
  X,
  Folder,
} from 'lucide-react';
import { AgentAvatar, agentHue } from '../components/AgentAvatar';
import { PageLoader } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';

type AgentKind = 'rascal' | 'outsider';

interface Agent {
  kind: AgentKind;
  tenantId: string;
  handle: string;
  displayName: string;
  cli: 'claude' | 'ollama';
  client: string;
  projectDir: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const KIND_LABEL: Record<AgentKind, string> = { rascal: 'Per-client', outsider: 'Staff' };
const KIND_HUE: Record<AgentKind, string> = { rascal: '#b56cff', outsider: '#4df5a5' };

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchAgents(): Promise<Agent[]> {
  const [rRes, oRes] = await Promise.all([
    fetch('api/agents/rascals', { headers: authHeaders() }),
    fetch('api/agents/outsiders', { headers: authHeaders() }),
  ]);
  if (!rRes.ok) throw new Error(`rascals HTTP ${rRes.status}`);
  if (!oRes.ok) throw new Error(`outsiders HTTP ${oRes.status}`);
  const rBody = (await rRes.json()) as { rascals: Omit<Agent, 'kind'>[] };
  const oBody = (await oRes.json()) as { outsiders: Omit<Agent, 'kind'>[] };
  const rascals: Agent[] = (rBody.rascals ?? []).map((a) => ({ ...a, kind: 'rascal' as const }));
  const outsiders: Agent[] = (oBody.outsiders ?? []).map((a) => ({ ...a, kind: 'outsider' as const }));
  // Dedupe by kind:handle (boss_outsiders can carry cross-tenant dupes).
  const seen = new Set<string>();
  const merged: Agent[] = [];
  for (const a of [...rascals, ...outsiders]) {
    const k = `${a.kind}:${a.handle}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(a);
  }
  merged.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return merged;
}

async function patchAgent(kind: AgentKind, handle: string, patch: { enabled: boolean }): Promise<void> {
  const base = kind === 'rascal' ? 'rascals' : 'outsiders';
  const res = await fetch(`api/agents/${base}/${handle}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

interface CreateBody {
  handle: string;
  displayName: string;
  cli: 'claude' | 'ollama';
  client: string;
  projectDir: string;
  enabled: boolean;
}

async function createAgent(kind: AgentKind, body: CreateBody): Promise<void> {
  const base = kind === 'rascal' ? 'rascals' : 'outsiders';
  const res = await fetch(`api/agents/${base}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
  }
}

interface AgentCardProps {
  agent: Agent;
  pending: boolean;
  onToggle: () => void;
}

function AgentCard({ agent, pending, onToggle }: AgentCardProps) {
  const hue = agentHue(agent.handle);
  const to = agent.kind === 'rascal' ? `/rascals/${agent.handle}` : `/agents/${agent.handle}`;
  const kindHue = KIND_HUE[agent.kind];
  return (
    <Link
      to={to}
      className="relative rounded-xl border border-border bg-surface-1/70 p-4 flex flex-col gap-3 hover:border-border-strong transition-colors block"
      style={{ backdropFilter: 'blur(10px)' }}
      data-testid="agent-card"
    >
      <div
        className="absolute top-0 left-4 right-4 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${hue}66, transparent)` }}
        aria-hidden
      />
      <div className="flex items-start gap-3">
        <AgentAvatar handle={agent.handle} displayName={agent.displayName} size={44} ring />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-text-primary leading-tight">{agent.displayName}</div>
          <div className="vs-mono text-[11px] mt-0.5 text-text-muted truncate">{agent.handle}</div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
          disabled={pending}
          className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${
            agent.enabled ? 'bg-success/15 text-success border border-success/40' : 'bg-surface-2 text-text-muted border border-border hover:text-text-primary'
          } disabled:opacity-50`}
          aria-label={agent.enabled ? 'Disable agent' : 'Enable agent'}
        >
          {agent.enabled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <CircleOff className="w-3.5 h-3.5" />}
          {agent.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="text-[9px] vs-mono uppercase tracking-[0.18em] px-2 py-0.5 rounded-full border"
          style={{ color: kindHue, borderColor: `${kindHue}55`, background: `${kindHue}12` }}
        >
          {KIND_LABEL[agent.kind]}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-text-muted">
          {agent.cli === 'claude' ? <Bot className="w-3 h-3" /> : <Terminal className="w-3 h-3" />}
          {agent.cli}
        </span>
      </div>
      <div>
        <div className="vs-mono text-[9px] uppercase tracking-[0.2em] text-text-muted">Client</div>
        <div className="text-text-primary truncate mt-0.5 text-[11.5px]">{agent.client || '—'}</div>
      </div>
      <div className="flex items-start gap-1.5 text-[11px] text-text-muted truncate">
        <Folder className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <span className="font-mono truncate" title={agent.projectDir}>{agent.projectDir}</span>
      </div>
    </Link>
  );
}

interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function CreateModal({ open, onClose, onCreated }: CreateModalProps) {
  const [kind, setKind] = useState<AgentKind>('rascal');
  const [form, setForm] = useState<CreateBody>({
    handle: '',
    displayName: '',
    cli: 'claude',
    client: '',
    projectDir: '',
    enabled: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind('rascal');
      setForm({ handle: '', displayName: '', cli: 'claude', client: '', projectDir: '', enabled: true });
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleValid = /^[a-z]{2,24}$/.test(form.handle);
  const valid = handleValid && form.displayName.trim().length > 0 && form.projectDir.trim().length > 0;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await createAgent(kind, form);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  }

  const inputBase = 'w-full bg-surface-2/70 border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-surface-1/95 p-5 shadow-xl">
        <header className="flex items-start justify-between mb-4">
          <div>
            <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">Action</div>
            <h2 className="text-lg font-semibold mt-1">Add agent</h2>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] vs-mono uppercase tracking-wider text-text-muted mb-1">Type</label>
            <div className="grid grid-cols-2 gap-2">
              {(['rascal', 'outsider'] as AgentKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`px-3 py-2 rounded-md text-[12px] border transition-colors ${
                    kind === k ? 'text-text-primary' : 'bg-surface-2 text-text-muted border-border hover:text-text-primary'
                  }`}
                  style={kind === k ? { borderColor: `${KIND_HUE[k]}88`, background: `${KIND_HUE[k]}18`, color: KIND_HUE[k] } : undefined}
                >
                  {KIND_LABEL[k]}{k === 'rascal' ? ' (rascal)' : ' (outsider)'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[11px] vs-mono uppercase tracking-wider text-text-muted mb-1">Handle</label>
            <input
              autoFocus
              className={`${inputBase} font-mono`}
              placeholder="lowercase a–z, 2–24 chars (e.g. support)"
              value={form.handle}
              onChange={(e) => setForm((f) => ({ ...f, handle: e.target.value.trim() }))}
            />
            {!handleValid && form.handle.length > 0 && (
              <p className="text-[10.5px] text-danger mt-1">Must be lowercase letters only, 2–24 chars.</p>
            )}
          </div>
          <div>
            <label className="block text-[11px] vs-mono uppercase tracking-wider text-text-muted mb-1">Display name</label>
            <input
              className={inputBase}
              placeholder="e.g. Customer Service"
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-[11px] vs-mono uppercase tracking-wider text-text-muted mb-1">Client</label>
            <input
              className={inputBase}
              placeholder={kind === 'rascal' ? 'e.g. Acme Corp' : 'e.g. staff function'}
              value={form.client}
              onChange={(e) => setForm((f) => ({ ...f, client: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-[11px] vs-mono uppercase tracking-wider text-text-muted mb-1">Project dir</label>
            <input
              className={`${inputBase} font-mono`}
              placeholder={kind === 'rascal' ? '/home/tcntryprd/rascals/<handle>' : '/home/tcntryprd/outsiders/<handle>'}
              value={form.projectDir}
              onChange={(e) => setForm((f) => ({ ...f, projectDir: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] vs-mono uppercase tracking-wider text-text-muted mb-1">CLI</label>
              <select
                className={inputBase}
                value={form.cli}
                onChange={(e) => setForm((f) => ({ ...f, cli: e.target.value as 'claude' | 'ollama' }))}
              >
                <option value="claude">claude</option>
                <option value="ollama">ollama</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] vs-mono uppercase tracking-wider text-text-muted mb-1">Enabled</label>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
                className={`w-full px-3 py-2 rounded-md text-sm border ${form.enabled ? 'bg-success/15 text-success border-success/40' : 'bg-surface-2 text-text-muted border-border'}`}
              >
                {form.enabled ? 'enabled' : 'disabled'}
              </button>
            </div>
          </div>
          {error && <p className="text-[12px] text-danger">{error}</p>}
        </div>
        <footer className="flex items-center justify-end gap-2 mt-5 pt-4 border-t border-border">
          <button type="button" onClick={onClose} className="text-[12px] text-text-muted hover:text-text-primary px-3 py-1.5">Cancel</button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!valid || submitting}
            className="text-[12px] font-semibold text-[#0a0c12] px-4 py-1.5 rounded-md disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)' }}
          >
            {submitting ? 'Creating…' : `Create ${KIND_LABEL[kind].toLowerCase()}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function Rascals() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setAgents(await fetchAgents());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleEnabled = useCallback(async (a: Agent) => {
    const key = `${a.kind}:${a.handle}`;
    setPending((p) => ({ ...p, [key]: true }));
    try {
      await patchAgent(a.kind, a.handle, { enabled: !a.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle');
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    }
  }, [refresh]);

  if (agents === null && loading) {
    return <PageLoader />;
  }

  const rascalCount = (agents ?? []).filter((a) => a.kind === 'rascal').length;
  const staffCount = (agents ?? []).filter((a) => a.kind === 'outsider').length;

  return (
    <div className="px-6 py-5" data-testid="rascals-page">
      <header className="flex items-start justify-between mb-5">
        <div>
          <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">Your Agents</div>
          <h1 className="text-2xl font-semibold mt-1 flex items-center gap-2">
            <Users className="w-5 h-5 text-accent" />
            Rascals
          </h1>
          <p className="text-[12px] text-text-muted mt-1 max-w-2xl">
            {rascalCount} per-client {rascalCount === 1 ? 'rascal' : 'rascals'} and {staffCount} staff {staffCount === 1 ? 'outsider' : 'outsiders'}. Click a card to open its workspace.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary px-3 py-1.5 rounded-md border border-border bg-surface-1/50 disabled:opacity-50"
            aria-label="Refresh agents"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-1.5 text-[12px] font-semibold text-[#0a0c12] px-3 py-1.5 rounded-md"
            style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)' }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add agent
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md border border-danger/40 bg-danger/10 text-[12px] text-danger">
          {error}
        </div>
      )}

      {agents && agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Add an agent to get started — give it a handle, a display name, and a role."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(agents ?? []).map((a) => (
            <AgentCard
              key={`${a.kind}:${a.handle}`}
              agent={a}
              pending={!!pending[`${a.kind}:${a.handle}`]}
              onToggle={() => void toggleEnabled(a)}
            />
          ))}
        </div>
      )}

      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void refresh()} />
    </div>
  );
}
