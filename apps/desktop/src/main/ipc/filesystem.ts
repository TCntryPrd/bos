/**
 * Filesystem IPC Handlers
 *
 * Provides the renderer process with safe, scoped access to local filesystem.
 * Scans user directories (Documents, Desktop, Downloads, Pictures) and sends
 * metadata to BOS API for analysis.
 */

import { ipcMain, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStore } from '../store.js';

export interface FileMetadata {
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

export interface ScanResult {
  rootPath: string;
  label: string;
  files: FileMetadata[];
  totalSize: number;
  fileCount: number;
  dirCount: number;
  scannedAt: string;
  errors: string[];
}

/** Default directories to scan on Windows */
function getDefaultScanPaths(): Array<{ path: string; label: string }> {
  const home = os.homedir();
  return [
    { path: path.join(home, 'Documents'), label: 'Documents' },
    { path: path.join(home, 'Desktop'), label: 'Desktop' },
    { path: path.join(home, 'Downloads'), label: 'Downloads' },
    { path: path.join(home, 'Pictures'), label: 'Pictures' },
  ];
}

/** Check if a path should be excluded based on configured patterns */
function shouldExclude(filePath: string, excludePatterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return excludePatterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return normalized.includes(`/${p}/`) || normalized.endsWith(`/${p}`);
  });
}

/** Recursively scan a directory and collect file metadata */
async function scanDirectory(
  dirPath: string,
  rootPath: string,
  excludePatterns: string[],
  maxDepth: number = 10,
  currentDepth: number = 0,
): Promise<{ files: FileMetadata[]; errors: string[] }> {
  const files: FileMetadata[] = [];
  const errors: string[] = [];

  if (currentDepth > maxDepth) return { files, errors };

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err: any) {
    errors.push(`Cannot read ${dirPath}: ${err.message}`);
    return { files, errors };
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (shouldExclude(fullPath, excludePatterns)) continue;

    try {
      const stats = await fs.promises.stat(fullPath);
      const relativePath = path.relative(rootPath, fullPath);

      files.push({
        name: entry.name,
        path: fullPath,
        relativePath,
        size: stats.size,
        extension: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
        isDirectory: entry.isDirectory(),
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        accessedAt: stats.atime.toISOString(),
      });

      if (entry.isDirectory()) {
        const subResult = await scanDirectory(
          fullPath,
          rootPath,
          excludePatterns,
          maxDepth,
          currentDepth + 1,
        );
        files.push(...subResult.files);
        errors.push(...subResult.errors);
      }
    } catch (err: any) {
      errors.push(`Cannot stat ${fullPath}: ${err.message}`);
    }
  }

  return { files, errors };
}

export function registerFileSystemHandlers(): void {
  /** Get the default scan paths for this machine */
  ipcMain.handle('fs:getDefaultScanPaths', (): Array<{ path: string; label: string }> => {
    return getDefaultScanPaths().filter((p) => fs.existsSync(p.path));
  });

  /** Get the user's configured scan paths */
  ipcMain.handle('fs:getScanPaths', (): string[] => {
    const store = getStore();
    const configured = store.get('scanPaths', []);
    if (configured.length > 0) return configured;
    return getDefaultScanPaths()
      .filter((p) => fs.existsSync(p.path))
      .map((p) => p.path);
  });

  /** Scan a specific directory */
  ipcMain.handle('fs:scanDirectory', async (_event, dirPath: string): Promise<ScanResult> => {
    const store = getStore();
    const excludePatterns = store.get('excludePatterns', []);
    const label = path.basename(dirPath);

    const { files, errors } = await scanDirectory(dirPath, dirPath, excludePatterns);

    const totalSize = files.reduce((sum, f) => sum + (f.isDirectory ? 0 : f.size), 0);
    const fileCount = files.filter((f) => !f.isDirectory).length;
    const dirCount = files.filter((f) => f.isDirectory).length;

    return {
      rootPath: dirPath,
      label,
      files,
      totalSize,
      fileCount,
      dirCount,
      scannedAt: new Date().toISOString(),
      errors,
    };
  });

  /** Scan all configured paths */
  ipcMain.handle('fs:scanAll', async (): Promise<ScanResult[]> => {
    const store = getStore();
    const excludePatterns = store.get('excludePatterns', []);
    const paths = getDefaultScanPaths().filter((p) => fs.existsSync(p.path));
    const configuredPaths = store.get('scanPaths', []);

    const scanTargets =
      configuredPaths.length > 0
        ? configuredPaths.map((p) => ({ path: p, label: path.basename(p) }))
        : paths;

    const results: ScanResult[] = [];

    for (const target of scanTargets) {
      const { files, errors } = await scanDirectory(target.path, target.path, excludePatterns);
      const totalSize = files.reduce((sum, f) => sum + (f.isDirectory ? 0 : f.size), 0);

      results.push({
        rootPath: target.path,
        label: target.label,
        files,
        totalSize,
        fileCount: files.filter((f) => !f.isDirectory).length,
        dirCount: files.filter((f) => f.isDirectory).length,
        scannedAt: new Date().toISOString(),
        errors,
      });
    }

    return results;
  });

  /** Check if a path exists */
  ipcMain.handle('fs:exists', (_event, filePath: string): boolean => {
    return fs.existsSync(filePath);
  });

  /** Get home directory */
  ipcMain.handle('fs:getHomePath', (): string => {
    return os.homedir();
  });

  /** Open a path in system file explorer */
  ipcMain.handle('fs:showInExplorer', async (_event, filePath: string): Promise<void> => {
    const { shell } = await import('electron');
    shell.showItemInFolder(filePath);
  });
}
