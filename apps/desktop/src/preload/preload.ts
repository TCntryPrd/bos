/**
 * BOS Desktop — Preload Script (IPC Bridge)
 *
 * Exposes a safe, typed API to the renderer process via contextBridge.
 * No direct Node.js access — all operations go through IPC invoke/send.
 */

import { contextBridge, ipcRenderer } from 'electron';

/** Type definitions for the exposed API */
export interface BossDesktopAPI {
  // App info
  getVersion: () => Promise<string>;

  // Configuration
  config: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    getAll: () => Promise<Record<string, unknown>>;
    setMultiple: (values: Record<string, unknown>) => Promise<void>;
    isSetupComplete: () => Promise<boolean>;
    completeSetup: (config: {
      serverUrl: string;
      authToken: string;
      displayName: string;
      autoStart: boolean;
      voiceEnabled: boolean;
    }) => Promise<void>;
    reset: () => Promise<void>;
    pickDirectory: () => Promise<string | null>;
    addScanPath: (dirPath: string) => Promise<void>;
    removeScanPath: (dirPath: string) => Promise<void>;
    testConnection: (serverUrl: string, token: string) => Promise<{ ok: boolean; error?: string }>;
  };

  // Filesystem
  fs: {
    getDefaultScanPaths: () => Promise<Array<{ path: string; label: string }>>;
    getScanPaths: () => Promise<string[]>;
    scanDirectory: (dirPath: string) => Promise<ScanResult>;
    scanAll: () => Promise<ScanResult[]>;
    exists: (filePath: string) => Promise<boolean>;
    getHomePath: () => Promise<string>;
    showInExplorer: (filePath: string) => Promise<void>;
  };

  // Cleanup
  cleanup: {
    executeAction: (action: CleanupAction) => Promise<CleanupResult>;
    executeProposal: (proposal: CleanupProposal) => Promise<CleanupResult[]>;
    trashFile: (filePath: string) => Promise<boolean>;
    getReviewItems: () => Promise<ReviewItem[]>;
    purgeReviewFolder: (daysOld?: number) => Promise<number>;
    onProgress: (callback: (progress: CleanupProgress) => void) => () => void;
  };

  // Voice
  voice: {
    start: () => Promise<boolean>;
    stop: () => Promise<void>;
    toggle: () => Promise<boolean>;
    getStatus: () => Promise<VoiceStatus>;
    sendText: (text: string) => Promise<void>;
    sendAudioChunk: (chunk: ArrayBuffer) => void;
    onStatusChanged: (callback: (status: string) => void) => () => void;
    onTranscription: (callback: (text: string) => void) => () => void;
    onMessage: (callback: (message: VoiceMessage) => void) => () => void;
    onToggle: (callback: () => void) => () => void;
  };

  // Auto-start
  autostart: {
    isEnabled: () => Promise<boolean>;
    enable: () => Promise<void>;
    disable: () => Promise<void>;
    toggle: () => Promise<boolean>;
  };

  // Tray
  tray: {
    setVoiceStatus: (status: string) => void;
  };

  // Navigation events from tray
  onNavigate: (callback: (route: string) => void) => () => void;
  onAction: (callback: (action: string) => void) => () => void;
}

/** Scan result from filesystem */
interface ScanResult {
  rootPath: string;
  label: string;
  files: FileMetadata[];
  totalSize: number;
  fileCount: number;
  dirCount: number;
  scannedAt: string;
  errors: string[];
}

interface FileMetadata {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  extension: string;
  isDirectory: boolean;
  createdAt: string;
  modifiedAt: string;
  accessedAt: string;
}

interface CleanupAction {
  id: string;
  type: 'move' | 'rename' | 'delete' | 'deduplicate';
  sourcePath: string;
  destinationPath?: string;
  reason: string;
  category: string;
  sizeBytes: number;
  approved: boolean;
}

interface CleanupProposal {
  id: string;
  createdAt: string;
  actions: CleanupAction[];
  totalSizeFreed: number;
  summary: string;
}

interface CleanupResult {
  actionId: string;
  success: boolean;
  error?: string;
  executedAt: string;
}

