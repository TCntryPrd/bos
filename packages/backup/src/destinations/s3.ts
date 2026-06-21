/**
 * S3 Backup Destination — uploads encrypted backup files to AWS S3 or
 * S3-compatible storage (MinIO, Backblaze B2, etc).
 * Layer 1 auth: IAM credentials or instance profile.
 */

import type { BackupDestination } from './git.js';

// ── Types ───────────────────────────────────────────────────────────

export interface S3DestinationConfig {
  /** S3 bucket name. */
  bucket: string;
  /** Key prefix (folder) for backups. Default 'boss-backups/'. */
  prefix?: string;
  /** AWS region. Default 'us-east-1'. */
  region?: string;
  /** Custom S3 endpoint for compatible services. */
  endpoint?: string;
  /** Access key ID. If not set, uses instance profile / env vars. */
  accessKeyId?: string;
  /** Secret access key. */
  secretAccessKey?: string;
  /** Storage class. Default 'STANDARD'. */
  storageClass?: S3StorageClass;
}

export type S3StorageClass =
  | 'STANDARD'
  | 'STANDARD_IA'
  | 'ONEZONE_IA'
  | 'GLACIER'
  | 'DEEP_ARCHIVE';

export interface S3UploadResult {
  key: string;
  etag: string;
  sizeBytes: number;
}

// ── Destination ─────────────────────────────────────────────────────

export class S3BackupDestination implements BackupDestination {
  readonly name = 's3';
  private config: Required<S3DestinationConfig>;

  constructor(config: S3DestinationConfig) {
    this.config = {
      bucket: config.bucket,
      prefix: config.prefix ?? 'boss-backups/',
      region: config.region ?? 'us-east-1',
      endpoint: config.endpoint ?? '',
      accessKeyId: config.accessKeyId ?? '',
      secretAccessKey: config.secretAccessKey ?? '',
      storageClass: config.storageClass ?? 'STANDARD',
    };
  }

  /**
   * Upload encrypted backup files to S3.
   */
  async deliver(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      const filename = filePath.split('/').pop() ?? filePath;
      const key = `${this.config.prefix}${filename}`;
      await this.uploadFile(filePath, key);
    }
  }

  /**
   * List backup files in the S3 bucket.
   */
  async listBackups(): Promise<S3BackupEntry[]> {
    return this.listObjects(this.config.prefix);
  }

  /**
   * Download a backup file from S3.
   */
  async download(key: string, outputPath: string): Promise<void> {
    await this.downloadObject(key, outputPath);
  }

  /**
   * Delete a backup file from S3.
   */
  async deleteBackup(key: string): Promise<void> {
    await this.deleteObject(key);
  }

  /**
   * Delete multiple backup files from S3.
   */
  async deleteBackups(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      try {
        await this.deleteObject(key);
        deleted++;
      } catch {
        // Log but continue
      }
    }
    return deleted;
  }

  // ── S3 client stubs ───────────────────────────────────────────────

  /**
   * Upload a file to S3.
   * Placeholder — will use AWS SDK v3 PutObjectCommand.
   */
  private async uploadFile(_localPath: string, _key: string): Promise<S3UploadResult> {
    // TODO: wire to @aws-sdk/client-s3 PutObjectCommand
    // Include: StorageClass, ServerSideEncryption (SSE-S3 as additional layer)
    return { key: _key, etag: '', sizeBytes: 0 };
  }

  /**
   * List objects with a prefix.
   */
  private async listObjects(_prefix: string): Promise<S3BackupEntry[]> {
    // TODO: wire to @aws-sdk/client-s3 ListObjectsV2Command
    return [];
  }

  /**
   * Download an object from S3.
   */
  private async downloadObject(_key: string, _outputPath: string): Promise<void> {
    // TODO: wire to @aws-sdk/client-s3 GetObjectCommand
  }

  /**
   * Delete an object from S3.
   */
  private async deleteObject(_key: string): Promise<void> {
    // TODO: wire to @aws-sdk/client-s3 DeleteObjectCommand
  }
}

// ── Supporting Types ────────────────────────────────────────────────

export interface S3BackupEntry {
  key: string;
  sizeBytes: number;
  lastModified: Date;
  storageClass: string;
}
