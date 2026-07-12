/**
 * VoiceButton — Animated push-to-talk mic button with live recording state.
 *
 * Variants:
 *   - idle:       solid indigo ring, mic icon
 *   - recording:  pulsing purple glow, animated ring, waveform icon
 *   - processing: spinning ring, brain icon
 *   - error:      red ring, shake animation
 *
 * Usage:
 *   <VoiceButton
 *     state="idle"
 *     onPressIn={handlePressIn}
 *     onPressOut={handlePressOut}
 *     onPress={handleToggle}
 *     size={120}
 *   />
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Colors, Radius } from '@/constants/theme';
import type { VoiceConnectionState } from '@/services/voice';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VoiceButtonProps {
  state: VoiceConnectionState;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  size?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
}

// ---------------------------------------------------------------------------
// Icons (text-based glyphs to avoid icon library dependency in this component)
// ---------------------------------------------------------------------------

const STATE_ICONS: Record<VoiceConnectionState, string> = {
  disconnected: '⊘',
  connecting:   '↻',
  connected:    '🎤',
  recording:    '⏺',
  processing:   '⌛',
  error:        '⚠',
};

const STATE_LABELS: Record<VoiceConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting:   'Connecting…',
  connected:    'Tap to speak',
  recording:    'Listening…',
  processing:   'Processing…',
  error:        'Error',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VoiceButton({
  state,
  onPress,
  onPressIn,
  onPressOut,
  size = 120,
  disabled = false,
  accessibilityLabel,
}: VoiceButtonProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const spinAnim  = useRef(new Animated.Value(0)).current;
  const glowAnim  = useRef(new Animated.Value(0)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);
  const spinRef  = useRef<Animated.CompositeAnimation | null>(null);
  const glowRef  = useRef<Animated.CompositeAnimation | null>(null);

  // Pulse — recording state
  useEffect(() => {
    if (state === 'recording') {
      pulseRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.18, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,    duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      pulseRef.current.start();

      glowRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      glowRef.current.start();
    } else {
      pulseRef.current?.stop();
      glowRef.current?.stop();
      Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true }).start();
      Animated.timing(glowAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    }
  }, [state, pulseAnim, glowAnim]);

  // Spin — processing / connecting
  useEffect(() => {
    if (state === 'processing' || state === 'connecting') {
      spinRef.current = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1200,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      spinRef.current.start();
    } else {
      spinRef.current?.stop();
      spinAnim.setValue(0);
    }
  }, [state, spinAnim]);

  // Shake — error
  useEffect(() => {
    if (state === 'error') {
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue:  8, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue:  6, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -6, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue:  0, duration: 60, useNativeDriver: true }),
      ]).start();
    }
  }, [state, shakeAnim]);

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const buttonColor = (() => {
    switch (state) {
      case 'recording':   return Colors.voiceActive;
      case 'processing':  return Colors.accent;
      case 'error':       return Colors.error;
      case 'disconnected': return Colors.textMuted;
      default:            return Colors.accent;
    }
  })();

  const glowColor = state === 'recording' ? Colors.voiceActiveGlow : Colors.accentMuted;

  const innerSize  = size;
  const outerSize  = size + 32;
  const iconSize   = Math.round(size * 0.36);
  const borderW    = 2;

  const label = accessibilityLabel ?? STATE_LABELS[state];

  return (
    <View style={styles.container}>
      {/* Outer glow ring — opacity animated during recording */}
      <Animated.View
        style={[
          styles.glowRing,
          {
            width: outerSize,
            height: outerSize,
            borderRadius: outerSize / 2,
            backgroundColor: glowColor,
            opacity: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] }),
            transform: [{ scale: pulseAnim }],
          },
        ]}
        pointerEvents="none"
      />

      {/* Button */}
      <Animated.View
        style={{
          transform: [
            { scale: pulseAnim },
            { rotate: spin },
            { translateX: shakeAnim },
          ],
        }}
      >
        <Pressable
          onPress={onPress}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          disabled={disabled || state === 'disconnected' || state === 'connecting'}
          accessible
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled, busy: state === 'processing' || state === 'connecting' }}
          style={({ pressed }) => [
            styles.button,
            {
              width: innerSize,
              height: innerSize,
              borderRadius: innerSize / 2,
              borderWidth: borderW,
              borderColor: buttonColor,
              backgroundColor: state === 'recording'
                ? `${Colors.voiceActive}22`
                : Colors.surfaceElevated,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Text style={{ fontSize: iconSize }}>
            {STATE_ICONS[state]}
          </Text>
        </Pressable>
      </Animated.View>

      {/* State label */}
      <Text style={styles.stateLabel}>{STATE_LABELS[state]}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowRing: {
    position: 'absolute',
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.voiceActiveGlow,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 8,
  },
  stateLabel: {
    marginTop: 16,
    fontSize: 13,
    fontWeight: '500',
    color: Colors.textSecondary,
    letterSpacing: 0.5,
  },
});
