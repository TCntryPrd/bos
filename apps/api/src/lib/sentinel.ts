/**
 * sentinel.ts - proactive Chief-of-Staff intelligence (Fusion P3).
 *
 * Aggregates the existing control plane into the Daily Brief and urgent-scan
 * tools. Every source is optional: if a table/integration is absent, that
 * section simply degrades instead of breaking the dashboard.
 */
import { getPool } from '../db.js';
import { getCalendarEventsForRange } from '../routes/calendar.js';
import { budgetStatus } from './model-routes.js';
import { currentTenantId } from './tenant.js';

type Severity = 'high' | 'medium' | 'low';
type BriefSection = { label: string; items: string[] };

export interface Priority {
  kind: string;
  label: string;
  count?: number;
  severity: Severity;
  route?: string;
  actionLabel?: string;
}

export interface Brief {
  date: string;
  generated_at: string;
  freshness_key: string;
  greeting: string;
  headline: string;
  priorities: Priority[];
  sections: BriefSection[];
  spoken: string;
}

const BRIEF_TZ = 'America/Chicago';

async function num(sql: string, params: unknown[] = []): Promise<number> {
  try {
    const { rows } = await getPool().query<{ n: string | number }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  try {
    const { rows } = await getPool().query(sql, params);
    return (rows[0] as T) ?? null;
  } catch {
    return null;
  }
}

async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    const { rows } = await getPool().query(sql, params);
    return rows as T[];
  } catch {
    return [];
  }
}

function localDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BRIEF_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function localHour(date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: BRIEF_TZ,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  return Number(hour === '24' ? '0' : hour);
}

