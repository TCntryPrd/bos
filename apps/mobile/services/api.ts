/**
 * BOS API client.
 *
 * Connects to the BOS server REST API. Base URL is loaded from SecureStore
 * at runtime, falling back to DEFAULT_API_URL from constants/config.
 *
 * Usage:
 *   import { apiClient } from '@/services/api';
 *   const health = await apiClient.health.getFull();
 */

import * as SecureStore from 'expo-secure-store';
import { DEFAULT_API_URL, API_TIMEOUT_MS, STORAGE_KEYS } from '@/constants/config';
import type { SystemHealth, HealthCheckResult } from '@boss/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
  statusCode: number;
}

export interface ActivityEvent {
  id: string;
  type: 'voice_command' | 'incident' | 'healing' | 'connector' | 'backup' | 'system';
  title: string;
  description?: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  service?: string;
  userId?: string;
  tenantId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityPage {
  events: ActivityEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface VoiceCommandRequest {
  audioBase64?: string;
  text?: string;
  sessionId: string;
}

export interface VoiceCommandResponse {
  id: string;
  transcript: string;
  response: string;
  intent?: string;
  actions?: Array<{ type: string; payload: unknown }>;
  ttsAudioBase64?: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  userId: string;
  tenantId: string;
  expiresAt: string;
}

export interface ServerInfo {
  status: 'ok';
  version: string;
  timestamp: string;
}

export interface NotificationRegistration {
  pushToken: string;
  platform: 'ios' | 'android';
  deviceId: string;
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

class BossApiClient {
  private baseUrl: string = DEFAULT_API_URL;

  async init(): Promise<void> {
    const stored = await SecureStore.getItemAsync(STORAGE_KEYS.API_URL);
    if (stored) {
      this.baseUrl = stored.replace(/\/$/, '');
    }
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  private async getAuthHeader(): Promise<Record<string, string>> {
    const token = await SecureStore.getItemAsync(STORAGE_KEYS.AUTH_TOKEN);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | boolean>;
      skipAuth?: boolean;
    }
  ): Promise<T> {
    await this.init();

    const auth = options?.skipAuth ? {} : await this.getAuthHeader();

    let url = `${this.baseUrl}${path}`;
    if (options?.params) {
      const qs = new URLSearchParams(
        Object.entries(options.params).reduce<Record<string, string>>(
          (acc, [k, v]) => ({ ...acc, [k]: String(v) }),
          {}
        )
      ).toString();
      url = `${url}?${qs}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...auth,
        },
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          message = errBody.message ?? message;
        } catch {
          // ignore parse error
        }
        const err: ApiError = {
          code: `HTTP_${response.status}`,
          message,
          statusCode: response.status,
        };
        throw err;
      }

      // 204 No Content
      if (response.status === 204) {
        return undefined as unknown as T;
      }

      return response.json() as Promise<T>;
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === 'AbortError') {
        throw { code: 'TIMEOUT', message: 'Request timed out', statusCode: 0 } satisfies ApiError;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  health = {
    ping: () =>
      this.request<ServerInfo>('GET', '/health', { skipAuth: true }),

    getFull: () =>
      this.request<SystemHealth>('GET', '/health/full', { skipAuth: true }),
  };

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  auth = {
    login: (email: string, password: string) =>
      this.request<AuthResponse>('POST', '/auth/login', {
        body: { email, password },
        skipAuth: true,
      }),

    refresh: () =>
      this.request<AuthResponse>('POST', '/auth/refresh'),

    logout: () =>
      this.request<void>('POST', '/auth/logout'),
  };

  // ---------------------------------------------------------------------------
  // Activity / Events
  // ---------------------------------------------------------------------------

  activity = {
    list: (params?: { page?: number; pageSize?: number; type?: ActivityEvent['type'] }) =>
      this.request<ActivityPage>('GET', '/activity', {
        params: params as Record<string, string | number | boolean>,
      }),

    getById: (id: string) =>
      this.request<ActivityEvent>('GET', `/activity/${id}`),
  };

  // ---------------------------------------------------------------------------
  // Voice (REST commands; streaming handled by voice.ts WebSocket)
  // ---------------------------------------------------------------------------

  voice = {
    command: (payload: VoiceCommandRequest) =>
      this.request<VoiceCommandResponse>('POST', '/voice/command', { body: payload }),

    endSession: (sessionId: string) =>
      this.request<void>('DELETE', `/voice/session/${sessionId}`),
  };

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  notifications = {
    register: (registration: NotificationRegistration) =>
      this.request<{ id: string }>('POST', '/notifications/register', { body: registration }),

    unregister: (deviceId: string) =>
      this.request<void>('DELETE', `/notifications/register/${deviceId}`),
  };
}

export const apiClient = new BossApiClient();