interface ReviewItem {
  name: string;
  path: string;
  size: number;
  movedAt: string;
}

interface CleanupProgress {
  current: number;
  total: number;
  actionId: string;
  type: string;
  sourcePath: string;
}

interface VoiceStatus {
  isListening: boolean;
  isProcessing: boolean;
  isConnected: boolean;
}

interface VoiceMessage {
  type: string;
  text?: string;
  intent?: string;
  confidence?: number;
  response?: string;
  error?: string;
}

/** Helper to create a one-time-removable event listener */
function createListener(channel: string, callback: (...args: any[]) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: any[]) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// Expose the API to the renderer
const api: BossDesktopAPI = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  config: {
    get: (key) => ipcRenderer.invoke('config:get', key),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
    getAll: () => ipcRenderer.invoke('config:getAll'),
    setMultiple: (values) => ipcRenderer.invoke('config:setMultiple', values),
    isSetupComplete: () => ipcRenderer.invoke('config:isSetupComplete'),
    completeSetup: (config) => ipcRenderer.invoke('config:completeSetup', config),
    reset: () => ipcRenderer.invoke('config:reset'),
    pickDirectory: () => ipcRenderer.invoke('config:pickDirectory'),
    addScanPath: (dirPath) => ipcRenderer.invoke('config:addScanPath', dirPath),
    removeScanPath: (dirPath) => ipcRenderer.invoke('config:removeScanPath', dirPath),
    testConnection: (serverUrl, token) =>
      ipcRenderer.invoke('config:testConnection', serverUrl, token),
  },

  fs: {
    getDefaultScanPaths: () => ipcRenderer.invoke('fs:getDefaultScanPaths'),
    getScanPaths: () => ipcRenderer.invoke('fs:getScanPaths'),
    scanDirectory: (dirPath) => ipcRenderer.invoke('fs:scanDirectory', dirPath),
    scanAll: () => ipcRenderer.invoke('fs:scanAll'),
    exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
    getHomePath: () => ipcRenderer.invoke('fs:getHomePath'),
    showInExplorer: (filePath) => ipcRenderer.invoke('fs:showInExplorer', filePath),
  },

  cleanup: {
    executeAction: (action) => ipcRenderer.invoke('cleanup:executeAction', action),
    executeProposal: (proposal) => ipcRenderer.invoke('cleanup:executeProposal', proposal),
    trashFile: (filePath) => ipcRenderer.invoke('cleanup:trashFile', filePath),
    getReviewItems: () => ipcRenderer.invoke('cleanup:getReviewItems'),
    purgeReviewFolder: (daysOld) => ipcRenderer.invoke('cleanup:purgeReviewFolder', daysOld),
    onProgress: (callback) => createListener('cleanup:progress', callback),
  },

  voice: {
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    toggle: () => ipcRenderer.invoke('voice:toggle'),
    getStatus: () => ipcRenderer.invoke('voice:getStatus'),
    sendText: (text) => ipcRenderer.invoke('voice:sendText', text),
    sendAudioChunk: (chunk) => ipcRenderer.send('voice:audioChunk', chunk),
    onStatusChanged: (callback) => createListener('voice:statusChanged', callback),
    onTranscription: (callback) => createListener('voice:transcription', callback),
    onMessage: (callback) => createListener('voice:message', callback),
    onToggle: (callback) => createListener('voice:toggle', callback),
  },

  autostart: {
    isEnabled: () => ipcRenderer.invoke('autostart:isEnabled'),
    enable: () => ipcRenderer.invoke('autostart:enable'),
    disable: () => ipcRenderer.invoke('autostart:disable'),
    toggle: () => ipcRenderer.invoke('autostart:toggle'),
  },

  tray: {
    setVoiceStatus: (status) => ipcRenderer.send('tray:setVoiceStatus', status),
  },

  onNavigate: (callback) => createListener('navigate:settings', () => callback('settings')),
  onAction: (callback) => createListener('action:runScan', () => callback('runScan')),
};

contextBridge.exposeInMainWorld('boss', api);
