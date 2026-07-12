// Vasari v3 — M1 vertical slice: one rascal answers via the full v3 path.
// message -> Context Assembler (SOUL + rolling history + curated skills)
//         -> Router (classify -> tier -> provider/model)
//         -> one-shot provider call (Gemini/xAI; cheap-first, conserves Claude)
//         -> persist (boss_chat_messages) -> token_ledger row.
// Run: POSTGRES_URL=... node v3-turn.mjs <handle> "<message>" [sessionId]
import pg from 'pg';
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const RASCAL_DIR = '/home/tcntryprd/rascals';
const SKILL_DIR  = '/home/tcntryprd/sp-hub/skills';

// USD per 1M tokens (approx; refined in M2 from provider docs)
const PRICING = {
  'google/gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
  'google/gemini-2.5-flash':      { in: 0.30, out: 2.50 },
  'xai/grok-4.3':                 { in: 3.00, out: 15.0 },
  'anthropic/claude-sonnet-4-6':  { in: 3.00, out: 15.0 },
};

const cfg = async (k) => (await pool.query(
  'SELECT value FROM runtime_config WHERE key=$1 AND tenant_id=$2', [k, 'default'])).rows[0]?.value;

// ── Router: classify → tier → model. Cheap-first; escalate complex to a stronger model.
function route(message) {
  const len = message.length;
  const complex = /\b(analy|strateg|plan|architect|legal|contract|compare|design|debug|forecast|negoti)\w*/i.test(message) || len > 600;
  if (complex)        return { tier: 'heavy',  provider: 'xai',    model: 'xai/grok-4.3' };
  if (len > 200)      return { tier: 'work',   provider: 'google', model: 'google/gemini-2.5-flash' };
  return                     { tier: 'triage', provider: 'google', model: 'google/gemini-2.5-flash-lite' };
}

