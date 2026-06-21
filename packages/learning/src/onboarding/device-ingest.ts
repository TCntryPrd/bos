/**
 * Device Ingest — scans laptop/desktop filesystem for metadata extraction,
 * file organization patterns, and cleanup opportunities.
 */

import type { TenantContext } from '@boss/core';

import type { PlatformIngester, PlatformName } from './sprint.js';
import type { PlatformIngestResult, IngestPattern, ProgressTracker } from './progress.js';

// ── Types ───────────────────────────────────────────────────────────

export interface DeviceIngestConfig {
  /** Directories to scan. Default: home dir standard locations. */
  scanPaths?: string[];
  /** Max files to index. Default 10000. */
  maxFiles?: number;
  /** Skip dot-directories. Default true. */
  skipHidden?: boolean;
}

export interface DeviceFileEntry {
  path: string;
  name: string;
  extension: string;
  size: number;
  isDirectory: boolean;
  depth: number;
  modifiedAt: Date;
  accessedAt: Date;
}

export interface DeviceScanResult {
  files: DeviceFileEntry[];
  totalSize: number;
  scanPaths: string[];
}

// ── Ingester ────────────────────────────────────────────────────────

export class DeviceIngester implements PlatformIngester {
  readonly platform: PlatformName = 'device';
  private config: Required<DeviceIngestConfig>;

  constructor(config: DeviceIngestConfig = {}) {
    this.config = {
      scanPaths: config.scanPaths ?? ['~/Desktop', '~/Documents', '~/Downloads'],
      maxFiles: config.maxFiles ?? 10000,
      skipHidden: config.skipHidden ?? true,
    };
  }

  async ingest(ctx: TenantContext, tracker: ProgressTracker): Promise<PlatformIngestResult> {
    tracker.updateProgress('device', 0, 0, 'Scanning filesystem...');

    const scanResult = await this.scanFilesystem(ctx);
    const files = scanResult.files;
    const total = files.length;

    tracker.updateProgress('device', 0, total, `Found ${total} files to analyze`);

    // Analysis accumulators
    const extensionMap = new Map<string, { count: number; totalSize: number }>();
    const directoryMap = new Map<string, number>();
    const staleFiles: DeviceFileEntry[] = [];
    const largeFiles: DeviceFileEntry[] = [];
    const duplicateNames = new Map<string, DeviceFileEntry[]>();
    const depthDist = new Map<number, number>();

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const largeSizeThreshold = 100 * 1024 * 1024; // 100MB

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (!file.isDirectory) {
        // Extension tracking
        const ext = file.extension.toLowerCase() || '(none)';
        const extEntry = extensionMap.get(ext) ?? { count: 0, totalSize: 0 };
        extEntry.count++;
        extEntry.totalSize += file.size;
        extensionMap.set(ext, extEntry);

        // Stale file detection
        if (file.modifiedAt < ninetyDaysAgo) {
          staleFiles.push(file);
        }

        // Large file detection
        if (file.size >= largeSizeThreshold) {
          largeFiles.push(file);
        }

        // Duplicate name tracking
        const dupes = duplicateNames.get(file.name) ?? [];
        dupes.push(file);
        duplicateNames.set(file.name, dupes);
      }

      // Directory tracking
      const parentDir = file.path.substring(0, file.path.lastIndexOf('/'));
      directoryMap.set(parentDir, (directoryMap.get(parentDir) ?? 0) + 1);

      // Depth distribution
      depthDist.set(file.depth, (depthDist.get(file.depth) ?? 0) + 1);

      if ((i + 1) % 500 === 0) {
        tracker.updateProgress('device', i + 1, total, `Analyzed ${i + 1} of ${total} files`);
      }
    }

    tracker.updateProgress('device', total, total, 'Analysis complete');

    // Only include actual duplicates (2+ files with same name)
    const actualDuplicates = new Map(
      Array.from(duplicateNames.entries()).filter(([, entries]) => entries.length > 1),
    );

