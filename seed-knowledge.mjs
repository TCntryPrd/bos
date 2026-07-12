// Seed the IR Custom AIOS white-label Weaviate Knowledge collection with the
// operational how-to library. Run inside the boss-ir_default network:
//   docker run --rm --network boss-ir_default -v /docker/boss-ir:/repo:ro \
//     --env-file /tmp/seed.env node:20-alpine node /repo/seed-knowledge.mjs
//
// Scope (Kevin-approved): operational docs only. NO client/consulting docs.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const WEAVIATE = process.env.WEAVIATE_URL || 'http://weaviate:8080';
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1); }

const DOCS = [
  { path: '/repo/docs/COO.md', title: 'COO Agent — Operating Guide', project: 'aios-operations' },
  { path: '/repo/docs/playbooks/backup-recovery.md', title: 'Playbook — Backup & Recovery', project: 'aios-operations' },
  { path: '/repo/docs/playbooks/dashboard-tiles.md', title: 'Playbook — Dashboard Tiles', project: 'aios-operations' },
  { path: '/repo/docs/playbooks/rascal-lifecycle.md', title: 'Playbook — Agent (Rascal) Lifecycle', project: 'aios-operations' },
  { path: '/repo/docs/playbooks/whatsapp-openwa.md', title: 'Playbook — WhatsApp via OpenWA', project: 'aios-operations' },
  { path: '/repo/docs/playbooks/whatsapp-sync-names.md', title: 'Playbook — WhatsApp Contact Name Sync', project: 'aios-operations' },
  { path: '/repo/docs/playbooks/whatsapp-vps-mirror.md', title: 'Playbook — WhatsApp VPS Mirror', project: 'aios-operations' },
  { path: '/repo/agents/spanky/AGENT.md', title: 'Agent Definition — Spanky', project: 'aios-agents' },
  { path: '/repo/agents/buckley/AGENT.md', title: 'Agent Definition — Buckley', project: 'aios-agents' },
  { path: '/repo/agents/mercury/AGENT.md', title: 'Agent Definition — Mercury', project: 'aios-agents' },
];

async function embed(text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent?key=${KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'models/gemini-embedding-2-preview', content: { parts: [{ text: text.slice(0, 7500) }] } }) }
  );
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).embedding.values;
}

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let ok = 0, fail = 0;
for (const doc of DOCS) {
  try {
    const content = readFileSync(doc.path, 'utf8');
    const vector = await embed(`${doc.title}\n\n${content}`);
    const body = {
      class: 'Knowledge',
      properties: {
        content, title: doc.title, project: doc.project,
        source: doc.path.replace('/repo/', ''),
        slug: slugify(doc.title),
        agent: 'spanky',
        captured_at: new Date().toISOString(),
      },
      vector,
    };
    const res = await fetch(`${WEAVIATE}/v1/objects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`weaviate ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = await res.json();
    console.log(`✓ ${basename(doc.path)} → ${out.id} (${vector.length}d)`);
    ok++;
  } catch (e) {
    console.error(`✗ ${doc.path}: ${e.message}`);
    fail++;
  }
}
console.log(`\nSeeded ${ok}/${DOCS.length} (${fail} failed)`);
