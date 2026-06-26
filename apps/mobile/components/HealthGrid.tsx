/**
 * HealthGrid — 2-column grid of service status cards.
 *
 * Displays each service from SystemHealth.services as a card with:
 * - Status indicator dot (healthy/degraded/unhealthy/unknown)
 * - Service name
 * - Optional latency
 * - Optional message
 *
 * Usage:
 *   <HealthGrid health={systemHealth} loading={false} />
 *   <HealthGrid health={null} loading={true} />
 */

import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { SystemHealth, HealthCheckResult, HealthStatus } from '@boss/core';
import { Colors, Radius, Spacing, FontSize } from '@/constants/theme';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HealthGridProps {
  health: SystemHealth | null;
  loading?: boolean;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<HealthStatus, string> = {
  healthy:   Colors.healthy,
  degraded:  Colors.degraded,
  unhealthy: Colors.unhealthy,
  unknown:   Colors.unknown,
};

const STATUS_BG: Record<HealthStatus, string> = {
  healthy:   Colors.successMuted,
  degraded:  Colors.warningMuted,
  unhealthy: Colors.errorMuted,
  unknown:   'rgba(107,114,128,0.12)',
};

const SERVICE_LABELS: Record<string, string> = {
  brain:                'Brain',
  postgres:             'Database',
  redis:                'Cache',
  weaviate:             'Vector DB',
  'connector-microsoft': 'Microsoft',
  'connector-google':    'Google',
  voice:                'Voice',
  backup:               'Backup',
};

// ---------------------------------------------------------------------------
// ServiceCard
// ---------------------------------------------------------------------------

interface ServiceCardProps {
  item: HealthCheckResult;
}

function ServiceCard({ item }: ServiceCardProps) {
  const color = STATUS_COLOR[item.status];
  const bg    = STATUS_BG[item.status];
  const label = SERVICE_LABELS[item.service] ?? item.service;

  return (
    <View
      style={[styles.card, { backgroundColor: Colors.surfaceElevated, borderColor: Colors.surfaceBorder }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${item.status}${item.latencyMs != null ? `, ${item.latencyMs}ms` : ''}`}
    >
      {/* Header row */}
      <View style={styles.cardHeader}>
        <View style={[styles.statusDot, { backgroundColor: color }]} />
        <Text style={styles.serviceName} numberOfLines={1}>{label}</Text>
      </View>

      {/* Status badge */}
      <View style={[styles.statusBadge, { backgroundColor: bg }]}>
        <Text style={[styles.statusText, { color }]}>
          {item.status.toUpperCase()}
        </Text>
      </View>

      {/* Latency */}
      {item.latencyMs != null && (
        <Text style={styles.latency}>{item.latencyMs}ms</Text>
      )}

      {/* Message */}
      {item.message && item.status !== 'healthy' && (
        <Text style={styles.message} numberOfLines={2}>{item.message}</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Skeleton card
// ---------------------------------------------------------------------------

function SkeletonCard() {
  return (
    <View style={[styles.card, styles.skeletonCard, { borderColor: Colors.surfaceBorder }]}>
      <View style={[styles.skeletonLine, { width: '60%', height: 12, marginBottom: 8 }]} />
      <View style={[styles.skeletonLine, { width: '40%', height: 10 }]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// OverallBanner
// ---------------------------------------------------------------------------

function OverallBanner({ status }: { status: HealthStatus }) {
  const color = STATUS_COLOR[status];
  const bg    = STATUS_BG[status];
  const text  = status === 'healthy'
    ? 'All systems operational'
    : status === 'degraded'
      ? 'Some services degraded'
      : status === 'unhealthy'
        ? 'Service disruption detected'
        : 'Status unknown';

  return (
    <View style={[styles.overallBanner, { backgroundColor: bg, borderColor: color }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Overall status: ${text}`}
    >
      <View style={[styles.statusDot, styles.overallDot, { backgroundColor: color }]} />
      <Text style={[styles.overallText, { color }]}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// HealthGrid
// ---------------------------------------------------------------------------

export function HealthGrid({ health, loading = false, error }: HealthGridProps) {
  if (loading && !health) {
    return (
      <View>
        <View style={styles.grid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </View>
      </View>
    );
  }

  if (error && !health) {
    return (
      <View style={styles.errorContainer} accessible accessibilityRole="alert">
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!health) {
    return (
      <View style={styles.emptyContainer}>
        <ActivityIndicator color={Colors.accent} />
      </View>
    );
  }

  return (
    <View>
      <OverallBanner status={health.overall} />
      <View style={styles.grid}>
        {health.services.map((svc) => (
          <ServiceCard key={svc.service} item={svc} />
        ))}
      </View>
      <Text style={styles.checkedAt}>
        Last checked: {new Date(health.checkedAt).toLocaleTimeString()}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  overallBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: 1,
    marginBottom: Spacing.base,
  },
  overallDot: {
    marginRight: Spacing.sm,
  },
  overallText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  card: {
    width: '47.5%',
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    minHeight: 88,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  serviceName: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Colors.textPrimary,
    flex: 1,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    marginBottom: 4,
  },
  statusText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  latency: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  message: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 4,
    lineHeight: 16,
  },
  skeletonCard: {
    backgroundColor: Colors.surfaceElevated,
    justifyContent: 'center',
  },
  skeletonLine: {
    backgroundColor: Colors.surfaceBorder,
    borderRadius: 4,
  },
  errorContainer: {
    padding: Spacing.base,
    alignItems: 'center',
  },
  errorText: {
    color: Colors.error,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  emptyContainer: {
    padding: Spacing['3xl'],
    alignItems: 'center',
  },
  checkedAt: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    textAlign: 'right',
    marginTop: Spacing.sm,
  },
});
