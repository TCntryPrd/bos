/**
 * Host status composite tool — vS.0.1.
 *
 * Single brain-tool call that returns a comprehensive snapshot of the
 * entire host: OS, containers, services, backups, n8n, CI, git, cron,
 * and firewall. All sections collected in parallel; individual failures
 * degrade gracefully (section shows { error } instead of data).
 *
 * Read-only / observer-tier.
 */

import type { BrainTool } from '@boss/brain';
import { handleBackupStatus } from './backup-status.js';

export const hostStatusTool: BrainTool = {
  name: 'boss_host_status',
  description:
    'Comprehensive host health snapshot in one call: OS info, Docker containers, ' +
    'systemd services, apt updates, backup health (all 5 assets), n8n workflow stats, ' +
    'recent GitHub Actions CI runs, recent git commits, crontab entries, and firewall ' +
    'posture. Read-only composite view — use this instead of calling individual sys tools.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const ALL_HOST_STATUS_TOOLS: BrainTool[] = [hostStatusTool];

// ── Data paths inside the API container ─────────────────────────────────────
const SCRIPTS = '/data/home/boss-dev/scripts';

// ── Section collectors ──────────────────────────────────────────────────────

async function collectOsInfo(): Promise<Record<string, unknown>> {
  // Read from host-generated status file — sys-info.sh produces malformed JSON
  // when run inside Alpine (the container), so the cron writes it on the host.
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/sys-info-status.json`, 'utf-8');
  return JSON.parse(raw);
}

async function collectDocker(): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/docker-status.txt`, 'utf-8');
  const lines = raw.trim().split('\n');
  // First line is header; rest are containers
  const containers = lines.slice(1).map((line) => {
    const parts = line.split(/\s{2,}/);
    return { name: parts[0], status: parts[1], image: parts[2], ports: parts[3] ?? '' };
  });
  return { count: containers.length, containers };
}

async function collectServices(): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/services-status.txt`, 'utf-8');
  return { raw: raw.trim() };
}

async function collectAptUpdates(): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/updates-check.txt`, 'utf-8');
  const upgradable = raw.split('\n').filter((l) => l.includes('upgradable'));
  return { pending_count: upgradable.length, packages: upgradable };
}

async function collectBackupHealth(): Promise<Record<string, unknown>> {
  const raw = await handleBackupStatus();
  return JSON.parse(raw);
}

async function collectN8n(): Promise<Record<string, unknown>> {
  // n8n is localhost-only on the host; read from status file written by cron
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/n8n-status.txt`, 'utf-8');
  return JSON.parse(raw);
}

async function collectGithubCi(): Promise<Record<string, unknown>> {
  // gh CLI is on the host, not in the container — read from status file
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/gh-ci-status.json`, 'utf-8');
  const runs = JSON.parse(raw) as Array<Record<string, unknown>>;
  return { runs };
}

async function collectGitRecent(): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/git-recent.txt`, 'utf-8');
  const commits = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date };
    });
  return { commits };
}

async function collectCrontab(): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/crontab-status.txt`, 'utf-8');
  const entries = raw
    .trim()
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  return { count: entries.length, entries };
}

async function collectFirewall(): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${SCRIPTS}/firewall-status.txt`, 'utf-8');
  return { status: raw.trim() };
}

async function collectSecurity(): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const results: Record<string, unknown> = {};

  try {
    const ports = await fs.readFile(`${SCRIPTS}/security-ports.txt`, 'utf-8');
    const portLines = ports.trim().split('\n').slice(1).filter(l => l.trim());
    results.listening_ports = portLines.length;
  } catch { results.listening_ports = 'unavailable'; }

  try {
    const auth = await fs.readFile(`${SCRIPTS}/security-authlog.txt`, 'utf-8');
    const lines = auth.trim().split('\n');
    results.auth_log = {
      failed_passwords: lines.filter(l => l.includes('Failed password')).length,
      invalid_users: lines.filter(l => l.includes('Invalid user')).length,
      sudo_invocations: lines.filter(l => l.includes('sudo:')).length,
    };
  } catch { results.auth_log = 'unavailable'; }

  try {
    const keys = await fs.readFile(`${SCRIPTS}/security-ssh-keys.txt`, 'utf-8');
    const keyLines = keys.trim().split('\n').filter(l => l && !l.startsWith('#'));
    results.ssh_authorized_keys = keyLines.length;
  } catch { results.ssh_authorized_keys = 'unavailable'; }

  try {
    const f2b = await fs.readFile(`${SCRIPTS}/security-fail2ban.txt`, 'utf-8');
    results.fail2ban = f2b.trim();
  } catch { results.fail2ban = 'unavailable'; }

  return results;
}

// ── Composite handler ───────────────────────────────────────────────────────

type Section = [string, () => Promise<Record<string, unknown>>];

const SECTIONS: Section[] = [
  ['os', collectOsInfo],
  ['docker', collectDocker],
  ['systemd_services', collectServices],
  ['apt_updates', collectAptUpdates],
  ['backup_health', collectBackupHealth],
  ['n8n', collectN8n],
  ['github_ci', collectGithubCi],
  ['git_recent', collectGitRecent],
  ['crontab', collectCrontab],
  ['firewall', collectFirewall],
  ['security', collectSecurity],
];

export async function handleHostStatus(): Promise<string> {
  const results = await Promise.allSettled(SECTIONS.map(([, fn]) => fn()));

  const assembled: Record<string, unknown> = {
    ok: true,
    collected_at: new Date().toISOString(),
  };

  for (let i = 0; i < SECTIONS.length; i++) {
    const [name] = SECTIONS[i];
    const result = results[i];
    assembled[name] =
      result.status === 'fulfilled'
        ? result.value
        : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
  }

  return JSON.stringify(assembled);
}
