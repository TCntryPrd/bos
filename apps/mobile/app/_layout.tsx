/**
 * Root layout — initializes services, configures navigation, applies dark theme.
 *
 * Handles:
 * - Notification service init
 * - API client base URL hydration from SecureStore
 * - Voice client connection on mount
 * - Expo Router Tabs layout with 4 tabs
 */

import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Tabs } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as SplashScreen from 'expo-splash-screen';
import { Text, StyleSheet } from 'react-native';

import { Colors } from '@/constants/theme';
import { STORAGE_KEYS } from '@/constants/config';
import { apiClient } from '@/services/api';
import { voiceClient } from '@/services/voice';
import { notificationService } from '@/services/notifications';
import { useAppStore } from '@/store/useAppStore';

// Keep splash visible until we finish async init
SplashScreen.preventAutoHideAsync().catch(() => {});

// ---------------------------------------------------------------------------
// Tab icon — text glyph, no external icon dep required for router layout
// ---------------------------------------------------------------------------

interface TabIconProps {
  glyph: string;
  color: string;
  size: number;
}

function TabIcon({ glyph, color, size }: TabIconProps) {
  return <Text style={{ fontSize: size, color, lineHeight: size + 4 }}>{glyph}</Text>;
}

// ---------------------------------------------------------------------------
// Root layout
// ---------------------------------------------------------------------------

export default function RootLayout() {
  const updateSettings = useAppStore((s) => s.updateSettings);

  useEffect(() => {
    async function init() {
      try {
        // Hydrate settings from SecureStore
        const [apiUrl, alwaysListenRaw, pushEnabledRaw, ttsVoiceId] = await Promise.all([
          SecureStore.getItemAsync(STORAGE_KEYS.API_URL),
          SecureStore.getItemAsync(STORAGE_KEYS.ALWAYS_LISTEN),
          SecureStore.getItemAsync(STORAGE_KEYS.PUSH_ENABLED),
          SecureStore.getItemAsync(STORAGE_KEYS.TTS_VOICE),
        ]);

        const settings: Record<string, unknown> = {};
        if (apiUrl)      settings.apiUrl       = apiUrl;
        if (ttsVoiceId)  settings.ttsVoiceId   = ttsVoiceId;
        if (alwaysListenRaw !== null) settings.alwaysListen = alwaysListenRaw === 'true';
        if (pushEnabledRaw  !== null) settings.pushEnabled  = pushEnabledRaw  !== 'false';
        if (Object.keys(settings).length > 0) {
          updateSettings(settings as Parameters<typeof updateSettings>[0]);
        }

        // Init API client
        if (apiUrl) apiClient.setBaseUrl(apiUrl);

        // Connect voice WebSocket
        voiceClient.connect().catch(console.error);

        // Init push notifications
        await notificationService.init();
      } catch (err) {
        console.error('[layout] Init error:', err);
      } finally {
        await SplashScreen.hideAsync();
      }
    }

    void init();

    return () => {
      voiceClient.disconnect();
    };
  }, [updateSettings]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor={Colors.background} />
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarStyle: {
              backgroundColor: Colors.tabBackground,
              borderTopColor: Colors.surfaceBorder,
              borderTopWidth: 1,
              height: 60,
              paddingBottom: 8,
            },
            tabBarActiveTintColor:   Colors.tabActive,
            tabBarInactiveTintColor: Colors.tabInactive,
            tabBarLabelStyle: {
              fontSize: 11,
              fontWeight: '500',
              letterSpacing: 0.3,
            },
          }}
        >
          <Tabs.Screen
            name="(tabs)/index"
            options={{
              title: 'Dashboard',
              tabBarIcon: ({ color, size }) => (
                <TabIcon glyph="⊞" color={color} size={size} />
              ),
            }}
          />
          <Tabs.Screen
            name="(tabs)/voice"
            options={{
              title: 'Voice',
              tabBarIcon: ({ color, size }) => (
                <TabIcon glyph="🎤" color={color} size={size} />
              ),
            }}
          />
          <Tabs.Screen
            name="(tabs)/activity"
            options={{
              title: 'Activity',
              tabBarIcon: ({ color, size }) => (
                <TabIcon glyph="⏱" color={color} size={size} />
              ),
            }}
          />
          <Tabs.Screen
            name="(tabs)/settings"
            options={{
              title: 'Settings',
              tabBarIcon: ({ color, size }) => (
                <TabIcon glyph="⚙" color={color} size={size} />
              ),
            }}
          />
        </Tabs>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
});
