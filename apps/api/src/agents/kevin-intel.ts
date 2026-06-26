/**
 * Kevin Intelligence Agent — Background Learning Heartbeat
 *
 * Runs every 4 hours. Ingests information to understand Kevin better:
 *   - Email patterns: who he talks to, response times, tone
 *   - Calendar: meeting frequency, who with, patterns
 *   - Drive: document topics, recent activity
 *   - Relationship mapping: contact frequency, formality, priority
 *
 * Saves all learnings to boss_memory with category 'pattern' or 'contact'.
 * This is NOT a fire-and-forget sub-agent — it's a persistent background process.
 */

import { getPool } from '../db.js';
import { executeTool } from '../tools/index.js';

const INTEL_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const TENANT_ID = 'default';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let lastRunAt: Date | null = null;

// ── Email Intelligence ──────────────────────────────────────────────────────

async function analyzeEmailPatterns(): Promise<string[]> {
  const learnings: string[] = [];

  try {
    // Get recent sent emails to understand who Kevin communicates with
    const sentResult = await executeTool(
      'boss_gmail_search',
      { query: 'in:sent newer_than:7d', max_results: 30 },
      TENANT_ID,
    );

    // Parse contacts from sent emails
    const contacts = new Map<string, { count: number; lastDate: string }>();
    const lines = sentResult.split('\n');
    let currentTo = '';

    for (const line of lines) {
      if (line.includes('From:') && line.includes('d.caine@dcaine.com')) continue;
      if (line.trim().startsWith('From:')) {
        currentTo = line.replace(/.*From:\s*/, '').trim();
      }
      if (currentTo && line.trim().startsWith('Date:')) {
        const existing = contacts.get(currentTo) || { count: 0, lastDate: '' };
        existing.count++;
        existing.lastDate = line.replace(/.*Date:\s*/, '').trim();
        contacts.set(currentTo, existing);
      }
    }

    // Log frequent contacts
    for (const [contact, info] of contacts) {
      if (info.count >= 2) {
        learnings.push(`Kevin communicated with ${contact} ${info.count} times in the last 7 days`);
      }
    }

    // Get unread count for responsiveness tracking
    const unreadResult = await executeTool(
      'boss_gmail_unread',
      { max_results: 50 },
      TENANT_ID,
    );
    const unreadCount = (unreadResult.match(/• ID:/g) || []).length;
    if (unreadCount > 10) {
      learnings.push(`Kevin has ${unreadCount} unread emails — inbox may need attention`);
    }
  } catch (err) {
    console.error('[kevin-intel] Email analysis error:', err);
  }

  return learnings;
}

// ── Calendar Intelligence ───────────────────────────────────────────────────

async function analyzeCalendarPatterns(): Promise<string[]> {
  const learnings: string[] = [];

  try {
    const calResult = await executeTool(
      'boss_calendar_upcoming',
      { days: 7 },
      TENANT_ID,
    );

    // Count meetings and extract patterns
    const meetingLines = calResult.split('\n').filter(l => l.includes('•'));
    const meetingCount = meetingLines.length;

    if (meetingCount > 0) {
      learnings.push(`Kevin has ${meetingCount} meetings in the next 7 days`);
    }

    // Extract recurring contacts from meetings
    const attendees = new Map<string, number>();
    for (const line of calResult.split('\n')) {
      if (line.includes('Attendees:') || line.includes('with')) {
        const names = line.match(/[A-Z][a-z]+ [A-Z][a-z]+/g) || [];
        for (const name of names) {
          if (name !== 'Kevin Starr') {
            attendees.set(name, (attendees.get(name) || 0) + 1);
          }
        }
      }
    }

    for (const [name, count] of attendees) {
      if (count >= 2) {
        learnings.push(`Kevin meets with ${name} frequently (${count} times in 7 days)`);
      }
    }
  } catch (err) {
    console.error('[kevin-intel] Calendar analysis error:', err);
  }

  return learnings;
}

// ── Drive Intelligence ──────────────────────────────────────────────────────

async function analyzeDriveActivity(): Promise<string[]> {
  const learnings: string[] = [];

  try {
    const driveResult = await executeTool(
      'boss_drive_recent',
      { max_results: 10 },
      TENANT_ID,
    );

    const fileCount = (driveResult.match(/• /g) || []).length;
    if (fileCount > 0) {
      learnings.push(`Kevin has ${fileCount} recently modified Drive files`);
    }

    // Look for document topics
    const topics = driveResult.match(/Name:\s*(.*)/g) || [];
    if (topics.length > 0) {
      const topicNames = topics.map(t => t.replace('Name: ', '').trim()).slice(0, 5);
      learnings.push(`Recent Drive activity topics: ${topicNames.join(', ')}`);
    }
  } catch (err) {
    console.error('[kevin-intel] Drive analysis error:', err);
  }

  return learnings;
}

// ── Core Loop ───────────────────────────────────────────────────────────────

async function runIntelGather(): Promise<void> {
  if (isRunning) {
    console.log('[kevin-intel] Already running, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    console.log('[kevin-intel] Starting intelligence gathering...');

    const allLearnings: string[] = [];

    // Run all analyses
    const [emailLearnings, calLearnings, driveLearnings] = await Promise.all([
      analyzeEmailPatterns(),
      analyzeCalendarPatterns(),
      analyzeDriveActivity(),
    ]);

    allLearnings.push(...emailLearnings, ...calLearnings, ...driveLearnings);

    // Save learnings to boss_memory
    if (allLearnings.length > 0) {
      const pool = getPool();
      for (const learning of allLearnings) {
        // Check for duplicate/similar entries first
        const { rows } = await pool.query(
          `SELECT id FROM boss_memory WHERE content = $1 AND created_at > now() - interval '24 hours'`,
          [learning],
        );
        if (rows.length === 0) {
          await pool.query(
            `INSERT INTO boss_memory (category, content, source, confidence)
             VALUES ('pattern', $1, 'kevin-intel-agent', 0.7)`,
            [learning],
          );
        }
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[kevin-intel] Complete: ${allLearnings.length} learnings in ${elapsed}ms`);
    lastRunAt = new Date();
  } catch (err) {
    console.error('[kevin-intel] Intel gathering failed:', err);
  } finally {
    isRunning = false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function startKevinIntel(): void {
  console.log(`[kevin-intel] Starting intelligence agent (every ${INTEL_INTERVAL_MS / 3600000}h)`);

  // First run after 2 minutes (let server stabilize)
  setTimeout(() => void runIntelGather(), 2 * 60 * 1000);

  // Then every 4 hours
  intervalHandle = setInterval(() => void runIntelGather(), INTEL_INTERVAL_MS);
}

export function stopKevinIntel(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[kevin-intel] Stopped');
  }
}

export function getKevinIntelStatus(): {
  running: boolean;
  lastRunAt: string | null;
  intervalHours: number;
} {
  return {
    running: isRunning,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    intervalHours: INTEL_INTERVAL_MS / 3600000,
  };
}
