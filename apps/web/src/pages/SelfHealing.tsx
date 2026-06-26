/**
 * Self-Healing — incident log, playbook library, health status.
 */

import React, { useState } from 'react';
import {
  ShieldCheck,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  BookOpen,
  Activity,
} from 'lucide-react';
import { Card } from '../components/Card';
import { StatusBadge } from '../components/StatusBadge';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { PageLoader } from '../components/LoadingSpinner';
import { useApi } from '../hooks/useApi';
import { healingApi, healthApi } from '../lib/api';
import { mockIncidents, mockPlaybooks, mockSystemHealth } from '../lib/mock';
import { formatRelativeTime, formatDateTime, slugToLabel } from '../lib/utils';
import type { Incident, Playbook, HealingAttempt } from '../types/api';

const SEVERITY_STYLES: Record<string, string> = {
  low:      'bg-info/10 text-info',
  medium:   'bg-warning/10 text-warning',
  high:     'bg-danger/10 text-danger',
  critical: 'bg-danger/20 text-danger font-semibold',
};

function IncidentAttempt({ attempt }: { attempt: HealingAttempt }) {
  return (
    <div className={`flex items-start gap-3 py-2 border-l-2 pl-3 ml-2 ${
      attempt.result === 'success' ? 'border-success' : 'border-danger/40'
    }`}>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text-secondary">
          <span className="font-medium">Attempt {attempt.attemptNumber}:</span>{' '}
          {attempt.action}
        </p>
        {attempt.notes && (
          <p className="text-xs text-text-muted mt-0.5">{attempt.notes}</p>
        )}
      </div>
      <div className="flex-shrink-0 flex items-center gap-2">
        <span className={`text-xs font-medium ${attempt.result === 'success' ? 'text-success' : 'text-danger'}`}>
          {attempt.result === 'success' ? 'Fixed' : 'Failed'}
        </span>
        <time className="text-xs text-text-muted" dateTime={attempt.timestamp}>
          {formatDateTime(attempt.timestamp)}
        </time>
      </div>
    </div>
  );
}

function IncidentRow({ incident }: { incident: Incident }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        className="w-full flex items-start justify-between gap-3 py-4 px-5 hover:bg-surface-3 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} incident: ${incident.title}`}
      >
        <div className="flex items-start gap-3 min-w-0">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-text-muted mt-0.5 flex-shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-muted mt-0.5 flex-shrink-0" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{incident.title}</p>
            <p className="text-xs text-text-muted mt-0.5 truncate">{incident.description}</p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${SEVERITY_STYLES[incident.severity]}`}>
                {incident.severity}
              </span>
              <span className="text-xs text-text-muted">{slugToLabel(incident.service)}</span>
              <span className="text-xs text-text-muted">
                {incident.attempts.length} attempt{incident.attempts.length !== 1 ? 's' : ''}
              </span>
              {incident.playbookUsed && (
                <span className="text-xs text-accent">Playbook applied</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <StatusBadge status={incident.status} size="sm" />
          <time className="text-xs text-text-muted" dateTime={incident.createdAt}>
            {formatRelativeTime(incident.createdAt)}
          </time>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-4 animate-fade-in">
          <div className="space-y-1 mb-3">
            {incident.attempts.map((attempt) => (
              <IncidentAttempt key={attempt.attemptNumber} attempt={attempt} />
            ))}
          </div>
          {incident.resolvedAt && (
            <p className="text-xs text-success ml-5">
              Resolved {formatDateTime(incident.resolvedAt)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const PLAYBOOK_COLUMNS: Column<Playbook>[] = [
  {
    key: 'service',
    header: 'Service',
    render: (p) => (
      <span className="text-sm text-text-primary font-medium">{slugToLabel(p.service)}</span>
    ),
  },
  {
    key: 'severity',
    header: 'Severity',
    render: (p) => (
      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${SEVERITY_STYLES[p.severity]}`}>
        {p.severity}
      </span>
    ),
  },
  {
    key: 'signature',
    header: 'Failure Pattern',
    render: (p) => (
      <code className="text-xs text-text-muted font-mono bg-surface-3 px-1.5 py-0.5 rounded">
        {p.failureSignature.slice(0, 40)}{p.failureSignature.length > 40 ? '…' : ''}
      </code>
    ),
  },
  {
    key: 'successCount',
    header: 'Successes',
    render: (p) => (
      <span className="text-sm font-semibold text-success">{p.successCount}</span>
    ),
  },
  {
    key: 'lastUsed',
    header: 'Last Used',
    render: (p) => (
      <span className="text-xs text-text-muted">
        {p.lastUsed ? formatRelativeTime(p.lastUsed) : 'Never'}
      </span>
    ),
  },
];

