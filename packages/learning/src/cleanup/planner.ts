/**
 * Cleanup Planner — generates file cleanup proposals from device ingest results.
 *
 * Phase 1 (Audit): report only, no changes.
 * Phase 2 (Propose): present plans with approval required per category.
 */

import type { DeviceFileEntry } from '../onboarding/device-ingest.js';

// ── Types ───────────────────────────────────────────────────────────

export type CleanupCategory =
  | 'stale_downloads'
  | 'duplicates'
  | 'unnamed_screenshots'
  | 'large_files'
  | 'empty_folders'
  | 'orphaned_files'
  | 'temp_files';

export type CleanupAction = 'move' | 'rename' | 'archive' | 'delete';

export interface CleanupProposal {
  id: string;
  category: CleanupCategory;
  description: string;
  items: CleanupItem[];
  /** Total size reclaimed if approved. */
  reclaimableBytes: number;
  /** Whether the user has approved this proposal. */
  approved: boolean;
  createdAt: Date;
}

export interface CleanupItem {
  /** Source file path. */
  sourcePath: string;
  /** Proposed destination path (for move/rename). */
  destinationPath?: string;
  /** Proposed new name (for rename). */
  newName?: string;
  action: CleanupAction;
  reason: string;
  size: number;
}

export interface CleanupAudit {
  totalFilesScanned: number;
  proposals: CleanupProposal[];
  totalReclaimableBytes: number;
  generatedAt: Date;
}

export interface CleanupPlannerConfig {
  /** Days without modification to consider a file stale. Default 90. */
  staleDays?: number;
  /** Size threshold in bytes for large file detection. Default 100MB. */
  largeSizeThreshold?: number;
  /** Target directory for organized files. Default '~/BOS Organized'. */
  organizedDir?: string;
  /** Review folder for items pending deletion. Default '~/BOS Review'. */
  reviewDir?: string;
}

// ── Planner ─────────────────────────────────────────────────────────

export class CleanupPlanner {
  private config: Required<CleanupPlannerConfig>;

  constructor(config: CleanupPlannerConfig = {}) {
    this.config = {
      staleDays: config.staleDays ?? 90,
      largeSizeThreshold: config.largeSizeThreshold ?? 100 * 1024 * 1024,
      organizedDir: config.organizedDir ?? '~/BOS Organized',
      reviewDir: config.reviewDir ?? '~/BOS Review',
    };
  }

  /**
   * Generate cleanup proposals from a set of scanned files.
   * This is Phase 1 (audit) + Phase 2 (proposals). No files are touched.
   */
  generateProposals(files: DeviceFileEntry[]): CleanupAudit {
    const proposals: CleanupProposal[] = [];

    proposals.push(...this.findStaleDownloads(files));
    proposals.push(...this.findDuplicates(files));
    proposals.push(...this.findUnnamedScreenshots(files));
    proposals.push(...this.findLargeFiles(files));
    proposals.push(...this.findTempFiles(files));

    const totalReclaimable = proposals.reduce((sum, p) => sum + p.reclaimableBytes, 0);

    return {
      totalFilesScanned: files.length,
      proposals,
      totalReclaimableBytes: totalReclaimable,
      generatedAt: new Date(),
    };
  }

  /**
   * Approve a specific proposal by ID.
   */
  approve(audit: CleanupAudit, proposalId: string): boolean {
    const proposal = audit.proposals.find((p) => p.id === proposalId);
    if (!proposal) return false;
    proposal.approved = true;
    return true;
  }

  // ── Proposal generators ───────────────────────────────────────────

  private findStaleDownloads(files: DeviceFileEntry[]): CleanupProposal[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.staleDays);

    const stale = files.filter(
      (f) =>
        !f.isDirectory &&
        f.path.toLowerCase().includes('download') &&
        f.modifiedAt < cutoff,
    );

    if (stale.length === 0) return [];

