/**
 * Employee Agents — headless AI staff agents (Email, CFO, …). They run on a
 * heartbeat and report to the COO + dashboard; they do NOT chat. This surface is
 * read-only observability: status, schedule, last report, and analytics + cost
 * (rolled up from boss_agent_runs) so the COO and Kevin can see what each agent
 * is doing and what it costs. Rascals/Outsiders do NOT live here.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Briefcase, Wallet, Mail, Sparkles, AlertTriangle, CheckCircle2, Clock, RefreshCw,
} from 'lucide-react';
import { employeeAgentsApi, type EmployeeAgentRow } from '../lib/api';

function num(v: string | number | null | undefined): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}
function money(v: string | number): string {
  const n = num(v);
  return '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}
function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function iconFor(a: EmployeeAgentRow): typeof Wallet {
  if (a.id.includes('cfo')) return Wallet;
  if (a.id.includes('email')) return Mail;
  return Sparkles;
}
function statusStyle(status: string): string {
  if (status === 'active') return 'bg-green-500/15 text-green-400 border-green-500/30';
  if (status === 'paused') return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  return 'bg-surface-2/70 text-text-muted border-border';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="aios-stat py-2">
      <div className="text-[13px] font-semibold text-text-secondary">{value}</div>
      <div className="vs-mono text-[9px] uppercase tracking-wide text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function AgentCard({ a }: { a: EmployeeAgentRow }) {
  const Icon = iconFor(a);
  const errored = a.last_status === 'error';
  return (
    <div className="aios-panel p-4 flex flex-col gap-3" data-testid="employee-agent-card">
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-lg grid place-items-center flex-shrink-0 text-info bg-info/10 border border-info/25" aria-hidden>
          <Icon className="w-5 h-5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-text-secondary leading-tight truncate">{a.name}</div>
          <div className="vs-mono text-[10px] mt-0.5 text-text-muted flex items-center gap-1 truncate">
            <Clock className="w-3 h-3 flex-shrink-0" /> {a.cron_expression} · {a.model ?? '—'}
          </div>
        </div>
        <span className={`text-[10px] font-medium px-2 py-1 rounded-md border flex-shrink-0 ${statusStyle(a.status)}`}>{a.status}</span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Cost 24h" value={money(a.cost_24h)} />
        <Stat label="Cost 7d" value={money(a.cost_7d)} />
        <Stat label="Runs 24h" value={String(num(a.runs_24h))} />
      </div>

      <div className="flex items-center justify-between text-[11px] text-text-muted">
        <span className="flex items-center gap-1">
          {errored
            ? <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            : <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
          last run {relTime(a.last_run_at)}
        </span>
        <span>{a.run_count} runs · {a.error_count} err</span>
      </div>

      {a.last_result ? (
        <div className="text-[11px] text-text-muted bg-surface-2/60 border border-border rounded-lg p-2 max-h-24 overflow-y-auto leading-relaxed whitespace-pre-wrap">
          {a.last_result.slice(0, 500)}
        </div>
      ) : (
        <div className="text-[11px] text-text-muted italic">No report yet — awaiting first heartbeat.</div>
      )}
    </div>
  );
}

export function EmployeeAgents() {
  const [agents, setAgents] = useState<EmployeeAgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await employeeAgentsApi.list();
      setAgents(res.agents ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="aios-page aios-page-pad min-h-full" data-testid="employee-agents-page">
      <header className="aios-command-hero mb-4 flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div>
          <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">Your Team</div>
          <h1 className="text-2xl font-semibold mt-1 flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-accent" />
            Employee Agents
          </h1>
          <p className="text-[12px] text-text-muted mt-1 max-w-2xl">
            Heartbeat AI staff with costs, runs, and last reports in one executive staff view.
          </p>
        </div>
        <button onClick={() => void load()} className="btn-secondary text-xs" title="Refresh" aria-label="Refresh">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </header>

      {err && <div className="text-[12px] text-red-400 mb-3">{err}</div>}
      {loading ? (
        <div className="text-[12px] text-text-muted">Loading…</div>
      ) : agents.length === 0 ? (
        <div className="text-[12px] text-text-muted">No Employee Agents registered yet.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((a) => <AgentCard key={a.id} a={a} />)}
        </div>
      )}
    </div>
  );
}
