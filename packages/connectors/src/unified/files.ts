/**
 * Unified Files interface — provider-agnostic.
 * upload(file) -> works with either Google Drive or OneDrive.
 */

import type {
  DriveFile,
  FileSearchParams,
  UploadFileParams,
  FileService,
  ConnectedAccount,
} from '../types.js';
import { GoogleDriveConnector } from '../google/drive.js';
import { OneDriveConnector } from '../microsoft/drive.js';
import type { GoogleClient } from '../google/api-client.js';
import type { GraphClient } from '../microsoft/graph-client.js';
import { logger } from '../logger.js';

export class UnifiedFileService implements FileService {
  private googleDrives = new Map<string, GoogleDriveConnector>();
  private oneDrives = new Map<string, OneDriveConnector>();

  constructor(
    accounts: ConnectedAccount[],
    googleClient?: GoogleClient,
    graphClient?: GraphClient,
  ) {
    for (const account of accounts) {
      if (account.provider === 'google' && googleClient) {
        this.googleDrives.set(account.id, new GoogleDriveConnector(googleClient, account.id));
      } else if (account.provider === 'microsoft' && graphClient) {
        this.oneDrives.set(account.id, new OneDriveConnector(graphClient, account.id));
      }
    }
  }

  async listFiles(params?: FileSearchParams): Promise<DriveFile[]> {
    if (params?.accountId) {
      return this.getConnector(params.accountId).listFiles(params);
    }

    const allFiles: DriveFile[] = [];
    for (const [, connector] of this.allConnectors()) {
      try {
        allFiles.push(...(await connector.listFiles(params)));
      } catch (err) {
        logger.warn({ err }, 'Failed to list files');
      }
    }
    return allFiles.sort((a, b) =>
      (b.modifiedAt?.getTime() ?? 0) - (a.modifiedAt?.getTime() ?? 0),
    );
  }

  async getFile(fileId: string, accountId?: string): Promise<DriveFile> {
    if (accountId) {
      return this.getConnector(accountId).getFile(fileId);
    }
    return this.tryAll((c) => c.getFile(fileId));
  }

  async upload(params: UploadFileParams): Promise<DriveFile> {
    const connector = params.accountId
      ? this.getConnector(params.accountId)
      : this.defaultConnector();
    return connector.upload(params);
  }

  async download(fileId: string, accountId?: string): Promise<Buffer> {
    if (accountId) {
      return this.getConnector(accountId).download(fileId);
    }
    return this.tryAll((c) => c.download(fileId));
  }

  async delete(fileId: string, accountId?: string): Promise<void> {
    if (accountId) {
      return this.getConnector(accountId).deleteFile(fileId);
    }
    return this.tryAll((c) => c.deleteFile(fileId));
  }

  async search(params: FileSearchParams): Promise<DriveFile[]> {
    if (params.accountId) {
      return this.getConnector(params.accountId).search(params);
    }

    const allFiles: DriveFile[] = [];
    for (const [, connector] of this.allConnectors()) {
      try {
        allFiles.push(...(await connector.search(params)));
      } catch (err) {
        logger.warn({ err }, 'Failed to search files');
      }
    }
    return allFiles;
  }

  // ── Internal ──────────────────────────────────────────────────

  private getConnector(accountId: string): FileConnector {
    const google = this.googleDrives.get(accountId);
    if (google) return google;
    const onedrive = this.oneDrives.get(accountId);
    if (onedrive) return onedrive;
    throw new Error(`No file connector for account ${accountId}`);
  }

  private defaultConnector(): FileConnector {
    const first =
      this.googleDrives.values().next().value ??
      this.oneDrives.values().next().value;
    if (!first) throw new Error('No file storage accounts connected');
    return first;
  }

  private *allConnectors(): Generator<[string, FileConnector]> {
    yield* this.googleDrives;
    yield* this.oneDrives;
  }

  private async tryAll<T>(fn: (c: FileConnector) => Promise<T>): Promise<T> {
    for (const [, connector] of this.allConnectors()) {
      try {
        return await fn(connector);
      } catch {
        continue;
      }
    }
    throw new Error('Operation failed across all file accounts');
  }
}

type FileConnector = GoogleDriveConnector | OneDriveConnector;
