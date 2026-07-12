/**
 * Drive Ingest — scans file structure, naming conventions,
 * sharing patterns, and active documents.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngester, PlatformName } from './sprint.js';
import type { PlatformIngestResult, IngestPattern, ProgressTracker } from './progress.js';

// ── Types ───────────────────────────────────────────────────────────

export interface DriveIngestConfig {
  /** Max depth for folder tree traversal. Default 10. */
  maxDepth?: number;
  /** Max files to scan metadata for. Default 5000. */
  maxFiles?: number;
}

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parentPath: string;
  depth: number;
  sharedWith: string[];
  createdAt: Date;
  modifiedAt: Date;
}

export interface FolderStructure {
  path: string;
  depth: number;
  fileCount: number;
  childFolderCount: number;
}

// ── Ingester ────────────────────────────────────────────────────────

export class DriveIngester implements PlatformIngester {
  readonly platform: PlatformName = 'drive';
  private config: Required<DriveIngestConfig>;

  constructor(config: DriveIngestConfig = {}) {
    this.config = {
      maxDepth: config.maxDepth ?? 10,
      maxFiles: config.maxFiles ?? 5000,
    };
  }

  async ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult> {
    tracker.updateProgress('drive', 0, 0, 'Scanning folder structure...');

    // Phase 1: Discover folder structure
    const folders = await this.scanFolders(ctx);
    tracker.updateProgress('drive', 0, 0, `Found ${folders.length} folders`);

    // Phase 2: Scan files
    const totalFiles = await this.countFiles(ctx);
    tracker.updateProgress('drive', 0, totalFiles, `Scanning ${totalFiles} files...`);

    const mimeTypes = new Map<string, number>();
    const collaborators = new Map<string, number>();
    const namingTokens = new Map<string, number>();
    const recentFiles: DriveFileItem[] = [];
    let processed = 0;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    while (processed < Math.min(totalFiles, this.config.maxFiles)) {
      const batch = await this.fetchFileBatch(ctx, processed, 100);
      if (batch.length === 0) break;

      for (const file of batch) {
        // Track MIME types
        mimeTypes.set(file.mimeType, (mimeTypes.get(file.mimeType) ?? 0) + 1);

        // Track collaborators
        for (const person of file.sharedWith) {
          collaborators.set(person, (collaborators.get(person) ?? 0) + 1);
        }

        // Track naming conventions
        const tokens = this.extractNamingTokens(file.name);
        for (const token of tokens) {
          namingTokens.set(token, (namingTokens.get(token) ?? 0) + 1);
        }

        // Track recent activity
        if (file.modifiedAt >= thirtyDaysAgo) {
          recentFiles.push(file);
        }
      }

      processed += batch.length;
      tracker.updateProgress('drive', processed, totalFiles, `Scanned ${processed} of ${totalFiles} files`);
    }

    const patterns = this.buildPatterns(folders, mimeTypes, collaborators, namingTokens, recentFiles, processed);

    return {
      platform: 'drive',
      itemsProcessed: processed,
      patterns,
      metadata: {
        folderCount: folders.length,
        fileCount: processed,
        uniqueCollaborators: collaborators.size,
        recentFileCount: recentFiles.length,
        topMimeTypes: Array.from(mimeTypes.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
      },
    };
  }

  // ── Connector stubs ───────────────────────────────────────────────

  private async scanFolders(_ctx: TenantContext): Promise<FolderStructure[]> {
    // TODO: wire to @boss/connectors unified files.listFolders()
    return [];
  }

  private async countFiles(_ctx: TenantContext): Promise<number> {
    // TODO: wire to @boss/connectors unified files.count()
    return 0;
  }

  private async fetchFileBatch(
    _ctx: TenantContext,
    _offset: number,
    _limit: number,
  ): Promise<DriveFileItem[]> {
    // TODO: wire to @boss/connectors unified files.list()
    return [];
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Extract naming convention tokens from a filename.
   * Detects patterns like dates, separators, prefixes.
   */
  private extractNamingTokens(filename: string): string[] {
    const tokens: string[] = [];
    const base = filename.replace(/\.[^.]+$/, '');

    if (base.includes('-')) tokens.push('separator:dash');
    if (base.includes('_')) tokens.push('separator:underscore');
    if (/\d{4}-\d{2}-\d{2}/.test(base)) tokens.push('format:date-iso');
    if (/\d{2}\.\d{2}\.\d{4}/.test(base)) tokens.push('format:date-eu');
    if (/^[A-Z]/.test(base)) tokens.push('case:title');
    if (base === base.toLowerCase()) tokens.push('case:lower');
    if (base === base.toUpperCase()) tokens.push('case:upper');
    if (/v\d+/i.test(base)) tokens.push('format:versioned');
    if (/\(copy\)|\(\d+\)/i.test(base)) tokens.push('format:duplicate');

    return tokens;
  }

  private buildPatterns(
    folders: FolderStructure[],
    mimeTypes: Map<string, number>,
    collaborators: Map<string, number>,
    namingTokens: Map<string, number>,
    recentFiles: DriveFileItem[],
    totalScanned: number,
  ): IngestPattern[] {
    const patterns: IngestPattern[] = [];

    // Folder structure depth
    if (folders.length > 0) {
      const maxDepth = Math.max(...folders.map((f) => f.depth));
      patterns.push({
        category: 'files.structure',
        description: `${folders.length} folders, max depth ${maxDepth}`,
        confidence: 0.95,
        evidence: folders.slice(0, 10).map((f) => f.path),
      });
    }

    // File type distribution
    const topTypes = Array.from(mimeTypes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topTypes.length > 0) {
      patterns.push({
        category: 'files.types',
        description: 'File type distribution',
        confidence: 0.9,
        evidence: topTypes.map(([mime, count]) => `${mime}: ${count} files`),
      });
    }

    // Top collaborators
    const topCollabs = Array.from(collaborators.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topCollabs.length > 0) {
      patterns.push({
        category: 'files.collaboration',
        description: `${collaborators.size} file collaborators identified`,
        confidence: 0.85,
        evidence: topCollabs.map(([person, count]) => `${person}: ${count} shared files`),
      });
    }

    // Naming conventions
    const topTokens = Array.from(namingTokens.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topTokens.length > 0 && totalScanned > 0) {
      patterns.push({
        category: 'files.naming',
        description: 'File naming conventions detected',
        confidence: 0.7,
        evidence: topTokens.map(([token, count]) =>
          `${token}: ${count} files (${Math.round((count / totalScanned) * 100)}%)`),
      });
    }

    // Recent activity
    if (recentFiles.length > 0) {
      patterns.push({
        category: 'files.activity',
        description: `${recentFiles.length} files modified in last 30 days`,
        confidence: 0.95,
        evidence: recentFiles.slice(0, 10).map((f) => f.name),
      });
    }

    return patterns;
  }
}
