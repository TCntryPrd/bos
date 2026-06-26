/**
 * BOS Desktop — System Tray Manager
 *
 * Manages the system tray icon, context menu, and status indicators.
 * Shows current voice status and provides quick actions for
 * dashboard access, voice toggle, and app quit.
 */

import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let currentVoiceStatus: VoiceStatus = 'idle';

export type VoiceStatus = 'idle' | 'listening' | 'processing' | 'error';

const STATUS_LABELS: Record<VoiceStatus, string> = {
  idle: 'Voice: Idle',
  listening: 'Voice: Listening',
  processing: 'Voice: Processing...',
  error: 'Voice: Error',
};

const STATUS_TOOLTIPS: Record<VoiceStatus, string> = {
  idle: 'BOS',
  listening: 'BOS - Listening',
  processing: 'BOS - Processing',
  error: 'BOS - Voice Error',
};

/** Load the tray icon, with fallback to empty image */
function loadTrayIcon(): Electron.NativeImage {
  const iconPath = path.join(__dirname, '..', '..', 'resources', 'tray-icon.png');
  try {
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // Try .ico variant for Windows
      const icoPath = path.join(__dirname, '..', '..', 'resources', 'tray-icon.ico');
      icon = nativeImage.createFromPath(icoPath);
    }
    return icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
}

/** Build the context menu for current state */
function buildContextMenu(voiceStatus: VoiceStatus): Electron.Menu {
  const mainWindow = BrowserWindow.getAllWindows()[0] ?? null;

  return Menu.buildFromTemplate([
    {
      label: 'BOS',
      type: 'normal',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: STATUS_LABELS[voiceStatus],
      type: 'normal',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: voiceStatus === 'listening' ? 'Stop Listening' : 'Start Listening',
      click: () => {
        mainWindow?.webContents.send('voice:toggle');
      },
    },
    {
      label: 'Run File Scan',
      click: () => {
        mainWindow?.webContents.send('action:runScan');
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        mainWindow?.webContents.send('navigate:settings');
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit BOS',
      click: () => {
        (app as any).isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/** Create and initialize the system tray */
export function createTray(): Tray {
  const icon = loadTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('BOS');

  updateTrayMenu('idle');

  // Double-click shows window
  tray.on('double-click', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });

  return tray;
}

/** Update the tray menu to reflect current voice status */
export function updateTrayMenu(status: VoiceStatus): void {
  if (!tray) return;

  currentVoiceStatus = status;
  tray.setToolTip(STATUS_TOOLTIPS[status]);
  tray.setContextMenu(buildContextMenu(status));
}

/** Get the current tray instance */
export function getTray(): Tray | null {
  return tray;
}

/** Destroy the tray icon */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
