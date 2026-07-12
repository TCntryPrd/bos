/**
 * Little Rascals — PRESETS.
 *
 * The 13 classic character presets, shipped as *import data only*. The live
 * rascals registry is the `boss_rascals` table. Nothing at runtime reads
 * this file except `POST /api/agents/rascals/import-presets`.
 *
 * Kevin's rule (locked 2026-04-24): BOS must boot with zero rascals; they
 * are created per-client via import or onboarding. These presets are a
 * convenience for the classic 13-character roster, not a declaration that
 * every install has them.
 *
 * Display names follow the "{Character} {ClientSurnameOrBrand}" pattern.
 * See memory/project_little_rascals_roster.md.
 */

export type RascalCli = 'claude' | 'ollama';

export interface RascalPreset {
  handle: string;       // tmux-session-safe, also the value stored in boss_tasks.assigned_agent
  displayName: string;
  cli: RascalCli;
  client: string;
  projectDir: string;
}

// Order is stable: Darla first because v1.4.0 imports her as the pilot.
// The COO ('Kevin's main /home/tcntryprd/.claude session) is NOT in this
// list — it's a different category of agent (user-self, not per-client) and
// is seeded directly via migration 017_rascals_coo_backfill.sql.
export const RASCAL_PRESETS: readonly RascalPreset[] = [
  { handle: 'darla',     displayName: 'Darla Wooldridge',     cli: 'claude', client: 'Debbie Wooldridge / TTC',          projectDir: '/home/tcntryprd/rascals/darla' },
  { handle: 'spanky',    displayName: 'Spanky Minkus',        cli: 'claude', client: 'Kane Minkus',                       projectDir: '/home/tcntryprd/rascals/spanky' },
  { handle: 'alfalfa',   displayName: 'Alfalfa District',     cli: 'ollama', client: 'AI District / Jess',                projectDir: '/home/tcntryprd/rascals/alfalfa' },
  { handle: 'buckwheat', displayName: 'Buckwheat Magnussen',  cli: 'claude', client: 'Douglas Estremadoyro / Magnussen',  projectDir: '/home/tcntryprd/rascals/buckwheat' },
  { handle: 'froggy',    displayName: 'Froggy Ballard',       cli: 'claude', client: 'John Ballard / Craft Architecture', projectDir: '/home/tcntryprd/rascals/froggy' },
  { handle: 'stymie',    displayName: 'Stymie Rockstar',      cli: 'ollama', client: 'Industry Rockstar (brand)',         projectDir: '/home/tcntryprd/rascals/stymie' },
  { handle: 'porky',     displayName: 'Porky Trusted',        cli: 'claude', client: 'Jessy / Trusted AI',                projectDir: '/home/tcntryprd/rascals/porky' },
  { handle: 'waldo',     displayName: 'Waldo GatorPixel',     cli: 'claude', client: 'Eric Bloom / GatorPixel',           projectDir: '/home/tcntryprd/rascals/waldo' },
  { handle: 'petey',     displayName: 'Petey Micazen',        cli: 'claude', client: 'Sharon / Micazen',                  projectDir: '/home/tcntryprd/rascals/petey' },
  { handle: 'wheezer',   displayName: 'Wheezer xpLORIZE',     cli: 'claude', client: 'Lori Zeoli / xpLORIZE',             projectDir: '/home/tcntryprd/rascals/wheezer' },
  { handle: 'butch',     displayName: 'Butch Pessy',          cli: 'claude', client: 'Chris Pessy',                       projectDir: '/home/tcntryprd/rascals/butch' },
  { handle: 'woim',      displayName: 'Woim Berfelo',         cli: 'claude', client: 'John Berfelo (pro-bono)',           projectDir: '/home/tcntryprd/rascals/woim' },
  { handle: 'maryann',   displayName: 'Mary Ann Productions', cli: 'claude', client: 'SP Productions',                    projectDir: '/home/tcntryprd/rascals/maryann' },
];

const PRESETS_BY_HANDLE = new Map<string, RascalPreset>(
  RASCAL_PRESETS.map((r) => [r.handle, r]),
);

export function getPreset(handle: string): RascalPreset | undefined {
  return PRESETS_BY_HANDLE.get(handle);
}
