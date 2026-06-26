/**
 * BOS Desktop — Main Process Entry Point
 *
 * Responsibilities:
 * - Create the main BrowserWindow (dashboard)
 * - System tray icon with listening status
 * - IPC handlers for filesystem access, voice, and cleanup
 * - Auto-start on Windows boot (optional)
 * - Minimize to system tray
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFileSystemHandlers } from './ipc/filesystem.js';
import { registerCleanupHandlers } from './ipc/cleanup.js';
import { registerVoiceHandlers, destroyVoice } from './ipc/voice.js';
import { registerConfigHandlers } from './ipc/config.js';
import { registerAutoStartHandlers } from './ipc/autostart.js';
import { createTray, updateTrayMenu, destroyTray } from './tray.js';
import { getStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged;
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER_DEV_URL = 'http://localhost:5173';
const RENDERER_PROD_PATH = path.join(__dirname, '..', 'renderer', 'index.html');

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'BOS',
    icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // Enable webview for embedding integrations (Make, Notion, etc.)
    },
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f172a',
      symbolColor: '#94a3b8',
      height: 36,
    },
  });

  // Show when ready to avoid flicker
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Load BOS web UI from server — falls back to local renderer
  const store = getStore();
  const serverUrl = store.get('serverUrl', 'https://last-castle.daggertooth-larch.ts.net/boss/ui/') as string;

  if (isDev) {
    mainWindow.loadURL(RENDERER_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL(serverUrl).catch(() => {
      // Fallback to local renderer if server unreachable
      mainWindow?.loadFile(RENDERER_PROD_PATH);
    });
  }

  // Allow webviews to load any URL (for Make, Notion, Airtable, Facebook, etc.)
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [''],
        // Remove X-Frame-Options to allow embedding any site
      },
    });
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    const store = getStore();
    if (store.get('minimizeToTray', true) && !(app as any).isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open links: internal integrations in webview, external in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // These open inside the app as embedded views
    const embedDomains = ['make.com', 'notion.so', 'airtable.com', 'stripe.com', 'facebook.com', 'spotify.com'];
    if (embedDomains.some(d => url.includes(d))) {
      // Send to renderer to open in browser frame
      mainWindow?.webContents.send('open-in-frame', url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Tray is now managed by ./tray.ts module

function registerAllIpcHandlers(): void {
  registerFileSystemHandlers();
  registerCleanupHandlers();
  registerVoiceHandlers();
  registerConfigHandlers();
  registerAutoStartHandlers();

  // Generic handler: get app version
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Generic handler: update tray voice status
  ipcMain.on('tray:setVoiceStatus', (_event, status: string) => {
    updateTrayMenu(status as 'idle' | 'listening' | 'processing' | 'error');
  });

  // Detect installed apps
  ipcMain.handle('apps:detect', async () => {
    const fs = await import('node:fs');
    const { execSync } = await import('node:child_process');
    const detected: Record<string, boolean> = {};

    // Claude Desktop
    try {
      if (process.platform === 'win32') {
        detected.claude = fs.existsSync('C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\AnthropicClaude\\claude.exe');
      } else if (process.platform === 'darwin') {
        detected.claude = fs.existsSync('/Applications/Claude.app');
      } else {
        detected.claude = !!execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim();
      }
    } catch { detected.claude = false; }

    // Spotify
    try {
      if (process.platform === 'win32') {
        detected.spotify = fs.existsSync('C:\\Users\\' + process.env.USERNAME + '\\AppData\\Roaming\\Spotify\\Spotify.exe');
      } else if (process.platform === 'darwin') {
        detected.spotify = fs.existsSync('/Applications/Spotify.app');
      } else {
        detected.spotify = !!execSync('which spotify 2>/dev/null || ls /snap/bin/spotify 2>/dev/null', { encoding: 'utf-8' }).trim();
      }
    } catch { detected.spotify = false; }

    return detected;
  });

  // Open terminal (spawn shell)
  ipcMain.handle('terminal:spawn', async () => {
    const { spawn } = await import('node:child_process');
    const shellCmd = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const proc = spawn(shellCmd, [], { env: process.env });
    return { pid: proc.pid };
  });
}

// Auto-updater
async function setupAutoUpdate(): Promise<void> {
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:available', info);
    });

    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('update:downloaded', info);
    });

    // Check every 4 hours
    autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
  } catch (err) {
    console.error('Auto-updater failed:', err);
  }
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// isQuitting flag
(app as any).isQuitting = false;

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerAllIpcHandlers();
  void setupAutoUpdate();
});

app.on('window-all-closed', () => {
  // On Windows, keep running in tray
  if (process.platform !== 'win32' || (app as any).isQuitting) {
    app.quit();
  }
});

app.on('before-quit', () => {
  (app as any).isQuitting = true;
  destroyVoice();
  destroyTray();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
