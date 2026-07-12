/**
 * Voice screen — large mic button, push-to-talk or always-listen toggle.
 *
 * - Tap mic:             starts recording (push-to-talk)
 * - Release / tap again: stops recording, sends to server
 * - Always-listen toggle: continuous recording with wake-word handled server-side
 * - Transcript strip:    shows partial + final transcript in real time
 * - Response area:       shows AI text response
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';

import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { STORAGE_KEYS } from '@/constants/config';
import { voiceClient } from '@/services/voice';
import { useAppStore } from '@/store/useAppStore';
import { VoiceButton } from '@/components/VoiceButton';
import type { VoiceTranscriptEvent, VoiceResponseEvent } from '@/services/voice';

// ---------------------------------------------------------------------------
// Transcript line
// ---------------------------------------------------------------------------

interface TranscriptLineProps {
  text: string;
  isPartial?: boolean;
  isUser?: boolean;
}

function TranscriptLine({ text, isPartial = false, isUser = true }: TranscriptLineProps) {
  return (
    <View
      style={[
        styles.transcriptLine,
        isUser ? styles.transcriptUser : styles.transcriptAgent,
      ]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${isUser ? 'You' : 'BOS'}: ${text}`}
    >
      <Text style={styles.transcriptSpeaker}>{isUser ? 'You' : 'BOS'}</Text>
      <Text style={[styles.transcriptText, isPartial && styles.transcriptPartial]}>
        {text}
        {isPartial && <Text style={styles.cursor}> ▌</Text>}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Voice screen
// ---------------------------------------------------------------------------

export default function VoiceScreen() {
  const voiceState     = useAppStore((s) => s.voiceState);
  const lastTranscript = useAppStore((s) => s.lastTranscript);
  const lastResponse   = useAppStore((s) => s.lastResponse);
  const alwaysListen   = useAppStore((s) => s.settings.alwaysListen);
  const setVoiceState  = useAppStore((s) => s.setVoiceState);
  const setTranscript  = useAppStore((s) => s.setLastTranscript);
  const setResponse    = useAppStore((s) => s.setLastResponse);
  const updateSettings = useAppStore((s) => s.updateSettings);

  // Conversation history (local to this screen session)
  const [history, setHistory] = React.useState<
    Array<{ id: string; text: string; isUser: boolean; isPartial?: boolean }>
  >([]);

  const partialIdRef  = useRef<string>(`p_${Date.now()}`);
  const scrollRef     = useRef<ScrollView>(null);
  const fadeAnim      = useRef(new Animated.Value(0)).current;

  // -------------------------------------------------------------------------
  // Wire up voice client listeners
  // -------------------------------------------------------------------------

  useEffect(() => {
    const unsubState = voiceClient.on('state', (state) => {
      setVoiceState(state);
    });

    const unsubTranscript = voiceClient.on('transcript', (event: VoiceTranscriptEvent) => {
      setTranscript(event.text);
      if (event.partial) {
        setHistory((h) => {
          const existing = h.find((l) => l.id === partialIdRef.current);
          if (existing) {
            return h.map((l) =>
              l.id === partialIdRef.current ? { ...l, text: event.text } : l
            );
          }
          return [...h, { id: partialIdRef.current, text: event.text, isUser: true, isPartial: true }];
        });
      } else {
        setHistory((h) =>
          h.map((l) =>
            l.id === partialIdRef.current
              ? { ...l, text: event.text, isPartial: false }
              : l
          )
        );
        partialIdRef.current = `p_${Date.now()}`;
      }
    });

    const unsubResponse = voiceClient.on('response', (event: VoiceResponseEvent) => {
      setResponse(event.text);
      setHistory((h) => [
        ...h,
        { id: `r_${Date.now()}`, text: event.text, isUser: false },
      ]);

      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
    });

    const unsubError = voiceClient.on('error', (err) => {
      console.warn('[voice screen] Error:', err.message);
    });

    // Ensure client is connected
    if (voiceState === 'disconnected') {
      voiceClient.connect().catch(console.error);
    }

    return () => {
      unsubState();
      unsubTranscript();
      unsubResponse();
      unsubError();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom when history changes
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [history]);

  // -------------------------------------------------------------------------
  // Push-to-talk handlers
  // -------------------------------------------------------------------------

  const handleMicPress = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    if (voiceState === 'recording') {
      voiceClient.stopRecording().catch(console.error);
    } else if (voiceState === 'connected') {
      voiceClient.startRecording().catch(console.error);
    }
  }, [voiceState]);

  // -------------------------------------------------------------------------
  // Always-listen toggle
  // -------------------------------------------------------------------------

  const handleAlwaysListenToggle = useCallback((value: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    updateSettings({ alwaysListen: value });
    voiceClient.setAlwaysListen(value);
    SecureStore.setItemAsync(STORAGE_KEYS.ALWAYS_LISTEN, value ? 'true' : 'false').catch(console.error);
  }, [updateSettings]);

  // -------------------------------------------------------------------------
  // Clear history
  // -------------------------------------------------------------------------

  const handleClear = useCallback(() => {
    setHistory([]);
    setTranscript('');
    setResponse('');
  }, [setTranscript, setResponse]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Voice</Text>
          {history.length > 0 && (
            <Pressable
              onPress={handleClear}
              accessible
              accessibilityRole="button"
              accessibilityLabel="Clear conversation"
              style={styles.clearBtn}
            >
              <Text style={styles.clearBtnText}>Clear</Text>
            </Pressable>
          )}
        </View>

        {/* Always-listen toggle */}
        <View style={styles.toggleRow} accessible accessibilityRole="switch" accessibilityLabel={`Always listen: ${alwaysListen ? 'on' : 'off'}`}>
          <View>
            <Text style={styles.toggleLabel}>Always Listen</Text>
            <Text style={styles.toggleSubtext}>Continuous voice detection</Text>
          </View>
          <Switch
            value={alwaysListen}
            onValueChange={handleAlwaysListenToggle}
            trackColor={{ false: Colors.surfaceBorder, true: Colors.accent }}
            thumbColor={Colors.textPrimary}
            ios_backgroundColor={Colors.surfaceBorder}
          />
        </View>

        {/* Conversation history */}
        <ScrollView
          ref={scrollRef}
          style={styles.history}
          contentContainerStyle={styles.historyContent}
          showsVerticalScrollIndicator={false}
        >
          {history.length === 0 ? (
            <View style={styles.emptyHistory}>
              <Text style={styles.emptyHistoryText}>
                {voiceState === 'disconnected' || voiceState === 'connecting'
                  ? 'Connecting to voice service…'
                  : alwaysListen
                    ? 'Listening — speak to BOS'
                    : 'Tap the mic to speak'}
              </Text>
            </View>
          ) : (
            history.map((line) => (
              <TranscriptLine
                key={line.id}
                text={line.text}
                isPartial={line.isPartial}
                isUser={line.isUser}
              />
            ))
          )}
        </ScrollView>

        {/* Mic button */}
        <View style={styles.micArea}>
          {lastTranscript.length > 0 && voiceState === 'recording' && (
            <Text style={styles.liveTranscript} numberOfLines={2}>{lastTranscript}</Text>
          )}
          <VoiceButton
            state={voiceState}
            onPress={handleMicPress}
            size={100}
            accessibilityLabel={
              voiceState === 'recording' ? 'Stop recording' : 'Start recording'
            }
          />
        </View>
      </View>
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
  container: {
    flex: 1,
    paddingHorizontal: Spacing.base,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Spacing.base,
    paddingBottom: Spacing.md,
  },
  headerTitle: {
    fontSize: FontSize['2xl'],
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  clearBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surfaceBorder,
  },
  clearBtnText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    padding: Spacing.base,
    marginBottom: Spacing.base,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  toggleLabel: {
    fontSize: FontSize.base,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  toggleSubtext: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  history: {
    flex: 1,
  },
  historyContent: {
    paddingVertical: Spacing.sm,
    gap: Spacing.md,
    flexGrow: 1,
  },
  emptyHistory: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing['4xl'],
  },
  emptyHistoryText: {
    fontSize: FontSize.base,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  transcriptLine: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.lg,
    maxWidth: '85%',
  },
  transcriptUser: {
    alignSelf: 'flex-end',
    backgroundColor: Colors.accentMuted,
    borderWidth: 1,
    borderColor: Colors.accent + '30',
  },
  transcriptAgent: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  transcriptSpeaker: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.textMuted,
    marginBottom: 3,
    letterSpacing: 0.5,
  },
  transcriptText: {
    fontSize: FontSize.base,
    color: Colors.textPrimary,
    lineHeight: 22,
  },
  transcriptPartial: {
    color: Colors.textSecondary,
  },
  cursor: {
    color: Colors.accent,
  },
  micArea: {
    alignItems: 'center',
    paddingVertical: Spacing['3xl'],
    gap: Spacing.base,
  },
  liveTranscript: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    fontStyle: 'italic',
    maxWidth: 280,
  },
});
