// Read-only connection audit: which integrations are LIVE vs need re-auth on the VPS.
import pg from 'pg';
import crypto from 'node:crypto';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const cfg = async k => (await pool.query("SELECT value FROM runtime_config WHERE key=$1 AND tenant_id='default'", [k])).rows[0]?.value;
const tf = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
const out = [];
const log = (svc, status, detail) => out.push(`  ${svc.padEnd(22)} ${status.padEnd(13)} ${detail || ''}`);
const decrypt = (enc, keyHex) => { const [iv, t, c] = enc.split(':'); const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'hex'), { authTagLength: 16 }); d.setAuthTag(Buffer.from(t, 'hex')); return d.update(c, 'hex', 'utf8') + d.final('utf8'); };

// --- Google accounts (decrypt refresh token → try refresh → identify) ---
try {
  const enc = process.env.BOSS_TOKEN_ENCRYPTION_KEY || await cfg('BOSS_TOKEN_ENCRYPTION_KEY');
  const cid = await cfg('GOOGLE_CLIENT_ID'), cs = await cfg('GOOGLE_CLIENT_SECRET');
  const rows = (await pool.query("SELECT account_id, refresh_token FROM boss_oauth_tokens WHERE provider='google'")).rows;
  for (const r of rows) {
    try {
      const rt = decrypt(r.refresh_token, enc);
      const res = await tf('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: rt, grant_type: 'refresh_token' }) });
      const j = await res.json();
      if (j.access_token) {
        const ui = await tf('https://www.googleapis.com/oauth2/v1/userinfo', { headers: { authorization: `Bearer ${j.access_token}` } }).then(x => x.json()).catch(() => ({}));
        log('google:' + (ui.email || r.account_id.slice(7, 25)), 'LIVE', 'token refreshes');
      } else log('google:' + r.account_id.slice(7, 27), 'NEEDS-REAUTH', j.error || '');
    } catch (e) { log('google:' + r.account_id.slice(7, 27), 'NEEDS-REAUTH', (e.message || '').slice(0, 30)); }
  }
} catch (e) { log('google', 'ERROR', e.message); }

// --- API-key services ---
const checks = [
  ['gemini', async () => (await tf(`https://generativelanguage.googleapis.com/v1beta/models?key=${await cfg('GEMINI_API_KEY')}`)).status],
  ['xai/grok', async () => (await tf('https://api.x.ai/v1/models', { headers: { authorization: `Bearer ${await cfg('GROK_API_KEY')}` } })).status],
  ['openai', async () => (await tf('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${await cfg('OPENAI_API_KEY')}` } })).status],
  ['slack(bot)', async () => { const j = await (await tf('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${await cfg('SLACK_BOT_TOKEN')}` } })).json(); return j.ok ? '200 ' + (j.team || '') : '401 ' + j.error; }],
  ['telegram', async () => { const j = await (await tf(`https://api.telegram.org/bot${await cfg('TELEGRAM_BOT_TOKEN')}/getMe`)).json(); return j.ok ? '200 @' + j.result.username : '401 ' + (j.description || ''); }],
  ['notion', async () => (await tf('https://api.notion.com/v1/users/me', { headers: { authorization: `Bearer ${await cfg('NOTION_API_KEY')}`, 'Notion-Version': '2022-06-28' } })).status],
  ['make', async () => (await tf('https://us2.make.com/api/v2/scenarios?organizationId=4658230', { headers: { authorization: `Token ${await cfg('MAKE_API_KEY')}` } })).status],
  ['n8n(vps)', async () => (await tf('http://localhost:5679/api/v1/workflows?limit=1', { headers: { 'X-N8N-API-KEY': await cfg('N8N_API_KEY') } })).status],
  ['airtable', async () => (await tf('https://api.airtable.com/v0/meta/whoami', { headers: { authorization: `Bearer ${await cfg('AIRTABLE_API_KEY')}` } })).status],
  ['github', async () => (await tf('https://api.github.com/user', { headers: { authorization: `Bearer ${await cfg('GITHUB_TOKEN')}`, 'user-agent': 'boss' } })).status],
  ['elevenlabs', async () => (await tf('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': await cfg('ELEVENLABS_API_KEY') } })).status],
  ['stripe', async () => (await tf('https://api.stripe.com/v1/balance', { headers: { authorization: `Bearer ${await cfg('STRIPE_SECRET_KEY')}` } })).status],
  ['heygen', async () => (await tf('https://api.heygen.com/v2/user/remaining_quota', { headers: { 'x-api-key': await cfg('HEYGEN_API_KEY') } })).status],
  ['openwa(box)', async () => (await tf('http://100.78.24.32:2785/api/sessions', { headers: { 'X-API-Key': process.env.OPENWA_API_KEY || await cfg('OPENWA_API_KEY') } })).status],
];
for (const [name, fn] of checks) {
  try { const s = await fn(); log(name, String(s).startsWith('2') ? 'LIVE' : 'CHECK', String(s)); }
  catch (e) { log(name, 'DEAD/ERR', (e.message || '').slice(0, 36)); }
}
console.log(out.join('\n'));
await pool.end();
