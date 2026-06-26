/**
 * BOS Desktop — Main Process Entry Point
 *
 * Responsibilities:
 * - Create the main BrowserWindow (dashboard)
 * - System tray icon with listening status
 * - IPC handlers for filesystem access, voice, and cleanup
 * - Auto-start on Windows boot (optional)
 * - Minimize to system tray
 *
 * NOTE: This file re-exports index.ts functionality with the tray
 * extracted to its own module. The actual entry point is index.ts.
 */

// This module exists as a named alias. See index.ts for the entry point.
export { } from './index.js';
