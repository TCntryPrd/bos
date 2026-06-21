/**
 * Host security / defensive posture tools — vS.1.1.
 *
 * All observer-tier, read-only. Read from status files written by
 * the host cron (update-status-files.sh every 5 min).
 *
 * These are also wired into boss_host_status as the "security" subsection.
 */

import type { BrainTool } from '@boss/brain';

const SCRIPTS = '/data/home/boss-dev/scripts';

export const hostFirewallTool: BrainTool = {
  name: 'boss_host_firewall',
  description: 'Show UFW firewall status and rules. Returns the raw ufw status output.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const hostPortsTool: BrainTool = {
  name: 'boss_host_ports',
  description:
    'Show all listening TCP ports on the host (ss -tlnp). Reveals exposed services ' +
    'and any unexpected listeners.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const hostCertsTool: BrainTool = {
  name: 'boss_host_certs',
  description:
    'Show Let\'s Encrypt certificate expiry dates for all domains. Flags certs ' +
    'expiring within 14 days.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const hostAuthlogTool: BrainTool = {
  name: 'boss_host_authlog',
  description:
    'Recent auth.log digest: failed SSH login attempts, invalid users, and sudo ' +
    'invocations. Last 50 entries. Use to detect brute-force attempts.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const hostSshKeysTool: BrainTool = {
  name: 'boss_host_ssh_keys',
  description:
    'Inventory of SSH authorized_keys on the host. Shows key type, fingerprint summary, ' +
    'and comment for each key.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const hostFail2banTool: BrainTool = {
  name: 'boss_host_fail2ban',
  description:
    'Show fail2ban status: active jails, currently banned IPs, and total ban counts.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export const ALL_HOST_SECURITY_TOOLS: BrainTool[] = [
  hostFirewallTool,
  hostPortsTool,
  hostCertsTool,
  hostAuthlogTool,
  hostSshKeysTool,
  hostFail2banTool,
];

// ── Handlers ────────────────────────────────────────────────────────────────

async function readStatusFile(filename: string): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(`${SCRIPTS}/${filename}`, 'utf-8');
}

export async function handleHostFirewall(): Promise<string> {
  return readStatusFile('firewall-status.txt');
}

export async function handleHostPorts(): Promise<string> {
  const raw = await readStatusFile('security-ports.txt');
  const lines = raw.trim().split('\n');
  // Count listening ports (skip header line)
  const ports = lines.slice(1).filter(l => l.trim());
  return `${ports.length} listening TCP ports:\n\n${raw}`;
}

export async function handleHostCerts(): Promise<string> {
  const raw = await readStatusFile('security-certs.txt');
  if (raw.trim() === 'no_letsencrypt') {
    return 'No Let\'s Encrypt certificates found at /etc/letsencrypt/live/.';
  }

  const lines = raw.trim().split('\n').filter(Boolean);
  const now = Date.now();
  const WARN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

  const results = lines.map((line) => {
    const [domain, expiry] = line.split('|');
    const expiryMs = Date.parse(expiry ?? '');
    const daysLeft = Number.isFinite(expiryMs) ? Math.round((expiryMs - now) / 86400000) : null;
    const flag = daysLeft !== null && daysLeft < 14 ? ' ⚠ EXPIRING SOON' : '';
    return `  ${domain}: expires ${expiry ?? 'unknown'} (${daysLeft ?? '?'} days)${flag}`;
  });

  return `${lines.length} certificate(s):\n${results.join('\n')}`;
}

export async function handleHostAuthlog(): Promise<string> {
  const raw = await readStatusFile('security-authlog.txt');
  const lines = raw.trim().split('\n').filter(Boolean);

  if (lines.length === 1 && lines[0].includes('not readable')) {
    return 'auth.log not readable (permission denied or missing).';
  }

  // Count by type
  const failed = lines.filter(l => l.includes('Failed password')).length;
  const invalid = lines.filter(l => l.includes('Invalid user')).length;
  const sudo = lines.filter(l => l.includes('sudo:')).length;

  return `Auth log digest (last ${lines.length} entries):\n` +
    `  Failed passwords: ${failed}\n` +
    `  Invalid users: ${invalid}\n` +
    `  Sudo invocations: ${sudo}\n\n` +
    `Recent entries:\n${lines.slice(-20).join('\n')}`;
}

export async function handleHostSshKeys(): Promise<string> {
  const raw = await readStatusFile('security-ssh-keys.txt');
  if (raw.trim() === 'no authorized_keys') {
    return 'No authorized_keys file found.';
  }

  const keys = raw.trim().split('\n').filter(l => l && !l.startsWith('#'));
  const summary = keys.map((k, i) => {
    const parts = k.split(/\s+/);
    const type = parts[0] ?? 'unknown';
    const comment = parts.slice(2).join(' ') || 'no comment';
    return `  ${i + 1}. ${type} — ${comment}`;
  });

  return `${keys.length} authorized key(s):\n${summary.join('\n')}`;
}

export async function handleHostFail2ban(): Promise<string> {
  return readStatusFile('security-fail2ban.txt');
}
