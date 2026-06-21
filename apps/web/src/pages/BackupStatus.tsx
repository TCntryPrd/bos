/**
 * Backup Status — last/next backup, retention policy, destinations, history.
 */

import React, { useState } from 'react';
import {
  DatabaseBackup,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Github,
  Cloud,
  Play,
  Clock,
} from 'lucide-react';
import { Card } from '../components/Card';
import { StatusBadge } from '../components/StatusBadge';
import { DataTable, type Column } from '../components/DataTable';
import { PageLoader } from '../components/LoadingSpinner';
import { useApi } from '../hooks/useApi';
import { backupApi } from '../lib/api';
import { mockBackupState } from '../lib/mock';
import { formatRelativeTime, formatDateTime, formatBytes } from '../lib/utils';
import type { BackupRecord } from '../types/api';

const HISTORY_COLUMNS: Column<BackupRecord>[] = [
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <div className="flex items-center gap-2">
        {r.status === 'success' ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success" aria-hidden />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-danger" aria-hidden />
        )}
        <span className={`text-xs font-medium ${r.status === 'success' ? 'text-success' : 'text-danger'}`}>
          {r.status === 'success' ? 'Success' : 'Failed'}
        </span>
      </div>
    ),
  },
  {
    key: 'startedAt',
    header: 'Started',
    render: (r) => (
      <span className="text-xs text-text-secondary">{formatDateTime(r.startedAt)}</span>
    ),
  },
  {
    key: 'size',
    header: 'Size',
    render: (r) => (
      <span className="text-xs text-text-secondary font-mono">
        {r.sizeBytes ? formatBytes(r.sizeBytes) : '—'}
      </span>
    ),
  },
  {
    key: 'destination',
    header: 'Destination',
    render: (r) => (
      <span className="text-xs text-text-muted capitalize">{r.destination}</span>
    ),
  },
  {
    key: 'error',
    header: 'Note',
    render: (r) => (
      <span className="text-xs text-text-muted truncate max-w-xs block">
        {r.error ?? '—'}
      </span>
    ),
  },
];

