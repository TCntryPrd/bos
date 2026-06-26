/**
 * BOS push notification handler.
 *
 * Handles Expo push token registration, incoming foreground notifications,
 * and notification tap routing. Persists the push token and registration
 * state in SecureStore.
 *
 * Usage:
 *   import { notificationService } from '@/services/notifications';
 *   await notificationService.init();
 *
 * Called once at app startup from _layout.tsx.
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiClient } from './api';
import { STORAGE_KEYS } from '@/constants/config';

// ---------------------------------------------------------------------------
// Notification display behaviour
// ---------------------------------------------------------------------------

// Show notification banner even when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BossNotificationData {
  type: 'incident' | 'healing' | 'voice_response' | 'connector' | 'backup' | 'system';
  eventId?: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  service?: string;
  route?: string;
}

export type NotificationTapHandler = (data: BossNotificationData) => void;

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

class NotificationService {
  private tapHandlers: Set<NotificationTapHandler> = new Set();
  private foregroundSubscription: Notifications.Subscription | null = null;
  private tapSubscription: Notifications.Subscription | null = null;
  private deviceId: string = '';

  // -------------------------------------------------------------------------
  // Init (call once at app startup)
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    this.deviceId = await this.getOrCreateDeviceId();

    const enabled = await SecureStore.getItemAsync(STORAGE_KEYS.PUSH_ENABLED);
    if (enabled === 'false') return;

    if (!Device.isDevice) {
      // Push notifications only work on physical devices
      console.warn('[notifications] Push notifications unavailable in simulator');
      return;
    }

    const token = await this.requestPermissionsAndGetToken();
    if (!token) return;

    await this.registerTokenWithServer(token);
    this.subscribeToEvents();
  }

  // -------------------------------------------------------------------------
  // Cleanup (call on unmount or logout)
  // -------------------------------------------------------------------------

  async teardown(): Promise<void> {
    this.foregroundSubscription?.remove();
    this.tapSubscription?.remove();
    this.foregroundSubscription = null;
    this.tapSubscription = null;

    if (this.deviceId) {
      try {
        await apiClient.notifications.unregister(this.deviceId);
      } catch {
        // Best-effort
      }
    }
  }

  // -------------------------------------------------------------------------
  // Push opt-in/out
  // -------------------------------------------------------------------------

  async setEnabled(enabled: boolean): Promise<void> {
    await SecureStore.setItemAsync(STORAGE_KEYS.PUSH_ENABLED, enabled ? 'true' : 'false');
    if (enabled) {
      await this.init();
    } else {
      await this.teardown();
    }
  }

  async isEnabled(): Promise<boolean> {
    const stored = await SecureStore.getItemAsync(STORAGE_KEYS.PUSH_ENABLED);
    return stored !== 'false';
  }

  // -------------------------------------------------------------------------
  // Tap handler registration
  // -------------------------------------------------------------------------

  onTap(handler: NotificationTapHandler): () => void {
    this.tapHandlers.add(handler);
    return () => this.tapHandlers.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async requestPermissionsAndGetToken(): Promise<string | null> {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;

    if (status !== 'granted') {
      const { status: requested } = await Notifications.requestPermissionsAsync();
      status = requested;
    }

    if (status !== 'granted') {
      console.warn('[notifications] Permission not granted');
      return null;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('boss-default', {
        name: 'BOS',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#6366f1',
      });

      await Notifications.setNotificationChannelAsync('boss-critical', {
        name: 'BOS Critical',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 250, 500],
        lightColor: '#ef4444',
      });
    }

    try {
      const { data } = await Notifications.getExpoPushTokenAsync();
      return data;
    } catch (err) {
      console.error('[notifications] Failed to get push token:', err);
      return null;
    }
  }

  private async registerTokenWithServer(token: string): Promise<void> {
    try {
      await apiClient.notifications.register({
        pushToken: token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        deviceId: this.deviceId,
      });
    } catch (err) {
      console.error('[notifications] Token registration failed:', err);
    }
  }

  private subscribeToEvents(): void {
    this.foregroundSubscription?.remove();
    this.tapSubscription?.remove();

    // Foreground notifications — just log them; banner is shown by handler above
    this.foregroundSubscription = Notifications.addNotificationReceivedListener(
      (notification) => {
        const data = notification.request.content.data as BossNotificationData;
        console.log('[notifications] Foreground notification:', data?.type ?? 'unknown');
      }
    );

    // Notification taps — route to registered handlers
    this.tapSubscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as BossNotificationData;
        this.tapHandlers.forEach((fn) => fn(data));
      }
    );
  }

  private async getOrCreateDeviceId(): Promise<string> {
    const key = 'boss.device_id';
    const existing = await SecureStore.getItemAsync(key);
    if (existing) return existing;

    const id = `device_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await SecureStore.setItemAsync(key, id);
    return id;
  }
}

export const notificationService = new NotificationService();
