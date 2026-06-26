/**
 * Config IPC Handlers
 *
 * Exposes configuration read/write to the renderer via IPC.
 * All config is stored encrypted via electron-store.
 */

import { ipcMain, dialog } from 'electron';
import { getStore, BossConfig } from '../store.js';

export function registerConfigHandlers(): void {
  /** Get a single config value */
  ipcMain.handle('config:get', (_event, key: keyof BossConfig): unknown => {
    const store = getStore();
    return store.get(key);
  });

  /** Set a single config value */
  ipcMain.handle(
    'config:set',
    (_event, key: keyof BossConfig, value: unknown): void => {
      const store = getStore();
      store.set(key, value as any);
    },
  );

  /** Get all config (used by SetupWizard and settings pages) */
  ipcMain.handle('config:getAll', (): BossConfig => {
    const store = getStore();
    return store.store;
  });

  /** Set multiple config values at once */
  ipcMain.handle(
    'config:setMultiple',
    (_event, values: Partial<BossConfig>): void => {
      const store = getStore();
      for (const [key, value] of Object.entries(values)) {
        store.set(key as keyof BossConfig, value as any);
      }
    },
  );

  /** Check if setup is complete */
  ipcMain.handle('config:isSetupComplete', (): boolean => {
    const store = getStore();
    return store.get('setupComplete', false);
  });

  /** Complete initial setup */
  ipcMain.handle(
    'config:completeSetup',
    (
      _event,
      config: {
        serverUrl: string;
        authToken: string;
        displayName: string;
        autoStart: boolean;
        voiceEnabled: boolean;
      },
    ): void => {
      const store = getStore();
      store.set('serverUrl', config.serverUrl);
      store.set('authToken', config.authToken);
      store.set('displayName', config.displayName);
      store.set('autoStart', config.autoStart);
      store.set('voiceEnabled', config.voiceEnabled);
      store.set('setupComplete', true);
    },
  );

  /** Reset all configuration (factory reset) */
  ipcMain.handle('config:reset', (): void => {
    const store = getStore();
    store.clear();
  });

  /** Open a directory picker dialog */
  ipcMain.handle('config:pickDirectory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select folder to scan',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  /** Add a scan path */
  ipcMain.handle('config:addScanPath', (_event, dirPath: string): void => {
    const store = getStore();
    const current = store.get('scanPaths', []);
    if (!current.includes(dirPath)) {
      store.set('scanPaths', [...current, dirPath]);
    }
  });

  /** Remove a scan path */
  ipcMain.handle('config:removeScanPath', (_event, dirPath: string): void => {
    const store = getStore();
    const current = store.get('scanPaths', []);
    store.set(
      'scanPaths',
      current.filter((p) => p !== dirPath),
    );
  });

  /** Test server connection */
  ipcMain.handle(
    'config:testConnection',
    async (_event, serverUrl: string, token: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const url = serverUrl.replace(/\/$/, '');
        const response = await fetch(`${url}/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
          return { ok: false, error: `Server returned ${response.status}` };
        }

        const data = await response.json();
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  );
}
