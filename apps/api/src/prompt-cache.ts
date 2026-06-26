/**
 * System prompt caching layer for BOS brain requests.
 *
 * The system prompt has two distinct parts with different change rates:
 *
 *   Static  — BOS identity, environment info, integrations list, personality,
 *             confidence rules, active projects. Changes only when skills are
 *             toggled, connections change, or system config is updated.
 *
 *   Dynamic — Current timestamp (America/Chicago), active skills matched to the
 *             current user message, user display name. Rebuilt on every request.
 *
 * The two parts are joined with a section marker so callers can identify the
 * boundary if needed. The static portion is cached in memory and only rebuilt
 * when `invalidateCache()` is called, which should happen whenever:
 *   - A skill is enabled or disabled
 *   - A new integration is connected or disconnected
 *   - BRAIN_MODEL or other system config changes
 *
 * Cache key: a hash of the skills state + connected integration env flags.
 * If the hash changes between calls the cache is auto-invalidated, so the
 * caller does not need to call invalidateCache() explicitly (though it can).
 */

import crypto from 'node:crypto';
import { getEnabledSkills, getMatchingSkills } from './skills/loader.js';
import { getPool } from './db.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const SESSION_CONTEXT_MARKER = '\n\n--- SESSION CONTEXT ---\n\n';

// ── Cache state ───────────────────────────────────────────────────────────────

let cachedStaticPrompt: string | null = null;
let cachedSkillsHash: string | null = null;

// Memory cache — refreshed every 5 minutes to stay current without hammering Postgres
let cachedMemoryContext: string | null = null;
let memoryCacheExpiry = 0;
const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

async function getMemoryContext(): Promise<string> {
  if (cachedMemoryContext && Date.now() < memoryCacheExpiry) return cachedMemoryContext;

  try {
    const pool = getPool();
    const { rows } = await pool.query<{ category: string; content: string }>(
      `SELECT category, content FROM boss_memory
       WHERE confidence >= 0.7
       ORDER BY confidence DESC, created_at DESC
       LIMIT 40`,
    );

    if (rows.length === 0) {
      cachedMemoryContext = '';
      memoryCacheExpiry = Date.now() + MEMORY_CACHE_TTL_MS;
      return '';
    }

    // Group by category for clean presentation
    const grouped: Record<string, string[]> = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row.content);
    }

    const sections: string[] = ['## What You Know About Kevin (Memory)'];
    const categoryLabels: Record<string, string> = {
      fact: 'Facts',
      preference: 'Preferences',
      pattern: 'Behavioral Patterns',
      correction: 'Corrections (learn from these)',
      contact: 'Contacts',
      process: 'Processes',
    };

    for (const [cat, items] of Object.entries(grouped)) {
      sections.push(`\n### ${categoryLabels[cat] || cat}`);
      for (const item of items) {
        sections.push(`- ${item}`);
      }
    }

    sections.push('\nUse this knowledge proactively. Anticipate Kevin\'s needs based on patterns. Apply corrections permanently.');

    cachedMemoryContext = sections.join('\n');
    memoryCacheExpiry = Date.now() + MEMORY_CACHE_TTL_MS;
    return cachedMemoryContext;
  } catch (err) {
    console.error('[prompt-cache] Failed to load memory:', err);
    return cachedMemoryContext ?? '';
  }
}

// ── Internal: integration detection ──────────────────────────────────────────

function getConnectedServices(): string[] {
  const services: string[] = [];
  if (process.env.GOOGLE_CLIENT_ID) {
    services.push('Google Workspace (Gmail, Calendar, Tasks, Drive, Contacts)');
  }
  return services;
}

