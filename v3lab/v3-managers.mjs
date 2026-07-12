// IR Custom AIOS v3 — Platform Managers (M3). Each normalizes its domain into boss_knowledge.
// Run by a systemd timer (always-on). Active managers have live pulls; stubs fill in via M5.
import { pool, cfg } from './v3-turn.mjs';
import { googleToken } from './v3-google.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);

async function upsert(domain, k, summary, detail, mgr) {
  await pool.query(
    `INSERT INTO boss_knowledge(domain, k, summary, detail, source_manager) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, domain, k) DO UPDATE SET summary=EXCLUDED.summary, detail=EXCLUDED.detail, updated_at=now()`,
    [domain, k, summary, JSON.stringify(detail || {}), mgr]);
}

// M5 — agent factory. A credential for a platform with no manager → auto stand-up.
const CRED_PLATFORMS = { STRIPE_SECRET_KEY: 'stripe', NOTION_API_KEY: 'notion', AIRTABLE_API_KEY: 'airtable', GITHUB_TOKEN: 'github', ZOOM_SECRET_TOKEN: 'zoom' };

export async function standUpManager(platform, displayName) {
  const handle = `${platform}-manager`;
  if ((await pool.query('SELECT 1 FROM platform_manager WHERE handle=$1', [handle])).rowCount) return null;
  const name = displayName || `${platform[0].toUpperCase() + platform.slice(1)} Manager`;
  await pool.query("INSERT INTO platform_manager(handle,platform,display_name,status) VALUES($1,$2,$3,'registered') ON CONFLICT DO NOTHING", [handle, platform, name]);
  const dir = `/home/tcntryprd/managers/${handle}`;
  await pexec('mkdir', ['-p', dir]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`${dir}/SOUL.md`, `# ${name}\n\nYou are the ${platform} Platform Manager for IR Custom AIOS. Own the ${platform} platform: monitor it, normalize its signal into IR Custom AIOS's knowledge, and execute delegated actions. Report status up to IR Custom AIOS. Draft-only on client-facing (DCS) work — never spend money or change client-facing state without approval.\n`);
  await pool.query(`INSERT INTO boss_knowledge(domain,k,summary,detail,source_manager) VALUES('factory',$1,$2,$3,'agent-factory')
     ON CONFLICT (tenant_id,domain,k) DO UPDATE SET summary=EXCLUDED.summary, updated_at=now()`,
    [handle, `Auto-stood-up ${handle} for new platform "${platform}"`, JSON.stringify({ platform, auto: true })]);
  return handle;
}

async function autoDetect() {
  const created = [];
  for (const [key, platform] of Object.entries(CRED_PLATFORMS)) {
    if (!(await pool.query("SELECT 1 FROM runtime_config WHERE key=$1 AND tenant_id='default'", [key])).rowCount) continue;
    if ((await pool.query('SELECT 1 FROM platform_manager WHERE platform=$1', [platform])).rowCount) continue;
    const h = await standUpManager(platform); if (h) created.push(h);
  }
  return created;
}

// Infra / Health Manager — watches the v3 stack; feeds observability knowledge.
async function infraManager() {
  const { stdout } = await pexec('docker', ['ps', '-a', '--format', '{{.Names}}|{{.Status}}'], { maxBuffer: 1 << 20 });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const running = lines.filter(l => /\|Up /.test(l));
  const bad = lines.filter(l => /Exited|Restarting|unhealthy/.test(l));
  await upsert('infra', 'containers', `${running.length} running, ${bad.length} down/unhealthy`,
    { running: running.map(l => l.split('|')[0]), problems: bad }, 'infra-manager');
  const v3 = await pexec('systemctl', ['is-active', 'boss-v3']).then(r => r.stdout.trim()).catch(() => 'unknown');
  await upsert('infra', 'boss-v3-service', `boss-v3 service: ${v3}`, {}, 'infra-manager');
  return `${running.length} up / ${bad.length} bad; service=${v3}`;
}

// Slack Manager — public-channel inventory (graceful if scopes limited).
async function slackManager() {
  const tok = await cfg('SLACK_BOT_TOKEN');
  if (!tok) { await upsert('slack', 'status', 'no SLACK_BOT_TOKEN', {}, 'slack-manager'); return 'no token'; }
  const r = await fetch('https://slack.com/api/conversations.list?limit=100&exclude_archived=true&types=public_channel', { headers: { authorization: `Bearer ${tok}` } });
  const j = await r.json();
  if (!j.ok) { await upsert('slack', 'status', `Slack API error: ${j.error}`, {}, 'slack-manager'); return 'slack ' + j.error; }
  const chans = (j.channels || []).map(c => c.name);
  await upsert('slack', 'channels', `${chans.length} public channels`, { channels: chans.slice(0, 50) }, 'slack-manager');
  return `${chans.length} channels`;
}

// Make Manager — scenarios via Make API (execution backend IR Custom AIOS can monitor/trigger).
async function makeManager() {
  const tok = await cfg('MAKE_API_KEY');
  if (!tok) return 'no token';
  const r = await fetch('https://us2.make.com/api/v2/scenarios?organizationId=4658230', { headers: { authorization: `Token ${tok}` } });
  const j = await r.json();
  if (!r.ok) { await upsert('make', 'status', `Make API ${r.status}: ${j.message || ''}`, {}, 'make-manager'); return 'make ' + r.status; }
  const scs = j.scenarios || [];
  const active = scs.filter(s => s.isActive).length;
  await upsert('make', 'scenarios', `${scs.length} scenarios (${active} active)`, { scenarios: scs.slice(0, 30).map(s => ({ name: s.name, active: s.isActive })) }, 'make-manager');
  return `${scs.length} scenarios, ${active} active`;
}

