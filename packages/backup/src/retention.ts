/**
 * Retention Manager — auto-deletes backup files after a configurable
 * 15-30 day retention period.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface RetentionConfig {
  /** Retention period in days. Must be 15-30. Default 30. */
  retentionDays: number;
  /** Local backup directory to clean. Default '/tmp/boss-backups'. */
  localDir?: string;
}

export interface RetentionRecord {
  id: string;
  filePath: string;
  destination: 'local' | 'git' | 's3';
  /** S3 key or git repo path, if applicable. */
  remoteKey?: string;
  createdAt: Date;
  expiresAt: Date;
  deleted: boolean;
  deletedAt?: Date;
}

export interface RetentionStats {
  totalTracked: number;
  activeFiles: number;
  expiredFiles: number;
  deletedFiles: number;
  oldestFile?: Date;
  newestFile?: Date;
}

// ── Manager ─────────────────────────────────────────────────────────

export class RetentionManager {
  private retentionDays: number;
  private localDir: string;
  private records: Map<string, RetentionRecord> = new Map();

  constructor(config: RetentionConfig) {
    // Clamp to 15-30 days
    this.retentionDays = Math.max(15, Math.min(30, config.retentionDays));
    this.localDir = config.localDir ?? '/tmp/boss-backups';
  }

  /**
   * Track a new backup file for retention.
   */
  track(filePath: string, destination: RetentionRecord['destination'], remoteKey?: string): RetentionRecord {
    const record: RetentionRecord = {
      id: `ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      destination,
      remoteKey,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.retentionDays * 24 * 60 * 60 * 1000),
      deleted: false,
    };

    this.records.set(record.id, record);
    return record;
  }

  /**
   * Run retention cleanup — delete all expired files.
   */
  async cleanup(): Promise<number> {
    const now = new Date();
    const expired = Array.from(this.records.values()).filter(
      (r) => !r.deleted && r.expiresAt <= now,
    );

    let deleted = 0;

    for (const record of expired) {
      try {
        await this.deleteBackupFile(record);
        record.deleted = true;
        record.deletedAt = new Date();
        deleted++;
      } catch {
        // Log and continue — will retry next cleanup cycle
      }
    }

    return deleted;
  }

  /**
   * Get retention stats.
   */
  getStats(): RetentionStats {
    const all = Array.from(this.records.values());
    const now = new Date();
    const active = all.filter((r) => !r.deleted && r.expiresAt > now);
    const expired = all.filter((r) => !r.deleted && r.expiresAt <= now);
    const deletedRecords = all.filter((r) => r.deleted);

    const dates = all.map((r) => r.createdAt.getTime());

    return {
      totalTracked: all.length,
      activeFiles: active.length,
      expiredFiles: expired.length,
      deletedFiles: deletedRecords.length,
      oldestFile: dates.length > 0 ? new Date(Math.min(...dates)) : undefined,
      newestFile: dates.length > 0 ? new Date(Math.max(...dates)) : undefined,
    };
  }

  /**
   * Get the configured retention period.
   */
  getRetentionDays(): number {
    return this.retentionDays;
  }

  /**
   * Update retention period. Does not retroactively change existing records.
   */
  setRetentionDays(days: number): void {
    this.retentionDays = Math.max(15, Math.min(30, days));
  }

  /**
   * Get all records (for audit/display).
   */
  getRecords(): RetentionRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  /**
   * Manually expire a specific record (force delete on next cleanup).
   */
  forceExpire(recordId: string): boolean {
    const record = this.records.get(recordId);
    if (!record || record.deleted) return false;
    record.expiresAt = new Date(0); // Expired immediately
    return true;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async deleteBackupFile(record: RetentionRecord): Promise<void> {
    switch (record.destination) {
      case 'local':
        await this.deleteLocalFile(record.filePath);
        break;
      case 'git':
        // Git-tracked files are managed by the git destination
        // Just remove from local clone if present
        await this.deleteLocalFile(record.filePath);
        break;
      case 's3':
        if (record.remoteKey) {
          await this.deleteS3Object(record.remoteKey);
        }
        await this.deleteLocalFile(record.filePath);
        break;
    }
  }

  // ── Filesystem / cloud stubs ──────────────────────────────────────

  private async deleteLocalFile(_path: string): Promise<void> {
    // TODO: wire to fs.unlink — ignore ENOENT (already deleted)
  }

  private async deleteS3Object(_key: string): Promise<void> {
    // TODO: wire to S3 DeleteObjectCommand
  }
}
