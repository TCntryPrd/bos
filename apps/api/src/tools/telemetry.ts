/**
 * Telemetry & self-improvement tools — vS.2.0.
 *
 * BOS watches her own production telemetry, identifies issues,
 * and can propose fixes via PRs. This closes the loop: BOS goes
 * from "Kevin fixes everything" to "BOS proposes, Kevin reviews."
 *
 * Tools:
 *   boss_telemetry_alerts — reads error signals, returns structured alerts
 *   boss_self_propose_fix — creates a boss/* branch with fix description
 *   boss_telemetry_history — stores/retrieves past alerts for patterns
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';

const SCRIPTS = '/data/home/boss-dev/scripts';

// ── Tool definitions ────────────────────────────────────────────────────────

export const telemetryAlertsTool: BrainTool = {
  name: 'boss_telemetry_alerts',
  description:
    'Scan all telemetry signals and return structured alerts. Checks: container health ' +
    '(crashes, restarts, unhealthy), API error rate, backup staleness, disk pressure, ' +
    'memory pressure, deploy smoke failures. Returns severity (critical/warning/info) ' +
    'for each signal.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const selfProposeFix: BrainTool = {
  name: 'boss_self_propose_fix',
  description:
    'Given a telemetry alert, propose a fix by describing the issue and suggested ' +
    'remediation. This does NOT create code — it creates a structured fix proposal ' +
    'that BOS (via boss_self_git + boss_github_open_pr) can then implement. ' +
    'The proposal is stored in the telemetry history for tracking.',
  parameters: {
    type: 'object',
    properties: {
      alert_type: { type: 'string', description: 'Type of alert (e.g., container_crash, api_errors, backup_stale)' },
      description: { type: 'string', description: 'What is wrong' },
      proposed_fix: { type: 'string', description: 'What should be done to fix it' },
      severity: { type: 'string', enum: ['critical', 'warning', 'info'], description: 'Severity level' },
    },
    required: ['alert_type', 'description', 'proposed_fix'],
  },
};

export const telemetryHistoryTool: BrainTool = {
  name: 'boss_telemetry_history',
  description:
    'View past telemetry alerts and fix proposals. Use to detect recurring patterns ' +
    'and avoid re-proposing fixes that were already tried.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max entries (default 20)' },
      alert_type: { type: 'string', description: 'Filter by alert type' },
    },
    required: [],
  },
};

export const ALL_TELEMETRY_TOOLS: BrainTool[] = [
  telemetryAlertsTool,
  selfProposeFix,
  telemetryHistoryTool,
];

// ── Alert thresholds ────────────────────────────────────────────────────────

const DISK_WARN_PCT = 80;
const DISK_CRIT_PCT = 90;
const MEM_WARN_PCT = 85;
const MEM_CRIT_PCT = 95;
const API_ERROR_WARN = 5;   // errors in 5-min window
const API_ERROR_CRIT = 20;

// ── Alert types ─────────────────────────────────────────────────────────────

interface Alert {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  data?: Record<string, unknown>;
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function handleTelemetryAlerts(): Promise<string> {
  const fs = await import('node:fs/promises');
  const alerts: Alert[] = [];

  // ── Container health ──────────────────────────────────────────────────
  try {
    const containers = await fs.readFile(`${SCRIPTS}/telemetry-containers.txt`, 'utf-8');
    const lines = containers.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [name, status] = line.split('|');
      if (status?.includes('unhealthy')) {
        alerts.push({ type: 'container_unhealthy', severity: 'critical', message: `${name} is unhealthy`, data: { name, status } });
      }
      if (status && !status.includes('Up')) {
        alerts.push({ type: 'container_down', severity: 'critical', message: `${name} is not running`, data: { name, status } });
      }
    }
  } catch { /* skip */ }

  // ── Container deaths (recent crashes) ─────────────────────────────────
  try {
    const deaths = await fs.readFile(`${SCRIPTS}/telemetry-container-deaths.txt`, 'utf-8');
    const deathLines = deaths.trim().split('\n').filter(Boolean);
    if (deathLines.length > 0) {
      alerts.push({
        type: 'container_crash',
        severity: 'warning',
        message: `${deathLines.length} container death(s) in last 5 minutes`,
        data: { deaths: deathLines },
      });
    }
  } catch { /* skip */ }

  // ── API errors ────────────────────────────────────────────────────────
  try {
    const errors = await fs.readFile(`${SCRIPTS}/telemetry-api-errors.txt`, 'utf-8');
    const errorLines = errors.trim().split('\n').filter(Boolean);
    const count = errorLines.length;
    if (count >= API_ERROR_CRIT) {
      alerts.push({ type: 'api_errors', severity: 'critical', message: `${count} API errors in last 5 min`, data: { count, sample: errorLines.slice(-5) } });
    } else if (count >= API_ERROR_WARN) {
      alerts.push({ type: 'api_errors', severity: 'warning', message: `${count} API errors in last 5 min`, data: { count, sample: errorLines.slice(-3) } });
    }
  } catch { /* skip */ }

  // ── Backup health ─────────────────────────────────────────────────────
  try {
    const { handleBackupStatus } = await import('./backup-status.js');
    const backupRaw = await handleBackupStatus();
    const backup = JSON.parse(backupRaw);
    if (backup.overall === 'degraded') {
      const stale = (backup.assets ?? []).filter((a: { state: string }) => a.state !== 'fresh');
      alerts.push({
        type: 'backup_stale',
        severity: 'warning',
        message: `Backup degraded: ${stale.length} asset(s) stale or never attempted`,
        data: { stale_assets: stale.map((a: { asset: string; state: string }) => `${a.asset}:${a.state}`) },
      });
    }
  } catch { /* skip */ }

  // ── Disk pressure ─────────────────────────────────────────────────────
  try {
    const disk = await fs.readFile(`${SCRIPTS}/telemetry-disk.txt`, 'utf-8');
    const [used, avail, pctStr] = disk.trim().split('|');
    const pct = parseInt(pctStr ?? '0', 10);
    if (pct >= DISK_CRIT_PCT) {
      alerts.push({ type: 'disk_pressure', severity: 'critical', message: `Disk ${pct}% full (${used} used, ${avail} free)` });
    } else if (pct >= DISK_WARN_PCT) {
      alerts.push({ type: 'disk_pressure', severity: 'warning', message: `Disk ${pct}% full (${used} used, ${avail} free)` });
    }
  } catch { /* skip */ }

  // ── Memory pressure ───────────────────────────────────────────────────
  try {
    const mem = await fs.readFile(`${SCRIPTS}/telemetry-memory.txt`, 'utf-8');
    const [totalStr, usedStr] = mem.trim().split('|');
    const total = parseInt(totalStr ?? '0', 10);
    const used = parseInt(usedStr ?? '0', 10);
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    if (pct >= MEM_CRIT_PCT) {
      alerts.push({ type: 'memory_pressure', severity: 'critical', message: `Memory ${pct}% (${used}MB / ${total}MB)` });
    } else if (pct >= MEM_WARN_PCT) {
      alerts.push({ type: 'memory_pressure', severity: 'warning', message: `Memory ${pct}% (${used}MB / ${total}MB)` });
    }
  } catch { /* skip */ }

  // ── Deploy smoke failures ─────────────────────────────────────────────
  try {
    const deployLog = await fs.readFile(`${SCRIPTS}/telemetry-deploy-log.txt`, 'utf-8');
    const failLines = deployLog.split('\n').filter(l => l.includes('ERROR') || l.includes('FAIL'));
    if (failLines.length > 0) {
      alerts.push({
        type: 'deploy_smoke_failure',
        severity: 'warning',
        message: `${failLines.length} failure(s) in last deploy log`,
        data: { failures: failLines.slice(-5) },
      });
    }
  } catch { /* skip */ }

  // ── Build result ──────────────────────────────────────────────────────
  const criticals = alerts.filter(a => a.severity === 'critical');
  const warnings = alerts.filter(a => a.severity === 'warning');

  const result = {
    status: criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy',
    checked_at: new Date().toISOString(),
    summary: `${criticals.length} critical, ${warnings.length} warning, ${alerts.length} total`,
    alerts,
  };

  return JSON.stringify(result);
}