    return [
      {
        id: `cp-stale-${Date.now()}`,
        category: 'stale_downloads',
        description: `${stale.length} files in Downloads not modified in ${this.config.staleDays}+ days`,
        items: stale.map((f) => ({
          sourcePath: f.path,
          destinationPath: `${this.config.reviewDir}/Downloads/${f.name}`,
          action: 'move' as CleanupAction,
          reason: `Not modified since ${f.modifiedAt.toISOString().split('T')[0]}`,
          size: f.size,
        })),
        reclaimableBytes: stale.reduce((sum, f) => sum + f.size, 0),
        approved: false,
        createdAt: new Date(),
      },
    ];
  }

  private findDuplicates(files: DeviceFileEntry[]): CleanupProposal[] {
    const nonDirFiles = files.filter((f) => !f.isDirectory);
    const byName = new Map<string, DeviceFileEntry[]>();

    for (const file of nonDirFiles) {
      const group = byName.get(file.name) ?? [];
      group.push(file);
      byName.set(file.name, group);
    }

    const duplicates = Array.from(byName.entries()).filter(([, group]) => group.length > 1);

    if (duplicates.length === 0) return [];

    const items: CleanupItem[] = [];
    for (const [, group] of duplicates) {
      // Keep newest, propose moving older copies to review
      const sorted = group.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
      for (let i = 1; i < sorted.length; i++) {
        items.push({
          sourcePath: sorted[i].path,
          destinationPath: `${this.config.reviewDir}/Duplicates/${sorted[i].name}`,
          action: 'move',
          reason: `Duplicate of ${sorted[0].path} (keeping newest)`,
          size: sorted[i].size,
        });
      }
    }

    return [
      {
        id: `cp-dupes-${Date.now()}`,
        category: 'duplicates',
        description: `${duplicates.length} sets of duplicate files found`,
        items,
        reclaimableBytes: items.reduce((sum, i) => sum + i.size, 0),
        approved: false,
        createdAt: new Date(),
      },
    ];
  }

  private findUnnamedScreenshots(files: DeviceFileEntry[]): CleanupProposal[] {
    const screenshotPatterns = [
      /^screenshot/i,
      /^screen shot/i,
      /^capture/i,
      /^snip/i,
      /^image\s?\d/i,
    ];

    const screenshots = files.filter(
      (f) =>
        !f.isDirectory &&
        screenshotPatterns.some((p) => p.test(f.name)) &&
        /\.(png|jpg|jpeg|webp|bmp)$/i.test(f.name),
    );

    if (screenshots.length === 0) return [];

    return [
      {
        id: `cp-screenshots-${Date.now()}`,
        category: 'unnamed_screenshots',
        description: `${screenshots.length} unnamed screenshots found`,
        items: screenshots.map((f) => ({
          sourcePath: f.path,
          destinationPath: `${this.config.organizedDir}/Screenshots/${f.name}`,
          action: 'move' as CleanupAction,
          reason: 'Unnamed screenshot — can be renamed with vision analysis',
          size: f.size,
        })),
        reclaimableBytes: 0, // Not deleting, just organizing
        approved: false,
        createdAt: new Date(),
      },
    ];
  }

  private findLargeFiles(files: DeviceFileEntry[]): CleanupProposal[] {
    const large = files.filter(
      (f) => !f.isDirectory && f.size >= this.config.largeSizeThreshold,
    );

    if (large.length === 0) return [];

    return [
      {
        id: `cp-large-${Date.now()}`,
        category: 'large_files',
        description: `${large.length} files over ${formatSize(this.config.largeSizeThreshold)}`,
        items: large
          .sort((a, b) => b.size - a.size)
          .map((f) => ({
            sourcePath: f.path,
            action: 'archive' as CleanupAction,
            reason: `Large file: ${formatSize(f.size)}`,
            size: f.size,
          })),
        reclaimableBytes: large.reduce((sum, f) => sum + f.size, 0),
        approved: false,
        createdAt: new Date(),
      },
    ];
  }

  private findTempFiles(files: DeviceFileEntry[]): CleanupProposal[] {
    const tempPatterns = [/\.tmp$/i, /\.temp$/i, /~$/, /\.bak$/i, /\.swp$/i, /\.DS_Store$/i, /Thumbs\.db$/i];

    const tempFiles = files.filter(
      (f) => !f.isDirectory && tempPatterns.some((p) => p.test(f.name)),
    );

    if (tempFiles.length === 0) return [];

    return [
      {
        id: `cp-temp-${Date.now()}`,
        category: 'temp_files',
        description: `${tempFiles.length} temporary/system files found`,
        items: tempFiles.map((f) => ({
          sourcePath: f.path,
          destinationPath: `${this.config.reviewDir}/Temp/${f.name}`,
          action: 'move' as CleanupAction,
          reason: 'Temporary or system file',
          size: f.size,
        })),
        reclaimableBytes: tempFiles.reduce((sum, f) => sum + f.size, 0),
        approved: false,
        createdAt: new Date(),
      },
    ];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
