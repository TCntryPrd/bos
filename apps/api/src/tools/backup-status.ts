/**
 * Backup-status brain tool — vD.0.1.
 *
 * Reads the JSON snapshot written by scripts/backup-status.sh after each
 * backup run and reports per-asset freshness. Considered "stale" if any
 * asset has not had a successful backup in >25h. Returns a JSON-string
 * payload so callers (smoke tests, brain UI) can parse it.
 *
 * Read-only / observer-tier.
 */

import type { BrainTool } from '@boss/brain';

export const backupStatusTool: BrainTool = {
  name: 'boss_backup_status',
  description:
    'Reports last-attempt and last-success timestamps for each backup asset ' +
    '(postgres, weaviate, n8n, cc-memory, cc-config). Returns "degraded" if ' +
    'any asset has not had a successful backup in >25h. Read-only.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const ALL_BACKUP_STATUS_TOOLS: BrainTool[] = [backupStatusTool];

const REQUIRED_ASSETS = [
  'postgres',
  'weaviate',
  'n8n',
  'cc-memory',
  'cc-config',
] as const;

const STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000;

interface AssetEntry {
  last_attempt?: string;
  last_success?: string;
  size_bytes?: number;
  last_error?: string;
}

interface AssetReport {
  asset: string;
  state: 'fresh' | 'stale' | 'never_attempted';
  last_attempt: string | null;
  last_success: string | null;
  age_hours: number | null;
  size_bytes: number;
  last_error: string | null;
}

interface BackupStatusResult {
  ok: boolean;
  overall?: 'healthy' | 'degraded';
  checked_at?: string;
  stale_threshold_hours?: number;
  assets?: AssetReport[];
  error?: string;
  path?: string;
  detail?: string;
}

export async function handleBackupStatus(): Promise<string> {
  const fs = await import('node:fs/promises');
  const statusFile =
    process.env.BACKUP_STATUS_FILE ?? '/var/lib/boss-backups/status.json';

  let raw: string;
  try {
    raw = await fs.readFile(statusFile, 'utf-8');
  } catch (e) {
    const result: BackupStatusResult = {
      ok: false,
      error: 'status_file_unreadable',
      path: statusFile,
      detail: e instanceof Error ? e.message : String(e),
    };
    return JSON.stringify(result);
  }

  let status: Record<string, AssetEntry | string>;
  try {
    status = JSON.parse(raw) as Record<string, AssetEntry | string>;
  } catch (e) {
    const result: BackupStatusResult = {
      ok: false,
      error: 'status_file_unparseable',
      path: statusFile,
      detail: e instanceof Error ? e.message : String(e),
    };
    return JSON.stringify(result);
  }

  const now = Date.now();
  const assetReports: AssetReport[] = REQUIRED_ASSETS.map((asset) => {
    const entry = status[asset];
    if (!entry || typeof entry === 'string') {
      return {
        asset,
        state: 'never_attempted',
        last_attempt: null,
        last_success: null,
        age_hours: null,
        size_bytes: 0,
        last_error: null,
      };
    }
    const lastSuccess = entry.last_success ?? '';
    const successMs = lastSuccess ? Date.parse(lastSuccess) : NaN;
    const ageMs = Number.isFinite(successMs) ? now - successMs : Infinity;
    const isStale = ageMs > STALE_THRESHOLD_MS;
    return {
      asset,
      state: isStale ? 'stale' : 'fresh',
      last_attempt: entry.last_attempt ?? null,
      last_success: lastSuccess || null,
      age_hours: Number.isFinite(ageMs)
        ? Math.round((ageMs / 3600000) * 10) / 10
        : null,
      size_bytes: entry.size_bytes ?? 0,
      last_error: entry.last_error || null,
    };
  });

  const anyDegraded = assetReports.some(
    (r) => r.state === 'stale' || r.state === 'never_attempted',
  );

  const result: BackupStatusResult = {
    ok: true,
    overall: anyDegraded ? 'degraded' : 'healthy',
    checked_at: new Date(now).toISOString(),
    stale_threshold_hours: 25,
    assets: assetReports,
  };
  return JSON.stringify(result);
}
