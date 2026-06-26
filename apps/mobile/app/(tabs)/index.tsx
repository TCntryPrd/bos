/**
 * Dashboard — health overview + quick actions.
 *
 * Polls /health/full every HEALTH_POLL_INTERVAL_MS.
 * Displays HealthGrid, a quick-action strip, and the latest activity preview.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { HEALTH_POLL_INTERVAL_MS } from '@/constants/config';
import { apiClient } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { HealthGrid } from '@/components/HealthGrid';

// ---------------------------------------------------------------------------
// Quick action definitions
// ---------------------------------------------------------------------------

interface QuickAction {
  id: string;
  label: string;
  icon: string;
  color: string;
  route?: '/(tabs)/voice' | '/(tabs)/activity' | '/(tabs)/settings';
  onPress?: () => void;
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }) {
  return (
    <Text style={styles.sectionHeader}>{title}</Text>
  );
}

// ---------------------------------------------------------------------------
// Quick action button
// ---------------------------------------------------------------------------

function QuickActionButton({ action }: { action: QuickAction }) {
  const router = useRouter();

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (action.route) {
      router.push(action.route);
    } else {
      action.onPress?.();
    }
  };

  return (
    <Pressable
      onPress={handlePress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={({ pressed }) => [
        styles.quickAction,
        { borderColor: action.color + '40', opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <View style={[styles.quickActionIcon, { backgroundColor: action.color + '20' }]}>
        <Text style={[styles.quickActionGlyph, { color: action.color }]}>{action.icon}</Text>
      </View>
      <Text style={styles.quickActionLabel} numberOfLines={1}>{action.label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Dashboard screen
// ---------------------------------------------------------------------------

export default function DashboardScreen() {
  const health        = useAppStore((s) => s.health);
  const healthLoading = useAppStore((s) => s.healthLoading);
  const healthError   = useAppStore((s) => s.healthError);
  const activity      = useAppStore((s) => s.activity);
  const voiceState    = useAppStore((s) => s.voiceState);
  const lastResponse  = useAppStore((s) => s.lastResponse);
  const setHealth     = useAppStore((s) => s.setHealth);
  const setHealthLoading = useAppStore((s) => s.setHealthLoading);
  const setHealthError   = useAppStore((s) => s.setHealthError);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      setHealthError(null);
      const data = await apiClient.health.getFull();
      setHealth(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setHealthError(`Could not reach server: ${msg}`);
    }
  }, [setHealth, setHealthError]);

  const handleRefresh = useCallback(async () => {
    setHealthLoading(true);
    await fetchHealth();
    setHealthLoading(false);
  }, [fetchHealth, setHealthLoading]);

  // Initial fetch + polling
  useEffect(() => {
    void handleRefresh();
    pollRef.current = setInterval(() => { void fetchHealth(); }, HEALTH_POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchHealth, handleRefresh]);

  const quickActions: QuickAction[] = [
    { id: 'voice',    label: 'Voice',    icon: '🎤', color: Colors.voiceActive,  route: '/(tabs)/voice' },
    { id: 'activity', label: 'Activity', icon: '⏱',  color: Colors.accent,       route: '/(tabs)/activity' },
    { id: 'refresh',  label: 'Refresh',  icon: '↻',  color: Colors.info,         onPress: () => void handleRefresh() },
    { id: 'settings', label: 'Settings', icon: '⚙',  color: Colors.textSecondary, route: '/(tabs)/settings' },
  ];

  const recentActivity = activity.slice(0, 3);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={healthLoading}
            onRefresh={handleRefresh}
            tintColor={Colors.accent}
            colors={[Colors.accent]}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>BOS</Text>
            <Text style={styles.headerSubtitle}>
              {voiceState === 'connected' || voiceState === 'recording' || voiceState === 'processing'
                ? 'Voice ready'
                : 'Voice offline'}
            </Text>
          </View>
          <View style={[
            styles.voiceIndicator,
            { backgroundColor: voiceState === 'recording' ? Colors.voiceActiveGlow : Colors.surfaceBorder },
          ]}>
            <Text style={styles.voiceIndicatorText}>
              {voiceState === 'recording' ? '⏺' : voiceState === 'processing' ? '⌛' : '🎤'}
            </Text>
          </View>
        </View>

        {/* Last AI response bubble */}
        {lastResponse.length > 0 && (
          <View style={styles.responseBubble} accessible accessibilityRole="text" accessibilityLabel={`BOS said: ${lastResponse}`}>
            <Text style={styles.responseBubbleLabel}>BOS</Text>
            <Text style={styles.responseBubbleText} numberOfLines={3}>{lastResponse}</Text>
          </View>
        )}

        {/* Quick actions */}
        <SectionHeader title="Quick Actions" />
        <View style={styles.quickActionsRow}>
          {quickActions.map((action) => (
            <QuickActionButton key={action.id} action={action} />
          ))}
        </View>

        {/* Health overview */}
        <SectionHeader title="System Health" />
        <HealthGrid health={health} loading={healthLoading} error={healthError} />

        {/* Recent activity preview */}
        {recentActivity.length > 0 && (
          <>
            <SectionHeader title="Recent Activity" />
            {recentActivity.map((event) => (
              <View
                key={event.id}
                style={styles.recentItem}
                accessible
                accessibilityRole="text"
                accessibilityLabel={`${event.type}: ${event.title}`}
              >
                <Text style={styles.recentTitle} numberOfLines={1}>{event.title}</Text>
                <Text style={styles.recentTime}>
                  {new Date(event.createdAt).toLocaleTimeString()}
                </Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.base,
    paddingBottom: Spacing['4xl'],
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xl,
    paddingTop: Spacing.sm,
  },
  headerTitle: {
    fontSize: FontSize['2xl'],
    fontWeight: '700',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  voiceIndicator: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceIndicatorText: {
    fontSize: 18,
  },
  responseBubble: {
    backgroundColor: Colors.accentMuted,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.accent + '30',
    padding: Spacing.md,
    marginBottom: Spacing.xl,
  },
  responseBubbleLabel: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.accentLight,
    marginBottom: 4,
    letterSpacing: 0.8,
  },
  responseBubbleText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    lineHeight: 22,
  },
  sectionHeader: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: Spacing.sm,
    marginTop: Spacing.xl,
  },
  quickActionsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  quickAction: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    gap: 6,
  },
  quickActionIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickActionGlyph: {
    fontSize: 18,
  },
  quickActionLabel: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  recentItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  recentTitle: {
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    flex: 1,
    marginRight: Spacing.sm,
  },
  recentTime: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
});