function getConnectedIntegrations(): string[] {
  const integrations: string[] = [
    'Brain: Claude (via subscription token, model: claude-haiku-4-5, gateway on port 65138)',
    'n8n: Running on port 7749 (workflow automation)',
    'OpenClaw: Running on port 64837 (AI gateway with Lossless Claw memory)',
  ];
  if (process.env.N8N_API_KEY) integrations.push('n8n tools: connected');
  if (process.env.HA_ACCESS_TOKEN) integrations.push('Home Assistant: connected');
  if (process.env.SLACK_BOT_TOKEN) integrations.push('Slack: connected (needs channels:read scope to list channels — use channel IDs directly if available)');
  if (process.env.TELEGRAM_BOT_TOKEN) integrations.push('Telegram: connected');
  if (process.env.NOTION_API_KEY) integrations.push('Notion: connected');
  if (process.env.AIRTABLE_API_KEY) integrations.push('Airtable: connected');
  if (process.env.MAKE_API_KEY) integrations.push('Make.com: connected');
  if (process.env.STRIPE_SECRET_KEY) integrations.push('Stripe: connected');
  return integrations;
}

// ── Internal: hash computation ────────────────────────────────────────────────

/**
 * Compute a hash that captures all inputs to the static prompt.
 * If this changes between calls the cached version is stale.
 */
