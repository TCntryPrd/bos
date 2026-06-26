/**
 * ActivityFeed — Scrollable, real-time event list.
 *
 * Renders a flat list of ActivityEvent items with:
 * - Event type icon and color coding
 * - Title, description, timestamp
 * - Severity badge for incidents
 * - Pull-to-refresh support
 * - Empty and loading states
 *
 * Usage:
 *   <ActivityFeed
 *     events={activityEvents}
 *     loading={false}
 *     onRefresh={handleRefresh}
 *     onEndReached={handleLoadMore}
 *   />
 */

import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { Colors, Radius, Spacing, FontSize } from '@/constants/theme';
import type { ActivityEvent } from '@/services/api';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ActivityFeedProps {
  events: ActivityEvent[];
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onEndReached?: () => void;
  ListHeaderComponent?: React.ReactElement;
}

// ---------------------------------------------------------------------------
// Type metadata
// ---------------------------------------------------------------------------

type EventTypeMeta = {
  icon: string;
  color: string;
  bg: string;
  label: string;
};

const TYPE_META: Record<ActivityEvent['type'], EventTypeMeta> = {
  voice_command: {
    icon: '🎤',
    color: Colors.voiceActive,
    bg: 'rgba(168,85,247,0.12)',
    label: 'Voice',
  },
  incident: {
    icon: '⚠',
    color: Colors.warning,
    bg: Colors.warningMuted,
    label: 'Incident',
  },
  healing: {
    icon: '⚡',
    color: Colors.success,
    bg: Colors.successMuted,
    label: 'Healing',
  },
  connector: {
    icon: '⇄',
    color: Colors.info,
    bg: Colors.infoMuted,
    label: 'Connector',
  },
  backup: {
    icon: '⬆',
    color: Colors.accentLight,
    bg: Colors.accentMuted,
    label: 'Backup',
  },
  system: {
    icon: '⚙',
    color: Colors.textSecondary,
    bg: 'rgba(136,136,168,0.12)',
    label: 'System',
  },
};

const SEVERITY_COLOR: Record<NonNullable<ActivityEvent['severity']>, string> = {
  info:     Colors.info,
  warning:  Colors.warning,
  error:    Colors.error,
  critical: Colors.error,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now  = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// EventItem
// ---------------------------------------------------------------------------

interface EventItemProps {
  event: ActivityEvent;
}

function EventItem({ event }: EventItemProps) {
  const meta = TYPE_META[event.type];

  return (
    <View
      style={[styles.item, { borderColor: Colors.surfaceBorder }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${meta.label}: ${event.title}. ${event.description ?? ''}. ${formatTime(event.createdAt)}`}
    >
      {/* Left: icon */}
      <View style={[styles.iconWrap, { backgroundColor: meta.bg }]}>
        <Text style={[styles.icon, { color: meta.color }]}>{meta.icon}</Text>
      </View>

      {/* Center: content */}
      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>{event.title}</Text>
          {event.severity && event.severity !== 'info' && (
            <View style={[styles.severityBadge, { backgroundColor: `${SEVERITY_COLOR[event.severity]}20` }]}>
              <Text style={[styles.severityText, { color: SEVERITY_COLOR[event.severity] }]}>
                {event.severity.toUpperCase()}
              </Text>
            </View>
          )}
        </View>

        {event.description && (
          <Text style={styles.description} numberOfLines={2}>{event.description}</Text>
        )}

        <View style={styles.metaRow}>
          {event.service && (
            <Text style={styles.serviceTag}>{event.service}</Text>
          )}
          <Text style={styles.timestamp}>{formatTime(event.createdAt)}</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

function Separator() {
  return <View style={styles.separator} />;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ loading }: { loading: boolean }) {
  if (loading) {
    return (
      <View style={styles.emptyContainer}>
        <ActivityIndicator color={Colors.accent} />
      </View>
    );
  }
  return (
    <View style={styles.emptyContainer} accessible accessibilityRole="text" accessibilityLabel="No activity yet">
      <Text style={styles.emptyIcon}>📋</Text>
      <Text style={styles.emptyText}>No activity yet</Text>
      <Text style={styles.emptySubtext}>Events will appear here as BOS works</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Footer loader
// ---------------------------------------------------------------------------

function FooterLoader() {
  return (
    <View style={styles.footer}>
      <ActivityIndicator size="small" color={Colors.accent} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------

export function ActivityFeed({
  events,
  loading = false,
  refreshing = false,
  error,
  onRefresh,
  onEndReached,
  ListHeaderComponent,
}: ActivityFeedProps) {
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ActivityEvent>) => <EventItem event={item} />,
    []
  );

  const keyExtractor = useCallback((item: ActivityEvent) => item.id, []);

  if (error && events.length === 0) {
    return (
      <View style={styles.errorContainer} accessible accessibilityRole="alert">
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={events}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={<EmptyState loading={loading && events.length === 0} />}
      ListFooterComponent={loading && events.length > 0 ? <FooterLoader /> : null}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.3}
      refreshControl={
        onRefresh
          ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.accent}
              colors={[Colors.accent]}
            />
          )
          : undefined
      }
      contentContainerStyle={events.length === 0 ? styles.emptyList : undefined}
      showsVerticalScrollIndicator={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
    marginTop: 2,
  },
  icon: {
    fontSize: 16,
  },
  content: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  title: {
    fontSize: FontSize.base,
    fontWeight: '600',
    color: Colors.textPrimary,
    flex: 1,
  },
  severityBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  severityText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  description: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 18,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  serviceTag: {
    fontSize: FontSize.xs,
    color: Colors.accent,
    backgroundColor: Colors.accentMuted,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  timestamp: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.surfaceBorder,
  },
  emptyContainer: {
    padding: Spacing['4xl'],
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyList: {
    flexGrow: 1,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: Spacing.base,
  },
  emptyText: {
    fontSize: FontSize.lg,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  emptySubtext: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  footer: {
    padding: Spacing.xl,
    alignItems: 'center',
  },
  errorContainer: {
    padding: Spacing.xl,
    alignItems: 'center',
  },
  errorText: {
    color: Colors.error,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
});
