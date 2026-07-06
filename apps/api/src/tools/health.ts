/**
 * Health brain tools — read-only views over the health module (migration 036).
 *
 * boss_health_brief   — compact multi-day text brief (same builder as GET /api/health/brief)
 * boss_health_summary — one day's metrics + workouts + sleep (same as GET /api/health/summary)
 *
 * Both call the in-process health service directly (no HTTP hop, no token) and
 * return a JSON-string payload so callers (Employee Agents, brain UI) can parse it.
 * Health data is personal: assistant-trust, not observer-visible (mirrors ERA finance).
 */

import type { BrainTool } from '@boss/brain';
import { getPool } from '../db.js';
import { currentTenantId } from '../lib/tenant.js';
import { briefText, healthToday, summary } from '../health/service.js';

export const healthBriefTool: BrainTool = {
  name: 'boss_health_brief',
  description:
    "Kevin's health brief over the last N days (default 7): steps, sleep, resting heart " +
    'rate, active energy, exercise and workouts, with trends. Returns JSON ' +
    '{brief, window_days} where brief is ready-to-send text. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      days: {
        type: 'number',
        description: 'Window size in days (1–90). Defaults to 7.',
      },
    },
    required: [],
  },
};

export const healthSummaryTool: BrainTool = {
  name: 'boss_health_summary',
  description:
    "Kevin's health metrics for a single day: every daily metric with detail, workouts, " +
    'and sleep breakdown. Returns JSON {date, metrics, workouts, sleep}. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'Day to summarize (YYYY-MM-DD). Defaults to today in the health timezone.',
      },
    },
    required: [],
  },
};

export const ALL_HEALTH_TOOLS: BrainTool[] = [healthBriefTool, healthSummaryTool];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleHealthBrief(args: Record<string, unknown>): Promise<string> {
  // Same clamp as GET /api/health/brief.
  const days = Math.min(Math.max(Number(args.days ?? 7) || 7, 1), 90);
  const result = await briefText(getPool(), currentTenantId(), days);
  return JSON.stringify(result);
}

export async function handleHealthSummary(args: Record<string, unknown>): Promise<string> {
  if (args.date !== undefined && (typeof args.date !== 'string' || !DATE_RE.test(args.date))) {
    return JSON.stringify({ ok: false, error: 'date must be a valid date (YYYY-MM-DD)' });
  }
  const date = (args.date as string | undefined) || healthToday();
  const result = await summary(getPool(), currentTenantId(), date);
  return JSON.stringify(result);
}