// n8n Manager — queries the VPS n8n (migrated execution backend) for workflow state.
async function n8nManager() {
  const key = await cfg('N8N_API_KEY');
  if (!key) return 'no api key';
  const r = await fetch('http://localhost:5679/api/v1/workflows?limit=250', { headers: { 'X-N8N-API-KEY': key } });
  const j = await r.json();
  if (!r.ok) { await upsert('n8n', 'status', `n8n API ${r.status}`, {}, 'n8n-manager'); return 'n8n ' + r.status; }
  const wf = j.data || [];
  const active = wf.filter(w => w.active).length;
  await upsert('n8n', 'workflows', `${wf.length} workflows on VPS n8n (${active} active — inactive until cutover)`, { workflows: wf.slice(0, 40).map(w => ({ name: w.name, active: w.active })) }, 'n8n-manager');
  return `${wf.length} workflows, ${active} active`;
}

// Google managers (real Gmail/Calendar/Drive via decrypted OAuth).
async function emailManager() {
  const { access, account } = await googleToken();
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=1', { headers: { authorization: `Bearer ${access}` } });
  const j = await r.json(); if (j.error) return 'gmail ' + j.error.code;
  const est = j.resultSizeEstimate ?? 0;
  await upsert('email', 'unread', `~${est} unread`, { account }, 'email-manager');
  return `~${est} unread`;
}
async function calendarManager() {
  const { access } = await googleToken();
  const now = new Date().toISOString(), end = new Date(Date.now() + 86400000).toISOString();
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${end}&singleEvents=true&orderBy=startTime&maxResults=10`, { headers: { authorization: `Bearer ${access}` } });
  const j = await r.json(); if (j.error) return 'cal ' + j.error.code;
  const items = (j.items || []).map(e => e.summary).filter(Boolean);
  await upsert('calendar', 'next24h', `${items.length} events in next 24h`, { events: items }, 'calendar-manager');
  return `${items.length} events/24h`;
}
async function driveManager() {
  const { access } = await googleToken();
  const r = await fetch('https://www.googleapis.com/drive/v3/files?orderBy=modifiedTime+desc&pageSize=10&fields=files(name,modifiedTime)', { headers: { authorization: `Bearer ${access}` } });
  const j = await r.json(); if (j.error) return 'drive ' + j.error.code;
  const files = (j.files || []).map(f => f.name);
  await upsert('drive', 'recent', `${files.length} recently-modified files`, { files }, 'drive-manager');
  return `${files.length} recent files`;
}
async function whatsappManager() {
  const apik = process.env.OPENWA_API_KEY; if (!apik) return 'no openwa key';
  const r = await fetch('http://100.78.24.32:2785/api/sessions', { headers: { 'X-API-Key': apik } }).catch(() => null);
  if (!r) { await upsert('whatsapp', 'status', 'OpenWA unreachable', {}, 'whatsapp-manager'); return 'unreachable'; }
  const j = await r.json().catch(() => null);
  const n = Array.isArray(j) ? j.length : (j?.sessions?.length || (j ? 1 : 0));
  await upsert('whatsapp', 'sessions', `OpenWA reachable, ${n} session(s)`, {}, 'whatsapp-manager');
  return `${n} session(s)`;
}
async function otterManager() {
  const m = (await pool.query("SELECT count(*) c FROM boss_knowledge WHERE domain='meetings'")).rows[0].c;
  const a = (await pool.query("SELECT count(*) c FROM boss_action_items WHERE status='open'")).rows[0].c;
  await upsert('meetings', 'pipeline', `${m} meeting(s) ingested, ${a} open action items`, {}, 'otter-manager');
  return `${m} meetings, ${a} open items`;
}
async function littlebirdManager() {
  await upsert('littlebird', 'status', 'Laptop stream → box littlebird-ingest:8020; VPS ingestion pending cutover', {}, 'littlebird-manager');
  return 'stream→box (pending cutover)';
}

const MANAGERS = {
  'infra-manager': infraManager, 'slack-manager': slackManager, 'make-manager': makeManager, 'n8n-manager': n8nManager,
  'email-manager': emailManager, 'calendar-manager': calendarManager, 'drive-manager': driveManager,
  'whatsapp-manager': whatsappManager, 'otter-manager': otterManager, 'littlebird-manager': littlebirdManager,
};

export async function runManagers() {
  const out = {};
  const autoCreated = await autoDetect();          // self-extend before polling
  if (autoCreated.length) out._auto_created = autoCreated;
  for (const [h, fn] of Object.entries(MANAGERS)) {
    try {
      const r = await fn(); out[h] = r;
      await pool.query("UPDATE platform_manager SET status='active', last_run_at=now(), last_result=$2 WHERE handle=$1", [h, String(r).slice(0, 200)]);
    } catch (e) {
      out[h] = 'ERR: ' + e.message;
      await pool.query("UPDATE platform_manager SET last_run_at=now(), last_result=$2 WHERE handle=$1", [h, ('ERR: ' + e.message).slice(0, 200)]);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runManagers().then(o => { console.log(JSON.stringify(o, null, 2)); return pool.end(); })
    .catch(async e => { console.error(e.message); await pool.end(); process.exit(1); });
}