function timeLabel(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BRIEF_TZ,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function money(n: unknown): string | null {
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  return `$${Math.round(value).toLocaleString()}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function compact(items: Array<string | null | undefined>, limit = 4): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = (item ?? '').replace(/\s+/g, ' ').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function addSection(sections: BriefSection[], label: string, items: Array<string | null | undefined>, limit = 4): void {
  const clean = compact(items, limit);
  if (clean.length) sections.push({ label, items: clean });
}

export async function computePriorities(tenantId: string): Promise<Priority[]> {
  const t = currentTenantId(tenantId);
  const out: Priority[] = [];

  const approvals = await num(`SELECT count(*) n FROM boss_approvals WHERE tenant_id=$1 AND status='pending'`, [t]);
  if (approvals) out.push({ kind: 'approvals', label: `${plural(approvals, 'approval')} need your OK`, count: approvals, severity: 'high', route: '/', actionLabel: 'Review' });

  const incidents = await num(`SELECT count(*) n FROM boss_incidents WHERE status NOT IN ('resolved','escalated')`);
  if (incidents) out.push({ kind: 'incidents', label: `${plural(incidents, 'open incident')} self-healing`, count: incidents, severity: 'high', route: '/self-healing', actionLabel: 'Heal' });

  const emailAttention = await num(`SELECT count(*) n FROM boss_email_log WHERE needs_attention = true AND resolved_at IS NULL`);
  if (emailAttention) out.push({ kind: 'email_attention', label: `${plural(emailAttention, 'email')} need attention`, count: emailAttention, severity: 'high', route: '/email', actionLabel: 'Open queue' });

  const blocked = await num(`SELECT count(*) n FROM boss_tasks WHERE status='blocked'`);
  if (blocked) out.push({ kind: 'tasks_blocked', label: `${plural(blocked, 'blocked task')} waiting`, count: blocked, severity: 'high', route: '/tasks', actionLabel: 'Unblock' });

  const stalled = await num(`SELECT count(*) n FROM boss_tasks WHERE status='failed'`);
  if (stalled) out.push({ kind: 'tasks_stalled', label: `${plural(stalled, 'stalled task')} to review`, count: stalled, severity: 'medium', route: '/tasks', actionLabel: 'Review' });

  const overdue = await num(`SELECT count(*) n FROM boss_tasks WHERE status IN ('pending','active') AND due_at IS NOT NULL AND due_at < now()`);
  if (overdue) out.push({ kind: 'tasks_overdue', label: `${plural(overdue, 'overdue task')} on the board`, count: overdue, severity: 'medium', route: '/tasks', actionLabel: 'Reschedule' });

  const slack = await num(`SELECT count(*) n FROM slack_attention WHERE tenant_id=$1 AND status='open'`, [t]);
  if (slack) out.push({ kind: 'slack_attention', label: `${plural(slack, 'Slack item')} open`, count: slack, severity: 'medium', route: '/slack', actionLabel: 'Open Slack' });

  const whatsappUnread = await num(`SELECT coalesce(sum(unread_count),0) n FROM boss_whatsapp_threads WHERE tenant_id=$1`, [t]);
  if (whatsappUnread) out.push({ kind: 'whatsapp_unread', label: `${plural(whatsappUnread, 'WhatsApp message')} unread`, count: whatsappUnread, severity: 'medium', route: '/whatsapp', actionLabel: 'Open inbox' });

  const open = await num(`SELECT count(*) n FROM boss_tasks WHERE status IN ('pending','active')`);
  if (open) out.push({ kind: 'tasks_open', label: `${plural(open, 'active task')} moving`, count: open, severity: 'low', route: '/tasks', actionLabel: 'Open board' });

  return out;
}

async function calendarItems(today: string): Promise<string[]> {
  try {
    const { events } = await getCalendarEventsForRange(today, today);
    if (events.length === 0) return ['No calendar blocks found for today.'];
    const upcoming = events.filter((event) => {
      const at = new Date(event.start).getTime();
      return Number.isFinite(at) && at >= Date.now() - 15 * 60 * 1000;
    });
    const next = upcoming[0] ?? events[0];
    const nextLabel = `${timeLabel(next.start)} ${next.summary}`.trim();
    return compact([
      `${plural(events.length, 'calendar event')} today`,
      nextLabel ? `Next: ${nextLabel}` : null,
      ...events.slice(0, 2).map((event) => `${timeLabel(event.start)} ${event.summary}`.trim()),
    ], 4);
  } catch {
    return [];
  }
}

function businessItems(fin: Record<string, unknown> | null, crm: Record<string, unknown> | null, reviews: { overall_rating: number | null; total_reviews: number } | null): string[] {
  const cash = money(fin?.cash ?? fin?.cash_available ?? fin?.cash_total ?? fin?.cash_on_hand);
  const revenue = money(fin?.revenue_mtd ?? fin?.mtd_revenue ?? fin?.revenue);
  const ar = money(fin?.ar_open_total);
  const pipeline = money(crm?.pipeline_value ?? crm?.pipeline ?? crm?.open_value);
  const contacts = Number(crm?.contacts ?? crm?.total_contacts ?? NaN);

  return compact([
    cash ? `Cash: ${cash}` : null,
    revenue ? `Revenue MTD: ${revenue}` : null,
    ar ? `AR open: ${ar}` : null,
    pipeline ? `Pipeline: ${pipeline}` : Number.isFinite(contacts) ? `${contacts} CRM contacts` : null,
    reviews?.overall_rating != null ? `Reputation: ${Number(reviews.overall_rating).toFixed(1)} stars across ${reviews.total_reviews} reviews` : null,
  ], 5);
}

async function communicationsItems(tenantId: string): Promise<string[]> {
  const email = await many<{ sender: string; subject: string; category: string | null }>(
    `SELECT sender, subject, category
       FROM boss_email_log
      WHERE needs_attention = true AND resolved_at IS NULL
      ORDER BY processed_at DESC
      LIMIT 2`,
  );
  const slackOpen = await num(`SELECT count(*) n FROM slack_attention WHERE tenant_id=$1 AND status='open'`, [tenantId]);
  const whatsapp = await one<{ unread: string; threads: string }>(
    `SELECT coalesce(sum(unread_count),0)::text AS unread,
            count(*) FILTER (WHERE unread_count > 0)::text AS threads
       FROM boss_whatsapp_threads WHERE tenant_id=$1`,
    [tenantId],
  );
  return compact([
    email.length ? `${plural(email.length, 'attention email')} surfaced; latest: ${email[0].sender} - ${email[0].subject}` : 'Email attention queue is clear.',
    slackOpen ? `${plural(slackOpen, 'Slack item')} open.` : 'Slack attention is clear.',
    Number(whatsapp?.unread ?? 0) ? `${plural(Number(whatsapp?.unread ?? 0), 'WhatsApp message')} across ${plural(Number(whatsapp?.threads ?? 0), 'thread')}.` : 'WhatsApp unread queue is clear.',
  ], 4);
}

async function operationsItems(): Promise<string[]> {
  const agents = await one<{ total: string; active: string; errors: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status='active')::text AS active,
            coalesce(sum(error_count),0)::text AS errors
       FROM boss_persistent_agents`,
  );
  const runs = await one<{ total: string; ok: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status IN ('ok','completed','success'))::text AS ok
       FROM boss_agent_runs WHERE started_at > now() - interval '24 hours'`,
  );
  const tasks = await one<{ open: string; overdue: string; blocked: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('pending','active'))::text AS open,
            count(*) FILTER (WHERE status IN ('pending','active') AND due_at IS NOT NULL AND due_at < now())::text AS overdue,
            count(*) FILTER (WHERE status='blocked')::text AS blocked
       FROM boss_tasks`,
  );

  const runTotal = Number(runs?.total ?? 0);
  const runOk = Number(runs?.ok ?? 0);
  const runLine = runTotal > 0 ? `${Math.round((runOk / runTotal) * 100)}% agent runs OK in 24h` : 'No agent runs logged in the last 24h.';

  return compact([
    agents ? `${agents.active}/${agents.total} employee agents active${Number(agents.errors) ? `; ${agents.errors} errors recorded` : ''}` : null,
    runLine,
    tasks ? `${tasks.open} active tasks, ${tasks.blocked} blocked, ${tasks.overdue} overdue.` : null,
  ], 4);
}

