/**
 * Global type declarations for the BOS Desktop renderer process.
 * Defines the window.boss API shape exposed via preload contextBridge.
 */

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

interface BossDesktopAPI {
  getVersion: () => Promise<string>;

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

  fs: {
    getDefaultScanPaths: () => Promise<Array<{ path: string; label: string }>>;
    getScanPaths: () => Promise<string[]>;
    scanDirectory: (dirPath: string) => Promise<ScanResult>;
    scanAll: () => Promise<ScanResult[]>;
    exists: (filePath: string) => Promise<boolean>;
    getHomePath: () => Promise<string>;
    showInExplorer: (filePath: string) => Promise<void>;
  };

  cleanup: {
    executeAction: (action: CleanupAction) => Promise<CleanupResult>;
    executeProposal: (proposal: CleanupProposal) => Promise<CleanupResult[]>;
    trashFile: (filePath: string) => Promise<boolean>;
    getReviewItems: () => Promise<ReviewItem[]>;
    purgeReviewFolder: (daysOld?: number) => Promise<number>;
    onProgress: (callback: (progress: CleanupProgress) => void) => () => void;
  };

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

  autostart: {
    isEnabled: () => Promise<boolean>;
    enable: () => Promise<void>;
    disable: () => Promise<void>;
    toggle: () => Promise<boolean>;
  };

  tray: {
    setVoiceStatus: (status: string) => void;
  };

  onNavigate: (callback: (route: string) => void) => () => void;
  onAction: (callback: (action: string) => void) => () => void;
}

declare global {
  interface Window {
    boss: BossDesktopAPI;
  }
}

export {};
