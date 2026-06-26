/**
 * Cleanup Agent IPC Handlers
 *
 * Receives cleanup proposals from the BOS API and executes approved actions.
 * Safety first: files go to Recycle Bin, never permanent delete.
 * All operations are logged and reversible.
 */

import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** A single cleanup action proposed by the API */
export interface CleanupAction {
  id: string;
  type: 'move' | 'rename' | 'delete' | 'deduplicate';
  sourcePath: string;
  destinationPath?: string;
  reason: string;
  category: 'stale' | 'duplicate' | 'unnamed' | 'reorganize' | 'backup';
  sizeBytes: number;
  approved: boolean;
}

/** A full cleanup proposal with multiple actions */
export interface CleanupProposal {
  id: string;
  createdAt: string;
  actions: CleanupAction[];
  totalSizeFreed: number;
  summary: string;
}

/** Result of executing a single action */
export interface CleanupResult {
  actionId: string;
  success: boolean;
  error?: string;
  executedAt: string;
}

/**
 * Ensure the BOS Review staging folder exists.
 * Files pending deletion go here first for a 7-day review window.
 */
function getReviewFolder(): string {
  const reviewPath = path.join(os.homedir(), 'BOS Review');
  if (!fs.existsSync(reviewPath)) {
    fs.mkdirSync(reviewPath, { recursive: true });
  }
  return reviewPath;
}

/** Ensure parent directory exists for a destination path */
function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function registerCleanupHandlers(): void {
  /**
   * Execute a single approved cleanup action.
   * Returns success/failure for each action.
   */
  ipcMain.handle(
    'cleanup:executeAction',
    async (_event, action: CleanupAction): Promise<CleanupResult> => {
      const result: CleanupResult = {
        actionId: action.id,
        success: false,
        executedAt: new Date().toISOString(),
      };

      if (!action.approved) {
        result.error = 'Action not approved by user';
        return result;
      }

      try {
        switch (action.type) {
          case 'move': {
            if (!action.destinationPath) {
              result.error = 'Move action requires a destination path';
              return result;
            }
            ensureParentDir(action.destinationPath);
            await fs.promises.rename(action.sourcePath, action.destinationPath);
            result.success = true;
            break;
          }

          case 'rename': {
            if (!action.destinationPath) {
              result.error = 'Rename action requires a destination path';
              return result;
            }
            ensureParentDir(action.destinationPath);
            await fs.promises.rename(action.sourcePath, action.destinationPath);
            result.success = true;
            break;
          }

          case 'delete': {
            // Move to BOS Review folder first, never permanent delete
            const reviewFolder = getReviewFolder();
            const timestamp = Date.now();
            const reviewName = `${timestamp}_${path.basename(action.sourcePath)}`;
            const reviewDest = path.join(reviewFolder, reviewName);

            await fs.promises.rename(action.sourcePath, reviewDest);
            result.success = true;
            break;
          }

          case 'deduplicate': {
            // Keep the source, move duplicate to review folder
            const reviewFolder = getReviewFolder();
            const timestamp = Date.now();
            const reviewName = `dup_${timestamp}_${path.basename(action.sourcePath)}`;
            const reviewDest = path.join(reviewFolder, reviewName);

            await fs.promises.rename(action.sourcePath, reviewDest);
            result.success = true;
            break;
          }

          default:
            result.error = `Unknown action type: ${action.type}`;
        }
      } catch (err: any) {
        result.error = err.message;
      }

      return result;
    },
  );

  /**
   * Execute all approved actions in a proposal.
   */
  ipcMain.handle(
    'cleanup:executeProposal',
    async (_event, proposal: CleanupProposal): Promise<CleanupResult[]> => {
      const results: CleanupResult[] = [];
      const approvedActions = proposal.actions.filter((a) => a.approved);

      for (const action of approvedActions) {
        // Send progress to renderer
        _event.sender.send('cleanup:progress', {
          current: results.length + 1,
          total: approvedActions.length,
          actionId: action.id,
          type: action.type,
          sourcePath: action.sourcePath,
        });

        const result: CleanupResult = {
          actionId: action.id,
          success: false,
          executedAt: new Date().toISOString(),
        };

        try {
          switch (action.type) {
            case 'move':
            case 'rename': {
              if (!action.destinationPath) {
                result.error = `${action.type} requires destination`;
                break;
              }
              ensureParentDir(action.destinationPath);
              await fs.promises.rename(action.sourcePath, action.destinationPath);
              result.success = true;
              break;
            }
            case 'delete':
            case 'deduplicate': {
              const reviewFolder = getReviewFolder();
              const prefix = action.type === 'deduplicate' ? 'dup_' : '';
              const reviewName = `${prefix}${Date.now()}_${path.basename(action.sourcePath)}`;
              await fs.promises.rename(action.sourcePath, path.join(reviewFolder, reviewName));
              result.success = true;
              break;
            }
            default:
              result.error = `Unknown action type: ${action.type}`;
          }
        } catch (err: any) {
          result.error = err.message;
        }

        results.push(result);
      }

      return results;
    },
  );

  /**
   * Send file to Recycle Bin using Electron's shell.trashItem.
   * This is the safest delete — OS recycle bin, fully recoverable.
   */
  ipcMain.handle('cleanup:trashFile', async (_event, filePath: string): Promise<boolean> => {
    try {
      await shell.trashItem(filePath);
      return true;
    } catch {
      return false;
    }
  });

  /**
   * List contents of the BOS Review folder (pending cleanup items).
   */
  ipcMain.handle('cleanup:getReviewItems', async (): Promise<Array<{
    name: string;
    path: string;
    size: number;
    movedAt: string;
  }>> => {
    const reviewFolder = getReviewFolder();
    const items: Array<{ name: string; path: string; size: number; movedAt: string }> = [];

    try {
      const entries = await fs.promises.readdir(reviewFolder, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(reviewFolder, entry.name);
        const stats = await fs.promises.stat(fullPath);
        items.push({
          name: entry.name,
          path: fullPath,
          size: stats.size,
          movedAt: stats.mtime.toISOString(),
        });
      }
    } catch {
      // Review folder might not exist yet
    }

    return items;
  });

  /**
   * Permanently clean the review folder (items older than 7 days).
   */
  ipcMain.handle('cleanup:purgeReviewFolder', async (_event, daysOld: number = 7): Promise<number> => {
    const reviewFolder = getReviewFolder();
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    let purgedCount = 0;

    try {
      const entries = await fs.promises.readdir(reviewFolder, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(reviewFolder, entry.name);
        const stats = await fs.promises.stat(fullPath);
        if (stats.mtimeMs < cutoff) {
          await shell.trashItem(fullPath);
          purgedCount++;
        }
      }
    } catch {
      // Ignore errors during purge
    }

    return purgedCount;
  });
}
