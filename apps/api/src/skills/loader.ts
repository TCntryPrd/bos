/**
 * BOS Skill Loader
 *
 * Skills are directories under apps/api/skills/ containing:
 *   skill.yaml  — metadata, triggers, enabled flag
 *   prompt.md   — content injected into the brain system prompt when active
 *
 * Skills are loaded from disk once at module init and cached in memory.
 * Enable/disable state persists to Postgres runtime_config as
 *   SKILL_<id>_ENABLED = "true" | "false"
 * with the skill.yaml `enabled` field as the fallback default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setRuntimeConfig, getRuntimeConfig } from '../config-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BossSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  triggers: string[];
  enabled: boolean;
  category: string;
  promptContent: string;
}

// ---------------------------------------------------------------------------
// Simple YAML parser
//
// Handles the flat key-value + array format used in skill.yaml.
// No external dependency. Supports:
//   key: value
//   key: "quoted value"
//   list_key:
//     - item
//     - item
// ---------------------------------------------------------------------------

function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (rawValue === '' || rawValue === undefined) {
      // Possibly an array block follows — collect lines that start with `  -`
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const trimmed = nextLine.trim();
        if (trimmed.startsWith('- ')) {
          items.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
          i++;
        } else if (trimmed === '' || trimmed.startsWith('#')) {
          i++;
        } else {
          // Non-list, non-empty line signals end of this array block
          break;
        }
      }
      if (items.length > 0) {
        result[key] = items;
      }
      continue;
    }

    // Inline value — strip optional quotes
    const stripped = rawValue.replace(/^["']|["']$/g, '');
    result[key] = stripped;
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Skill directory resolution
//
// The server is always started from apps/api/ (via `node dist/index.js` or
// `tsx watch src/index.ts`), so process.cwd() reliably points to apps/api/.
// The skills data directory is apps/api/skills/ — a sibling of dist/ and src/.
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.resolve(process.cwd(), 'skills');

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let _cache: BossSkill[] | null = null;

function ensureLoaded(): BossSkill[] {
  if (_cache !== null) return _cache;
  _cache = loadSkillsFromDisk();
  return _cache;
}

function loadSkillsFromDisk(): BossSkill[] {
  const skills: BossSkill[] = [];

  if (!fs.existsSync(SKILLS_DIR)) {
    return skills;
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(SKILLS_DIR, entry.name);
    const yamlPath = path.join(skillDir, 'skill.yaml');
    const promptPath = path.join(skillDir, 'prompt.md');

    if (!fs.existsSync(yamlPath)) continue;

    try {
      const yamlContent = fs.readFileSync(yamlPath, 'utf8');
      const meta = parseSimpleYaml(yamlContent);

      const id = typeof meta['id'] === 'string' ? meta['id'] : entry.name;
      const name = typeof meta['name'] === 'string' ? meta['name'] : id;
      const description = typeof meta['description'] === 'string' ? meta['description'] : '';
      const version = typeof meta['version'] === 'string' ? meta['version'] : '1.0';
      const author = typeof meta['author'] === 'string' ? meta['author'] : '';
      const category = typeof meta['category'] === 'string' ? meta['category'] : 'custom';
      const enabledRaw = meta['enabled'];
      const enabled = enabledRaw === 'false' ? false : enabledRaw === false ? false : true;

      const triggers: string[] = Array.isArray(meta['triggers'])
        ? (meta['triggers'] as string[])
        : [];

      const promptContent = fs.existsSync(promptPath)
        ? fs.readFileSync(promptPath, 'utf8').trim()
        : '';

      skills.push({ id, name, description, version, author, triggers, enabled, category, promptContent });
    } catch (err) {
      // Silently skip malformed skill directories — don't crash startup
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[skills] Failed to load skill "${entry.name}": ${msg}\n`);
    }
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all skills (including disabled ones). Returns cached result after
 * first call. Reload is only triggered by a process restart.
 */
export function loadSkills(): BossSkill[] {
  return ensureLoaded();
}

/**
 * Return only skills whose `enabled` field is true, taking runtime_config
 * overrides into account via the in-memory process.env projection written by
 * setRuntimeConfig/loadRuntimeConfig.
 *
 * process.env values take precedence over the skill.yaml default because
 * loadRuntimeConfig() populates process.env at startup.
 */
export function getEnabledSkills(): BossSkill[] {
  return ensureLoaded().filter((skill) => {
    const envKey = `SKILL_${skill.id.toUpperCase().replace(/-/g, '_')}_ENABLED`;
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
      return envVal === 'true';
    }
    return skill.enabled;
  });
}

/**
 * Return skills whose triggers match the given message (case-insensitive
 * substring match). Only returns skills that are also enabled.
 */
export function getMatchingSkills(message: string): BossSkill[] {
  const lower = message.toLowerCase();
  return getEnabledSkills().filter((skill) =>
    skill.triggers.some((trigger) => lower.includes(trigger.toLowerCase())),
  );
}

/**
 * Enable or disable a skill. Persists to Postgres runtime_config so the
 * setting survives process restarts. Also updates process.env immediately so
 * the next call to getEnabledSkills() reflects the change without a restart.
 */
export async function setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
  const envKey = `SKILL_${skillId.toUpperCase().replace(/-/g, '_')}_ENABLED`;
  await setRuntimeConfig(envKey, enabled ? 'true' : 'false');
}

/**
 * Check whether a skill is currently enabled. Reads runtime_config first
 * (via process.env projection), falls back to the skill.yaml default.
 */
export async function isSkillEnabled(skillId: string): Promise<boolean> {
  const envKey = `SKILL_${skillId.toUpperCase().replace(/-/g, '_')}_ENABLED`;

  // Check in-memory first (populated at startup by loadRuntimeConfig)
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    return envVal === 'true';
  }

  // Fall back to Postgres (covers cases where loadRuntimeConfig missed it)
  try {
    const stored = await getRuntimeConfig(envKey);
    if (stored !== null) {
      return stored === 'true';
    }
  } catch {
    // DB unavailable — fall through to yaml default
  }

  // Final fallback: skill.yaml enabled field
  const skill = ensureLoaded().find((s) => s.id === skillId);
  return skill?.enabled ?? false;
}
