/**
 * Activity screen — recent events, notifications, incident log.
 *
 * Polls /activity every ACTIVITY_POLL_INTERVAL_MS.
 * Supports pull-to-refresh and infinite scroll (pagination).
 * Type filter tabs above the feed.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { ACTIVITY_POLL_INTERVAL_MS } from '@/constants/config';
import { apiClient } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { ActivityFeed } from '@/components/ActivityFeed';
import type { ActivityEvent } from '@/services/api';

// ---------------------------------------------------------------------------
// Filter tab definitions
// ---------------------------------------------------------------------------

type FilterType = 'all' | ActivityEvent['type'];

interface FilterTab {
  id: FilterType;
  label: string;
  icon: string;
}

const FILTER_TABS: FilterTab[] = [
  { id: 'all',          label: 'All',       icon: '⊞' },
  { id: 'incident',     label: 'Incidents', icon: '⚠' },
  { id: 'voice_command',label: 'Voice',     icon: '🎤' },
  { id: 'healing',      label: 'Healing',   icon: '⚡' },
  { id: 'connector',    label: 'Connectors',icon: '⇄' },
];

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ActivityScreen() {
  const activity        = useAppStore((s) => s.activity);
  const activityLoading = useAppStore((s) => s.activityLoading);
  const activityError   = useAppStore((s) => s.activityError);
  const activityTotal   = useAppStore((s) => s.activityTotal);
  const setActivity     = useAppStore((s) => s.setActivity);
  const setActivityLoading = useAppStore((s) => s.setActivityLoading);
  const setActivityError   = useAppStore((s) => s.setActivityError);

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  const fetchActivity = useCallback(async (p: number, replace: boolean) => {
    try {
      setActivityError(null);
      const params: Record<string, unknown> = { page: p, pageSize: PAGE_SIZE };
      if (activeFilter !== 'all') params.type = activeFilter;

      const data = await apiClient.activity.list(
        params as Parameters<typeof apiClient.activity.list>[0]
      );

      if (replace) {
        setActivity(data.events, data.total);
      } else {
        // Use store snapshot at call time — avoids stale closure on load-more
        const current = useAppStore.getState().activity;
        setActivity([...current, ...data.events], data.total);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActivityError(`Failed to load activity: ${msg}`);
    }
  }, [activeFilter, setActivity, setActivityError]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setPage(1);
    await fetchActivity(1, true);
    setRefreshing(false);
  }, [fetchActivity]);

  const handleLoadMore = useCallback(() => {
    const loaded = activity.length;
    if (activityLoading || loaded >= activityTotal) return;
    const nextPage = page + 1;
    setPage(nextPage);
    setActivityLoading(true);
    fetchActivity(nextPage, false).finally(() => setActivityLoading(false));
  }, [activity.length, activityLoading, activityTotal, fetchActivity, page, setActivityLoading]);

  // Initial fetch + polling
  useEffect(() => {
    setActivityLoading(true);
    fetchActivity(1, true).finally(() => setActivityLoading(false));
    pollRef.current = setInterval(() => { void fetchActivity(1, true); }, ACTIVITY_POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Filter change
  // -------------------------------------------------------------------------

  const handleFilterChange = useCallback((filter: FilterType) => {
    setActiveFilter(filter);
    setPage(1);
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const header = (
    <View>
      {/* Screen header */}
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Activity</Text>
        <Text style={styles.eventCount}>
          {activityTotal > 0 ? `${activityTotal} events` : ''}
        </Text>
      </View>

      {/* Filter tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterScroll}
        style={styles.filterBar}
      >
        {FILTER_TABS.map((tab) => {
          const isActive = activeFilter === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => handleFilterChange(tab.id)}
              accessible
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: isActive }}
              style={[
                styles.filterTab,
                isActive && styles.filterTabActive,
              ]}
            >
              <Text style={styles.filterIcon}>{tab.icon}</Text>
              <Text style={[styles.filterLabel, isActive && styles.filterLabelActive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ActivityFeed
        events={activity}
        loading={activityLoading}
        refreshing={refreshing}
        error={activityError}
        onRefresh={handleRefresh}
        onEndReached={handleLoadMore}
        ListHeaderComponent={header}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  screenHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.base,
    paddingBottom: Spacing.md,
  },
  screenTitle: {
    fontSize: FontSize['2xl'],
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  eventCount: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  filterBar: {
    marginBottom: Spacing.sm,
  },
  filterScroll: {
    paddingHorizontal: Spacing.base,
    gap: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  filterTabActive: {
    backgroundColor: Colors.accentMuted,
    borderColor: Colors.accent,
  },
  filterIcon: {
    fontSize: 13,
  },
  filterLabel: {
    fontSize: FontSize.sm,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  filterLabelActive: {
    color: Colors.accentLight,
    fontWeight: '600',
  },
});
