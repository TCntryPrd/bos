/**
 * BOS Voice WebSocket client.
 *
 * Manages a persistent WebSocket connection for streaming audio to/from the
 * BOS voice service. Handles reconnection, push-to-talk gating, and
 * always-listen mode.
 *
 * Usage:
 *   import { voiceClient } from '@/services/voice';
 *   voiceClient.connect();
 *   voiceClient.startRecording();
 *   voiceClient.stopRecording();
 *
 * Events are delivered via the listener pattern:
 *   voiceClient.on('transcript', (text) => ...);
 *   voiceClient.on('response', (text, audioBase64?) => ...);
 *   voiceClient.on('state', (state) => ...);
 */

import { Audio } from 'expo-av';
import * as SecureStore from 'expo-secure-store';
import { DEFAULT_WS_URL, VOICE_WS_RECONNECT_DELAY_MS, STORAGE_KEYS } from '@/constants/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'recording'
  | 'processing'
  | 'error';

export interface VoiceTranscriptEvent {
  partial: boolean;
  text: string;
  sessionId: string;
}

export interface VoiceResponseEvent {
  text: string;
  ttsAudioBase64?: string;
  intent?: string;
  sessionId: string;
}

export interface VoiceErrorEvent {
  code: string;
  message: string;
}

type VoiceEventMap = {
  state: (state: VoiceConnectionState) => void;
  transcript: (event: VoiceTranscriptEvent) => void;
  response: (event: VoiceResponseEvent) => void;
  error: (event: VoiceErrorEvent) => void;
};

type Listeners = {
  [K in keyof VoiceEventMap]: Set<VoiceEventMap[K]>;
};

// ---------------------------------------------------------------------------
// WebSocket message envelope
// ---------------------------------------------------------------------------

interface WsMessage {
  type: 'audio_chunk' | 'end_utterance' | 'transcript' | 'response' | 'error' | 'ping' | 'pong';
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// VoiceClient class
// ---------------------------------------------------------------------------

class VoiceClient {
  private ws: WebSocket | null = null;
  private baseUrl: string = DEFAULT_WS_URL;
  private sessionId: string = '';
  private state: VoiceConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect: boolean = false;
  private recording: Audio.Recording | null = null;
  private alwaysListen: boolean = false;

  private listeners: Listeners = {
    state: new Set(),
    transcript: new Set(),
    response: new Set(),
    error: new Set(),
  };

  // -------------------------------------------------------------------------
  // Listener API
  // -------------------------------------------------------------------------

  on<K extends keyof VoiceEventMap>(event: K, listener: VoiceEventMap[K]): () => void {
    (this.listeners[event] as Set<VoiceEventMap[K]>).add(listener);
    return () => (this.listeners[event] as Set<VoiceEventMap[K]>).delete(listener);
  }

  private emit<K extends keyof VoiceEventMap>(
    event: K,
    ...args: Parameters<VoiceEventMap[K]>
  ): void {
    (this.listeners[event] as Set<(...a: unknown[]) => void>).forEach((fn) => fn(...args));
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') return;

    const stored = await SecureStore.getItemAsync(STORAGE_KEYS.API_URL);
    if (stored) {
      this.baseUrl = stored.replace(/^http/, 'ws').replace(/\/$/, '');
    }

    const token = await SecureStore.getItemAsync(STORAGE_KEYS.AUTH_TOKEN);
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.shouldReconnect = true;

    this.setState('connecting');

    const url = `${this.baseUrl}/voice/ws?sessionId=${this.sessionId}${token ? `&token=${token}` : ''}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.setState('connected');
      this.startPing();
      if (this.alwaysListen) {
        this.startRecording().catch(console.error);
      }
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onerror = () => {
      this.emit('error', { code: 'WS_ERROR', message: 'WebSocket connection error' });
      this.setState('error');
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.state !== 'error') {
        this.setState('disconnected');
      }
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopRecording().catch(console.error);
    this.stopPing();
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  async startRecording(): Promise<void> {
    if (this.state !== 'connected') return;

    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      this.emit('error', { code: 'NO_MIC_PERMISSION', message: 'Microphone permission denied' });
      return;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    this.recording = new Audio.Recording();
    await this.recording.prepareToRecordAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY
    );
    await this.recording.startAsync();
    this.setState('recording');
  }

  async stopRecording(): Promise<void> {
    if (!this.recording) return;

    try {
      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.recording = null;

      if (uri && this.ws?.readyState === WebSocket.OPEN) {
        await this.sendAudioFile(uri);
        this.sendJson({ type: 'end_utterance', payload: { sessionId: this.sessionId } });
        this.setState('processing');
      } else {
        this.setState('connected');
      }
    } catch {
      this.recording = null;
      this.setState('connected');
    }

    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  }

  // -------------------------------------------------------------------------
  // Always-listen mode
  // -------------------------------------------------------------------------

  setAlwaysListen(enabled: boolean): void {
    this.alwaysListen = enabled;
    if (enabled && this.state === 'connected') {
      this.startRecording().catch(console.error);
    } else if (!enabled && this.state === 'recording') {
      this.stopRecording().catch(console.error);
    }
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  getState(): VoiceConnectionState {
    return this.state;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private setState(next: VoiceConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  private handleMessage(raw: string): void {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'transcript': {
        const p = msg.payload as VoiceTranscriptEvent;
        this.emit('transcript', p);
        break;
      }
      case 'response': {
        const p = msg.payload as VoiceResponseEvent;
        this.setState('connected');
        this.emit('response', p);
        if (this.alwaysListen && this.state === 'connected') {
          this.startRecording().catch(console.error);
        }
        break;
      }
      case 'error': {
        const p = msg.payload as VoiceErrorEvent;
        this.emit('error', p);
        this.setState('connected');
        break;
      }
      case 'pong':
        break;
      default:
        break;
    }
  }

  private sendJson(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async sendAudioFile(uri: string): Promise<void> {
    try {
      const response = await fetch(uri);
      const blob = await response.blob();
      const reader = new FileReader();
      await new Promise<void>((resolve, reject) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          this.sendJson({
            type: 'audio_chunk',
            payload: { audio: base64, sessionId: this.sessionId, final: true },
          });
          resolve();
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      // If file encoding fails, skip sending audio — session still ends cleanly
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.sendJson({ type: 'ping' });
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect().catch(console.error);
      }
    }, VOICE_WS_RECONNECT_DELAY_MS);
  }
}

export const voiceClient = new VoiceClient();
