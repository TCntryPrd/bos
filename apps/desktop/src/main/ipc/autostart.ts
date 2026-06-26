/**
 * Auto-Start IPC Handlers
 *
 * Manages Windows auto-start (launch on boot) via Electron's
 * app.setLoginItemSettings API.
 */

import { ipcMain, app } from 'electron';
import { getStore } from '../store.js';

export function registerAutoStartHandlers(): void {
  /** Check if auto-start is currently enabled in the OS */
  ipcMain.handle('autostart:isEnabled', (): boolean => {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  });

  /** Enable auto-start */
  ipcMain.handle('autostart:enable', (): void => {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      args: ['--autostart'],
    });
    const store = getStore();
    store.set('autoStart', true);
  });

  /** Disable auto-start */
  ipcMain.handle('autostart:disable', (): void => {
    app.setLoginItemSettings({
      openAtLogin: false,
    });
    const store = getStore();
    store.set('autoStart', false);
  });

  /** Toggle auto-start */
  ipcMain.handle('autostart:toggle', (): boolean => {
    const settings = app.getLoginItemSettings();
    const newValue = !settings.openAtLogin;

    app.setLoginItemSettings({
      openAtLogin: newValue,
      openAsHidden: newValue,
      args: newValue ? ['--autostart'] : [],
    });

    const store = getStore();
    store.set('autoStart', newValue);
    return newValue;
  });
}