    const patterns = this.buildPatterns(
      extensionMap, directoryMap, staleFiles, largeFiles,
      actualDuplicates, depthDist, scanResult.totalSize, total,
    );

    return {
      platform: 'device',
      itemsProcessed: total,
      patterns,
      metadata: {
        totalFiles: total,
        totalSize: scanResult.totalSize,
        scanPaths: scanResult.scanPaths,
        staleFileCount: staleFiles.length,
        largeFileCount: largeFiles.length,
        duplicateNameCount: actualDuplicates.size,
        uniqueExtensions: extensionMap.size,
      },
    };
  }

  // ── Connector stubs ───────────────────────────────────────────────

  /**
   * Scan filesystem via Electron/desktop agent IPC.
   * Placeholder — will be wired to the desktop app agent.
   */
  private async scanFilesystem(_ctx: TenantContext): Promise<DeviceScanResult> {
    // TODO: wire to Electron desktop app IPC
    return { files: [], totalSize: 0, scanPaths: this.config.scanPaths };
  }

  // ── Pattern building ──────────────────────────────────────────────

  private buildPatterns(
    extensionMap: Map<string, { count: number; totalSize: number }>,
    directoryMap: Map<string, number>,
    staleFiles: DeviceFileEntry[],
    largeFiles: DeviceFileEntry[],
    duplicates: Map<string, DeviceFileEntry[]>,
    depthDist: Map<number, number>,
    totalSize: number,
    totalFiles: number,
  ): IngestPattern[] {
    const patterns: IngestPattern[] = [];

    if (totalFiles === 0) return patterns;

    // File type distribution
    const topExtensions = Array.from(extensionMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15);

    if (topExtensions.length > 0) {
      patterns.push({
        category: 'device.filetypes',
        description: `${extensionMap.size} file types across ${totalFiles} files`,
        confidence: 0.95,
        evidence: topExtensions.map(
          ([ext, data]) => `${ext}: ${data.count} files (${formatSize(data.totalSize)})`,
        ),
      });
    }

    // Folder density (busiest folders)
    const busiestDirs = Array.from(directoryMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (busiestDirs.length > 0) {
      patterns.push({
        category: 'device.organization',
        description: 'Busiest directories',
        confidence: 0.9,
        evidence: busiestDirs.map(([dir, count]) => `${dir}: ${count} files`),
      });
    }

    // Stale files (cleanup opportunity)
    if (staleFiles.length > 0) {
      const staleSize = staleFiles.reduce((sum, f) => sum + f.size, 0);
      patterns.push({
        category: 'device.cleanup',
        description: `${staleFiles.length} files not modified in 90+ days (${formatSize(staleSize)})`,
        confidence: 0.85,
        evidence: staleFiles.slice(0, 10).map((f) => `${f.path} (${formatSize(f.size)})`),
      });
    }

    // Large files
    if (largeFiles.length > 0) {
      patterns.push({
        category: 'device.large_files',
        description: `${largeFiles.length} files over 100MB`,
        confidence: 0.95,
        evidence: largeFiles
          .sort((a, b) => b.size - a.size)
          .slice(0, 10)
          .map((f) => `${f.path} (${formatSize(f.size)})`),
      });
    }

    // Duplicates
    if (duplicates.size > 0) {
      const totalDupeFiles = Array.from(duplicates.values()).reduce((sum, files) => sum + files.length, 0);
      patterns.push({
        category: 'device.duplicates',
        description: `${duplicates.size} duplicate filenames (${totalDupeFiles} files total)`,
        confidence: 0.7,
        evidence: Array.from(duplicates.entries())
          .slice(0, 10)
          .map(([name, files]) => `${name}: ${files.length} copies`),
      });
    }

    // Overall storage
    patterns.push({
      category: 'device.storage',
      description: `Total scanned: ${formatSize(totalSize)} across ${totalFiles} files`,
      confidence: 1.0,
      evidence: [
        `Max depth: ${Math.max(...Array.from(depthDist.keys()), 0)}`,
        `Directories: ${new Set(Array.from(directoryMap.keys())).size}`,
      ],
    });

    return patterns;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
