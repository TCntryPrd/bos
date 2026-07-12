/**
 * OneDrive connector via Microsoft Graph API.
 * Files, search, upload, download.
 */

import type {
  DriveFile,
  FileSearchParams,
  UploadFileParams,
  Provider,
} from '../types.js';
import type { GraphClient } from './graph-client.js';

interface GraphDriveItem {
  id: string;
  name: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
  size: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentReference?: { id: string };
  webUrl?: string;
  '@microsoft.graph.downloadUrl'?: string;
  shared?: Record<string, unknown>;
}

export class OneDriveConnector {
  private readonly provider: Provider = 'microsoft';

  constructor(
    private client: GraphClient,
    private accountId: string,
  ) {}

  async listFiles(params?: FileSearchParams): Promise<DriveFile[]> {
    let path = '/me/drive/root/children';
    if (params?.parentId) {
      path = `/me/drive/items/${params.parentId}/children`;
    }

    const data = await this.client.get<{ value: GraphDriveItem[] }>(
      path,
      {
        $top: String(params?.maxResults ?? 50),
        $orderby: 'lastModifiedDateTime desc',
        $select: 'id,name,file,folder,size,createdDateTime,lastModifiedDateTime,parentReference,webUrl,shared',
      },
      { accountId: params?.accountId ?? this.accountId },
    );

    return data.value.map((item) => this.parseItem(item));
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const data = await this.client.get<GraphDriveItem>(
      `/me/drive/items/${fileId}`,
      { $select: 'id,name,file,folder,size,createdDateTime,lastModifiedDateTime,parentReference,webUrl,shared' },
      { accountId: this.accountId },
    );

    return this.parseItem(data);
  }

  async upload(params: UploadFileParams): Promise<DriveFile> {
    let path: string;
    if (params.parentId) {
      path = `/me/drive/items/${params.parentId}:/${encodeURIComponent(params.name)}:/content`;
    } else {
      path = `/me/drive/root:/${encodeURIComponent(params.name)}:/content`;
    }

    const data = await this.client.put<GraphDriveItem>(
      path,
      params.content,
      {
        accountId: params.accountId ?? this.accountId,
        contentType: params.mimeType,
      },
    );

    return this.parseItem(data);
  }

  async download(fileId: string): Promise<Buffer> {
    const tokens = await this.client.getAllTokens();
    const token = tokens.find((t) => t.accountId === this.accountId)?.accessToken;
    if (!token) throw new Error('No valid token for download');

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) {
      throw new Error(`OneDrive download failed: ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.client.delete(
      `/me/drive/items/${fileId}`,
      { accountId: this.accountId },
    );
  }

  async search(params: FileSearchParams): Promise<DriveFile[]> {
    if (!params.query) return this.listFiles(params);

    const data = await this.client.get<{ value: GraphDriveItem[] }>(
      `/me/drive/root/search(q='${encodeURIComponent(params.query)}')`,
      { $top: String(params.maxResults ?? 50) },
      { accountId: params.accountId ?? this.accountId },
    );

    return data.value.map((item) => this.parseItem(item));
  }

  // ── Internal ──────────────────────────────────────────────────

  private parseItem(item: GraphDriveItem): DriveFile {
    return {
      id: item.id,
      accountId: this.accountId,
      provider: this.provider,
      name: item.name,
      mimeType: item.file?.mimeType ?? (item.folder ? 'application/vnd.ms-folder' : 'application/octet-stream'),
      size: item.size,
      createdAt: item.createdDateTime ? new Date(item.createdDateTime) : undefined,
      modifiedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : undefined,
      parentId: item.parentReference?.id,
      webUrl: item.webUrl,
      downloadUrl: item['@microsoft.graph.downloadUrl'],
      shared: !!item.shared,
    };
  }
}
