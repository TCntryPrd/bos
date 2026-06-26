/**
 * @boss/backup — Encrypted backup system with dual-auth and retention.
 * Phase 8 implementation.
 */

// Core backup
export { BackupScheduler } from './scheduler.js';
export type {
  BackupSchedulerConfig,
  BackupResult,
  BackupFileInfo,
  DeliveryResult,
  SchedulerStatus,
} from './scheduler.js';
export { PostgresDumper } from './postgres-dump.js';
export type { PostgresDumpConfig, DumpResult } from './postgres-dump.js';
export { WeaviateExporter } from './weaviate-export.js';
export type { WeaviateExportConfig, ExportResult, CollectionExport } from './weaviate-export.js';

// Encryption
export { BackupEncryptor } from './encrypt.js';
export type { EncryptorConfig, EncryptionMetadata, KeyInfo } from './encrypt.js';

// Destinations
export { GitBackupDestination } from './destinations/git.js';
export type { BackupDestination, GitDestinationConfig } from './destinations/git.js';
export { S3BackupDestination } from './destinations/s3.js';
export type { S3DestinationConfig, S3StorageClass, S3BackupEntry } from './destinations/s3.js';
export { DualBackupDestination } from './destinations/both.js';
export type { DualDestinationConfig, DualDeliveryResult } from './destinations/both.js';

// Retention
export { RetentionManager } from './retention.js';
export type { RetentionConfig, RetentionRecord, RetentionStats } from './retention.js';