export function BackupStatus() {
  const { data: state, isLoading, refresh } = useApi(
    backupApi.getState,
    { fallback: mockBackupState, pollInterval: 60_000 },
  );

  const [triggering, setTriggering] = useState(false);
  const [triggered, setTriggered] = useState(false);

  async function handleTrigger() {
    setTriggering(true);
    setTriggered(false);
    try {
      await backupApi.triggerBackup();
      setTriggered(true);
      setTimeout(refresh, 3_000);
    } catch { /* noop */ }
    finally {
      setTriggering(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {isLoading && !state ? (
        <PageLoader />
      ) : state ? (
        <>
          {/* Status overview */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-4">
              <p className="text-xs text-text-muted mb-2">Current Status</p>
              <StatusBadge status={state.status} />
            </div>
            <div className="card p-4">
              <p className="text-xs text-text-muted mb-1">Last Backup</p>
              <p className="text-sm font-semibold text-text-primary">
                {state.lastBackupAt ? formatRelativeTime(state.lastBackupAt) : 'Never'}
              </p>
              {state.lastBackupSize && (
                <p className="text-xs text-text-muted mt-0.5 font-mono">
                  {formatBytes(state.lastBackupSize)}
                </p>
              )}
            </div>
            <div className="card p-4">
              <p className="text-xs text-text-muted mb-1">Next Backup</p>
              <p className="text-sm font-semibold text-text-primary">
                {state.nextScheduledAt ? formatRelativeTime(state.nextScheduledAt) : '—'}
              </p>
              <p className="text-xs text-text-muted mt-0.5">
                Every {state.intervalMinutes} min
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-text-muted mb-1">Retention</p>
              <p className="text-sm font-semibold text-text-primary">
                {state.retentionDays} days
              </p>
              <p className="text-xs text-text-muted mt-0.5 capitalize">
                Destination: {state.destination}
              </p>
            </div>
          </div>

          {/* Destinations */}
          <Card>
            <Card.Header title="Backup Destinations" subtitle="Where backups are stored — AES-256 encrypted" />
            <Card.Body className="space-y-4">
              {state.destinationStatus.git && (
                <div className="flex items-center justify-between gap-3 p-4 rounded-lg bg-surface-3 border border-border">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-surface-4">
                      <Github className="w-4 h-4 text-text-secondary" aria-hidden />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">Git Repository</p>
                      <p className="text-xs text-text-muted">
                        Layer 1 auth: SSH key · Layer 2 auth: AES-256 per-file encryption
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {state.destinationStatus.git.lastPushAt && (
                      <span className="text-xs text-text-muted hidden sm:block">
                        Last push {formatRelativeTime(state.destinationStatus.git.lastPushAt)}
                      </span>
                    )}
                    {state.destinationStatus.git.healthy ? (
                      <CheckCircle2 className="w-4 h-4 text-success" aria-label="Git destination healthy" />
                    ) : (
                      <XCircle className="w-4 h-4 text-danger" aria-label="Git destination error" />
                    )}
                    {state.destinationStatus.git.error && (
                      <span className="text-xs text-danger">{state.destinationStatus.git.error}</span>
                    )}
                  </div>
                </div>
              )}

              {state.destinationStatus.s3 && (
                <div className="flex items-center justify-between gap-3 p-4 rounded-lg bg-surface-3 border border-border">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-surface-4">
                      <Cloud className="w-4 h-4 text-text-secondary" aria-hidden />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">S3 / Object Storage</p>
                      <p className="text-xs text-text-muted">
                        Layer 1 auth: IAM credentials · Layer 2 auth: AES-256 per-file encryption
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {state.destinationStatus.s3.lastUploadAt && (
                      <span className="text-xs text-text-muted hidden sm:block">
                        Last upload {formatRelativeTime(state.destinationStatus.s3.lastUploadAt)}
                      </span>
                    )}
                    {state.destinationStatus.s3.healthy ? (
                      <CheckCircle2 className="w-4 h-4 text-success" aria-label="S3 destination healthy" />
                    ) : (
                      <XCircle className="w-4 h-4 text-danger" aria-label="S3 destination error" />
                    )}
                    {state.destinationStatus.s3.error && (
                      <span className="text-xs text-danger">{state.destinationStatus.s3.error}</span>
                    )}
                  </div>
                </div>
              )}
            </Card.Body>
          </Card>

          {/* Manual trigger */}
          <Card>
            <Card.Header
              title="Manual Backup"
              subtitle="Trigger an immediate backup outside the schedule"
            />
            <Card.Body>
              <div className="flex items-center gap-4 flex-wrap">
                <button
                  className="btn-primary gap-2"
                  onClick={handleTrigger}
                  disabled={triggering || state.status === 'running'}
                  aria-label="Trigger manual backup"
                >
                  <Play className="w-4 h-4" aria-hidden />
                  {triggering ? 'Triggering...' : 'Trigger Backup Now'}
                </button>
                {triggered && (
                  <div className="flex items-center gap-1.5 text-xs text-success animate-fade-in">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
                    Backup job queued
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <Clock className="w-3.5 h-3.5" aria-hidden />
                  Typically completes in under 2 minutes
                </div>
              </div>
            </Card.Body>
          </Card>

          {/* History table */}
          <Card noPadding>
            <Card.Header
              title="Backup History"
              subtitle="Recent backup records"
              action={
                <button
                  className="btn-ghost text-xs gap-1.5"
                  onClick={refresh}
                  aria-label="Refresh backup status"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden />
                  Refresh
                </button>
              }
            />
            <DataTable
              columns={HISTORY_COLUMNS}
              rows={state.history}
              keyExtractor={(r) => r.id}
              emptyMessage="No backup history yet"
            />
          </Card>
        </>
      ) : (
        <div className="card p-5 text-center text-text-muted">
          <DatabaseBackup className="w-8 h-8 mx-auto mb-2 opacity-40" aria-hidden />
          <p className="text-sm">Backup state unavailable</p>
        </div>
      )}
    </div>
  );
}
