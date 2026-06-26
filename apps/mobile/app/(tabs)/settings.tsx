/**
 * Settings screen — server URL, notifications toggle, TTS voice picker.
 *
 * All settings are persisted in SecureStore and synced to the Zustand store.
 * Server URL change triggers apiClient.setBaseUrl() and voice reconnect.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';

import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { DEFAULT_API_URL, STORAGE_KEYS, TTS_VOICES, type TtsVoiceId } from '@/constants/config';
import { apiClient } from '@/services/api';
import { voiceClient } from '@/services/voice';
import { notificationService } from '@/services/notifications';
import { useAppStore } from '@/store/useAppStore';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function Divider() {
  return <View style={styles.divider} />;
}

interface SettingRowProps {
  label: string;
  sublabel?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}

function SettingRow({ label, sublabel, right, onPress, accessibilityLabel }: SettingRowProps) {
  const content = (
    <View style={styles.settingRow} accessible accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={accessibilityLabel ?? label}>
      <View style={styles.settingRowLeft}>
        <Text style={styles.settingLabel}>{label}</Text>
        {sublabel && <Text style={styles.settingSubLabel}>{sublabel}</Text>}
      </View>
      {right && <View style={styles.settingRowRight}>{right}</View>}
    </View>
  );

  if (onPress) {
    return <Pressable onPress={onPress}>{content}</Pressable>;
  }
  return content;
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const settings       = useAppStore((s) => s.settings);
  const voiceState     = useAppStore((s) => s.voiceState);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [serverUrl, setServerUrl]   = useState(settings.apiUrl);
  const [urlEditing, setUrlEditing] = useState(false);
  const [urlSaving, setUrlSaving]   = useState(false);

  // Sync local URL field with store
  useEffect(() => {
    setServerUrl(settings.apiUrl);
  }, [settings.apiUrl]);

  // -------------------------------------------------------------------------
  // Server URL
  // -------------------------------------------------------------------------

  const handleSaveUrl = useCallback(async () => {
    const cleaned = serverUrl.trim().replace(/\/$/, '');
    if (!cleaned) return;

    setUrlSaving(true);
    try {
      // Validate by pinging
      apiClient.setBaseUrl(cleaned);
      await apiClient.health.ping();

      await SecureStore.setItemAsync(STORAGE_KEYS.API_URL, cleaned);
      updateSettings({ apiUrl: cleaned });
      setUrlEditing(false);

      // Reconnect voice with new URL
      voiceClient.disconnect();
      setTimeout(() => voiceClient.connect().catch(console.error), 500);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      Alert.alert('Connection Failed', `Could not reach server at:\n${cleaned}\n\nCheck the URL and try again.`);
      // Revert
      apiClient.setBaseUrl(settings.apiUrl);
    } finally {
      setUrlSaving(false);
    }
  }, [serverUrl, settings.apiUrl, updateSettings]);

  const handleCancelUrl = useCallback(() => {
    setServerUrl(settings.apiUrl);
    setUrlEditing(false);
  }, [settings.apiUrl]);

  const handleResetUrl = useCallback(async () => {
    setServerUrl(DEFAULT_API_URL);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.API_URL);
    apiClient.setBaseUrl(DEFAULT_API_URL);
    updateSettings({ apiUrl: DEFAULT_API_URL });
    voiceClient.disconnect();
    setTimeout(() => voiceClient.connect().catch(console.error), 500);
  }, [updateSettings]);

  // -------------------------------------------------------------------------
  // Notifications toggle
  // -------------------------------------------------------------------------

  const handleNotificationsToggle = useCallback(async (value: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    updateSettings({ pushEnabled: value });
    await notificationService.setEnabled(value);
  }, [updateSettings]);

  // -------------------------------------------------------------------------
  // TTS voice
  // -------------------------------------------------------------------------

  const handleVoiceSelect = useCallback(async (voiceId: TtsVoiceId) => {
    Haptics.selectionAsync().catch(() => {});
    updateSettings({ ttsVoiceId: voiceId });
    await SecureStore.setItemAsync(STORAGE_KEYS.TTS_VOICE, voiceId);
  }, [updateSettings]);

  // -------------------------------------------------------------------------
  // Always-listen
  // -------------------------------------------------------------------------

  const handleAlwaysListenToggle = useCallback(async (value: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    updateSettings({ alwaysListen: value });
    voiceClient.setAlwaysListen(value);
    await SecureStore.setItemAsync(STORAGE_KEYS.ALWAYS_LISTEN, value ? 'true' : 'false');
  }, [updateSettings]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const connectionStatusColor =
    voiceState === 'connected' || voiceState === 'recording' || voiceState === 'processing'
      ? Colors.healthy
      : voiceState === 'connecting'
        ? Colors.warning
        : Colors.unhealthy;

  const connectionStatusLabel =
    voiceState === 'disconnected' ? 'Disconnected'
    : voiceState === 'connecting' ? 'Connecting…'
    : voiceState === 'error'      ? 'Connection error'
    : 'Connected';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Title */}
          <Text style={styles.screenTitle}>Settings</Text>

          {/* ---------------------------------------------------------------- */}
          {/* Connection */}
          {/* ---------------------------------------------------------------- */}
          <SectionHeader title="Connection" />
          <View style={styles.card}>
            {/* Status row */}
            <SettingRow
              label="Voice Service"
              sublabel={connectionStatusLabel}
              right={
                <View style={[styles.statusDot, { backgroundColor: connectionStatusColor }]} />
              }
            />
            <Divider />

            {/* Server URL */}
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Server URL</Text>
                {urlEditing ? (
                  <TextInput
                    style={styles.urlInput}
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="done"
                    onSubmitEditing={handleSaveUrl}
                    placeholder={DEFAULT_API_URL}
                    placeholderTextColor={Colors.textMuted}
                    accessible
                    accessibilityLabel="Server URL input"
                  />
                ) : (
                  <Text style={styles.settingSubLabel} numberOfLines={1}>{serverUrl}</Text>
                )}
              </View>
              <View style={styles.settingRowRight}>
                {urlEditing ? (
                  <View style={styles.urlButtons}>
                    <Pressable
                      onPress={handleCancelUrl}
                      style={styles.urlBtn}
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel="Cancel URL edit"
                    >
                      <Text style={styles.urlBtnCancel}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={handleSaveUrl}
                      disabled={urlSaving}
                      style={[styles.urlBtn, styles.urlBtnSave]}
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel="Save server URL"
                    >
                      <Text style={styles.urlBtnSaveText}>
                        {urlSaving ? 'Saving…' : 'Save'}
                      </Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    onPress={() => setUrlEditing(true)}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel="Edit server URL"
                  >
                    <Text style={styles.editBtn}>Edit</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {!urlEditing && settings.apiUrl !== DEFAULT_API_URL && (
              <>
                <Divider />
                <SettingRow
                  label="Reset to Default"
                  sublabel={DEFAULT_API_URL}
                  onPress={handleResetUrl}
                  accessibilityLabel="Reset server URL to default"
                  right={<Text style={styles.resetText}>Reset</Text>}
                />
              </>
            )}
          </View>

          {/* ---------------------------------------------------------------- */}
          {/* Voice */}
          {/* ---------------------------------------------------------------- */}
          <SectionHeader title="Voice" />
          <View style={styles.card}>
            <SettingRow
              label="Always Listen"
              sublabel="Continuous microphone for wake-word detection"
              right={
                <Switch
                  value={settings.alwaysListen}
                  onValueChange={handleAlwaysListenToggle}
                  trackColor={{ false: Colors.surfaceBorder, true: Colors.accent }}
                  thumbColor={Colors.textPrimary}
                  ios_backgroundColor={Colors.surfaceBorder}
                />
              }
              accessibilityLabel={`Always listen: ${settings.alwaysListen ? 'on' : 'off'}`}
            />
            <Divider />
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>TTS Voice</Text>
            </View>
            {TTS_VOICES.map((voice, index) => (
              <React.Fragment key={voice.id}>
                {index > 0 && <Divider />}
                <Pressable
                  onPress={() => handleVoiceSelect(voice.id)}
                  style={styles.settingRow}
                  accessible
                  accessibilityRole="radio"
                  accessibilityState={{ checked: settings.ttsVoiceId === voice.id }}
                  accessibilityLabel={voice.label}
                >
                  <View style={styles.settingRowLeft}>
                    <Text style={[
                      styles.settingLabel,
                      settings.ttsVoiceId === voice.id && { color: Colors.accentLight },
                    ]}>
                      {voice.label}
                    </Text>
                    <Text style={styles.settingSubLabel}>{voice.provider}</Text>
                  </View>
                  {settings.ttsVoiceId === voice.id && (
                    <Text style={styles.checkmark}>✓</Text>
                  )}
                </Pressable>
              </React.Fragment>
            ))}
          </View>

          {/* ---------------------------------------------------------------- */}
          {/* Notifications */}
          {/* ---------------------------------------------------------------- */}
          <SectionHeader title="Notifications" />
          <View style={styles.card}>
            <SettingRow
              label="Push Notifications"
              sublabel="Incidents, healing events, and system alerts"
              right={
                <Switch
                  value={settings.pushEnabled}
                  onValueChange={handleNotificationsToggle}
                  trackColor={{ false: Colors.surfaceBorder, true: Colors.accent }}
                  thumbColor={Colors.textPrimary}
                  ios_backgroundColor={Colors.surfaceBorder}
                />
              }
              accessibilityLabel={`Push notifications: ${settings.pushEnabled ? 'on' : 'off'}`}
            />
          </View>

          {/* ---------------------------------------------------------------- */}
          {/* About */}
          {/* ---------------------------------------------------------------- */}
          <SectionHeader title="About" />
          <View style={styles.card}>
            <SettingRow label="Version"       right={<Text style={styles.metaText}>2.0.0</Text>} />
            <Divider />
            <SettingRow label="Build"         right={<Text style={styles.metaText}>BOS v2</Text>} />
            <Divider />
            <SettingRow label="Organization"  right={<Text style={styles.metaText}>Starr &amp; Partners</Text>} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
  flex: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.base,
    paddingBottom: Spacing['4xl'],
  },
  screenTitle: {
    fontSize: FontSize['2xl'],
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: Spacing.xl,
    paddingTop: Spacing.sm,
  },
  sectionHeader: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: Spacing.xl,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.xs,
  },
  card: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    minHeight: 52,
  },
  settingRowLeft: {
    flex: 1,
    marginRight: Spacing.md,
  },
  settingRowRight: {
    alignItems: 'flex-end',
  },
  settingLabel: {
    fontSize: FontSize.base,
    fontWeight: '500',
    color: Colors.textPrimary,
  },
  settingSubLabel: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.surfaceBorder,
    marginHorizontal: Spacing.base,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  urlInput: {
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    marginTop: 4,
    borderWidth: 1,
    borderColor: Colors.accent + '60',
  },
  urlButtons: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  urlBtn: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: Radius.sm,
  },
  urlBtnCancel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  urlBtnSave: {
    backgroundColor: Colors.accent,
    paddingHorizontal: Spacing.md,
  },
  urlBtnSaveText: {
    fontSize: FontSize.sm,
    color: Colors.textInverse,
    fontWeight: '600',
  },
  editBtn: {
    fontSize: FontSize.sm,
    color: Colors.accentLight,
    fontWeight: '600',
  },
  resetText: {
    fontSize: FontSize.sm,
    color: Colors.error,
    fontWeight: '500',
  },
  checkmark: {
    fontSize: FontSize.lg,
    color: Colors.accent,
    fontWeight: '700',
  },
  metaText: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
});
