/**
 * Persistent configuration store using electron-store.
 * Stores server URL, auth tokens, user preferences.
 */

import Store from 'electron-store';

export interface BossConfig {
  // Server connection
  serverUrl: string;
  authToken: string;
  refreshToken: string;

  // User identity
  userId: string;
  tenantId: string;
  displayName: string;

  // App behavior
  minimizeToTray: boolean;
  autoStart: boolean;
  voiceEnabled: boolean;
  voiceWakeWord: string;

  // Scan configuration
  scanPaths: string[];
  excludePatterns: string[];

  // Completed setup
  setupComplete: boolean;

  // Window state
  windowBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

const defaults: BossConfig = {
  serverUrl: '',
  authToken: '',
  refreshToken: '',
  userId: '',
  tenantId: '',
  displayName: '',
  minimizeToTray: true,
  autoStart: false,
  voiceEnabled: false,
  voiceWakeWord: 'hey boss',
  scanPaths: [],
  excludePatterns: [
    'node_modules',
    '.git',
    '__pycache__',
    '.venv',
    'AppData',
    'ProgramData',
    '$Recycle.Bin',
  ],
  setupComplete: false,
  windowBounds: {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
  },
};

let store: Store<BossConfig> | null = null;

export function getStore(): Store<BossConfig> {
  if (!store) {
    store = new Store<BossConfig>({
      name: 'boss-config',
      defaults,
      encryptionKey: 'boss-local-encryption-key',
    });
  }
  return store;
}
