/**
 * Backup Scheduler — runs backups at a configurable 30-60 minute interval.
 *
 * Coordinates Postgres dumps, Weaviate exports, encryption, and
 * destination delivery. Reports health status for the healing engine.
 */

import { PostgresDumper } from './postgres-dump.js';
import { WeaviateExporter } from './weaviate-export.js';
import { BackupEncryptor } from './encrypt.js';
import { RetentionManager } from './retention.js';
import type { BackupDestination } from './destinations/git.js';

// ── Types ───────────────────────────────────────────────────────────

export interface BackupSchedulerConfig {
  /** Interval in minutes. Must be 30-60. Default 30. */
  intervalMinutes: number;
  /** Tenant ID for this backup schedule. */
  tenantId: string;
  /** Whether to include Weaviate export. Default true. */
  includeWeaviate?: boolean;
  /** Postgres connection string. */
  postgresUrl: string;
  /** Weaviate endpoint. */
  weaviateUrl?: string;
  /** Encryption key (AES-256, 32 bytes hex-encoded). */
  encryptionKey: string;
  /** Retention period in days. Default 30. */
  retentionDays?: number;
  /** Backup destination(s). */
  destinations: BackupDestination[];
}

export interface BackupResult {
  id: string;
  tenantId: string;
  success: boolean;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  /** Paths of encrypted backup files. */
  files: BackupFileInfo[];
  errors: string[];
  /** Destination delivery results. */
  deliveries: DeliveryResult[];
}

export interface BackupFileInfo {
  type: 'postgres' | 'weaviate';
  path: string;
  sizeBytes: number;
  encrypted: boolean;
}

export interface DeliveryResult {
  destination: string;
  success: boolean;
  error?: string;
}

export interface SchedulerStatus {
  running: boolean;
  lastBackup?: BackupResult;
  nextBackupAt?: Date;
  totalBackups: number;
  totalFailures: number;
}

// ── Scheduler ───────────────────────────────────────────────────────

export class BackupScheduler {
  private config: BackupSchedulerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private status: SchedulerStatus;
  private dumper: PostgresDumper;
  private exporter: WeaviateExporter;
  private encryptor: BackupEncryptor;
  private retention: RetentionManager;

  constructor(config: BackupSchedulerConfig) {
    // Clamp interval to 30-60 minutes
    const interval = Math.max(30, Math.min(60, config.intervalMinutes));
    this.config = { ...config, intervalMinutes: interval };

    this.dumper = new PostgresDumper({ connectionUrl: config.postgresUrl });
    this.exporter = new WeaviateExporter({
      endpoint: config.weaviateUrl ?? 'http://localhost:8080',
    });
    this.encryptor = new BackupEncryptor({ key: config.encryptionKey });
    this.retention = new RetentionManager({
      retentionDays: config.retentionDays ?? 30,
    });

    this.status = {
      running: false,
      totalBackups: 0,
      totalFailures: 0,
    };
  }

  /**
   * Start the backup scheduler.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.status.running = true;

    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    this.status.nextBackupAt = new Date(Date.now() + intervalMs);

    this.timer = setInterval(() => {
      void this.runBackup();
    }, intervalMs);

    // Run first backup immediately
    void this.runBackup();
  }

  /**
   * Stop the backup scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.status.running = false;
    this.status.nextBackupAt = undefined;
  }

  /**
   * Get current scheduler status.
   */
  getStatus(): SchedulerStatus {
    return { ...this.status };
  }

  /**
   * Run a backup manually (outside the schedule).
   */
  async runBackup(): Promise<BackupResult> {
    const startedAt = new Date();
    const backupId = `backup-${this.config.tenantId}-${startedAt.getTime()}`;
    const files: BackupFileInfo[] = [];
    const errors: string[] = [];

    // Phase 1: Dump Postgres
    try {
      const pgResult = await this.dumper.dump(this.config.tenantId);
      const encryptedPath = await this.encryptor.encryptFile(pgResult.path);
      files.push({
        type: 'postgres',
        path: encryptedPath,
        sizeBytes: pgResult.sizeBytes,
        encrypted: true,
      });
    } catch (err) {
      errors.push(`Postgres dump failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Phase 2: Export Weaviate (if enabled)
    if (this.config.includeWeaviate !== false) {
      try {
        const wvResult = await this.exporter.export(this.config.tenantId);
        const encryptedPath = await this.encryptor.encryptFile(wvResult.path);
        files.push({
          type: 'weaviate',
          path: encryptedPath,
          sizeBytes: wvResult.sizeBytes,
          encrypted: true,
        });
      } catch (err) {
        errors.push(`Weaviate export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Phase 3: Deliver to destinations
    const deliveries: DeliveryResult[] = [];
    for (const dest of this.config.destinations) {
      try {
        await dest.deliver(files.map((f) => f.path));
        deliveries.push({ destination: dest.name, success: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        deliveries.push({ destination: dest.name, success: false, error });
        errors.push(`Delivery to ${dest.name} failed: ${error}`);
      }
    }

    // Phase 4: Retention cleanup
    try {
      await this.retention.cleanup();
    } catch (err) {
      errors.push(`Retention cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const result: BackupResult = {
      id: backupId,
      tenantId: this.config.tenantId,
      success: errors.length === 0,
      startedAt,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
      files,
      errors,
      deliveries,
    };

    // Update status
    this.status.lastBackup = result;
    this.status.totalBackups++;
    if (!result.success) this.status.totalFailures++;

    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    this.status.nextBackupAt = new Date(Date.now() + intervalMs);

    return result;
  }
}