// ── Context Assembler
async function pickSkills(message) {
  let names = [];
  try { names = (await readdir(SKILL_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  const words = message.toLowerCase().match(/[a-z]{4,}/g) || [];
  const scored = names.map(n => ({ n, s: words.filter(w => n.includes(w) || n.split('-').some(p => p === w)).length }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
  const out = [];
  for (const { n } of scored) {
    let desc = '';
    try { const m = (await readFile(`${SKILL_DIR}/${n}/SKILL.md`, 'utf8')).match(/description:\s*(.+)/i); desc = (m ? m[1] : '').slice(0, 140); } catch {}
    out.push({ name: n, desc });
  }
  return out;
}

async function assemble(handle, sessionId, message) {
  const dir = `${RASCAL_DIR}/${handle}`;
  const soul = (await readFile(`${dir}/CLAUDE.md`, 'utf8').catch(() => '')).slice(0, 4000); // cacheable standing context
  // Cognitive-memory recall: MEMORY.md index + most recent episodes (so reasoning turns answer from memory, no tools).
  let memory = await readFile(`${dir}/MEMORY.md`, 'utf8').catch(() => '');
  try {
    const eps = (await readdir(`${dir}/memory/episodes`)).filter(f => f.endsWith('.md')).sort().slice(-2);
    for (const e of eps) memory += `\n\n--- episode ${e} ---\n` + (await readFile(`${dir}/memory/episodes/${e}`, 'utf8').catch(() => ''));
  } catch {}
  memory = memory.slice(0, 6000);
  let history = [];
  if (sessionId) {
    const r = await pool.query('SELECT role, content FROM boss_chat_messages WHERE session_id=$1 ORDER BY created_at DESC LIMIT 6', [sessionId]);
    history = r.rows.reverse();
  }
  const skills = await pickSkills(message);
  const skillBlock = skills.length ? `\n\n## Curated skills available this turn\n${skills.map(s => `- ${s.name}: ${s.desc}`).join('\n')}` : '';
  const memBlock = memory.trim() ? `\n\n## YOUR MEMORY (recent — answer from this)\n${memory}` : '';
  const guard = '\n\n## TURN MODE: reasoning (no live tools this turn)\nAnswer from your SOUL + YOUR MEMORY above. Do NOT fabricate command output or the current date. If something genuinely is not in your memory, say briefly you would check live — do not guess.';
  return { system: soul + memBlock + skillBlock + guard, history, skills };
}

// ── Providers
async function callGemini(model, system, messages, key) {
  const m = model.split('/')[1];
  const contents = messages.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: 1024 } };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('gemini ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return { text: j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '',
    tin: j.usageMetadata?.promptTokenCount || 0, tout: j.usageMetadata?.candidatesTokenCount || 0 };
}
async function callXai(model, system, messages, key) {
  const body = { model: model.split('/')[1], messages: [{ role: 'system', content: system }, ...messages], max_tokens: 1024 };
  const r = await fetch('https://api.x.ai/v1/chat/completions',
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('xai ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return { text: j.choices?.[0]?.message?.content || '', tin: j.usage?.prompt_tokens || 0, tout: j.usage?.completion_tokens || 0 };
}

// OpenRouter (OpenAI-compatible). Gateway for cheap/FREE models (Kevin 2026-06-03,
// $100/mo cap set on OpenRouter side). `model` is a full OR id e.g.
// "google/gemma-4-31b-it:free".
async function callOpenRouter(model, system, messages, key) {
  const body = { model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: 1024 };
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`,
      'http-referer': 'https://vasari-vps.daggertooth-larch.ts.net', 'x-title': 'Vasari' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('openrouter ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return { text: j.choices?.[0]?.message?.content || '', tin: j.usage?.prompt_tokens || 0, tout: j.usage?.completion_tokens || 0 };
}

// Rotating pool of Google AI Studio keys → 3× the free-tier rate limit + failover
// (Kevin supplied 3 keys 2026-06-03). Comma-separated in GEMINI_API_KEYS, falling
// back to the single GEMINI_API_KEY.
let _gki = 0;
async function geminiKeys() {
  const raw = (await cfg('GEMINI_API_KEYS')) || (await cfg('GEMINI_API_KEY')) || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Cheap-tier text gen, FREE-FIRST done right: Gemma 4 via Google's OWN API
// (Kevin's preferred model, free on Google's tier), rotating across his 3 keys and
// retrying on per-key rate-limit. Paid OpenRouter Gemma-4 is the backstop if every
// Google key is exhausted/erroring — so a turn never fails. No OpenRouter middleman
// or BYOK fee in the normal path. For non-tool cheap work (classifier, router,
// extraction, rascal answers). Returns {text,tin,tout,model}.
async function cheapChat(system, messages) {
  const model = process.env.OPENROUTER_CHEAP_MODEL || 'google/gemma-4-31b-it'; // google/<id> works for both APIs
  const keys = await geminiKeys();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(_gki++) % keys.length];
    try { return { ...(await callGemini(model, system, messages, key)), model }; }
    catch { /* this key rate-limited/errored → rotate to the next */ }
  }
  const orKey = await cfg('OPENROUTER_API_KEY');
  if (orKey) {
    try { return { ...(await callOpenRouter(model, system, messages, orKey)), model: model + ' (or)' }; }
    catch { /* fall through */ }
  }
  // Last resort so a turn never hangs.
  return { ...(await callGemini('google/gemini-2.5-flash-lite', system, messages, keys[0] || '')), model: 'google/gemini-2.5-flash-lite' };
}

async function ensureSession(handle, model, name) {
  const r = await pool.query(
    `INSERT INTO boss_chat_sessions(tenant_id, rascal_handle, name, model, agent_kind) VALUES('default',$1,$2,$3,'rascal') RETURNING id`,
    [handle, name, model]);
  return r.rows[0].id;
}

// ── Tool-turn path: agentic `claude -p` one-shot in the rascal's project dir
// (subscription auth, auto-loads the dir's CLAUDE.md SOUL + skills). Stateless.
function needsTools(m) {
  // tool/action intent OR live-data intent (client status/data needs real reads, not guesses)
  return /\b(check|list|read|run|fetch|send|create|update|look up|search|file|files|directory|calendar|email|inbox|schedule|upload|download|execute|today'?s date|status|latest|recent|progress|account|where are we|where do we stand|how (is|are))\b/i.test(m);
}
function callClaudeCode(handle, message) {
  return new Promise((resolve, reject) => {
    const cwd = `${RASCAL_DIR}/${handle}`;
    // stdin closed (/dev/null) so claude -p doesn't hang waiting for stdin under systemd.
    // ANTHROPIC_API_KEY (if set) authenticates via API — stable during parallel-run.
    const ch = spawn('claude', ['-p', message, '--output-format', 'json', '--dangerously-skip-permissions'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: '/home/tcntryprd' } });
    let out = '', err = '';
    ch.stdout.on('data', d => (out += d));
    ch.stderr.on('data', d => (err += d));
    const to = setTimeout(() => { ch.kill('SIGKILL'); reject(new Error('claude -p timeout')); }, 180000);
    ch.on('error', e => { clearTimeout(to); reject(e); });
    ch.on('close', () => {
      clearTimeout(to);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(j.result || 'claude error'));
        resolve({ text: j.result || '', tin: j.usage?.input_tokens || 0, tout: j.usage?.output_tokens || 0, costUsd: j.total_cost_usd });
      } catch { reject(new Error('claude -p failed: ' + (err || out).slice(0, 180))); }
    });
  });
}

// ── COO brain: Sonnet 4.6 via Max `claude -p`. The orchestration reasoning model
// (Kevin 2026-06-03). Runs in a NEUTRAL dir (no stray CLAUDE.md/SOUL) with the
// COO identity + live knowledge injected via --append-system-prompt. Returns the
// same {text,tin,tout} shape as callGemini so callers swap cleanly.
const COO_DIR = '/home/tcntryprd/coo';
function callClaudeBrain(system, message, model = 'claude-sonnet-4-6') {
  return new Promise((resolve, reject) => {
    const ch = spawn('claude', ['-p', message,
      '--append-system-prompt', system, '--model', model,
      // Bound exploration so an impossible/ambiguous task can't run away on an
      // interactive COO turn — caps spend, and the timeout below is the hard stop.
      '--max-budget-usd', '0.35',
      '--output-format', 'json', '--dangerously-skip-permissions'],
      { cwd: COO_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: '/home/tcntryprd' } });
    let out = '', err = '';
    ch.stdout.on('data', d => (out += d));
    ch.stderr.on('data', d => (err += d));
    const to = setTimeout(() => { ch.kill('SIGKILL'); reject(new Error('claude brain timeout')); }, 60000);
    ch.on('error', e => { clearTimeout(to); reject(e); });
    ch.on('close', () => {
      clearTimeout(to);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(j.result || 'claude error'));
        resolve({ text: j.result || '', tin: j.usage?.input_tokens || 0, tout: j.usage?.output_tokens || 0, costUsd: j.total_cost_usd });
      } catch { reject(new Error('claude brain failed: ' + (err || out).slice(0, 180))); }
    });
  });
}

// ── Execution path: route actionable directives to the tool-enabled brain loop
// (apps/api /api/brain/chat) which runs executeTool() in DANGEROUS mode. This is
// where "the work gets done" (Kevin 2026-06-03). Full-dangerous: no approval gate.

const BRAIN_URL = process.env.BOSS_BRAIN_URL || 'http://localhost:8001/api/brain/chat';

// Mint a short-lived admin JWT (HS256) so the orchestrator can call the protected
// brain endpoint as the owner.
function mintServiceJwt() {
  const secret = process.env.BOSS_JWT_SECRET;
  const b = (x) => Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = b(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b(JSON.stringify({ sub: 'boss-coo', role: 'admin', tenantId: 'd05cde41-4754-4f1f-ae13-ecb0be8b6fad', iat: now, exp: now + 600 }));
  const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${p}.${sig}`;
}

// Does this message want WORK done (a change/action), vs. a question to answer?
function isAction(message) {
  return /\b(send|create|make|update|delete|remove|restart|stop|start|deploy|build|fix|schedule|post|move|add|set|run|execute|draft|reply|write|generate|configure|enable|disable|cancel|book|order|rename|archive|assign|kick off|spin up|stand up|provision|migrate|clean up|clear)\b/i.test(message);
}

// Best-effort platform/domain for frequency tracking + auto-hire.
function detectDomain(message) {
  const m = message.toLowerCase();
  const map = [
    ['email', /\b(email|gmail|inbox|mail)\b/], ['calendar', /\b(calendar|event|meeting|schedule)\b/],
    ['slack', /\bslack\b/], ['drive', /\b(drive|document|file|folder)\b/], ['n8n', /\bn8n\b/],
    ['make', /\b(make|scenario)\b/], ['whatsapp', /\b(whatsapp|wa|dally)\b/], ['notion', /\bnotion\b/],
    ['stripe', /\b(stripe|invoice|payment|billing)\b/], ['telegram', /\btelegram\b/],
    ['github', /\b(github|repo|pull request|commit)\b/], ['infra', /\b(container|docker|service|host|server|systemctl|deploy)\b/],
  ];
  for (const [d, re] of map) if (re.test(m)) return d;
  return null;
}

// Run a directive through the brain tool loop. Returns { text, ok, err, latency }.
async function callBrainExecute(message, conversationId) {
  const t0 = Date.now();
  try {
    const r = await fetch(BRAIN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mintServiceJwt()}` },
      body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { text: '', ok: false, err: (j.message || JSON.stringify(j)).slice(0, 200), latency: Date.now() - t0 };
    return { text: j.response || j.answer || j.text || '', ok: true, err: '', latency: Date.now() - t0 };
  } catch (e) {
    return { text: '', ok: false, err: e.message, latency: Date.now() - t0 };
  }
}

// ── Post-turn memory write: cheap gated extraction → durable note appended to
// the rascal's cognitive-memory tree (only writes when there's something durable).
async function memoryWrite(handle, message, answer) {
  try {
    const key = await cfg('GEMINI_API_KEY');
    const prompt = `From this exchange extract at most ONE durable, reusable fact worth long-term memory (a decision, client fact, preference, or status). If nothing durable, return {"durable":false}. Reply ONLY JSON {"durable":bool,"note":"<=160 chars"}.\nUSER: ${message}\nASSISTANT: ${answer.slice(0, 1500)}`;
    const res = await callGemini('google/gemini-2.5-flash-lite', 'You extract durable memory notes. JSON only.', [{ role: 'user', content: prompt }], key);
    const p = PRICING['google/gemini-2.5-flash-lite'];
    await pool.query(`INSERT INTO token_ledger(agent_kind,agent_handle,task_class,provider,model,tokens_in,tokens_out,cost_usd,meta)
      VALUES('rascal',$1,'extract','google','gemini-2.5-flash-lite',$2,$3,$4,'{"m1":true}')`,
      [handle, res.tin, res.tout, (res.tin * p.in + res.tout * p.out) / 1e6]);
    const m = res.text.match(/\{[\s\S]*\}/); if (!m) return null;
    const j = JSON.parse(m[0]); if (!j.durable || !j.note) return null;
    const day = new Date().toISOString().slice(0, 10);
    const dir = `${RASCAL_DIR}/${handle}/memory/episodes`;
    await pexec('mkdir', ['-p', dir]);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(`${dir}/${day}.md`, `- (v3 turn) ${j.note}\n`);
    return j.note;
  } catch { return null; }
}

// ── Turn handler
async function runTurn(handle, message, sessionId) {
  const t0 = Date.now();
  // Budget enforcement (DoD #2): block/escalate when an agent hits its daily cap.
  const cap = (await pool.query("SELECT daily_usd_cap, hard_stop FROM token_budget WHERE agent_kind='rascal' AND (agent_handle=$1 OR agent_handle='*') ORDER BY (agent_handle=$1) DESC LIMIT 1", [handle])).rows[0];
  if (cap?.daily_usd_cap) {
    const spent = Number((await pool.query("SELECT COALESCE(sum(cost_usd),0) s FROM token_ledger WHERE agent_handle=$1 AND ts::date = now()::date", [handle])).rows[0].s);
    if (spent >= Number(cap.daily_usd_cap) && cap.hard_stop) {
      return { route: { tier: 'blocked', model: 'none' }, sid: sessionId || null, text: `[budget] ${handle} hit its daily cap ($${cap.daily_usd_cap}; spent $${spent.toFixed(4)}). Escalating to Kevin rather than spending more.`, tin: 0, tout: 0, cost: 0, latency: 0, skills: [], memNote: null };
    }
  }
  // Route is a pure heuristic (no model call), so decide it first. Interactive
  // rascal/outsider CHAT that needs tools → agentic claude -p (quality — Kevin is
  // talking to a manager). Background cron duties use cheap models in the managers
  // loop, not this path, so this doesn't affect cron cost.
  let r = needsTools(message) ? { tier: 'tool', provider: 'anthropic', model: 'claude-code' } : route(message);
  let skills = [];

  // PERSIST THE USER MESSAGE IMMEDIATELY — never drop it, even if the model call fails.
  const sid = sessionId || await ensureSession(handle, r.model, message.slice(0, 60));
  await pool.query("INSERT INTO boss_chat_messages(session_id, role, content) VALUES($1,'user',$2)", [sid, message]);

  // Run the model with a graceful fallback so a turn never vanishes / hangs the bubble.
  let res;
  try {
    if (r.tier === 'tool') {
      // Agentic claude -p in the rascal's own dir (loads its CLAUDE.md SOUL + skills).
      res = await callClaudeCode(handle, message);
    } else {
      const a = await assemble(handle, sid, message);
      skills = a.skills;
      // triage/work → Gemini (decent, cheap); heavy → Grok. NOT gemma-4 (it
      // produced junk on the rascal SOUL prompts — that broke the chats).
      const key = r.provider === 'google' ? await cfg('GEMINI_API_KEY') : await cfg('GROK_API_KEY');
      res = r.provider === 'google'
        ? await callGemini(r.model, a.system, [...a.history, { role: 'user', content: message }], key)
        : await callXai(r.model, a.system, [...a.history, { role: 'user', content: message }], key);
    }
  } catch (e) {
    // tool turn unavailable (e.g. Max rate-capped) → fall back to a fast memory-grounded answer
    try {
      const a = await assemble(handle, sid, message);
      skills = a.skills;
      const fb = await callGemini('google/gemini-2.5-flash', a.system, [...a.history, { role: 'user', content: message }], await cfg('GEMINI_API_KEY'));
      r = { tier: 'fallback', provider: 'google', model: 'google/gemini-2.5-flash' };
      res = { text: fb.text || `(reasoned from memory — live tools unavailable: ${(e.message || '').slice(0, 80)})`, tin: fb.tin, tout: fb.tout };
    } catch (e2) {
      r = { tier: 'error', provider: 'none', model: 'none' };
      res = { text: `⚠️ ${(e.message || 'turn failed').slice(0, 240)}`, tin: 0, tout: 0 };
    }
  }
  const latency = Date.now() - t0;

  // Always persist an assistant row (real answer, fallback, or error note).
  await pool.query("INSERT INTO boss_chat_messages(session_id, role, content, tokens_out) VALUES($1,'assistant',$2,$3)", [sid, res.text, res.tout || 0]);

  if (r.provider !== 'none') {
    const modelId = r.model.includes('/') ? r.model.split('/')[1] : r.model;
    const p = PRICING[r.model] || { in: 0, out: 0 };
    const cost = res.costUsd != null ? res.costUsd : ((res.tin || 0) * p.in + (res.tout || 0) * p.out) / 1e6;
    await pool.query(
      `INSERT INTO token_ledger(agent_kind, agent_handle, session_id, task_class, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, escalated, meta)
       VALUES('rascal',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [handle, sid, r.tier, r.provider, modelId, res.tin || 0, res.tout || 0, cost, latency, r.tier === 'heavy', JSON.stringify({ tool: r.tier === 'tool', fallback: r.tier === 'fallback', skills: skills.map(s => s.name) })]);
  }

  const memNote = await memoryWrite(handle, message, res.text);
  return { route: r, sid, text: res.text, tin: res.tin || 0, tout: res.tout || 0, cost: 0, latency, skills, memNote };
}

export { runTurn, pool, cfg, callGemini, callXai, callOpenRouter, cheapChat, callClaudeBrain, callBrainExecute, isAction, detectDomain, route, assemble };

// CLI mode only when invoked directly (not when imported by the server)
if (import.meta.url === `file://${process.argv[1]}`) {
  const [handle, message, sessionId] = process.argv.slice(2);
  if (!handle || !message) { console.error('usage: node v3-turn.mjs <handle> "<message>" [sessionId]'); process.exit(1); }
  runTurn(handle, message, sessionId)
    .then(o => {
      console.log(`\n── ROUTE: ${o.route.tier} → ${o.route.model}  (${o.tin} in / ${o.tout} out, $${o.cost.toFixed(6)}, ${o.latency}ms)`);
      console.log(`── SKILLS injected: ${o.skills.map(s => s.name).join(', ') || '(none matched)'}`);
      console.log(`── SESSION: ${o.sid}`);
      if (o.memNote) console.log(`── MEMORY WRITE: ${o.memNote}`);
      console.log(`\n${o.text}\n`);
      return pool.end();
    })
    .catch(async e => { console.error('TURN FAILED:', e.message); await pool.end(); process.exit(1); });
}
