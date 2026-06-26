/**
 * Global Zustand store for BOS mobile app.
 *
 * Manages:
 * - Server connection state
 * - System health data
 * - Activity feed
 * - Voice session state
 * - User settings
 */

import { create } from 'zustand';
import type { SystemHealth } from '@boss/core';
import type { ActivityEvent } from '@/services/api';
import type { VoiceConnectionState } from '@/services/voice';

// ---------------------------------------------------------------------------
// Settings slice
// ---------------------------------------------------------------------------

export interface AppSettings {
  apiUrl: string;
  alwaysListen: boolean;
  pushEnabled: boolean;
  ttsVoiceId: string;
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface AppState {
  // Health
  health: SystemHealth | null;
  healthLoading: boolean;
  healthError: string | null;
  lastHealthFetch: number | null;

  // Activity
  activity: ActivityEvent[];
  activityLoading: boolean;
  activityError: string | null;
  activityTotal: number;

  // Voice
  voiceState: VoiceConnectionState;
  lastTranscript: string;
  lastResponse: string;
  voiceSessionId: string;

  // Settings
  settings: AppSettings;

  // Actions
  setHealth: (health: SystemHealth | null) => void;
  setHealthLoading: (loading: boolean) => void;
  setHealthError: (error: string | null) => void;

  setActivity: (events: ActivityEvent[], total: number) => void;
  prependActivity: (event: ActivityEvent) => void;
  setActivityLoading: (loading: boolean) => void;
  setActivityError: (error: string | null) => void;

  setVoiceState: (state: VoiceConnectionState) => void;
  setLastTranscript: (text: string) => void;
  setLastResponse: (text: string) => void;
  setVoiceSessionId: (id: string) => void;

  updateSettings: (partial: Partial<AppSettings>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Health
  health: null,
  healthLoading: false,
  healthError: null,
  lastHealthFetch: null,

  // Activity
  activity: [],
  activityLoading: false,
  activityError: null,
  activityTotal: 0,

  // Voice
  voiceState: 'disconnected',
  lastTranscript: '',
  lastResponse: '',
  voiceSessionId: '',

  // Settings defaults — overridden by SecureStore on mount
  settings: {
    apiUrl: 'http://localhost:3000',
    alwaysListen: false,
    pushEnabled: true,
    ttsVoiceId: 'elevenlabs_rachel',
  },

  // Actions
  setHealth: (health) => set({ health, lastHealthFetch: Date.now() }),
  setHealthLoading: (healthLoading) => set({ healthLoading }),
  setHealthError: (healthError) => set({ healthError }),

  setActivity: (activity, activityTotal) => set({ activity, activityTotal }),
  prependActivity: (event) =>
    set((s) => ({ activity: [event, ...s.activity], activityTotal: s.activityTotal + 1 })),
  setActivityLoading: (activityLoading) => set({ activityLoading }),
  setActivityError: (activityError) => set({ activityError }),

  setVoiceState: (voiceState) => set({ voiceState }),
  setLastTranscript: (lastTranscript) => set({ lastTranscript }),
  setLastResponse: (lastResponse) => set({ lastResponse }),
  setVoiceSessionId: (voiceSessionId) => set({ voiceSessionId }),

  updateSettings: (partial) =>
    set((s) => ({ settings: { ...s.settings, ...partial } })),
}));
