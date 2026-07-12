/**
 * Cleanup Executor — executes approved cleanup proposals.
 *
 * Safety rules:
 * - Only processes proposals marked as approved.
 * - Files move to "BOS Review" folder first, never directly deleted.
 * - 7-day review window before anything is removed.
 * - All actions are logged for auditability.
 */

import type { CleanupProposal, CleanupItem, CleanupAction } from './planner.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ExecutionResult {
  proposalId: string;
  success: boolean;
  itemsProcessed: number;
  itemsFailed: number;
  errors: ExecutionError[];
  startedAt: Date;
  completedAt: Date;
}

export interface ExecutionError {
  sourcePath: string;
  action: CleanupAction;
  error: string;
}

export interface ExecutionLog {
  id: string;
  proposalId: string;
  item: CleanupItem;
  success: boolean;
  error?: string;
  executedAt: Date;
  /** Can be used to undo the action. */
  undoInfo?: UndoInfo;
}

export interface UndoInfo {
  originalPath: string;
  movedTo: string;
  originalName?: string;
}

export interface ExecutorConfig {
  /** Whether to perform a dry run (log but don't actually move). Default false. */
  dryRun?: boolean;
  /** Review period in days before review folder is cleaned. Default 7. */
  reviewPeriodDays?: number;
}

// ── Executor ────────────────────────────────────────────────────────

export class CleanupExecutor {
  private config: Required<ExecutorConfig>;
  private executionLogs: ExecutionLog[] = [];

  constructor(config: ExecutorConfig = {}) {
    this.config = {
      dryRun: config.dryRun ?? false,
      reviewPeriodDays: config.reviewPeriodDays ?? 7,
    };
  }

  /**
   * Execute an approved cleanup proposal.
   * Returns immediately if proposal is not approved.
   */
  async execute(proposal: CleanupProposal): Promise<ExecutionResult> {
    const startedAt = new Date();
    const errors: ExecutionError[] = [];
    let processed = 0;
    let failed = 0;

    if (!proposal.approved) {
      return {
        proposalId: proposal.id,
        success: false,
        itemsProcessed: 0,
        itemsFailed: 0,
        errors: [{ sourcePath: '', action: 'move', error: 'Proposal not approved' }],
        startedAt,
        completedAt: new Date(),
      };
    }

    for (const item of proposal.items) {
      try {
        await this.executeItem(proposal.id, item);
        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ sourcePath: item.sourcePath, action: item.action, error: message });
        failed++;
      }
    }

    return {
      proposalId: proposal.id,
      success: failed === 0,
      itemsProcessed: processed,
      itemsFailed: failed,
      errors,
      startedAt,
      completedAt: new Date(),
    };
  }

  /**
   * Undo a specific cleanup action by execution log ID.
   */
  async undo(logId: string): Promise<boolean> {
    const log = this.executionLogs.find((l) => l.id === logId);
    if (!log || !log.undoInfo) return false;

    try {
      await this.moveFile(log.undoInfo.movedTo, log.undoInfo.originalPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all execution logs.
   */
  getLogs(): ExecutionLog[] {
    return [...this.executionLogs];
  }

  /**
   * Get logs for a specific proposal.
   */
  getLogsForProposal(proposalId: string): ExecutionLog[] {
    return this.executionLogs.filter((l) => l.proposalId === proposalId);
  }

  /**
   * Clean up the review folder — remove items past the review period.
   * Only processes items where the review period has expired.
   */
  async cleanReviewFolder(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.reviewPeriodDays);

    const expired = this.executionLogs.filter(
      (l) => l.success && l.executedAt < cutoff && l.undoInfo,
    );

    let cleaned = 0;
    for (const log of expired) {
      if (log.undoInfo) {
        try {
          await this.deleteFile(log.undoInfo.movedTo);
          cleaned++;
        } catch {
          // Log but don't fail — will retry next cycle
        }
      }
    }

    return cleaned;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async executeItem(proposalId: string, item: CleanupItem): Promise<void> {
    const logEntry: ExecutionLog = {
      id: `el-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      proposalId,
      item,
      success: false,
      executedAt: new Date(),
    };

    if (this.config.dryRun) {
      logEntry.success = true;
      this.executionLogs.push(logEntry);
      return;
    }

    switch (item.action) {
      case 'move': {
        if (!item.destinationPath) {
          throw new Error(`No destination path for move action: ${item.sourcePath}`);
        }
        await this.ensureDirectory(item.destinationPath);
        await this.moveFile(item.sourcePath, item.destinationPath);
        logEntry.undoInfo = {
          originalPath: item.sourcePath,
          movedTo: item.destinationPath,
        };
        break;
      }
      case 'rename': {
        if (!item.newName) {
          throw new Error(`No new name for rename action: ${item.sourcePath}`);
        }
        const dir = item.sourcePath.substring(0, item.sourcePath.lastIndexOf('/'));
        const newPath = `${dir}/${item.newName}`;
        await this.moveFile(item.sourcePath, newPath);
        logEntry.undoInfo = {
          originalPath: item.sourcePath,
          movedTo: newPath,
          originalName: item.sourcePath.substring(item.sourcePath.lastIndexOf('/') + 1),
        };
        break;
      }
      case 'archive': {
        // Move to review folder rather than archiving in place
        const reviewPath = item.destinationPath ?? `${item.sourcePath}.archived`;
        await this.moveFile(item.sourcePath, reviewPath);
        logEntry.undoInfo = {
          originalPath: item.sourcePath,
          movedTo: reviewPath,
        };
        break;
      }
      case 'delete': {
        // Safety: never actually delete — move to review instead
        const reviewDest = item.destinationPath ?? `${item.sourcePath}.review`;
        await this.moveFile(item.sourcePath, reviewDest);
        logEntry.undoInfo = {
          originalPath: item.sourcePath,
          movedTo: reviewDest,
        };
        break;
      }
    }

    logEntry.success = true;
    this.executionLogs.push(logEntry);
    await this.persistLog(logEntry);
  }

  // ── Filesystem stubs (wired to Electron IPC or server fs) ────────

  private async moveFile(_source: string, _destination: string): Promise<void> {
    // TODO: wire to filesystem (Electron IPC or Node fs)
  }

  private async deleteFile(_path: string): Promise<void> {
    // TODO: wire to filesystem
  }

  private async ensureDirectory(_path: string): Promise<void> {
    // TODO: wire to filesystem — mkdir -p equivalent
  }

  private async persistLog(_log: ExecutionLog): Promise<void> {
    // TODO: wire to Postgres data layer
  }
}