export function SelfHealing() {
  const { data: incidents, isLoading: loadingIncidents, refresh: refreshIncidents } = useApi(
    healingApi.getIncidents,
    { fallback: mockIncidents },
  );

  const { data: playbooks, isLoading: loadingPlaybooks } = useApi(
    healingApi.getPlaybooks,
    { fallback: mockPlaybooks },
  );

  const { data: health, refresh: refreshHealth } = useApi(
    healthApi.getSystemHealth,
    { fallback: mockSystemHealth, pollInterval: 30_000 },
  );

  const [runningCheck, setRunningCheck] = useState(false);

  async function handleHealthCheck() {
    setRunningCheck(true);
    try {
      await healingApi.runHealthCheck();
      // Re-fetch live status after manual check
      refreshHealth();
    } finally {
      setRunningCheck(false);
    }
  }

  const openIncidents = incidents?.filter((i) => i.status === 'open' || i.status === 'in_progress') ?? [];
  const resolvedIncidents = incidents?.filter((i) => i.status === 'resolved' || i.status === 'escalated') ?? [];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Open Incidents', value: openIncidents.length, color: openIncidents.length > 0 ? 'text-danger' : 'text-success' },
          { label: 'Playbooks', value: playbooks?.length ?? 0, color: 'text-text-primary' },
          { label: 'Auto-Resolved', value: resolvedIncidents.length, color: 'text-success' },
          { label: 'System Status', value: health?.overall ? health.overall.charAt(0).toUpperCase() + health.overall.slice(1) : '...', color: health?.overall === 'healthy' ? 'text-success' : 'text-warning' },
        ].map((stat) => (
          <div key={stat.label} className="card p-4 text-center">
            <p className={`text-xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-text-muted mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Incident log */}
      <Card noPadding>
        <Card.Header
          title="Incident Log"
          subtitle="All healing events — auto-resolved and escalated"
          action={
            <button
              className="btn-ghost text-xs gap-1.5"
              onClick={refreshIncidents}
              aria-label="Refresh incident log"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden />
              Refresh
            </button>
          }
        />
        {loadingIncidents && !incidents ? (
          <div className="p-5"><PageLoader /></div>
        ) : incidents && incidents.length > 0 ? (
          <div>
            {incidents.map((incident) => (
              <IncidentRow key={incident.id} incident={incident} />
            ))}
          </div>
        ) : (
          <div className="p-5">
            <EmptyState
              icon={<ShieldCheck className="w-10 h-10" />}
              title="No incidents recorded"
              description="The self-healing engine will log events here when services need attention."
            />
          </div>
        )}
      </Card>

      {/* Playbook library */}
      <Card noPadding>
        <Card.Header
          title="Playbook Library"
          subtitle="Known fix sequences — battle-tested by the diagnostic agent"
          action={
            <span className="text-xs text-text-muted">
              {playbooks?.length ?? 0} playbooks
            </span>
          }
        />
        {loadingPlaybooks && !playbooks ? (
          <div className="p-5"><PageLoader /></div>
        ) : playbooks && playbooks.length > 0 ? (
          <DataTable
            columns={PLAYBOOK_COLUMNS}
            rows={playbooks}
            keyExtractor={(p) => p.id}
            emptyMessage="No playbooks yet"
          />
        ) : (
          <div className="p-5">
            <EmptyState
              icon={<BookOpen className="w-10 h-10" />}
              title="No playbooks built yet"
              description="Playbooks are auto-generated when the diagnostic agent successfully resolves an incident."
            />
          </div>
        )}
      </Card>

      {/* Manual health check */}
      <Card>
        <Card.Header
          title="Manual Health Check"
          subtitle="Run an immediate check on all services"
        />
        <Card.Body>
          <div className="flex items-center gap-4 flex-wrap">
            <button
              className="btn-primary gap-2"
              onClick={handleHealthCheck}
              disabled={runningCheck}
              aria-label="Run manual health check"
            >
              <Activity className={`w-4 h-4 ${runningCheck ? 'animate-pulse' : ''}`} aria-hidden />
              {runningCheck ? 'Running Check...' : 'Run Health Check'}
            </button>
            <p className="text-xs text-text-muted">
              Heartbeat runs automatically every 30 seconds. Use this to run an immediate diagnostic.
            </p>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}