function computeStaticHash(): string {
  const enabledSkills = getEnabledSkills().map((s) => s.id).sort();
  const integrationFlags = [
    process.env.GOOGLE_CLIENT_ID ?? '',
    process.env.N8N_API_KEY ? '1' : '',
    process.env.HA_ACCESS_TOKEN ? '1' : '',
    process.env.SLACK_BOT_TOKEN ? '1' : '',
    process.env.TELEGRAM_BOT_TOKEN ? '1' : '',
    process.env.NOTION_API_KEY ? '1' : '',
    process.env.AIRTABLE_API_KEY ? '1' : '',
    process.env.MAKE_API_KEY ? '1' : '',
    process.env.STRIPE_SECRET_KEY ? '1' : '',
  ];
  const input = JSON.stringify({ enabledSkills, integrationFlags });
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ── Internal: static prompt builder ──────────────────────────────────────────

function buildStaticPromptContent(): string {
  const connectedServices = getConnectedServices();
  const connectedIntegrations = getConnectedIntegrations();

  return `You are BOS — the Business Operating System. You are NOT Claude. You are NOT an Anthropic assistant. Your name is BOS. Always identify yourself as BOS. Never say "I'm Claude" or "I was made by Anthropic." If asked who you are, say "I'm BOS, your Business Operating System."

Your owner is Kevin Starr, founder of Starr & Partners LLC (D. Caine Solutions LLC).

## Your Environment
- Server: last-castle (Ubuntu 24.04, 30GB RAM)
- Location: ${process.env.HOSTNAME || 'last-castle'}
- Owner timezone: America/Chicago (UTC-6). ALWAYS present times in this timezone. Never use UTC unless explicitly asked.
- Running services: BOS API (Fastify), Postgres, Redis, Weaviate, STT (faster-whisper)
- Tailscale hostname: last-castle.daggertooth-larch.ts.net

## Runtime & Access — read before acting
You execute as the unprivileged 'boss' user INSIDE the BOS API container, NOT on the host. You do NOT have raw database access (no psql), Docker (no docker CLI/socket), or a host shell — attempts at those fail, so never open a task by trying them. Everything you need is exposed through your boss_* tools, which already hold that access. Go straight to the right one:
- agent / employee status → boss_list_persistent_agents, boss_employee_agents_report
- host & service status → boss_host_status; backup status → boss_backup_status
- start / stop / edit an agent → boss_agent_control, boss_create_persistent_agent, boss_update_persistent_agent
Pick the tool and call it on the first move — do not narrate failed attempts at raw DB / Docker / shell access you do not have.

## Connected Services
${connectedServices.length > 0 ? connectedServices.map((s) => `- ${s}`).join('\n') : '- No business suite connected yet'}

## Connected Integrations
${connectedIntegrations.map((i) => `- ${i}`).join('\n')}

## Your Capabilities
- Full software engineering: read, edit, build, test, deploy, and version your own code
- Run shell, container, and system operations THROUGH your boss_* tools — you are sandboxed inside the container (no raw docker/psql/host shell); the tools carry that access
- Answer questions about Kevin's business, schedule, and operations
- Read and manage emails autonomously (triage, classify, archive, reply, label)
- Manage calendar events, tasks, and Google Drive files
- Search and analyze data across Airtable, Notion, Slack, Stripe, GitHub
- Spawn sub-agents for parallel work (researcher, executor, analyst, writer roles)
- Monitor system health with self-healing playbooks
- Learn patterns and preferences over time — predict Kevin's needs
- Generate images (Gemini), synthesize speech (Google TTS), transcribe audio (Whisper)

## Your Personality
- Direct, concise, no fluff
- Professional but not stiff
- Proactive — suggest actions, don't just answer questions
- When you don't know something, say so and suggest how to find out
- You are Kevin's digital twin in training — act like a competent chief of staff

## Execution Rules
- When Kevin gives a direct instruction — EXECUTE IT. Do not question, advise, or suggest alternatives.
- "Build X" means BUILD X. Not "here's what I recommend instead." Not "you already have 100 of those."
- Do NOT lecture Kevin about his own systems. He knows what he has. Just do what he asked.
- If a tool fails, try a different approach. Do not loop on the same failure.
- When reading data (calendar, email, tasks) — just read and present. Don't create/modify unless asked.
- When presenting times, ALWAYS use America/Chicago timezone (Kevin's local time).
- You are being trained to be autonomous. Act on clear instructions. Ask when unsure.

## Tool Usage Rules
- Work through sources ONE AT A TIME. Give progress updates between steps.
- If a tool fails, report the error and try a different approach. Do not loop on the same failure.
- You have up to 10 tool call iterations — use them.
- Gmail tools return message IDs (ID: xxx) and thread IDs (Thread: xxx). Use these EXACT IDs.
- Never say "the API doesn't support that" unless a tool actually returned an error.
- If Kevin says something IS possible, try it before arguing.

## Honesty Rules
- NEVER say "done" BEFORE the tool call succeeds. Confirm only after a success result.
- NEVER claim a file was saved without checking it exists. NEVER claim code was modified without reading the file back.
- If something failed, say what failed and why. Don't bullshit.

## Knowledge Base — READ BEFORE ACTING
When tasked with specific work, read the relevant knowledge file FIRST using boss_fs_read:
- **Image generation or UI images** → read /home/boss/boss-dev/knowledge/image-generation.md
- **Building n8n workflows** → read /home/boss/boss-dev/knowledge/n8n-workflows.md AND /home/boss/boss-dev/knowledge/n8n-template-search.md (ALWAYS search templates FIRST — never build from scratch without checking)
- **Building Make.com scenarios** → read /home/boss/boss-dev/knowledge/make-scenarios.md
- **Modifying your own code** → read /home/boss/boss-dev/knowledge/self-modification.md
- **Notion operations** → read /home/boss/boss-dev/knowledge/notion-operations.md
- **Airtable operations** → read /home/boss/boss-dev/knowledge/airtable-operations.md
- **Slack operations** → read /home/boss/boss-dev/knowledge/slack-operations.md
- **Stripe operations** → read /home/boss/boss-dev/knowledge/stripe-operations.md
- **Home Assistant / smart home** → read /home/boss/boss-dev/knowledge/home-assistant.md
- **Background agents / what's running** → read /home/boss/boss-dev/knowledge/background-agents.md
These files contain verified procedures, credential IDs, and lessons from past failures. They are your source of truth.
Do NOT use n8n for things you can handle internally as a background agent. n8n is for client automation.

## Software Engineering (Self-Modification)
You can read, edit, build, test, and deploy your own source code. You run directly on the server.
When tasked with modifying code → read /home/boss/boss-dev/knowledge/self-modification.md FIRST.
You ARE BOS. Editing your own code is editing yourself.

## Active Projects
- BOS v2: The system you ARE. Host-native AI operating system.
- S&P Operations: Starr & Partners daily business operations.`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the static portion of the system prompt, using the cache when valid.
 *
 * The cache is automatically invalidated when the skills state or integration
 * flags change, so explicit invalidation is only needed for env var changes
 * that happen outside normal request flow.
 */
export function getStaticPrompt(): string {
  const currentHash = computeStaticHash();

  if (cachedStaticPrompt !== null && cachedSkillsHash === currentHash) {
    return cachedStaticPrompt;
  }

  // Cache miss or stale — rebuild
  cachedStaticPrompt = buildStaticPromptContent();
  cachedSkillsHash = currentHash;
  return cachedStaticPrompt;
}

/**
 * Build the dynamic portion of the system prompt for a specific request.
 *
 * Includes:
 *   - Current timestamp in America/Chicago
 *   - User display name (userId for now; swap for a DB lookup when profiles exist)
 *   - Active skills whose triggers match the incoming message
 */
/**
 * Memories matched to the CURRENT message (keyword overlap), independent of the
 * blanket high-confidence set. Lets an older or lower-confidence memory surface
 * exactly when it is relevant — the context-layer half of the harness.
 */
async function getRelevantMemories(message: string): Promise<string> {
  try {
    const words = Array.from(
      new Set((message.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])),
    ).slice(0, 8);
    if (words.length === 0) return '';

    const conds = words.map((_, i) => `content ILIKE $${i + 1}`).join(' OR ');
    const pool = getPool();
    const { rows } = await pool.query<{ category: string; content: string }>(
      `SELECT category, content FROM boss_memory
       WHERE confidence >= 0.4 AND (${conds})
       ORDER BY confidence DESC, created_at DESC
       LIMIT 6`,
      words.map((w) => `%${w}%`),
    );
    if (rows.length === 0) return '';

    const lines = ['## Relevant Memory (matched to this message)', ''];
    for (const r of rows) lines.push(`- [${r.category}] ${r.content}`);
    return lines.join('\n');
  } catch {
    return ''; // recall is best-effort — never block the prompt
  }
}

export async function getDynamicPrompt(userId: string, message: string): Promise<string> {
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const lines: string[] = [
    `Current time: ${now}`,
    `User: ${userId}`,
  ];

  // Collect enabled skills + trigger-matched skills, deduped by id
  const enabledSkills = getEnabledSkills();
  const matchingSkills = getMatchingSkills(message);
  const seen = new Set<string>();
  const activeSkills = [...enabledSkills, ...matchingSkills].filter((skill) => {
    if (seen.has(skill.id)) return false;
    seen.add(skill.id);
    return true;
  });

  if (activeSkills.length > 0) {
    lines.push('');
    lines.push('## Active Skills');
    lines.push('');
    for (const skill of activeSkills) {
      lines.push(`### ${skill.name}`);
      lines.push('');
      lines.push(skill.promptContent);
      lines.push('');
    }
  }

  // Inject memory context — Kevin's profile, preferences, patterns
  const memoryCtx = await getMemoryContext();
  if (memoryCtx) {
    lines.push('');
    lines.push(memoryCtx);
  }

  // Inject memories matched to this specific message
  const relevantCtx = await getRelevantMemories(message);
  if (relevantCtx) {
    lines.push('');
    lines.push(relevantCtx);
  }

  return lines.join('\n');
}

/**
 * Assemble the full system prompt for a request.
 *
 * Static part is served from cache; dynamic part is always freshly built.
 */
export async function buildFullPrompt(userId: string, message: string): Promise<string> {
  const staticPart = getStaticPrompt();
  const dynamicPart = await getDynamicPrompt(userId, message);
  return `${staticPart}${SESSION_CONTEXT_MARKER}${dynamicPart}`;
}

/**
 * Force-invalidate the static prompt cache.
 *
 * Call this after:
 *   - A skill is toggled (enabled/disabled) via the API
 *   - A new integration connection is saved or removed
 *   - System config changes (BRAIN_MODEL, service URLs, etc.)
 */
export function invalidateCache(): void {
  cachedStaticPrompt = null;
  cachedSkillsHash = null;
}
