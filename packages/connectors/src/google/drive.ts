/**
 * Google Drive connector — files, search, upload, download.
 */

import type { DriveFile, FileSearchParams, UploadFileParams, Provider } from '../types.js';
import type { GoogleClient } from './api-client.js';

const DRIVE = '/drive/v3';

interface GDriveFile {
  id: string; name: string; mimeType: string; size?: string;
  createdTime?: string; modifiedTime?: string; parents?: string[];
  webViewLink?: string; webContentLink?: string; shared?: boolean;
}

export class GoogleDriveConnector {
  private readonly provider: Provider = 'google';
  constructor(private client: GoogleClient, private accountId: string) {}

  async listFiles(params?: FileSearchParams): Promise<DriveFile[]> {
    const q = this.buildQuery(params);
    const qp: Record<string, string> = {
      fields: 'files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,webContentLink,shared)',
      pageSize: String(params?.maxResults ?? 50), orderBy: 'modifiedTime desc',
    };
    if (q) qp.q = q;
    const data = await this.client.get<{ files?: GDriveFile[] }>(`${DRIVE}/files`, qp, { accountId: params?.accountId ?? this.accountId });
    return (data.files ?? []).map((f) => this.parse(f));
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const data = await this.client.get<GDriveFile>(`${DRIVE}/files/${fileId}`, {
      fields: 'id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,webContentLink,shared',
    }, { accountId: this.accountId });
    return this.parse(data);
  }

  async upload(params: UploadFileParams): Promise<DriveFile> {
    const metadata: Record<string, unknown> = { name: params.name, mimeType: params.mimeType };
    if (params.parentId) metadata.parents = [params.parentId];
    const boundary = `boss_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const body = [
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
      `--${boundary}`, `Content-Type: ${params.mimeType}`, 'Content-Transfer-Encoding: base64', '',
      params.content.toString('base64'), `--${boundary}--`,
    ].join('\r\n');
    const data = await this.client.post<GDriveFile>(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,createdTime,modifiedTime,webViewLink`,
      body, { accountId: params.accountId ?? this.accountId, contentType: `multipart/related; boundary=${boundary}` },
    );
    return this.parse(data);
  }

  async download(fileId: string): Promise<Buffer> {
    const tokens = await this.client.getAllTokens();
    const token = tokens.find((t) => t.accountId === this.accountId)?.accessToken;
    if (!token) throw new Error('No valid token for download');
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Drive download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.client.delete(`${DRIVE}/files/${fileId}`, { accountId: this.accountId });
  }

  async search(params: FileSearchParams): Promise<DriveFile[]> {
    return this.listFiles(params);
  }

  private buildQuery(params?: FileSearchParams): string {
    const parts = ['trashed = false'];
    if (params?.query) parts.push(`fullText contains '${params.query.replace(/'/g, "\\'")}'`);
    if (params?.mimeType) parts.push(`mimeType = '${params.mimeType}'`);
    if (params?.parentId) parts.push(`'${params.parentId}' in parents`);
    return parts.join(' and ');
  }

  private parse(file: GDriveFile): DriveFile {
    return {
      id: file.id, accountId: this.accountId, provider: this.provider, name: file.name,
      mimeType: file.mimeType, size: file.size ? parseInt(file.size, 10) : undefined,
      createdAt: file.createdTime ? new Date(file.createdTime) : undefined,
      modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
      parentId: file.parents?.[0], webUrl: file.webViewLink, downloadUrl: file.webContentLink, shared: file.shared,
    };
  }
}
