import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { handleBackupStatus } from './backup-status';

const TMP_STATUS = '/tmp/boss-backup-status-test.json';

beforeEach(() => {
  process.env.BACKUP_STATUS_FILE = TMP_STATUS;
});

afterEach(async () => {
  await fs.rm(TMP_STATUS, { force: true });
});

describe('handleBackupStatus', () => {
  it('returns ok=false when status file missing', async () => {
    const out = JSON.parse(await handleBackupStatus());
    expect(out.ok).toBe(false);
    expect(out.error).toBe('status_file_unreadable');
  });

  it('reports fresh + healthy when all 5 assets within 25h', async () => {
    const now = new Date().toISOString();
    await fs.writeFile(
      TMP_STATUS,
      JSON.stringify({
        postgres:    { last_attempt: now, last_success: now, size_bytes: 7300000 },
        weaviate:    { last_attempt: now, last_success: now, size_bytes: 220000000 },
        n8n:         { last_attempt: now, last_success: now, size_bytes: 50000 },
        'cc-memory': { last_attempt: now, last_success: now, size_bytes: 1000000 },
        'cc-config': { last_attempt: now, last_success: now, size_bytes: 5000 },
      }),
    );
    const out = JSON.parse(await handleBackupStatus());
    expect(out.ok).toBe(true);
    expect(out.overall).toBe('healthy');
    expect(out.assets.every((a: { state: string }) => a.state === 'fresh')).toBe(true);
  });

  it('reports degraded + stale when an asset is >25h old', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    await fs.writeFile(
      TMP_STATUS,
      JSON.stringify({
        postgres:    { last_attempt: now, last_success: now, size_bytes: 7300000 },
        weaviate:    { last_attempt: old, last_success: old, size_bytes: 220000000 },
        n8n:         { last_attempt: now, last_success: now, size_bytes: 50000 },
        'cc-memory': { last_attempt: now, last_success: now, size_bytes: 1000000 },
        'cc-config': { last_attempt: now, last_success: now, size_bytes: 5000 },
      }),
    );
    const out = JSON.parse(await handleBackupStatus());
    expect(out.ok).toBe(true);
    expect(out.overall).toBe('degraded');
    expect(
      out.assets.find((a: { asset: string }) => a.asset === 'weaviate').state,
    ).toBe('stale');
  });

  it('reports degraded with never_attempted when asset missing from file', async () => {
    const now = new Date().toISOString();
    await fs.writeFile(
      TMP_STATUS,
      JSON.stringify({
        postgres: { last_attempt: now, last_success: now, size_bytes: 7300000 },
      }),
    );
    const out = JSON.parse(await handleBackupStatus());
    expect(out.overall).toBe('degraded');
    expect(
      out.assets.find((a: { asset: string }) => a.asset === 'weaviate').state,
    ).toBe('never_attempted');
  });
});
