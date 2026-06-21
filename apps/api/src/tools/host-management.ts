/**
 * Host-OS management tools — vS.1.0.
 *
 * Curated, audit-logged interfaces for host system management.
 * Every invocation writes to boss_admin_audit BEFORE executing.
 *
 * Execution model:
 *   - Read operations: read from status files written by host cron
 *   - Write operations: execute via host-side dispatcher script
 *     (scripts/host-cmd-dispatch.sh) which the container triggers
 *     by writing a command file to the bind-mounted scripts/ dir.
 *
 * All write tools default to dry_run=true. Pass dry_run=false to execute.
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

const SCRIPTS = '/data/home/boss-dev/scripts';

// ── Audit helper ────────────────────────────────────────────────────────────

async function auditLog(
  toolName: string,
  args: Record<string, unknown>,
  dryRun: boolean,
  result: string,
  status: 'success' | 'failure' | 'denied',
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO boss_admin_audit (tool_name, args, dry_run, result, status)
         VALUES ($1, $2, $3, $4, $5)`,
      [toolName, JSON.stringify(args), dryRun, result.substring(0, 5000), status],
    );
  } catch {
    // Audit failure should not block the tool — log to stderr
    console.error(`[audit] Failed to log ${toolName}`);
  }
}

// ── Tool definitions ────────────────────────────────────────────────────────

export const hostAptTool: BrainTool = {
  name: 'boss_host_apt',
  description:
    'Check for or apply system package updates. Default is dry-run (read-only check). ' +
    'Set dry_run=false to actually run apt upgrade. All invocations are audit-logged.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['check', 'upgrade'],
        description: 'check = list upgradable (observer), upgrade = apply updates (admin)',
      },
      dry_run: {
        type: 'boolean',
        description: 'If true (default), simulate the upgrade without applying. Set false to execute.',
      },
    },
    required: ['action'],
  },
};

export const hostSystemctlTool: BrainTool = {
  name: 'boss_host_systemctl',
  description:
    'Restart or reload a curated list of systemd services. Only allowed services: ' +
    'boss-agent, boss-gateway, meeting-listener, littlebird-weaviate, screenpipe-weaviate. ' +
    'All invocations are audit-logged.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['restart', 'reload', 'status'], description: 'systemctl action' },
      service: { type: 'string', description: 'Service name (without .service suffix)' },
      dry_run: { type: 'boolean', description: 'If true (default), show what would happen without executing' },
    },
    required: ['action', 'service'],
  },
};

export const hostCronTool: BrainTool = {
  name: 'boss_host_cron',
  description:
    'Read or modify the user crontab. List shows current entries. Add/remove operations ' +
    'are audit-logged and default to dry-run.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'remove'],
        description: 'list = show crontab, add = add entry, remove = remove matching entry',
      },
      entry: { type: 'string', description: 'Cron entry to add or pattern to match for removal' },
      dry_run: { type: 'boolean', description: 'If true (default), show what would change without executing' },
    },
    required: ['action'],
  },
};

export const hostAuditTool: BrainTool = {
  name: 'boss_admin_audit_log',
  description:
    'View the admin audit log. Shows recent admin tool invocations with timestamps, ' +
    'arguments, results, and dry-run status.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max entries to return (default 20)' },
      tool_name: { type: 'string', description: 'Filter by tool name' },
    },
    required: [],
  },
};

export const ALL_HOST_MANAGEMENT_TOOLS: BrainTool[] = [
  hostAptTool,
  hostSystemctlTool,
  hostCronTool,
  hostAuditTool,
];

// ── Allowed services for systemctl ──────────────────────────────────────────

const ALLOWED_SERVICES = new Set([
  'boss-agent',
  'boss-gateway',
  'meeting-listener',
  'littlebird-weaviate',
  'screenpipe-weaviate',
  'openclaw-gateway',
]);

// ── Handlers ────────────────────────────────────────────────────────────────

export async function handleHostApt(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? 'check');
  const dryRun = args.dry_run !== false; // default true

  if (action === 'check') {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(`${SCRIPTS}/updates-check.txt`, 'utf-8');
    const upgradable = raw.split('\n').filter(l => l.includes('upgradable'));
    const result = upgradable.length === 0
      ? 'System is up to date.'
      : `${upgradable.length} packages can be upgraded:\n${upgradable.join('\n')}`;
    await auditLog('boss_host_apt', { action }, true, result, 'success');
    return result;
  }

  if (action === 'upgrade') {
    if (dryRun) {
      const result = '[DRY RUN] Would execute: sudo apt-get update && sudo apt-get upgrade -y\nSet dry_run=false to execute.';
      await auditLog('boss_host_apt', { action, dry_run: true }, true, result, 'success');
      return result;
    }

    // Write command to dispatch queue
    const fs = await import('node:fs/promises');
    const cmdFile = `${SCRIPTS}/host-cmd-queue/apt-upgrade-${Date.now()}.sh`;
    await fs.mkdir(`${SCRIPTS}/host-cmd-queue`, { recursive: true });
    await fs.writeFile(cmdFile, '#!/bin/bash\nsudo apt-get update && sudo apt-get upgrade -y\n', { mode: 0o755 });

    const result = `Upgrade command queued at ${cmdFile}. Host dispatcher will execute on next cycle.`;
    await auditLog('boss_host_apt', { action, dry_run: false }, false, result, 'success');
    return result;
  }

  return `Unknown action: ${action}`;
}

export async function handleHostSystemctl(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? 'status');
  const service = String(args.service ?? '');
  const dryRun = args.dry_run !== false;

  if (!service) return 'Error: service name is required';

  if (!ALLOWED_SERVICES.has(service)) {
    const result = `Error: service "${service}" not in allowed list. Allowed: ${[...ALLOWED_SERVICES].join(', ')}`;
    await auditLog('boss_host_systemctl', { action, service }, dryRun, result, 'denied');
    return result;
  }

  if (action === 'status') {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(`${SCRIPTS}/services-status.txt`, 'utf-8');
    const lines = raw.split('\n').filter(l => l.includes(service));
    const result = lines.length > 0 ? lines.join('\n') : `Service ${service} not found in status file`;
    await auditLog('boss_host_systemctl', { action, service }, true, result, 'success');
    return result;
  }

  if (action === 'restart' || action === 'reload') {
    if (dryRun) {
      const result = `[DRY RUN] Would execute: systemctl --user ${action} ${service}.service\nSet dry_run=false to execute.`;
      await auditLog('boss_host_systemctl', { action, service, dry_run: true }, true, result, 'success');
      return result;
    }

    const fs = await import('node:fs/promises');
    const cmdFile = `${SCRIPTS}/host-cmd-queue/systemctl-${action}-${service}-${Date.now()}.sh`;
    await fs.mkdir(`${SCRIPTS}/host-cmd-queue`, { recursive: true });
    await fs.writeFile(cmdFile, `#!/bin/bash\nsystemctl --user ${action} ${service}.service\n`, { mode: 0o755 });

    const result = `${action} command for ${service} queued. Host dispatcher will execute on next cycle.`;
    await auditLog('boss_host_systemctl', { action, service, dry_run: false }, false, result, 'success');
    return result;
  }

  return `Unknown action: ${action}. Use status, restart, or reload.`;
}

export async function handleHostCron(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? 'list');
  const entry = String(args.entry ?? '');
  const dryRun = args.dry_run !== false;

  if (action === 'list') {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(`${SCRIPTS}/crontab-status.txt`, 'utf-8');
    const entries = raw.trim().split('\n').filter(l => l && !l.startsWith('#'));
    const result = entries.length === 0
      ? 'No cron entries.'
      : `${entries.length} cron entries:\n${entries.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`;
    await auditLog('boss_host_cron', { action }, true, result, 'success');
    return result;
  }

  if (action === 'add') {
    if (!entry) return 'Error: entry is required for add action';
    if (dryRun) {
      const result = `[DRY RUN] Would add cron entry: ${entry}\nSet dry_run=false to execute.`;
      await auditLog('boss_host_cron', { action, entry, dry_run: true }, true, result, 'success');
      return result;
    }

    const fs = await import('node:fs/promises');
    const cmdFile = `${SCRIPTS}/host-cmd-queue/cron-add-${Date.now()}.sh`;
    await fs.mkdir(`${SCRIPTS}/host-cmd-queue`, { recursive: true });
    await fs.writeFile(cmdFile, `#!/bin/bash\n(crontab -l 2>/dev/null; echo '${entry.replace(/'/g, "'\\''")}') | crontab -\n`, { mode: 0o755 });

    const result = `Cron add command queued: ${entry}`;
    await auditLog('boss_host_cron', { action, entry, dry_run: false }, false, result, 'success');
    return result;
  }

  if (action === 'remove') {
    if (!entry) return 'Error: entry pattern is required for remove action';
    if (dryRun) {
      const result = `[DRY RUN] Would remove cron entries matching: ${entry}\nSet dry_run=false to execute.`;
      await auditLog('boss_host_cron', { action, entry, dry_run: true }, true, result, 'success');
      return result;
    }

    const fs = await import('node:fs/promises');
    const cmdFile = `${SCRIPTS}/host-cmd-queue/cron-remove-${Date.now()}.sh`;
    await fs.mkdir(`${SCRIPTS}/host-cmd-queue`, { recursive: true });
    const safePattern = entry.replace(/'/g, "'\\''");
    await fs.writeFile(cmdFile, `#!/bin/bash\ncrontab -l 2>/dev/null | grep -v '${safePattern}' | crontab -\n`, { mode: 0o755 });

    const result = `Cron remove command queued for pattern: ${entry}`;
    await auditLog('boss_host_cron', { action, entry, dry_run: false }, false, result, 'success');
    return result;
  }

  return `Unknown action: ${action}. Use list, add, or remove.`;
}

export async function handleAdminAuditLog(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Number(args.limit ?? 20), 100);
  const toolFilter = args.tool_name ? String(args.tool_name) : null;

  const query = toolFilter
    ? `SELECT * FROM boss_admin_audit WHERE tool_name = $1 ORDER BY created_at DESC LIMIT $2`
    : `SELECT * FROM boss_admin_audit ORDER BY created_at DESC LIMIT $1`;

  const params = toolFilter ? [toolFilter, limit] : [limit];
  const { rows } = await getPool().query(query, params);

  if (rows.length === 0) return 'No audit entries found.';

  const lines = [`${rows.length} audit entries:\n`];
  for (const r of rows) {
    const ts = new Date(r.created_at).toISOString();
    lines.push(`[${ts}] ${r.tool_name} (${r.dry_run ? 'DRY RUN' : 'LIVE'}) → ${r.status}`);
    lines.push(`  Args: ${JSON.stringify(r.args)}`);
    if (r.result) lines.push(`  Result: ${r.result.substring(0, 200)}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}
