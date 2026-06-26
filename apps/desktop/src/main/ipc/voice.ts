/**
 * Voice IPC Handlers
 *
 * Manages always-listening microphone via system audio capture.
 * Streams audio to BOS STT service for wake-word detection and command processing.
 * Uses WebSocket connection to the BOS API for real-time voice interaction.
 */

import { ipcMain, BrowserWindow } from 'electron';
import WebSocket from 'ws';
import { getStore } from '../store.js';

/** Voice session state */
interface VoiceState {
  isListening: boolean;
  isProcessing: boolean;
  wsConnection: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const state: VoiceState = {
  isListening: false,
  isProcessing: false,
  wsConnection: null,
  reconnectTimer: null,
};

/** Get the WebSocket URL for voice streaming */
function getVoiceWsUrl(): string {
  const store = getStore();
  const serverUrl = store.get('serverUrl', '');
  if (!serverUrl) return '';

  // Convert http(s) to ws(s)
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  return `${wsUrl}/voice/stream`;
}

/** Connect to the BOS voice WebSocket */
function connectVoiceStream(): void {
  const url = getVoiceWsUrl();
  if (!url) return;

  const store = getStore();
  const token = store.get('authToken', '');

  try {
    state.wsConnection = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    state.wsConnection.on('open', () => {
      state.isListening = true;
      broadcastVoiceStatus('listening');
    });

    state.wsConnection.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        handleVoiceMessage(message);
      } catch {
        // Binary audio data or malformed message
      }
    });

    state.wsConnection.on('close', () => {
      state.isListening = false;
      broadcastVoiceStatus('idle');

      // Auto-reconnect if voice is enabled
      if (store.get('voiceEnabled', false)) {
        scheduleReconnect();
      }
    });

    state.wsConnection.on('error', (err) => {
      console.error('[Voice] WebSocket error:', err.message);
      state.isListening = false;
      broadcastVoiceStatus('error');
    });
  } catch (err: any) {
    console.error('[Voice] Failed to connect:', err.message);
    broadcastVoiceStatus('error');
  }
}

/** Schedule a reconnection attempt */
function scheduleReconnect(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }
  state.reconnectTimer = setTimeout(() => {
    connectVoiceStream();
  }, 5000);
}

/** Handle incoming voice messages from the server */
function handleVoiceMessage(message: {
  type: string;
  text?: string;
  intent?: string;
  confidence?: number;
  response?: string;
  error?: string;
}): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('voice:message', message);
  }

  switch (message.type) {
    case 'wake_word_detected':
      state.isProcessing = true;
      broadcastVoiceStatus('processing');
      break;

    case 'transcription':
      // Speech-to-text result
      for (const win of windows) {
        win.webContents.send('voice:transcription', message.text);
      }
      break;

    case 'response':
      state.isProcessing = false;
      broadcastVoiceStatus('listening');
      break;

    case 'error':
      state.isProcessing = false;
      broadcastVoiceStatus('error');
      break;
  }
}

/** Broadcast voice status to all renderer windows and update tray */
function broadcastVoiceStatus(status: 'idle' | 'listening' | 'processing' | 'error'): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('voice:statusChanged', status);
  }
}

/** Send an audio chunk over the WebSocket */
function sendAudioChunk(chunk: Buffer): void {
  if (state.wsConnection?.readyState === WebSocket.OPEN) {
    state.wsConnection.send(chunk);
  }
}

/** Disconnect and clean up voice resources */
function disconnectVoice(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.wsConnection) {
    state.wsConnection.close();
    state.wsConnection = null;
  }

  state.isListening = false;
  state.isProcessing = false;
}

export function registerVoiceHandlers(): void {
  /** Start voice listening */
  ipcMain.handle('voice:start', async (): Promise<boolean> => {
    const store = getStore();
    if (!store.get('serverUrl')) {
      return false;
    }

    store.set('voiceEnabled', true);
    connectVoiceStream();
    return true;
  });

  /** Stop voice listening */
  ipcMain.handle('voice:stop', async (): Promise<void> => {
    const store = getStore();
    store.set('voiceEnabled', false);
    disconnectVoice();
    broadcastVoiceStatus('idle');
  });

  /** Toggle voice listening */
  ipcMain.handle('voice:toggle', async (): Promise<boolean> => {
    if (state.isListening) {
      disconnectVoice();
      broadcastVoiceStatus('idle');
      const store = getStore();
      store.set('voiceEnabled', false);
      return false;
    } else {
      const store = getStore();
      store.set('voiceEnabled', true);
      connectVoiceStream();
      return true;
    }
  });

  /** Get current voice status */
  ipcMain.handle('voice:getStatus', (): {
    isListening: boolean;
    isProcessing: boolean;
    isConnected: boolean;
  } => {
    return {
      isListening: state.isListening,
      isProcessing: state.isProcessing,
      isConnected: state.wsConnection?.readyState === WebSocket.OPEN,
    };
  });

  /** Send audio data from renderer to voice WebSocket */
  ipcMain.on('voice:audioChunk', (_event, chunk: ArrayBuffer) => {
    sendAudioChunk(Buffer.from(chunk));
  });

  /** Send a text command (typed, not spoken) */
  ipcMain.handle('voice:sendText', async (_event, text: string): Promise<void> => {
    if (state.wsConnection?.readyState === WebSocket.OPEN) {
      state.wsConnection.send(
        JSON.stringify({
          type: 'text_command',
          text,
        }),
      );
    }
  });

  /** Listen for toggle from tray menu */
  ipcMain.on('voice:toggle-from-tray', async () => {
    if (state.isListening) {
      disconnectVoice();
      broadcastVoiceStatus('idle');
    } else {
      connectVoiceStream();
    }
  });
}

/** Clean up all voice resources on app quit */
export function destroyVoice(): void {
  disconnectVoice();
}
