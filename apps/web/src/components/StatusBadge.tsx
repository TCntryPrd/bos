/**
 * StatusBadge — displays a health/status value as a colored badge.
 *
 * Usage:
 *   <StatusBadge status="healthy" />
 *   <StatusBadge status="degraded" label="Token refresh pending" />
 */

import React from 'react';
import { cn } from '../lib/utils';
import type { HealthStatus, VoiceDeviceStatus, IncidentStatus } from '../types/api';

type AnyStatus = HealthStatus | VoiceDeviceStatus | IncidentStatus | 'online' | 'offline' | 'provisioning' | 'open' | 'in_progress' | 'resolved' | 'escalated' | 'running' | 'idle' | 'success' | 'failed';

interface StatusBadgeProps {
  status: AnyStatus;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

const STATUS_MAP: Record<string, { dot: string; badge: string; label: string }> = {
  healthy:      { dot: 'bg-success', badge: 'bg-success/10 text-success',   label: 'Healthy' },
  online:       { dot: 'bg-success', badge: 'bg-success/10 text-success',   label: 'Online' },
  success:      { dot: 'bg-success', badge: 'bg-success/10 text-success',   label: 'Success' },
  resolved:     { dot: 'bg-success', badge: 'bg-success/10 text-success',   label: 'Resolved' },
  complete:     { dot: 'bg-success', badge: 'bg-success/10 text-success',   label: 'Complete' },

  degraded:     { dot: 'bg-warning animate-pulse', badge: 'bg-warning/10 text-warning', label: 'Degraded' },
  in_progress:  { dot: 'bg-warning animate-pulse', badge: 'bg-warning/10 text-warning', label: 'In Progress' },
  running:      { dot: 'bg-warning animate-pulse', badge: 'bg-warning/10 text-warning', label: 'Running' },
  provisioning: { dot: 'bg-warning animate-pulse', badge: 'bg-warning/10 text-warning', label: 'Provisioning' },
  idle:         { dot: 'bg-info',    badge: 'bg-info/10 text-info',         label: 'Idle' },

  unhealthy:    { dot: 'bg-danger',  badge: 'bg-danger/10 text-danger',     label: 'Unhealthy' },
  offline:      { dot: 'bg-danger',  badge: 'bg-danger/10 text-danger',     label: 'Offline' },
  error:        { dot: 'bg-danger',  badge: 'bg-danger/10 text-danger',     label: 'Error' },
  failed:       { dot: 'bg-danger',  badge: 'bg-danger/10 text-danger',     label: 'Failed' },
  escalated:    { dot: 'bg-danger',  badge: 'bg-danger/10 text-danger',     label: 'Escalated' },
  open:         { dot: 'bg-danger',  badge: 'bg-danger/10 text-danger',     label: 'Open' },

  unknown:      { dot: 'bg-text-muted', badge: 'bg-surface-3 text-text-secondary', label: 'Unknown' },
  pending:      { dot: 'bg-text-muted', badge: 'bg-surface-3 text-text-secondary', label: 'Pending' },
};

function getConfig(status: AnyStatus) {
  return STATUS_MAP[status] ?? STATUS_MAP['unknown'];
}

export function StatusBadge({ status, label, size = 'md', className }: StatusBadgeProps) {
  const config = getConfig(status);
  const displayLabel = label ?? config.label;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-xs',
        config.badge,
        className,
      )}
      aria-label={`Status: ${displayLabel}`}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', config.dot)} aria-hidden />
      {displayLabel}
    </span>
  );
}

/** Just the dot indicator without the label text. */
export function StatusDot({ status, className }: { status: AnyStatus; className?: string }) {
  const config = getConfig(status);
  return (
    <span
      className={cn('inline-block w-2 h-2 rounded-full flex-shrink-0', config.dot, className)}
      aria-label={`Status: ${config.label}`}
    />
  );
}