async function automationItems(tenantId: string): Promise<string[]> {
  const integrations = await many<{ provider: string; n: string; any_fresh: boolean }>(
    `SELECT provider, count(*)::text n, bool_or(expires_at IS NULL OR expires_at > now()) any_fresh
       FROM boss_oauth_tokens GROUP BY provider`,
  );
  const connected = integrations.filter((row) => row.any_fresh).length;
  const expired = integrations.filter((row) => !row.any_fresh).map((row) => row.provider);
  const budget = await budgetStatus(tenantId).catch(() => null);

  return compact([
    integrations.length ? `${connected}/${integrations.length} connector groups healthy.` : 'No connector health data yet.',
    expired.length ? `Reconnect needed: ${expired.slice(0, 3).join(', ')}.` : null,
    budget ? `AI spend: ${money(budget.spent_usd) ?? '$0'}${budget.cap_usd != null ? ` of ${money(budget.cap_usd)}` : ''}${budget.status === 'warn' ? ' - nearing cap' : budget.status === 'over' ? ' - over cap' : ''}.` : null,
  ], 4);
}

async function healthItems(tenantId: string, today: string): Promise<string[]> {
  const devices = await one<{ paired: string; seen: Date | null }>(
    `SELECT count(*) FILTER (WHERE paired_at IS NOT NULL AND revoked_at IS NULL)::text AS paired,
            max(last_seen_at) AS seen
       FROM health_devices WHERE tenant_id=$1`,
    [tenantId],
  );
  if (!devices || Number(devices.paired) === 0) return [];

  const rows = await many<{ metric: string; value: number }>(
    `SELECT metric, value::float AS value
       FROM health_daily
      WHERE tenant_id=$1 AND day=$2::date
        AND metric IN ('steps','sleep_minutes','resting_hr','weight_kg')
      ORDER BY metric`,
    [tenantId, today],
  );
  const byMetric = new Map(rows.map((row) => [row.metric, row.value]));
  const steps = byMetric.get('steps');
  const sleep = byMetric.get('sleep_minutes');
  const hr = byMetric.get('resting_hr');

  return compact([
    Number.isFinite(steps) ? `Health: ${Math.round(steps ?? 0).toLocaleString()} steps today.` : 'Health device paired; awaiting today\'s movement data.',
    Number.isFinite(sleep) ? `Sleep: ${Math.floor((sleep ?? 0) / 60)}h ${Math.round((sleep ?? 0) % 60)}m.` : null,
    Number.isFinite(hr) ? `Resting HR: ${Math.round(hr ?? 0)} bpm.` : null,
    devices.seen ? `Phone last synced ${timeLabel(devices.seen)}.` : null,
  ], 4);
}