export async function handleSelfProposeFix(args: Record<string, unknown>): Promise<string> {
  const alertType = String(args.alert_type ?? '');
  const description = String(args.description ?? '');
  const proposedFix = String(args.proposed_fix ?? '');
  const severity = String(args.severity ?? 'warning');

  if (!alertType || !description || !proposedFix) {
    return 'Error: alert_type, description, and proposed_fix are required';
  }

  // Store the proposal in the telemetry history
  try {
    await getPool().query(
      `INSERT INTO claude.memory (category, key, value, layer, ttl_days, salience)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'telemetry_fix_proposal',
        `${alertType}-${Date.now()}`,
        JSON.stringify({
          alert_type: alertType,
          description,
          proposed_fix: proposedFix,
          severity,
          timestamp: new Date().toISOString(),
          status: 'proposed',
        }),
        'working',
        30,
        0.7,
      ],
    );
  } catch {
    // Don't fail the tool if memory write fails
  }

  return JSON.stringify({
    status: 'proposed',
    alert_type: alertType,
    severity,
    description,
    proposed_fix: proposedFix,
    next_steps: [
      'Use boss_self_git to create a boss/fix-<type> branch',
      'Implement the fix on that branch',
      'Use boss_github_open_pr to propose the change',
      'Use boss_github_request_review to notify Kevin',
    ],
    timestamp: new Date().toISOString(),
  });
}

export async function handleTelemetryHistory(args: Record<string, unknown>): Promise<string> {
  const limit = Math.min(Number(args.limit ?? 20), 100);
  const alertType = args.alert_type ? String(args.alert_type) : null;

  try {
    const query = alertType
      ? `SELECT key, value, created_at FROM claude.memory
           WHERE category = 'telemetry_fix_proposal' AND value::text LIKE $1
           ORDER BY created_at DESC LIMIT $2`
      : `SELECT key, value, created_at FROM claude.memory
           WHERE category = 'telemetry_fix_proposal'
           ORDER BY created_at DESC LIMIT $1`;

    const params = alertType ? [`%${alertType}%`, limit] : [limit];
    const { rows } = await getPool().query(query, params);

    if (rows.length === 0) return 'No telemetry history entries found.';

    const entries = rows.map((r: { key: string; value: string; created_at: string }) => {
      const val = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      return `[${r.created_at}] ${val.alert_type} (${val.severity}) — ${val.status}\n  ${val.description}\n  Fix: ${val.proposed_fix}`;
    });

    return `${rows.length} telemetry entries:\n\n${entries.join('\n\n')}`;
  } catch (e) {
    return `Error reading telemetry history: ${e instanceof Error ? e.message : String(e)}`;
  }
}