function buildSpokenBrief(brief: Omit<Brief, 'spoken'>): string {
  const focus = brief.priorities.slice(0, 4).map((p) => {
    const action = p.actionLabel ? `I put a ${p.actionLabel} link beside it` : 'I put the action link beside it';
    return `${p.label}; ${action}`;
  });
  const sectionLines = brief.sections
    .slice(0, 5)
    .flatMap((section) => section.items.slice(0, 1).map((item) => `${section.label}: ${item}`));
  const lines = compact([
    `${brief.greeting}. I have your executive brief for ${brief.date}.`,
    brief.headline,
    focus.length
      ? `Here is what I would handle first: ${focus.join('. ')}.`
      : 'No urgent approvals or escalations are waiting, so the room is calm right now.',
    ...sectionLines,
    'I left the links in the Daily Brief so you can jump straight into anything you want handled.',
  ], 14);
  return lines.join(' ');
}

export async function composeBrief(tenantId: string): Promise<Brief> {
  const t = currentTenantId(tenantId);
  const now = new Date();
  const today = localDateKey(now);
  const generatedAt = now.toISOString();
  const priorities = await computePriorities(t);
  const sections: BriefSection[] = [];

  addSection(sections, 'Attention', priorities.length ? priorities.map((p) => p.label) : ['No urgent approvals, escalations, or blocked work waiting.'], 5);
  addSection(sections, 'Today', await calendarItems(today), 4);

  const fin = await one<{ snapshot: Record<string, unknown> }>(`SELECT snapshot FROM boss_finance_snapshot ORDER BY created_at DESC LIMIT 1`);
  const crm = await one<{ snapshot: Record<string, unknown> }>(`SELECT snapshot FROM boss_crm_snapshot ORDER BY created_at DESC LIMIT 1`);
  const reviews = await one<{ overall_rating: number | null; total_reviews: number }>(`SELECT overall_rating, total_reviews FROM boss_reviews_snapshot ORDER BY created_at DESC LIMIT 1`);
  addSection(sections, 'Business', businessItems(fin?.snapshot ?? null, crm?.snapshot ?? null, reviews), 5);

  addSection(sections, 'Operations', await operationsItems(), 4);
  addSection(sections, 'Communications', await communicationsItems(t), 4);
  addSection(sections, 'Systems', await automationItems(t), 4);
  addSection(sections, 'Wellness', await healthItems(t, today), 4);

  const highCount = priorities.filter((p) => p.severity === 'high').length;
  const attentionCount = highCount || priorities.length;
  const headline = attentionCount
    ? `${attentionCount} executive signal${attentionCount === 1 ? '' : 's'} want attention today`
    : 'The room is calm; your operating system is watching the edges.';
  const hour = localHour(now);
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const base: Omit<Brief, 'spoken'> = {
    date: today,
    generated_at: generatedAt,
    freshness_key: today,
    greeting,
    headline,
    priorities,
    sections,
  };
  return { ...base, spoken: buildSpokenBrief(base) };
}
