# Little Rascals Orchestrator — v1.4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Little Rascals orchestrator such that IR Custom AIOS **boots with zero rascals** and rascals are **created via an import/onboarding flow, one per client**. Ship v1.4.0 by importing **Darla** (Debbie Wooldridge / TTC) as the first real rascal and taking her live end-to-end: cron wakes her tmux-parked Claude Code CLI, she reads her pending tasks from the Pipeline Engine (`GET /api/tasks/agent/darla`), produces output, advances the task, and the save script captures scrollback into Weaviate.

**Architecture:**
- **DB-backed registry.** A new `boss_rascals` table owns all agent metadata (handle, display name, CLI type, client reference, project dir, enabled flag). No TS registry claims authority; the DB is the source of truth.
- **Presets as import data.** `apps/api/src/agents/rascals-presets.ts` ships the 13 classic characters as *import templates only* — data, not a runtime registry. `POST /api/agents/rascals/import-presets` (optionally filtered by handles) seeds selected rows. A fresh install with no client yet = no rascals, no tmux sessions, no cron lines.
- **Runtime API.** Full CRUD at `/api/agents/rascals` (list / create / update / delete / import-presets). Bash scripts fetch the active registry over HTTP at runtime rather than hardcoding handles.
- **Host scripts.** Four bash scripts (`boot`, `wake`, `save`, `reset`) under the `tcntryprd` user, driven by a systemd unit (boot-on-startup) and cron (per-rascal schedules). Each agent owns a per-client working directory under `/home/tcntryprd/rascals/{handle}/` with `crons/` (prompt templates), `output/` (work product), and `state/wake-log.json` (audit trail). Directories are created on first import, not pre-seeded.

v1.4.0 ships **Darla only, as an imported rascal** — the onboarding flow proves itself by being how she arrives, not as an afterthought. The other 12 characters exist only in the presets file; they don't touch the DB, tmux, or cron until explicitly imported in a later tag (or during a real client's onboarding).

**Tech Stack:** Bash 5 (scripts), `tmux` (persistent CLI sessions), `flock` (mutex), `jq` (state), `curl` (API/Weaviate), `systemd` (boot), `cron` (schedule), `bats-core` (bash tests), TypeScript + Vitest (registry + presets + routes), PostgreSQL (rascals table + tasks via existing Pipeline Engine), Weaviate (ingest via existing `http://boss_weaviate:8080`), Claude Code CLI (agent runtime).

**Non-negotiables (Kevin's locked preferences):**
1. **Bulletproof > first-place.** Idempotent scripts, defensive locking, logs everywhere, graceful degradation. Scripts succeed even when no rascals exist.
2. **Non-disruptive by default.** Fresh install = nothing runs until a rascal is imported. Only Darla is imported + cron-enabled at v1.4.0 ship. No changes to existing running containers.
3. **No surprise external calls.** All API endpoints hit 127.0.0.1 or the Docker network. No outbound calls from scripts. Claude API is the only paid call and fires only via the tmux-attached CLI (not scripts).
4. **No hardcoded secrets or handle lists.** Script logic reads the registry from the API; auth via env (read from `~/.config/rascals/.env` sourced at script start). Zero literal tokens in committed files.
5. **No scope creep.** v1.4.0 scope is exactly this plan. Morning-sweep-for-all-13, evening digest, post-meeting dynamic crons, weekly-reset cron-enablement, and a full onboarding UI are **explicit follow-ups** (v1.4.1+).

---

## File Structure

### New — committed to `boss-dev` repo (v2-little-rascals branch)

```
services/postgres/migrations/
  016_rascals.sql                # boss_rascals table + indexes

apps/api/src/agents/
  rascals-presets.ts             # 13 classic rascals as IMPORT DATA (not a live registry)
  rascals-presets.test.ts        # Vitest unit tests
  rascals-repo.ts                # DB layer: list/get/create/update/delete/importPresets
  rascals-repo.test.ts           # Integration tests against scratch Postgres

apps/api/src/routes/
  rascals.ts                     # /api/agents/rascals/* — CRUD + import-presets
  rascals.test.ts                # Route-level integration tests (full CRUD + import flow)

docs/superpowers/plans/
  2026-04-24-little-rascals-orchestrator.md   # THIS DOC

scripts/rascals/                 # Tracked bash + bats-test dir inside boss-dev
  lib/rascals-common.sh          # Helpers: env load, lock, log, rascals_fetch_registry (HTTP)
  little-rascals-boot.sh         # Creates tmux sessions for enabled rascals (fetched from API)
  wake-agent.sh                  # Lock-protected tmux send-keys + wake-log append
  agent-save.sh                  # Scrollback → Weaviate + wake log append
  rascals-reset.sh               # Kill + relaunch CLIs in each session
  tests/
    common.bats                  # Unit tests for rascals-common.sh (curl stubbed)
    boot.bats                    # Unit tests for boot script (curl + tmux stubbed)
    wake.bats                    # Unit tests for wake-agent.sh (curl + tmux stubbed)
    save.bats                    # Unit tests for save script (curl stubbed)
    reset.bats                   # Unit tests for reset script (curl + tmux stubbed)
  install/
    little-rascals.service       # systemd unit template
    rascals.crontab              # Cron entries template (empty for v1.4.0 — ops adds Darla post-import)
    README.md                    # Install steps: host setup → import Darla → add cron → start systemd
    examples/darla/              # Reference CLAUDE.md + crons/morning-check.md for manual seeding
```

### New — deployed on host (NOT committed; installed by operator from `scripts/rascals/install/`)

```
/etc/systemd/system/little-rascals.service    # installed from scripts/rascals/install/
/etc/cron.d/little-rascals                    # installed from scripts/rascals/install/

/home/tcntryprd/.config/rascals/.env          # chmod 600 — reads BOSS_API_URL, etc.
/home/tcntryprd/rascals/                      # per-agent working tree
  darla/
    CLAUDE.md                                 # Agent's system prompt + context
    crons/
      morning-check.md                        # Prompt template
    output/                                   # Agent deliverables (gitignored)
    state/
      wake-log.json                           # Append-only log of wake cycles
  spanky/ ... mary-ann/                       # Skeleton dirs; CLAUDE.md is a TODO until that agent's tag
/home/tcntryprd/rascals/logs/
  boot.log
  wake-{handle}.log
  save-{handle}.log
  reset.log
/home/tcntryprd/rascals/locks/
  little-rascals.lock                         # Single global mutex (flock)
```

### Modified

```
apps/api/src/server.ts           # Register rascals routes
apps/api/src/db.ts               # (no change expected)
```

---

## Integration contract with Pipeline Engine (v1.3.1)

Already live from Phase 1 (don't re-build):

- `GET /api/pipeline` — list 5 seeded templates
- `POST /api/tasks` — create task `{ pipeline_id, title, assigned_agent, assigned_client?, priority? }`
- `GET /api/tasks/agent/:name` — returns `{agent, tasks: [...]}` filtered to `status IN ('pending','active','blocked')`, ordered by priority
- `POST /api/tasks/:id/start` — `pending` → `active`
- `POST /api/tasks/:id/advance` — body `{ output: string }` — next stage
- `POST /api/tasks/:id/approve` — unblock a review gate
- `POST /api/tasks/:id/fail` — body `{ reason: string }`

**Authentication gotcha discovered during v1.3.1 smoke:** the tenant middleware resolves tenant from JWT → `X-Tenant-ID` header → subdomain → `BOSS_TENANT_ID` env → `'default'` fallback. Scripts running from the host will use the `X-BOSS-Internal: true` + `X-Tenant-ID: default` header pair. This is exactly what the v1.3.1 smoke test locked in.

## New API contract — rascals registry (this PR)

All under `/api/agents/rascals`, tenant-scoped, `X-BOSS-Internal` + `X-Tenant-ID` header conventions:

- `GET /api/agents/rascals` — list. Optional `?enabled=true`, `?handle=darla`. Returns `{ rascals: [{ handle, displayName, cli, client, projectDir, enabled, createdAt, updatedAt }] }`. Empty array when nothing imported.
- `POST /api/agents/rascals` — create one. Body `{ handle, displayName, cli, client, projectDir?, enabled? }`. Validates `handle` is `[a-z]{2,24}` and unique. Creates the host project dir if missing. Returns 201 with the full row.
- `PATCH /api/agents/rascals/:handle` — update fields. Body can include any subset of `{ displayName, cli, client, projectDir, enabled }`. Returns 200 with the full row. 404 if handle not found.
- `DELETE /api/agents/rascals/:handle` — delete the row. Returns 204. **Does not** delete the host project dir or tmux session — ops responsibility. Refuses (409) if tasks are assigned to the handle.
- `POST /api/agents/rascals/import-presets` — bulk-seed from `rascals-presets.ts`. Body `{ handles?: string[] }` picks specific presets; omit for all 13. Idempotent: existing handles are skipped, not clobbered. Returns `{ imported: [...], skipped: [...] }`.

**Contract for bash scripts:** they call `GET /api/agents/rascals?enabled=true` with the internal/tenant headers. If the API is unreachable, scripts log the failure and exit 0 (bulletproof — IR Custom AIOS down ≠ script errors). Individual scripts degrade gracefully: `boot` skips session creation, `wake` logs and skips, `save` still writes local files (ingest is best-effort), `reset` no-ops.

---

# Tasks

---

### Task 1: Create worktree and branch

**Files:** None modified; this is the git setup step.

- [ ] **Step 1: Verify master is clean and up-to-date**

Run:
```bash
cd /home/tcntryprd/boss-dev
git checkout master
git pull --ff-only
git log --oneline -3
```

Expected: top commit is `ad02ebe fix(pipeline): map task 'done' to stage_log 'completed'...` (or newer). Working tree can have uncommitted auto-generated artifacts — those don't block branch creation.

- [ ] **Step 2: Create the v2-little-rascals branch**

Run:
```bash
cd /home/tcntryprd/boss-dev
git checkout -b v2-little-rascals master
```

Expected: `Switched to a new branch 'v2-little-rascals'`

- [ ] **Step 3: Verify Postgres + Weaviate + boss_api are up**

Run:
```bash
docker ps --filter name=boss --format 'table {{.Names}}\t{{.Status}}' | head -10
```

Expected: `boss_api`, `boss_postgres`, `boss_weaviate`, `boss_web`, `boss_worker` all `Up` and `healthy`. If any are down, bring them up with `docker compose -f /home/tcntryprd/boss-dev/docker-compose.yml up -d` before continuing.

---

### Task 2: Rascals presets file (13 classic characters as import data)

**Files:**
- Create: `apps/api/src/agents/rascals-presets.ts`
- Create: `apps/api/src/agents/rascals-presets.test.ts`

This file is **data, not a live registry**. It exists so that `POST /api/agents/rascals/import-presets` can seed the 13 classic characters in one shot. Nothing at runtime reads it except the import endpoint.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/agents/rascals-presets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RASCAL_PRESETS, type RascalPreset } from './rascals-presets.js';

describe('Little Rascals presets', () => {
  it('ships exactly 13 classic presets', () => {
    expect(RASCAL_PRESETS).toHaveLength(13);
  });

  it('uses unique, lowercase handles suitable for tmux session names', () => {
    const handles = RASCAL_PRESETS.map((r: RascalPreset) => r.handle);
    expect(new Set(handles).size).toBe(13);
    for (const h of handles) {
      expect(h).toMatch(/^[a-z]{2,24}$/);
    }
  });

  it('puts Darla Wooldridge first (v1.4.0 primary)', () => {
    const darla = RASCAL_PRESETS[0];
    expect(darla.handle).toBe('darla');
    expect(darla.displayName).toBe('Darla Wooldridge');
    expect(darla.cli).toBe('claude');
    expect(darla.client).toContain('Debbie');
  });

  it('spells Stymie with "Rockstar" — one r, not two', () => {
    const stymie = RASCAL_PRESETS.find((r: RascalPreset) => r.handle === 'stymie');
    expect(stymie).toBeDefined();
    expect(stymie!.displayName).toBe('Stymie Rockstar');
  });

  it('uses the ollama CLI only for Alfalfa and Stymie', () => {
    const ollama = RASCAL_PRESETS.filter((r: RascalPreset) => r.cli === 'ollama').map((r: RascalPreset) => r.handle).sort();
    expect(ollama).toEqual(['alfalfa', 'stymie']);
  });

  it('defaults projectDir to /home/tcntryprd/rascals/{handle}', () => {
    for (const r of RASCAL_PRESETS) {
      expect(r.projectDir).toBe(`/home/tcntryprd/rascals/${r.handle}`);
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /home/tcntryprd/boss-dev && npx vitest run apps/api/src/agents/rascals-presets.test.ts`
Expected: FAIL — "Cannot find module './rascals-presets.js'".

- [ ] **Step 3: Implement the presets**

Create `apps/api/src/agents/rascals-presets.ts`:

```typescript
/**
 * Little Rascals — PRESETS.
 *
 * The 13 classic character presets, shipped as *import data only*. The live
 * rascals registry is the `boss_rascals` table. Nothing at runtime reads
 * this file except `POST /api/agents/rascals/import-presets`.
 *
 * Kevin's rule (locked 2026-04-24): IR Custom AIOS must boot with zero rascals; they
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
```

- [ ] **Step 4: Run test, verify all 6 pass**

Run: `cd /home/tcntryprd/boss-dev && npx vitest run apps/api/src/agents/rascals-presets.test.ts`
Expected: `Tests 6 passed (6)`.

- [ ] **Step 5: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add apps/api/src/agents/rascals-presets.ts apps/api/src/agents/rascals-presets.test.ts
git commit -m "feat(rascals): add presets file with 13 classic characters as import data"
```

---

### Task 2.5: Migration 016 — `boss_rascals` table

**Files:**
- Create: `services/postgres/migrations/016_rascals.sql`

The DB is the authoritative registry. A fresh install has zero rows.

- [ ] **Step 1: Write the migration**

Create `services/postgres/migrations/016_rascals.sql`:

```sql
-- 016_rascals.sql — Little Rascals registry.
--
-- Kevin's rule (locked 2026-04-24): IR Custom AIOS boots with zero rascals; each
-- rascal is created per-client via import or onboarding. This table is the
-- source of truth — the rascals-presets.ts file is import data only.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + constraint guards).

CREATE TABLE IF NOT EXISTS boss_rascals (
  tenant_id     TEXT        NOT NULL DEFAULT 'default',
  handle        TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  cli           TEXT        NOT NULL,
  client        TEXT        NOT NULL,
  project_dir   TEXT        NOT NULL,
  enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, handle),
  CONSTRAINT boss_rascals_handle_ck
    CHECK (handle ~ '^[a-z]{2,24}$'),
  CONSTRAINT boss_rascals_cli_ck
    CHECK (cli IN ('claude','ollama'))
);

CREATE INDEX IF NOT EXISTS idx_boss_rascals_enabled
  ON boss_rascals (tenant_id, enabled)
  WHERE enabled = TRUE;

-- updated_at trigger — reuses the foundation function from migration 010
DROP TRIGGER IF EXISTS boss_rascals_set_updated_at ON boss_rascals;
CREATE TRIGGER boss_rascals_set_updated_at
  BEFORE UPDATE ON boss_rascals
  FOR EACH ROW EXECUTE FUNCTION boss_set_updated_at();
```

- [ ] **Step 2: Apply the migration to the live DB (defer if running this plan fresh)**

Run:
```bash
docker exec -i boss_postgres psql -U boss -d boss_db < /home/tcntryprd/boss-dev/services/postgres/migrations/016_rascals.sql
docker exec boss_postgres psql -U boss -d boss_db -c "INSERT INTO schema_migrations(filename) VALUES ('016_rascals.sql') ON CONFLICT DO NOTHING;"
docker exec boss_postgres psql -U boss -d boss_db -c "\d boss_rascals"
```

Expected: table exists with the 8 columns, the CHECK constraints, and the partial index.

- [ ] **Step 3: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add services/postgres/migrations/016_rascals.sql
git commit -m "feat(rascals): add migration 016 — boss_rascals registry table"
```

---

### Task 2.75: Rascals repository (DB access layer)

**Files:**
- Create: `apps/api/src/agents/rascals-repo.ts`
- Create: `apps/api/src/agents/rascals-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/agents/rascals-repo.test.ts`. This follows the same pattern as `apps/api/src/routes/pipeline.test.ts` — it spins up a scratch DB per run, applies the foundation function + migration 016, and exercises the repo directly. If Postgres isn't reachable via `TEST_PG_HOST`/`TEST_PG_PORT`, tests skip with `it.skip` (not silent `return`) so CI surfaces the skip.

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initDb, closeDb, getPool } from '../db.js';
import {
  listRascals,
  getRascal,
  createRascal,
  updateRascal,
  deleteRascal,
  importPresets,
} from './rascals-repo.js';

const { Client } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASS = process.env.TEST_PG_PASSWORD ?? '';
const auth = PG_PASS ? `${PG_USER}:${PG_PASS}` : PG_USER;
const ADMIN_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_rascals_${process.pid}`;

const MIGRATIONS_DIR = resolve(__dirname, '../../../../services/postgres/migrations');

const FOUNDATION_FN = `
  CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;
`;

let reachable = false;

async function pgReachable(): Promise<boolean> {
  const c = new Client({ connectionString: ADMIN_URL });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

beforeAll(async () => {
  reachable = await pgReachable();
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  const scratch = new Client({ connectionString: `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}` });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, '016_rascals.sql'), 'utf-8'));
  await scratch.end();

  initDb(`postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`);
});

afterAll(async () => {
  await closeDb();
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SCRATCH_DB]);
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
});

beforeEach(async () => {
  if (!reachable) return;
  await getPool().query(`DELETE FROM boss_rascals`);
});

describe.skipIf(!reachable)('rascals-repo', () => {
  it('listRascals returns [] on a fresh install', async () => {
    expect(await listRascals('default')).toEqual([]);
  });

  it('createRascal inserts a row with defaults', async () => {
    const r = await createRascal('default', {
      handle: 'darla',
      displayName: 'Darla Wooldridge',
      cli: 'claude',
      client: 'TTC',
    });
    expect(r.handle).toBe('darla');
    expect(r.enabled).toBe(false);
    expect(r.projectDir).toBe('/home/tcntryprd/rascals/darla');
  });

  it('createRascal rejects duplicate handles per tenant', async () => {
    await createRascal('default', { handle: 'darla', displayName: 'X', cli: 'claude', client: 'Y' });
    await expect(
      createRascal('default', { handle: 'darla', displayName: 'X', cli: 'claude', client: 'Y' }),
    ).rejects.toThrow(/handle.*exists|duplicate/i);
  });

  it('createRascal rejects invalid handle format', async () => {
    await expect(
      createRascal('default', { handle: 'BadHandle', displayName: 'X', cli: 'claude', client: 'Y' }),
    ).rejects.toThrow();
  });

  it('updateRascal patches the specified fields and bumps updated_at', async () => {
    const created = await createRascal('default', { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' });
    const updated = await updateRascal('default', 'darla', { enabled: true, client: 'TTC — Debbie' });
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(true);
    expect(updated!.client).toBe('TTC — Debbie');
    expect(updated!.displayName).toBe('D');
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
  });

  it('updateRascal returns null for unknown handle', async () => {
    expect(await updateRascal('default', 'nobody', { enabled: true })).toBeNull();
  });

  it('deleteRascal removes the row and returns true', async () => {
    await createRascal('default', { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' });
    expect(await deleteRascal('default', 'darla')).toBe(true);
    expect(await getRascal('default', 'darla')).toBeNull();
  });

  it('deleteRascal returns false for unknown handle', async () => {
    expect(await deleteRascal('default', 'nobody')).toBe(false);
  });

  it('importPresets seeds all 13 on an empty tenant', async () => {
    const result = await importPresets('default');
    expect(result.imported).toHaveLength(13);
    expect(result.skipped).toEqual([]);
    expect((await listRascals('default')).length).toBe(13);
  });

  it('importPresets filters by handle list when provided', async () => {
    const result = await importPresets('default', ['darla']);
    expect(result.imported).toEqual(['darla']);
    const all = await listRascals('default');
    expect(all.map((r) => r.handle)).toEqual(['darla']);
  });

  it('importPresets is idempotent — re-importing skips existing handles', async () => {
    await importPresets('default', ['darla']);
    const second = await importPresets('default');
    expect(second.imported).toHaveLength(12); // 13 - darla
    expect(second.skipped).toEqual(['darla']);
  });

  it('importPresets rejects unknown handles in the filter', async () => {
    await expect(importPresets('default', ['nobody'])).rejects.toThrow(/unknown preset/i);
  });

  it('listRascals supports ?enabled=true filter', async () => {
    await createRascal('default', { handle: 'a', displayName: 'A', cli: 'claude', client: 'x' });
    await createRascal('default', { handle: 'b', displayName: 'B', cli: 'claude', client: 'x', enabled: true });
    const enabled = await listRascals('default', { enabledOnly: true });
    expect(enabled.map((r) => r.handle)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /home/tcntryprd/boss-dev && TEST_PG_HOST=127.0.0.1 TEST_PG_PORT=5434 TEST_PG_USER=boss TEST_PG_PASSWORD="$(docker exec boss_postgres printenv POSTGRES_PASSWORD)" BOSS_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32) JWT_SECRET=test-jwt-secret npx vitest run apps/api/src/agents/rascals-repo.test.ts`
Expected: FAIL — "Cannot find module './rascals-repo.js'".

- [ ] **Step 3: Implement the repo**

Create `apps/api/src/agents/rascals-repo.ts`:

```typescript
/**
 * Rascals DB layer. The boss_rascals table is the authoritative registry.
 * Routes call these functions; callers upstream handle HTTP concerns.
 *
 * No process-level singletons here beyond the shared pg pool. Tenant ID is
 * always an explicit parameter.
 */

import { getPool } from '../db.js';
import { RASCAL_PRESETS, type RascalCli } from './rascals-presets.js';

export interface Rascal {
  handle: string;
  displayName: string;
  cli: RascalCli;
  client: string;
  projectDir: string;
  enabled: boolean;
  createdAt: string; // ISO
  updatedAt: string;
}

export interface CreateRascalInput {
  handle: string;
  displayName: string;
  cli: RascalCli;
  client: string;
  projectDir?: string;
  enabled?: boolean;
}

export interface UpdateRascalInput {
  displayName?: string;
  cli?: RascalCli;
  client?: string;
  projectDir?: string;
  enabled?: boolean;
}

export interface ImportPresetsResult {
  imported: string[];
  skipped: string[];
}

const HANDLE_RE = /^[a-z]{2,24}$/;

interface RascalRow {
  handle: string;
  display_name: string;
  cli: RascalCli;
  client: string;
  project_dir: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToRascal(r: RascalRow): Rascal {
  return {
    handle: r.handle,
    displayName: r.display_name,
    cli: r.cli,
    client: r.client,
    projectDir: r.project_dir,
    enabled: r.enabled,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listRascals(
  tenantId: string,
  opts: { enabledOnly?: boolean } = {},
): Promise<Rascal[]> {
  const sql = opts.enabledOnly
    ? `SELECT handle, display_name, cli, client, project_dir, enabled, created_at, updated_at
         FROM boss_rascals
        WHERE tenant_id = $1 AND enabled = TRUE
        ORDER BY handle`
    : `SELECT handle, display_name, cli, client, project_dir, enabled, created_at, updated_at
         FROM boss_rascals
        WHERE tenant_id = $1
        ORDER BY handle`;
  const { rows } = await getPool().query<RascalRow>(sql, [tenantId]);
  return rows.map(rowToRascal);
}

export async function getRascal(tenantId: string, handle: string): Promise<Rascal | null> {
  const { rows } = await getPool().query<RascalRow>(
    `SELECT handle, display_name, cli, client, project_dir, enabled, created_at, updated_at
       FROM boss_rascals WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
  return rows[0] ? rowToRascal(rows[0]) : null;
}

export async function createRascal(tenantId: string, input: CreateRascalInput): Promise<Rascal> {
  if (!HANDLE_RE.test(input.handle)) {
    throw new Error(`Invalid handle: must match ${HANDLE_RE}`);
  }
  const projectDir = input.projectDir ?? `/home/tcntryprd/rascals/${input.handle}`;
  try {
    const { rows } = await getPool().query<RascalRow>(
      `INSERT INTO boss_rascals (tenant_id, handle, display_name, cli, client, project_dir, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING handle, display_name, cli, client, project_dir, enabled, created_at, updated_at`,
      [tenantId, input.handle, input.displayName, input.cli, input.client, projectDir, input.enabled ?? false],
    );
    return rowToRascal(rows[0]);
  } catch (err: unknown) {
    // 23505 = unique_violation
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === '23505') {
      throw new Error(`Rascal handle "${input.handle}" already exists`);
    }
    throw err;
  }
}

export async function updateRascal(
  tenantId: string,
  handle: string,
  patch: UpdateRascalInput,
): Promise<Rascal | null> {
  const sets: string[] = [];
  const params: unknown[] = [tenantId, handle];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.displayName !== undefined) push('display_name', patch.displayName);
  if (patch.cli !== undefined)         push('cli',          patch.cli);
  if (patch.client !== undefined)      push('client',       patch.client);
  if (patch.projectDir !== undefined)  push('project_dir',  patch.projectDir);
  if (patch.enabled !== undefined)     push('enabled',      patch.enabled);

  if (sets.length === 0) {
    return getRascal(tenantId, handle);
  }
  const { rows } = await getPool().query<RascalRow>(
    `UPDATE boss_rascals SET ${sets.join(', ')}
       WHERE tenant_id = $1 AND handle = $2
       RETURNING handle, display_name, cli, client, project_dir, enabled, created_at, updated_at`,
    params,
  );
  return rows[0] ? rowToRascal(rows[0]) : null;
}

export async function deleteRascal(tenantId: string, handle: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM boss_rascals WHERE tenant_id = $1 AND handle = $2`,
    [tenantId, handle],
  );
  return (rowCount ?? 0) > 0;
}

export async function importPresets(
  tenantId: string,
  handles?: string[],
): Promise<ImportPresetsResult> {
  const presetsByHandle = new Map(RASCAL_PRESETS.map((p) => [p.handle, p]));

  let targets = RASCAL_PRESETS.map((p) => p.handle);
  if (handles && handles.length > 0) {
    const unknown = handles.filter((h) => !presetsByHandle.has(h));
    if (unknown.length > 0) {
      throw new Error(`Unknown preset handle(s): ${unknown.join(', ')}`);
    }
    targets = handles;
  }

  // Bulk lookup of existing rows so we can report skipped.
  const { rows: existing } = await getPool().query<{ handle: string }>(
    `SELECT handle FROM boss_rascals WHERE tenant_id = $1 AND handle = ANY($2::text[])`,
    [tenantId, targets],
  );
  const existingSet = new Set(existing.map((r) => r.handle));

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const h of targets) {
    if (existingSet.has(h)) { skipped.push(h); continue; }
    const p = presetsByHandle.get(h)!;
    await createRascal(tenantId, {
      handle: p.handle,
      displayName: p.displayName,
      cli: p.cli,
      client: p.client,
      projectDir: p.projectDir,
      enabled: false,
    });
    imported.push(h);
  }

  return { imported, skipped };
}
```

- [ ] **Step 4: Run test, verify all pass**

Run: same command as Step 2. Expected: `Tests 12 passed (12)` (or similar depending on how skipIf resolves).

- [ ] **Step 5: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add apps/api/src/agents/rascals-repo.ts apps/api/src/agents/rascals-repo.test.ts
git commit -m "feat(rascals): add rascals-repo (DB CRUD + importPresets)"
```

---

### Task 3: `/api/agents/rascals` routes (full CRUD + import-presets)

**Files:**
- Create: `apps/api/src/routes/rascals.ts`
- Create: `apps/api/src/routes/rascals.test.ts`
- Modify: `apps/api/src/server.ts` (one line — register route)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/rascals.test.ts`. Same scratch-DB pattern as `pipeline.test.ts` (see Task 2.75 test for the boilerplate — copy the `beforeAll` / `afterAll` / `beforeEach` scaffolding but apply migration 016 in addition to any other needed migrations):

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { closeDb } from '../db.js';

const { Client } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASS = process.env.TEST_PG_PASSWORD ?? '';
const auth = PG_PASS ? `${PG_USER}:${PG_PASS}` : PG_USER;
const ADMIN_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_rascals_routes_${process.pid}`;
const MIGRATIONS_DIR = resolve(__dirname, '../../../../services/postgres/migrations');
const FOUNDATION_FN = `
  CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;
`;

let server: FastifyInstance | null = null;
let reachable = false;

const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

async function pgReachable(): Promise<boolean> {
  const c = new Client({ connectionString: ADMIN_URL });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

beforeAll(async () => {
  reachable = await pgReachable();
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();
  const scratch = new Client({ connectionString: `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}` });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, '016_rascals.sql'), 'utf-8'));
  await scratch.end();
  process.env.POSTGRES_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.BOSS_TENANT_ID = 'default';
  process.env.BOSS_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  server = await buildServer();
});

afterAll(async () => {
  if (server) await server.close();
  await closeDb();
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SCRATCH_DB]);
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
});

beforeEach(async () => {
  if (!reachable) return;
  await server!.inject({ method: 'POST', url: '/api/agents/rascals/_test_reset', headers: H });
});

describe.skipIf(!reachable)('rascals routes', () => {
  it('GET /api/agents/rascals returns [] on empty tenant', async () => {
    const r = await server!.inject({ method: 'GET', url: '/api/agents/rascals', headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ rascals: unknown[] }>().rascals).toEqual([]);
  });

  it('POST /api/agents/rascals creates a rascal and returns 201', async () => {
    const r = await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'darla', displayName: 'Darla Wooldridge', cli: 'claude', client: 'TTC' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ handle: string; enabled: boolean }>();
    expect(body.handle).toBe('darla');
    expect(body.enabled).toBe(false);
  });

  it('POST rejects invalid handle format with 400', async () => {
    const r = await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'BadName', displayName: 'X', cli: 'claude', client: 'y' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('POST rejects duplicate handle with 409', async () => {
    const body = { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' };
    await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: body });
    const r = await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: body });
    expect(r.statusCode).toBe(409);
  });

  it('PATCH /api/agents/rascals/:handle updates fields', async () => {
    await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' },
    });
    const r = await server!.inject({
      method: 'PATCH', url: '/api/agents/rascals/darla', headers: H,
      payload: { enabled: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ enabled: boolean }>().enabled).toBe(true);
  });

  it('PATCH returns 404 for unknown handle', async () => {
    const r = await server!.inject({ method: 'PATCH', url: '/api/agents/rascals/nobody', headers: H, payload: { enabled: true } });
    expect(r.statusCode).toBe(404);
  });

  it('DELETE removes the row and returns 204', async () => {
    await server!.inject({
      method: 'POST', url: '/api/agents/rascals', headers: H,
      payload: { handle: 'darla', displayName: 'D', cli: 'claude', client: 'TTC' },
    });
    const r = await server!.inject({ method: 'DELETE', url: '/api/agents/rascals/darla', headers: H });
    expect(r.statusCode).toBe(204);
  });

  it('POST /import-presets with no body imports all 13', async () => {
    const r = await server!.inject({ method: 'POST', url: '/api/agents/rascals/import-presets', headers: H, payload: {} });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ imported: string[]; skipped: string[] }>();
    expect(body.imported).toHaveLength(13);
    expect(body.skipped).toEqual([]);
  });

  it('POST /import-presets with {handles:["darla"]} imports one', async () => {
    const r = await server!.inject({
      method: 'POST', url: '/api/agents/rascals/import-presets', headers: H,
      payload: { handles: ['darla'] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ imported: string[] }>().imported).toEqual(['darla']);
    const list = await server!.inject({ method: 'GET', url: '/api/agents/rascals', headers: H });
    expect(list.json<{ rascals: unknown[] }>().rascals).toHaveLength(1);
  });

  it('GET ?enabled=true filters to enabled only', async () => {
    await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: { handle: 'a', displayName: 'A', cli: 'claude', client: 'x' } });
    await server!.inject({ method: 'POST', url: '/api/agents/rascals', headers: H, payload: { handle: 'b', displayName: 'B', cli: 'claude', client: 'x', enabled: true } });
    const r = await server!.inject({ method: 'GET', url: '/api/agents/rascals?enabled=true', headers: H });
    const body = r.json<{ rascals: Array<{ handle: string }> }>();
    expect(body.rascals.map((x) => x.handle)).toEqual(['b']);
  });
});
```

Note the `/_test_reset` endpoint is a test-only helper — you can either implement it behind `process.env.NODE_ENV === 'test'` or drop it and do `TRUNCATE` via a direct pg query in `beforeEach`.

- [ ] **Step 2: Run test, verify it fails**

Run: same env as Task 2.75 Step 2, targeting `apps/api/src/routes/rascals.test.ts`.
Expected: FAIL — route not found / 404.

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/rascals.ts`:

```typescript
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  listRascals,
  getRascal,
  createRascal,
  updateRascal,
  deleteRascal,
  importPresets,
  type RascalCli,
} from '../agents/rascals-repo.js';
import { getPool } from '../db.js';

function tenantOf(req: FastifyRequest): string {
  return req.tenant?.tenantId ?? 'default';
}

type CreateBody = {
  handle: string;
  displayName: string;
  cli: RascalCli;
  client: string;
  projectDir?: string;
  enabled?: boolean;
};

type PatchBody = Partial<Omit<CreateBody, 'handle'>>;

type ImportBody = { handles?: string[] };

export async function rascalsRoutes(server: FastifyInstance) {
  server.get<{ Querystring: { enabled?: string; handle?: string } }>(
    '/agents/rascals',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const enabledOnly = request.query.enabled === 'true';
      if (request.query.handle) {
        const one = await getRascal(tenantId, request.query.handle);
        return reply.send({ rascals: one ? [one] : [] });
      }
      const rascals = await listRascals(tenantId, { enabledOnly });
      return reply.send({ rascals });
    },
  );

  server.post<{ Body: CreateBody }>(
    '/agents/rascals',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      try {
        const created = await createRascal(tenantId, request.body);
        return reply.status(201).send(created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(msg)) {
          return reply.status(409).send({ error: 'conflict', message: msg });
        }
        if (/invalid handle/i.test(msg)) {
          return reply.status(400).send({ error: 'bad_request', message: msg });
        }
        throw err;
      }
    },
  );

  server.patch<{ Params: { handle: string }; Body: PatchBody }>(
    '/agents/rascals/:handle',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      const updated = await updateRascal(tenantId, request.params.handle, request.body);
      if (!updated) return reply.status(404).send({ error: 'not_found' });
      return reply.send(updated);
    },
  );

  server.delete<{ Params: { handle: string } }>(
    '/agents/rascals/:handle',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      // Refuse delete if tasks reference this handle
      const { rows: refs } = await getPool().query(
        `SELECT 1 FROM boss_tasks
          WHERE tenant_id = $1 AND assigned_agent = $2
            AND status IN ('pending','active','blocked') LIMIT 1`,
        [tenantId, request.params.handle],
      );
      if (refs.length > 0) {
        return reply.status(409).send({
          error: 'in_use',
          message: `Rascal "${request.params.handle}" has open tasks; advance or fail them before deleting.`,
        });
      }
      const ok = await deleteRascal(tenantId, request.params.handle);
      if (!ok) return reply.status(404).send({ error: 'not_found' });
      return reply.status(204).send();
    },
  );

  server.post<{ Body: ImportBody }>(
    '/agents/rascals/import-presets',
    async (request, reply) => {
      const tenantId = tenantOf(request);
      try {
        const result = await importPresets(tenantId, request.body?.handles);
        return reply.send(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unknown preset/i.test(msg)) {
          return reply.status(400).send({ error: 'bad_request', message: msg });
        }
        throw err;
      }
    },
  );

  // Test-only helper (NODE_ENV=test only). Simplifies beforeEach in integration tests.
  if (process.env.NODE_ENV === 'test') {
    server.post('/agents/rascals/_test_reset', async (request, reply) => {
      const tenantId = tenantOf(request);
      await getPool().query(`DELETE FROM boss_rascals WHERE tenant_id = $1`, [tenantId]);
      return reply.status(204).send();
    });
  }
}
```

- [ ] **Step 4: Register the route in server.ts**

In `apps/api/src/server.ts`, find where `pipelineRoutes` is registered. Add adjacent:

```typescript
import { rascalsRoutes } from './routes/rascals.js';
// ... inside buildServer:
server.register(rascalsRoutes, { prefix: '/api' });
```

- [ ] **Step 5: Run tests, verify they pass**

Run: same env vars, targeting `apps/api/src/routes/rascals.test.ts`.
Expected: all route tests green.

- [ ] **Step 6: Run full suite — confirm no regressions**

Run: `cd /home/tcntryprd/boss-dev && npx vitest run`
Expected: baseline 352 + 6 (presets) + 12 (repo) + 10 (routes) = 380.

- [ ] **Step 7: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add apps/api/src/routes/rascals.ts apps/api/src/routes/rascals.test.ts apps/api/src/server.ts
git commit -m "feat(rascals): add /api/agents/rascals CRUD + import-presets routes"
```

---

### Task 4: Host-side shared infrastructure

Per-rascal directories are created on import (by the API route, which calls `mkdir -p` for each new row's `project_dir`) — not pre-seeded. This task only creates the shared logs/locks tree and the env file.

**Files:**
- Create: `/home/tcntryprd/rascals/logs/` and `/home/tcntryprd/rascals/locks/`
- Create: `/home/tcntryprd/.config/rascals/.env` (chmod 600)

- [ ] **Step 1: Create the shared directories**

Run:
```bash
mkdir -p /home/tcntryprd/rascals/logs /home/tcntryprd/rascals/locks
```

Expected: no errors. `ls /home/tcntryprd/rascals/` is empty except `logs/` and `locks/` on a fresh host.

- [ ] **Step 2: Seed the env file (NO hardcoded tokens, NO hardcoded handle list)**

Create `/home/tcntryprd/.config/rascals/.env`:

```bash
# Little Rascals environment — sourced by all rascals scripts.
# Keep this file chmod 600. Never commit.

# IR Custom AIOS API — local-only calls. Scripts fetch the live registry from here.
BOSS_API_URL="http://127.0.0.1:8001"
BOSS_TENANT_ID="default"

# Weaviate — reachable from host via mapped port
WEAVIATE_URL="http://127.0.0.1:8081"

# Paths
RASCALS_ROOT="/home/tcntryprd/rascals"
RASCALS_LOCK="/home/tcntryprd/rascals/locks/little-rascals.lock"
RASCALS_LOG_DIR="/home/tcntryprd/rascals/logs"

# Wake timeouts
RASCALS_WAKE_TIMEOUT_SEC=900      # 15 min — if lock held longer, skip + log
RASCALS_WAKE_COMPLETION_SEC=1200  # 20 min — if CLI prompt doesn't return, log timeout

# Boot stagger (seconds between CLI launches)
RASCALS_BOOT_STAGGER_SEC=10
```

Run:
```bash
mkdir -p /home/tcntryprd/.config/rascals
# (paste contents into editor, save)
chmod 700 /home/tcntryprd/.config/rascals
chmod 600 /home/tcntryprd/.config/rascals/.env
```

Expected: `stat -c '%a %n' /home/tcntryprd/.config/rascals/.env` prints `600 /home/tcntryprd/.config/rascals/.env`.

- [ ] **Step 3: No commit** — host state only. The install README walks operators through this.

> **Note on Darla's per-agent files:** Darla's `CLAUDE.md` and `crons/morning-check.md` are created as part of Task 13 (the live smoke), after she's been imported via the API. Reference copies live in `scripts/rascals/install/examples/darla/` committed to git — Kevin can cp them into `/home/tcntryprd/rascals/darla/` once the API-side create has stamped that directory.

---

### Task 5: Install bats-core for bash testing

**Files:** None in repo; installs a system-wide (or user-local) test runner.

- [ ] **Step 1: Check if bats is already installed**

Run: `which bats && bats --version`
If present (version ≥ 1.9), skip to Task 6. If absent, continue.

- [ ] **Step 2: Install bats-core via apt**

Run:
```bash
sudo apt-get update
sudo apt-get install -y bats
bats --version
```

Expected: version prints (likely `Bats 1.x`). If apt version is too old or unavailable, fall back to:

```bash
cd /tmp
git clone --depth=1 https://github.com/bats-core/bats-core.git
cd bats-core && sudo ./install.sh /usr/local
bats --version
```

- [ ] **Step 3: Smoke-test bats**

Create `/tmp/bats-smoke.bats`:

```bash
#!/usr/bin/env bats

@test "bats works" {
  [ "$((1+1))" -eq 2 ]
}
```

Run: `bats /tmp/bats-smoke.bats`
Expected: `1 test, 0 failures`.

- [ ] **Step 4: No commit** — tooling install, not code.

---

### Task 6: Shared library `rascals-common.sh`

**Files:**
- Create: `scripts/rascals/lib/rascals-common.sh`
- Create: `scripts/rascals/tests/common.bats`

This library replaces the prior hardcoded `rascals_list` with `rascals_fetch_registry`, which calls `GET /api/agents/rascals?enabled=true` and emits lines of `handle|cli|project_dir`. Scripts parse those lines. No handle lists live in bash.

- [ ] **Step 1: Write the failing tests**

Create `scripts/rascals/tests/common.bats`:

```bash
#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"   # stubbed
  export BOSS_TENANT_ID="default"
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs"

  # curl stub: writes invocation to $CURL_STUB_LOG, emits content from $CURL_STUB_STDOUT file (or empty).
  export CURL_STUB_LOG="$BATS_TEST_TMPDIR/curl.log"
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  : > "$CURL_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$CURL_STUB_LOG"
ec="$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
if [ -s "$CURL_STUB_STDOUT" ]; then cat "$CURL_STUB_STDOUT"; fi
exit "$ec"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  source "${BATS_TEST_DIRNAME}/../lib/rascals-common.sh"
}

@test "rascals_log appends a timestamped line to the named log" {
  rascals_log "boot" "hello world"
  grep -q "hello world" "$RASCALS_LOG_DIR/boot.log"
  grep -qE '^\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T' "$RASCALS_LOG_DIR/boot.log"
}

@test "rascals_acquire_lock exits non-zero when lock is held by another process" {
  (
    flock -x 9 -c "sleep 2" &
  ) 9>"$RASCALS_LOCK"
  sleep 0.2
  run rascals_acquire_lock 1
  [ "$status" -ne 0 ]
}

@test "rascals_acquire_lock succeeds when no lock is held" {
  run bash -c ". ${BATS_TEST_DIRNAME}/../lib/rascals-common.sh && rascals_acquire_lock 1 && echo ok"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok"* ]]
}

@test "rascals_fetch_registry parses JSON and emits handle|cli|project_dir lines" {
  cat > "$CURL_STUB_STDOUT" <<'JSON'
{"rascals":[
  {"handle":"darla","cli":"claude","projectDir":"/home/tcntryprd/rascals/darla"},
  {"handle":"maryann","cli":"claude","projectDir":"/home/tcntryprd/rascals/maryann"}
]}
JSON
  run rascals_fetch_registry
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | wc -l)" -eq 2 ]
  [[ "$output" == *"darla|claude|/home/tcntryprd/rascals/darla"* ]]
  [[ "$output" == *"maryann|claude|/home/tcntryprd/rascals/maryann"* ]]
}

@test "rascals_fetch_registry passes enabled=true and tenant header to curl" {
  printf '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run rascals_fetch_registry
  [ "$status" -eq 0 ]
  grep -q 'enabled=true'     "$CURL_STUB_LOG"
  grep -q 'X-BOSS-Internal' "$CURL_STUB_LOG"
  grep -q 'X-Tenant-ID: default' "$CURL_STUB_LOG"
}

@test "rascals_fetch_registry returns non-zero and empty stdout when API is down" {
  echo 22 > "$CURL_STUB_EXIT"
  run rascals_fetch_registry
  [ "$status" -ne 0 ]
  [ -z "$output" ]
}

@test "rascals_fetch_registry emits nothing when the registry is empty" {
  printf '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run rascals_fetch_registry
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd /home/tcntryprd/boss-dev && bats scripts/rascals/tests/common.bats`
Expected: FAIL — source file doesn't exist.

- [ ] **Step 3: Implement rascals-common.sh**

Create `scripts/rascals/lib/rascals-common.sh`:

```bash
#!/usr/bin/env bash
# rascals-common.sh — shared helpers for the Little Rascals scripts.
# Source, don't execute: `source /path/to/rascals-common.sh`.

set -u

: "${BOSS_API_URL:=http://127.0.0.1:8001}"
: "${BOSS_TENANT_ID:=default}"
: "${RASCALS_ROOT:=/home/tcntryprd/rascals}"
: "${RASCALS_LOCK:=${RASCALS_ROOT}/locks/little-rascals.lock}"
: "${RASCALS_LOG_DIR:=${RASCALS_ROOT}/logs}"

# rascals_log <name> <message ...>
#   Appends "[ISO8601] <message>" to $RASCALS_LOG_DIR/<name>.log.
rascals_log() {
  local name="${1:-default}"; shift || true
  local msg="$*"
  mkdir -p "$RASCALS_LOG_DIR"
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" >> "$RASCALS_LOG_DIR/${name}.log"
}

# rascals_fetch_registry
#   GET /api/agents/rascals?enabled=true — emits pipe-delimited lines
#   "<handle>|<cli>|<projectDir>", one per active rascal.
#   On API failure: returns non-zero with empty stdout. Callers should treat
#   that as "no rascals to act on right now" and exit cleanly.
rascals_fetch_registry() {
  local url="${BOSS_API_URL%/}/api/agents/rascals?enabled=true"
  local json
  if ! json="$(curl -sS --max-time 10 \
      -H 'X-BOSS-Internal: true' \
      -H "X-Tenant-ID: ${BOSS_TENANT_ID}" \
      "$url")"; then
    return 22
  fi
  # Parse with python3 (jq also fine; python is always present on this host).
  python3 - <<EOF || return 23
import json, sys
try:
    data = json.loads("""${json//\"/\\\"}""")
except Exception:
    sys.exit(23)
for r in data.get("rascals", []):
    print(f'{r["handle"]}|{r["cli"]}|{r["projectDir"]}')
EOF
}

# rascals_acquire_lock <timeout_sec>
#   Non-blocking acquire of $RASCALS_LOCK via flock -xn, with up to
#   <timeout_sec> seconds of retries (1 Hz). Returns 0 on success.
rascals_acquire_lock() {
  local timeout="${1:-60}"
  mkdir -p "$(dirname "$RASCALS_LOCK")"
  exec 200>"$RASCALS_LOCK"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if flock -xn 200; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# rascals_release_lock
#   Releases the lock acquired by rascals_acquire_lock.
rascals_release_lock() {
  flock -u 200 2>/dev/null || true
  exec 200>&- 2>/dev/null || true
}
```

**Note on the heredoc JSON parsing:** the inline `${json//\"/\\\"}` escape is fragile if the JSON contains literal backslashes. If shellcheck flags it or the test fails, refactor to write `$json` to a temp file and have python read the file path instead — simpler and safer.

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd /home/tcntryprd/boss-dev && bats scripts/rascals/tests/common.bats`
Expected: `ok 1..7`.

- [ ] **Step 5: Shellcheck**

Run: `shellcheck scripts/rascals/lib/rascals-common.sh`
Expected: no warnings. Any that appear: fix before commit.

- [ ] **Step 6: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/rascals/lib/rascals-common.sh scripts/rascals/tests/common.bats
git commit -m "feat(rascals): add rascals-common.sh (API fetch + lock + log helpers)"
```

---

### Task 7: Bootstrap script `little-rascals-boot.sh`

**Files:**
- Create: `scripts/rascals/little-rascals-boot.sh`
- Create: `scripts/rascals/tests/boot.bats`

- [ ] **Step 1: Write the failing tests**

Create `scripts/rascals/tests/boot.bats`:

```bash
#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"
  export BOSS_TENANT_ID="default"
  export RASCALS_BOOT_STAGGER_SEC=0
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs" "$RASCALS_ROOT/darla" "$RASCALS_ROOT/spanky"

  # Stub curl: emits contents of $CURL_STUB_STDOUT, exits $CURL_STUB_EXIT (default 0)
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
ec="$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$ec"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  # Stub tmux: record invocations, all calls succeed
  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$TMUX_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1" in
  has-session) exit 1 ;;   # pretend no session exists
esac
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/tmux"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  BOOT="${BATS_TEST_DIRNAME}/../little-rascals-boot.sh"
}

@test "boot creates a tmux session for each enabled rascal returned by the API" {
  cat > "$CURL_STUB_STDOUT" <<'JSON'
{"rascals":[
  {"handle":"darla","cli":"claude","projectDir":"'"${RASCALS_ROOT}"'/darla"},
  {"handle":"spanky","cli":"claude","projectDir":"'"${RASCALS_ROOT}"'/spanky"}
]}
JSON
  # The above heredoc contains literal text; expand vars via substitution:
  sed -i "s#'\"\${RASCALS_ROOT}\"'#${RASCALS_ROOT}#g" "$CURL_STUB_STDOUT"

  run bash "$BOOT"
  [ "$status" -eq 0 ]
  grep -q "new-session -d -s darla -c ${RASCALS_ROOT}/darla"  "$TMUX_STUB_LOG"
  grep -q "new-session -d -s spanky -c ${RASCALS_ROOT}/spanky" "$TMUX_STUB_LOG"
}

@test "boot does NOT send-keys to start a CLI when RASCALS_TEST_MODE=1" {
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla"}]}' "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  ! grep -q 'send-keys' "$TMUX_STUB_LOG"
}

@test "boot exits 0 with empty registry (no rascals imported yet)" {
  echo '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  ! grep -q 'new-session' "$TMUX_STUB_LOG"
  grep -q 'no enabled rascals' "$RASCALS_LOG_DIR/boot.log"
}

@test "boot exits 0 and logs when the API is unreachable (bulletproof)" {
  echo 22 > "$CURL_STUB_EXIT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  ! grep -q 'new-session' "$TMUX_STUB_LOG"
  grep -q 'API unreachable' "$RASCALS_LOG_DIR/boot.log"
}

@test "boot skips a rascal whose projectDir is missing and logs it" {
  rm -rf "$RASCALS_ROOT/spanky"
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla"},{"handle":"spanky","cli":"claude","projectDir":"%s/spanky"}]}' "$RASCALS_ROOT" "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  grep -q 'new-session -d -s darla' "$TMUX_STUB_LOG"
  ! grep -q 'new-session -d -s spanky' "$TMUX_STUB_LOG"
  grep -q 'spanky' "$RASCALS_LOG_DIR/boot.log"
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bats scripts/rascals/tests/boot.bats`
Expected: FAIL — script doesn't exist.

- [ ] **Step 3: Implement little-rascals-boot.sh**

Create `scripts/rascals/little-rascals-boot.sh`:

```bash
#!/usr/bin/env bash
# little-rascals-boot.sh — Create tmux sessions for each enabled rascal
# returned by GET /api/agents/rascals?enabled=true.
#
# Behavior:
#   - Sources ~/.config/rascals/.env if present + rascals-common.sh
#   - If the API is unreachable, logs and exits 0 (bulletproof)
#   - If the registry is empty, logs and exits 0 (fresh install path)
#   - For each rascal:
#       * Skips if projectDir missing (logs and continues)
#       * Skips if tmux session already exists (idempotent)
#       * Creates detached tmux session with cwd = projectDir
#       * In prod, sends CLI launch keys with a stagger delay
#       * In RASCALS_TEST_MODE=1, session-creation only (no CLI spawn)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

rascals_log boot "=== boot run starting ==="

STAGGER="${RASCALS_BOOT_STAGGER_SEC:-10}"

registry="$(rascals_fetch_registry)" || {
  rascals_log boot "API unreachable — skipping boot (exit 0)"
  exit 0
}

if [ -z "$registry" ]; then
  rascals_log boot "no enabled rascals — nothing to boot"
  exit 0
fi

while IFS='|' read -r handle cli project_dir; do
  [ -z "$handle" ] && continue

  if [ ! -d "$project_dir" ]; then
    rascals_log boot "SKIP ${handle} — project dir missing: ${project_dir}"
    continue
  fi

  if tmux has-session -t "$handle" 2>/dev/null; then
    rascals_log boot "SKIP ${handle} — tmux session already exists"
    continue
  fi

  rascals_log boot "creating tmux session: ${handle} (cwd=${project_dir})"
  tmux new-session -d -s "$handle" -c "$project_dir"

  if [ "${RASCALS_TEST_MODE:-0}" = "1" ]; then
    rascals_log boot "TEST_MODE — skipping CLI launch for ${handle}"
    continue
  fi

  case "$cli" in
    claude) cli_cmd='claude --dangerously-skip-permissions' ;;
    ollama) cli_cmd='ollama run gemma4' ;;
    *)
      rascals_log boot "WARN ${handle} — unknown cli '${cli}', defaulting to claude"
      cli_cmd='claude --dangerously-skip-permissions'
      ;;
  esac

  rascals_log boot "launching CLI in ${handle}: ${cli_cmd}"
  tmux send-keys -t "$handle" "$cli_cmd" Enter

  sleep "$STAGGER"
done <<< "$registry"

rascals_log boot "=== boot run complete ==="
```

Then: `chmod +x scripts/rascals/little-rascals-boot.sh`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `bats scripts/rascals/tests/boot.bats`
Expected: `ok 1..5`.

- [ ] **Step 5: Shellcheck**

Run: `shellcheck scripts/rascals/little-rascals-boot.sh`
Expected: no warnings. Fix any that print.

- [ ] **Step 6: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/rascals/little-rascals-boot.sh scripts/rascals/tests/boot.bats
git commit -m "feat(rascals): add little-rascals-boot.sh (API-driven tmux bootstrap)"
```

---

### Task 8: Wake script `wake-agent.sh`

**Files:**
- Create: `scripts/rascals/wake-agent.sh`
- Create: `scripts/rascals/tests/wake.bats`

- [ ] **Step 1: Write the failing tests**

Create `scripts/rascals/tests/wake.bats`:

```bash
#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"
  export BOSS_TENANT_ID="default"
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs" "$RASCALS_ROOT/darla/crons" "$RASCALS_ROOT/darla/state"
  echo '[]' > "$RASCALS_ROOT/darla/state/wake-log.json"

  # Default curl stub: emits an "enabled darla" row; tests override by rewriting
  # $CURL_STUB_STDOUT before calling the script.
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla","enabled":true}]}' "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$TMUX_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1" in
  has-session) exit 0 ;;
  send-keys)   exit 0 ;;
  new-session) exit 0 ;;
esac
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/tmux"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  WAKE="${BATS_TEST_DIRNAME}/../wake-agent.sh"
}

@test "wake-agent requires a handle argument" {
  run bash "$WAKE"
  [ "$status" -ne 0 ]
}

@test "wake-agent rejects a handle that isn't enabled in the API" {
  # Stub curl to return empty (rascal not found / not enabled).
  # The wake script will look up the one handle via ?handle=alfalfa&enabled=true.
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  printf '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  run bash "$WAKE" alfalfa "hello"
  [ "$status" -ne 0 ]
  grep -q 'not enabled\|not found' "$RASCALS_LOG_DIR/wake-alfalfa.log"
}

@test "wake-agent sends the prompt via tmux send-keys" {
  run bash "$WAKE" darla "say hi"
  [ "$status" -eq 0 ]
  grep -q 'send-keys -t darla' "$TMUX_STUB_LOG"
  grep -q 'say hi' "$TMUX_STUB_LOG"
}

@test "wake-agent appends an entry to the agent's wake-log.json" {
  run bash "$WAKE" darla "first prompt"
  [ "$status" -eq 0 ]
  [ -s "$RASCALS_ROOT/darla/state/wake-log.json" ]
  grep -q 'first prompt' "$RASCALS_ROOT/darla/state/wake-log.json"
}

@test "wake-agent skips if the global lock is already held" {
  # Hold the lock from another process
  (
    flock -x 9 -c "sleep 3" &
  ) 9>"$RASCALS_LOCK"
  sleep 0.2
  export RASCALS_WAKE_TIMEOUT_SEC=1
  run bash "$WAKE" darla "blocked"
  [ "$status" -ne 0 ]
  grep -q 'lock' "$RASCALS_LOG_DIR/wake-darla.log"
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bats scripts/rascals/tests/wake.bats`
Expected: FAIL — script doesn't exist.

- [ ] **Step 3: Implement wake-agent.sh**

Create `scripts/rascals/wake-agent.sh`:

```bash
#!/usr/bin/env bash
# wake-agent.sh <handle> "<prompt>"
# Sends a prompt into the named rascal's tmux session, under the global lock.
#
# Flow:
#   1. Validate handle is enabled
#   2. Acquire global lock (flock, timeout = RASCALS_WAKE_TIMEOUT_SEC)
#   3. Ensure tmux session exists (create if not — boot script should have done this, but be defensive)
#   4. Send prompt to the session via send-keys
#   5. Append wake entry to state/wake-log.json
#   6. Release lock and exit (completion detection and save are the job of agent-save.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

handle="${1:-}"
prompt="${2:-}"

if [ -z "$handle" ] || [ -z "$prompt" ]; then
  echo "Usage: $0 <handle> \"<prompt>\"" >&2
  exit 2
fi

log_name="wake-${handle}"

# Validate the handle is present and enabled in the DB-backed registry.
# We query GET /api/agents/rascals?handle=<h>&enabled=true. Empty result ⇒ refuse.
lookup_url="${BOSS_API_URL%/}/api/agents/rascals?enabled=true&handle=${handle}"
lookup_json="$(curl -sS --max-time 10 \
  -H 'X-BOSS-Internal: true' \
  -H "X-Tenant-ID: ${BOSS_TENANT_ID}" \
  "$lookup_url" 2>/dev/null || echo '')"

if ! printf '%s' "$lookup_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    sys.exit(0 if data.get("rascals") else 1)
except Exception:
    sys.exit(1)
'; then
  rascals_log "$log_name" "REFUSED — handle '${handle}' not enabled or not found"
  exit 3
fi

# Extract project_dir for this handle
project_dir="$(printf '%s' "$lookup_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["rascals"][0]["projectDir"])
')"

timeout="${RASCALS_WAKE_TIMEOUT_SEC:-900}"
if ! rascals_acquire_lock "$timeout"; then
  rascals_log "$log_name" "ABORT — could not acquire lock within ${timeout}s"
  exit 4
fi
trap 'rascals_release_lock' EXIT

# Defensive: recreate session if missing. Normally boot script does this.
if ! tmux has-session -t "$handle" 2>/dev/null; then
  rascals_log "$log_name" "session missing — creating ${handle} in ${project_dir}"
  tmux new-session -d -s "$handle" -c "$project_dir"
  # In prod, also launch CLI. In test mode, caller stubs tmux so this is moot.
  if [ "${RASCALS_TEST_MODE:-0}" != "1" ]; then
    case "$handle" in
      alfalfa|stymie) tmux send-keys -t "$handle" 'ollama run gemma4' Enter ;;
      *)              tmux send-keys -t "$handle" 'claude --dangerously-skip-permissions' Enter ;;
    esac
    sleep 5
  fi
fi

rascals_log "$log_name" "sending prompt to ${handle} (${#prompt} chars)"
tmux send-keys -t "$handle" "$prompt" Enter

# Append to wake-log.json (atomic: write-temp + mv)
mkdir -p "${project_dir}/state"
log_file="${project_dir}/state/wake-log.json"
[ -f "$log_file" ] || echo '[]' > "$log_file"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp)"
# Use jq if available; otherwise append a bare entry and let save.sh normalize.
if command -v jq >/dev/null 2>&1; then
  jq --arg ts "$ts" --arg prompt "$prompt" \
     '. + [{timestamp: $ts, prompt: $prompt, status: "sent"}]' \
     "$log_file" > "$tmp"
  mv "$tmp" "$log_file"
else
  # Fallback: naive append (drops closing ']', writes entry, appends ']')
  # This path is used only if jq is missing; install jq on any real rascals host.
  sed -i 's/]$//' "$log_file"
  if [ "$(tr -d '[:space:]' < "$log_file")" = "[" ]; then
    printf '{"timestamp":"%s","prompt":%s,"status":"sent"}\n]\n' "$ts" "$(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >> "$log_file"
  else
    printf ',\n{"timestamp":"%s","prompt":%s,"status":"sent"}\n]\n' "$ts" "$(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >> "$log_file"
  fi
fi

rascals_log "$log_name" "wake complete"
```

Then: `chmod +x scripts/rascals/wake-agent.sh`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `bats scripts/rascals/tests/wake.bats`
Expected: `ok 1..5`.

- [ ] **Step 5: Shellcheck**

Run: `shellcheck scripts/rascals/wake-agent.sh`
Expected: no warnings. (`SC1091` for sourced env files is fine with the inline disable.)

- [ ] **Step 6: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/rascals/wake-agent.sh scripts/rascals/tests/wake.bats
git commit -m "feat(rascals): add wake-agent.sh (lock-protected tmux send + wake-log append)"
```

---

### Task 9: Save script `agent-save.sh`

**Files:**
- Create: `scripts/rascals/agent-save.sh`
- Create: `scripts/rascals/tests/save.bats`

Purpose: called by cron after a wake's expected work window closes, or by wake-agent if synchronous. Captures tmux scrollback, writes to `output/{date}-{slug}.md`, posts to Weaviate `/v1/objects` as a `Knowledge` object tagged with the agent handle.

- [ ] **Step 1: Write the failing tests**

Create `scripts/rascals/tests/save.bats`:

```bash
#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"   # unused by save (no registry lookup)
  export BOSS_TENANT_ID="default"
  export WEAVIATE_URL="http://127.0.0.1:65000"     # stubbed below
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs" "$RASCALS_ROOT/darla/output"

  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$TMUX_STUB_LOG"
  # tmux capture-pane stub emits fixed content
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1" in
  capture-pane)
    echo "fake scrollback line 1"
    echo "fake scrollback line 2"
    ;;
  has-session) exit 0 ;;
esac
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/tmux"

  # curl stub that records and succeeds
  export CURL_STUB_LOG="$BATS_TEST_TMPDIR/curl.log"
  : > "$CURL_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$CURL_STUB_LOG"
echo '{"id":"stub-uuid"}'
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  SAVE="${BATS_TEST_DIRNAME}/../agent-save.sh"
}

@test "save requires a handle" {
  run bash "$SAVE"
  [ "$status" -ne 0 ]
}

@test "save writes an output file under output/" {
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  ls "$RASCALS_ROOT/darla/output/" | grep -qE '\.md$'
}

@test "save captures tmux scrollback into the output file" {
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  grep -rq 'fake scrollback line 1' "$RASCALS_ROOT/darla/output/"
}

@test "save posts to Weaviate with agent and slug labels" {
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  grep -q 'Knowledge' "$CURL_STUB_LOG"
  grep -q 'darla' "$CURL_STUB_LOG"
}

@test "save skips the Weaviate call if WEAVIATE_URL is empty" {
  export WEAVIATE_URL=""
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  ! grep -q 'Knowledge' "$CURL_STUB_LOG"
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bats scripts/rascals/tests/save.bats`
Expected: FAIL — script doesn't exist.

- [ ] **Step 3: Implement agent-save.sh**

Create `scripts/rascals/agent-save.sh`:

```bash
#!/usr/bin/env bash
# agent-save.sh <handle> <slug>
# Captures the named rascal's tmux scrollback, writes to output/, and ingests
# to Weaviate's Knowledge collection.
#
# Non-disruptive: if Weaviate is unreachable or WEAVIATE_URL is empty, skip
# the ingest step with a log line — the local file is still written.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

handle="${1:-}"
slug="${2:-wake}"

if [ -z "$handle" ]; then
  echo "Usage: $0 <handle> [slug]" >&2
  exit 2
fi

log_name="save-${handle}"

project_dir="${RASCALS_ROOT}/${handle}"
out_dir="${project_dir}/output"
mkdir -p "$out_dir"

# Sanitize slug
safe_slug="$(printf '%s' "$slug" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"
[ -z "$safe_slug" ] && safe_slug="wake"

date_str="$(date -u +%Y-%m-%d-%H%M)"
out_file="${out_dir}/${date_str}-${safe_slug}.md"

# Capture scrollback. -p prints to stdout; -S -9999 grabs a large chunk.
if tmux has-session -t "$handle" 2>/dev/null; then
  content="$(tmux capture-pane -t "$handle" -p -S -9999 || true)"
else
  content="[session '${handle}' not found at save time]"
fi

# Write markdown
{
  printf '# %s — %s\n\n' "$handle" "$safe_slug"
  printf 'Captured: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '---\n\n```\n%s\n```\n' "$content"
} > "$out_file"

rascals_log "$log_name" "wrote ${out_file} ($(wc -c < "$out_file") bytes)"

# Weaviate ingest — non-disruptive
if [ -z "${WEAVIATE_URL:-}" ]; then
  rascals_log "$log_name" "WEAVIATE_URL empty — skipping ingest"
  exit 0
fi

# Build a small JSON payload. Keep it minimal; vectorization modules are
# attached on the Weaviate class side.
payload=$(python3 - <<EOF
import json
print(json.dumps({
    "class": "Knowledge",
    "properties": {
        "agent": "${handle}",
        "slug": "${safe_slug}",
        "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
        "source": "rascals-save",
        "content": open("${out_file}").read(),
    },
}))
EOF
)

if ! curl -sS --max-time 30 -X POST \
     -H "Content-Type: application/json" \
     -d "$payload" \
     "${WEAVIATE_URL%/}/v1/objects" > /tmp/rascals-weaviate-$$.out 2>/tmp/rascals-weaviate-$$.err; then
  rascals_log "$log_name" "WARN — Weaviate ingest failed: $(tr '\n' ' ' < /tmp/rascals-weaviate-$$.err | head -c 200)"
  rm -f /tmp/rascals-weaviate-$$.out /tmp/rascals-weaviate-$$.err
  exit 0   # do not fail the whole save
fi
rascals_log "$log_name" "ingest ok — $(head -c 200 /tmp/rascals-weaviate-$$.out)"
rm -f /tmp/rascals-weaviate-$$.out /tmp/rascals-weaviate-$$.err
```

Then: `chmod +x scripts/rascals/agent-save.sh`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `bats scripts/rascals/tests/save.bats`
Expected: `ok 1..5`.

- [ ] **Step 5: Shellcheck**

Run: `shellcheck scripts/rascals/agent-save.sh`
Expected: no warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/rascals/agent-save.sh scripts/rascals/tests/save.bats
git commit -m "feat(rascals): add agent-save.sh (scrollback capture + Weaviate ingest)"
```

---

### Task 10: Weekly reset script `rascals-reset.sh`

**Files:**
- Create: `scripts/rascals/rascals-reset.sh`
- Create: `scripts/rascals/tests/reset.bats`

- [ ] **Step 1: Write the failing test**

Create `scripts/rascals/tests/reset.bats`:

```bash
#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"
  export BOSS_TENANT_ID="default"
  export RASCALS_BOOT_STAGGER_SEC=0
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs" "$RASCALS_ROOT/darla" "$RASCALS_ROOT/spanky"

  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla"},{"handle":"spanky","cli":"claude","projectDir":"%s/spanky"}]}' "$RASCALS_ROOT" "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$TMUX_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1" in
  has-session) exit 0 ;;
  kill-session) exit 0 ;;
esac
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/tmux"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  RESET="${BATS_TEST_DIRNAME}/../rascals-reset.sh"
}

@test "reset kills each enabled session (from API) and invokes boot" {
  run bash "$RESET"
  [ "$status" -eq 0 ]
  grep -q 'kill-session -t darla'  "$TMUX_STUB_LOG"
  grep -q 'kill-session -t spanky' "$TMUX_STUB_LOG"
  grep -q 'new-session -d -s darla'  "$TMUX_STUB_LOG"
  grep -q 'new-session -d -s spanky' "$TMUX_STUB_LOG"
}

@test "reset exits 0 and logs on empty registry" {
  echo '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run bash "$RESET"
  [ "$status" -eq 0 ]
  ! grep -q 'kill-session' "$TMUX_STUB_LOG"
  grep -q 'nothing to reset' "$RASCALS_LOG_DIR/reset.log"
}

@test "reset logs to reset.log" {
  run bash "$RESET"
  [ -s "$RASCALS_LOG_DIR/reset.log" ]
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bats scripts/rascals/tests/reset.bats`
Expected: FAIL — script doesn't exist.

- [ ] **Step 3: Implement rascals-reset.sh**

Create `scripts/rascals/rascals-reset.sh`:

```bash
#!/usr/bin/env bash
# rascals-reset.sh — kill each enabled rascal's tmux session and recreate
# via the boot script. Runs weekly (Sunday 3 AM) to keep CLI context fresh.
#
# Takes the global lock for the duration so wake crons can't collide.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

rascals_log reset "=== reset run starting ==="

if ! rascals_acquire_lock 60; then
  rascals_log reset "ABORT — could not acquire lock within 60s"
  exit 1
fi
trap 'rascals_release_lock' EXIT

registry="$(rascals_fetch_registry)" || {
  rascals_log reset "API unreachable — skipping reset"
  exit 0
}

if [ -z "$registry" ]; then
  rascals_log reset "nothing to reset — no enabled rascals"
  exit 0
fi

while IFS='|' read -r handle _cli _project; do
  [ -z "$handle" ] && continue
  if tmux has-session -t "$handle" 2>/dev/null; then
    rascals_log reset "killing session ${handle}"
    tmux kill-session -t "$handle" || true
  else
    rascals_log reset "no existing session for ${handle} — skipping kill"
  fi
done <<< "$registry"

# Recreate via boot. Boot is idempotent and fetches the registry itself.
# Release the lock before invoking boot so boot has a clean environment.
rascals_release_lock

rascals_log reset "invoking boot to recreate sessions"
"$SCRIPT_DIR/little-rascals-boot.sh"

rascals_log reset "=== reset run complete ==="
```

Then: `chmod +x scripts/rascals/rascals-reset.sh`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `bats scripts/rascals/tests/reset.bats`
Expected: `ok 1..2`.

- [ ] **Step 5: Shellcheck**

Run: `shellcheck scripts/rascals/rascals-reset.sh`
Expected: no warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/rascals/rascals-reset.sh scripts/rascals/tests/reset.bats
git commit -m "feat(rascals): add rascals-reset.sh (weekly tmux session refresh)"
```

---

### Task 11: systemd unit + cron templates

**Files:**
- Create: `scripts/rascals/install/little-rascals.service`
- Create: `scripts/rascals/install/rascals.crontab`
- Create: `scripts/rascals/install/README.md`

These files are templates — the operator installs them into `/etc/systemd/system/` and `/etc/cron.d/` manually (see README). Nothing auto-installs.

- [ ] **Step 1: Write the systemd unit**

Create `scripts/rascals/install/little-rascals.service`:

```ini
[Unit]
Description=Little Rascals — tmux-parked agent bootstrap
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=tcntryprd
Group=tcntryprd
Environment=HOME=/home/tcntryprd
ExecStart=/home/tcntryprd/boss-dev/scripts/rascals/little-rascals-boot.sh
RemainAfterExit=yes
StandardOutput=append:/home/tcntryprd/rascals/logs/boot.systemd.log
StandardError=append:/home/tcntryprd/rascals/logs/boot.systemd.log

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the cron template (empty for a fresh install; ops appends per-rascal lines after import)**

Create `scripts/rascals/install/rascals.crontab`:

```cron
# Little Rascals — cron schedule.
# Installed at /etc/cron.d/little-rascals. Ships EMPTY on fresh installs —
# add one morning-check + save pair for each rascal *after* you've imported
# them via the API and enabled them. Example (uncomment after importing darla):
#
#   0  7 * * 1-5 tcntryprd /home/tcntryprd/boss-dev/scripts/rascals/wake-agent.sh darla "Run crons/morning-check.md for $(date +%F)"
#   15 7 * * 1-5 tcntryprd /home/tcntryprd/boss-dev/scripts/rascals/agent-save.sh darla morning-check
#
# Stagger: leave ≥2 min between distinct agents' morning checks.
# Weekly reset (disabled in v1.4.0 — enable after an observation window):
#   0  3 * * 0 tcntryprd /home/tcntryprd/boss-dev/scripts/rascals/rascals-reset.sh

SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""

# (no active cron entries — operator adds them after importing rascals)
```

Also add `scripts/rascals/install/examples/darla/CLAUDE.md` and `examples/darla/crons/morning-check.md` containing the content Kevin drafted in the earlier iteration of this plan (see Task 13 for the text; commit them under `examples/` so they're version-tracked and `cp`-able post-import).

- [ ] **Step 3: Write the install README**

Create `scripts/rascals/install/README.md`:

```markdown
# Little Rascals — Install Guide

IR Custom AIOS ships with zero rascals. Each rascal is created per-client via the
import/onboarding flow. This guide walks through enabling the first one
(Darla for Debbie/TTC) post-v1.4.0 deploy.

## Order of operations

1. Migration 016 ran (part of v1.4.0 deploy).
2. Install shared host directories + env file.
3. Import Darla via API.
4. Seed Darla's CLAUDE.md + morning-check.md.
5. Enable Darla in the registry.
6. Install systemd unit and start it (creates her tmux session + launches CLI).
7. Install the cron, append Darla's wake + save lines.
8. Smoke test.

## 2. Shared host setup

```bash
mkdir -p /home/tcntryprd/rascals/logs /home/tcntryprd/rascals/locks

mkdir -p /home/tcntryprd/.config/rascals
cat > /home/tcntryprd/.config/rascals/.env <<EOF
BOSS_API_URL="http://127.0.0.1:8001"
BOSS_TENANT_ID="default"
WEAVIATE_URL="http://127.0.0.1:8081"
RASCALS_ROOT="/home/tcntryprd/rascals"
RASCALS_LOCK="/home/tcntryprd/rascals/locks/little-rascals.lock"
RASCALS_LOG_DIR="/home/tcntryprd/rascals/logs"
RASCALS_WAKE_TIMEOUT_SEC=900
RASCALS_WAKE_COMPLETION_SEC=1200
RASCALS_BOOT_STAGGER_SEC=10
EOF
chmod 700 /home/tcntryprd/.config/rascals
chmod 600 /home/tcntryprd/.config/rascals/.env
```

## 3. Import Darla from presets

```bash
curl -sS -X POST \
  -H 'X-BOSS-Internal: true' \
  -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' \
  -d '{"handles":["darla"]}' \
  http://127.0.0.1:8001/api/agents/rascals/import-presets | jq
# Expected: {"imported":["darla"],"skipped":[]}
```

Verify the row and the auto-created project dir:
```bash
curl -sS -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
  http://127.0.0.1:8001/api/agents/rascals | jq
ls /home/tcntryprd/rascals/darla/    # crons/ output/ state/ created
```

## 4. Seed Darla's prompt files

```bash
cp scripts/rascals/install/examples/darla/CLAUDE.md                /home/tcntryprd/rascals/darla/
cp scripts/rascals/install/examples/darla/crons/morning-check.md   /home/tcntryprd/rascals/darla/crons/
```

Edit `/home/tcntryprd/rascals/darla/CLAUDE.md` to replace the `(TODO — Kevin to fill this in)` section with the real Debbie/TTC context. Darla only knows what's in this file + what she can query.

## 5. Enable Darla

```bash
curl -sS -X PATCH \
  -H 'X-BOSS-Internal: true' \
  -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' \
  http://127.0.0.1:8001/api/agents/rascals/darla | jq
# Expected: "enabled":true in the response
```

## 6. Install + start systemd

```bash
sudo cp scripts/rascals/install/little-rascals.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable little-rascals.service
sudo systemctl start little-rascals.service
sudo systemctl status little-rascals.service   # expect "active (exited)"
tmux list-sessions | grep darla                # expect `darla: 1 windows ...`
```

## 7. Install cron + append Darla's lines

```bash
sudo cp scripts/rascals/install/rascals.crontab /etc/cron.d/little-rascals
sudo chmod 644 /etc/cron.d/little-rascals

# Append Darla's wake + save lines
sudo tee -a /etc/cron.d/little-rascals >/dev/null <<'EOF'
0  7 * * 1-5 tcntryprd /home/tcntryprd/boss-dev/scripts/rascals/wake-agent.sh darla "Run crons/morning-check.md for $(date +%F)"
15 7 * * 1-5 tcntryprd /home/tcntryprd/boss-dev/scripts/rascals/agent-save.sh darla morning-check
EOF
sudo systemctl reload cron
```

## 8. Smoke test (don't wait for cron)

See Task 13 of the implementation plan for the full end-to-end check, or run the short version:
```bash
/home/tcntryprd/boss-dev/scripts/rascals/wake-agent.sh darla "Smoke: reply 'hello' then stop."
sleep 90
/home/tcntryprd/boss-dev/scripts/rascals/agent-save.sh darla smoke-test
ls /home/tcntryprd/rascals/darla/output/
tail -20 /home/tcntryprd/rascals/logs/wake-darla.log
tail -20 /home/tcntryprd/rascals/logs/save-darla.log
```

## Onboarding a new rascal (post-v1.4.0)

For each new client:
1. `POST /api/agents/rascals` with a fresh `{handle, displayName, cli, client}` (or `import-presets` if the character is in the roster).
2. `cp` or hand-write the client's `CLAUDE.md` and `crons/*.md` into the newly-created project dir.
3. `PATCH /api/agents/rascals/{handle}` with `{"enabled": true}`.
4. Append morning-check + save cron lines to `/etc/cron.d/little-rascals` (stagger ≥2 min from existing rascals).
5. `sudo systemctl restart little-rascals.service` → new tmux session + CLI launch.
```

- [ ] **Step 4: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/rascals/install/
git commit -m "feat(rascals): add systemd unit, cron template, and install README"
```

---

### Task 12: Commit the Darla example files under `install/examples/`

These templates need to live in git so the install README can `cp` them.

**Files:**
- Create: `scripts/rascals/install/examples/darla/CLAUDE.md`
- Create: `scripts/rascals/install/examples/darla/crons/morning-check.md`

- [ ] **Step 1: Write Darla's CLAUDE.md**

Create `scripts/rascals/install/examples/darla/CLAUDE.md`:

```markdown
# Darla Wooldridge — Debbie Wooldridge / TTC

You are Darla, the Little Rascal assigned to Debbie Wooldridge (TTC) as client.

## Your job

You are Debbie / TTC's point of contact inside IR Custom AIOS for everything that
does not require Kevin personally — solutioning, project planning, stage
tracking in the Pipeline Engine, follow-ups, task management.

- Read your pending tasks at `http://127.0.0.1:8001/api/tasks/agent/darla`
  (send `X-BOSS-Internal: true` and `X-Tenant-ID: default` headers).
- Work the highest-priority task first (lowest `priority` number).
- When done with a stage, advance the task via `POST /api/tasks/{id}/advance`
  with `{output: "<short markdown summary>"}`.
- Save full deliverables as files under `output/{YYYY-MM-DD}-{slug}.md`.

## What you know about Debbie / TTC

(TODO — Kevin to replace this section with the real client context before
enabling Darla's cron.)

## Rules

- Never spawn new tmux windows, child Claude instances, or background processes.
- Never write to files outside `/home/tcntryprd/rascals/darla/`.
- If you hit an error or uncertainty, call `POST /api/tasks/{id}/fail` with a
  clear `reason` and stop.
- Your session will be reset every Sunday 3 AM — context is ephemeral.
  Long-term memory lives in Weaviate and `MEMORY.md`.
```

- [ ] **Step 2: Write Darla's morning-check template**

Create `scripts/rascals/install/examples/darla/crons/morning-check.md`:

```markdown
Morning check.

1. Fetch your pending tasks:
   `curl -sH 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' http://127.0.0.1:8001/api/tasks/agent/darla`
2. If any tasks are `pending`, pick the highest priority one and `POST /api/tasks/{id}/start`.
3. If any are `active`, continue working on them.
4. Check d.caine@dcaine.com calendar for meetings today involving Debbie
   Wooldridge or TTC. If a meeting is within 2 hours, prep a briefing.
5. If no tasks and no meetings: reply "Nothing to do this morning." and stop.

When finished, call `POST /api/tasks/{id}/advance` with a short `output`
summary, or create a new task (`POST /api/tasks`) if you discovered work.
```

- [ ] **Step 3: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/rascals/install/examples/darla/
git commit -m "feat(rascals): add Darla example CLAUDE.md + morning-check template"
```

---

### Task 13: First live wake — end-to-end smoke

This is the **ship gate** per master plan Phase 2: "Darla wakes on cron, reads her pending tasks, produces output, advances task." Steps 1-4 below exercise the onboarding flow Kevin specified — no rascal exists at step 1, Darla is imported and enabled during the smoke.

- [ ] **Step 0: Confirm starting state — no rascals, no tmux sessions**

Run:
```bash
curl -sS -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
  http://127.0.0.1:8001/api/agents/rascals | jq
# Expected: {"rascals":[]} — fresh state
tmux list-sessions 2>&1 | grep -E '^darla' || echo "no darla session (good)"
```

- [ ] **Step 1: Import Darla from presets**

Run:
```bash
curl -sS -X POST \
  -H 'X-BOSS-Internal: true' \
  -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' \
  -d '{"handles":["darla"]}' \
  http://127.0.0.1:8001/api/agents/rascals/import-presets | jq
# Expected: {"imported":["darla"],"skipped":[]}
ls /home/tcntryprd/rascals/darla/
# Expected: crons/ output/ state/
```

- [ ] **Step 2: Seed Darla's prompt files and enable her**

```bash
cp /home/tcntryprd/boss-dev/scripts/rascals/install/examples/darla/CLAUDE.md \
   /home/tcntryprd/rascals/darla/
cp /home/tcntryprd/boss-dev/scripts/rascals/install/examples/darla/crons/morning-check.md \
   /home/tcntryprd/rascals/darla/crons/

curl -sS -X PATCH \
  -H 'X-BOSS-Internal: true' \
  -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' \
  http://127.0.0.1:8001/api/agents/rascals/darla | jq
# Expected: enabled=true in response
```

- [ ] **Step 3: Seed a pending pipeline task for Darla**

Run:
```bash
docker exec boss_api node -e '
const h = require("http");
const call = (path, method="GET", body) => new Promise((ok, err) => {
  const data = body ? JSON.stringify(body) : "";
  const headers = { "X-BOSS-Internal":"true", "X-Tenant-ID":"default" };
  if (data) { headers["Content-Type"]="application/json"; headers["Content-Length"]=Buffer.byteLength(data); }
  const r = h.request({host:"127.0.0.1",port:8001,path,method,headers},(res)=>{
    let c=[]; res.on("data",d=>c.push(d));
    res.on("end",()=>ok(JSON.parse(Buffer.concat(c).toString()||"{}")));
  });
  r.on("error", err); if (data) r.write(data); r.end();
});
(async () => {
  const list = await call("/api/pipeline");
  const meeting = list.pipelines.find(p => p.name === "Client Meeting Followup");
  const task = await call("/api/tasks", "POST", {
    pipeline_id: meeting.id,
    title: "Smoke: Darla reads this, advances, produces output",
    assigned_agent: "darla",
    assigned_client: "06-debbie-wooldridge",
    priority: 1,
  });
  console.log(JSON.stringify(task, null, 2));
})();
'
```

Expected: a created task JSON with `id`, `status: "pending"`, `assigned_agent: "darla"`.

- [ ] **Step 4: Verify the agent-filtered endpoint sees it**

Run:
```bash
curl -sH 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
  http://127.0.0.1:8001/api/tasks/agent/darla | jq .
```

Expected: `{ "agent": "darla", "tasks": [ { id, title, current_stage: "calendar_detect", status: "pending", priority: 1, ... } ] }`.

- [ ] **Step 5: Start Darla's tmux session manually (systemd can come later)**

Run:
```bash
/home/tcntryprd/boss-dev/scripts/rascals/little-rascals-boot.sh
tmux list-sessions | grep darla
```

Expected: `darla: 1 windows (...)`. Attach briefly to confirm Claude Code is running:
```bash
tmux attach -t darla
# Wait ~5 seconds after you see the prompt, then detach: Ctrl+B, D
```

- [ ] **Step 6: Send the first real wake prompt**

Run:
```bash
/home/tcntryprd/boss-dev/scripts/rascals/wake-agent.sh darla "$(cat /home/tcntryprd/rascals/darla/crons/morning-check.md)"
```

Expected: exit 0. Log line in `wake-darla.log`. Visible activity in `tmux attach -t darla`.

- [ ] **Step 7: Wait for Darla to finish, then capture**

Give her ~2-5 minutes. Then:
```bash
/home/tcntryprd/boss-dev/scripts/rascals/agent-save.sh darla morning-check-smoke
ls -la /home/tcntryprd/rascals/darla/output/
```

Expected: a new `.md` file in `output/` containing the tmux scrollback.

- [ ] **Step 8: Verify Weaviate ingest**

Run:
```bash
curl -s 'http://127.0.0.1:8081/v1/objects?class=Knowledge&limit=5' | jq '.objects[] | {id, agent: .properties.agent, slug: .properties.slug}' | head -30
```

Expected: at least one object with `agent: "darla"` and a recent timestamp.

- [ ] **Step 9: Verify the task was advanced (or failed cleanly)**

Run:
```bash
curl -sH 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
  http://127.0.0.1:8001/api/tasks/agent/darla | jq '.tasks[] | {id, title, current_stage, status}'
```

Expected: the task is either in a later stage (`transcript_pull` or beyond), blocked at review, or has been marked failed with a reason. **What matters:** it's not still sitting at `calendar_detect, pending` — Darla took action.

If she didn't: attach to the session (`tmux attach -t darla`), read her output, debug the CLAUDE.md instructions. Common issue: Darla may not know she's supposed to call `/start` before `/advance`. Iterate on `CLAUDE.md` until the flow clicks — this is exactly the observation Phase 2 is designed to surface.

- [ ] **Step 10: No commit** — smoke test only. Document findings in session notes.

---

### Task 14: Full test suite, shellcheck sweep, typecheck

- [ ] **Step 1: Vitest full run (with DB env for integration tests)**

Run:
```bash
cd /home/tcntryprd/boss-dev && \
  TEST_PG_HOST=127.0.0.1 TEST_PG_PORT=5434 TEST_PG_USER=boss \
  TEST_PG_PASSWORD="$(docker exec boss_postgres printenv POSTGRES_PASSWORD)" \
  BOSS_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  JWT_SECRET=test-jwt-secret \
  npx vitest run
```
Expected: all tests pass. Baseline was 352; Task 2 adds 6 (presets); Task 2.75 adds 12 (repo); Task 3 adds 10 (routes) → expect 380.

- [ ] **Step 2: bats full run**

Run: `cd /home/tcntryprd/boss-dev && bats scripts/rascals/tests/`
Expected: all .bats files pass (7 common + 5 boot + 5 wake + 5 save + 3 reset = 25 tests).

- [ ] **Step 3: Shellcheck sweep**

Run:
```bash
cd /home/tcntryprd/boss-dev
shellcheck scripts/rascals/lib/*.sh scripts/rascals/*.sh
```

Expected: exit 0, no warnings. Any findings: fix and re-commit.

- [ ] **Step 4: TypeScript typecheck**

Run: `cd /home/tcntryprd/boss-dev && npx tsc --noEmit -p apps/api`
Expected: no output (no errors).

---

### Task 15: Open PR, code-reviewer subagent, land, tag v1.4.0

- [ ] **Step 1: Push the branch**

Run:
```bash
cd /home/tcntryprd/boss-dev
git push -u origin v2-little-rascals
```

- [ ] **Step 2: Open the PR**

Run:
```bash
cd /home/tcntryprd/boss-dev
gh pr create --base master --title "feat: Little Rascals orchestrator — Darla live (v1.4.0)" --body "$(cat <<'EOF'
## Summary

- Builds the Little Rascals orchestrator as a **dynamic, per-client system**: IR Custom AIOS boots with zero rascals; each rascal is imported/onboarded per client via the API.
- The 13 classic characters ship as import presets (data, not a baked registry).
- v1.4.0 goes live by importing **Darla** (Debbie Wooldridge / TTC) as the pilot rascal and proving the full flow end-to-end.
- Ship gate: after import + enable, Darla wakes on cron, reads `/api/tasks/agent/darla`, produces output, advances the task, save script captures scrollback to Weaviate.

## What lands in this PR

- Migration `016_rascals.sql` — authoritative `boss_rascals` table
- TS: `apps/api/src/agents/rascals-presets.ts` (import data), `rascals-repo.ts` (DB layer), `routes/rascals.ts` (CRUD + import-presets)
- Bash: `scripts/rascals/{boot,wake,save,reset}.sh` + `lib/rascals-common.sh` (API-driven, no hardcoded handles)
- Install: `scripts/rascals/install/{little-rascals.service,rascals.crontab,examples/darla/,README.md}`
- Tests: 28 new Vitest cases (6 presets + 12 repo + 10 routes) + 25 new bats cases

## Scope boundary

Out of scope for this PR (follow-up tags):
- Enabling additional rascals beyond Darla (onboarding flow now exists — just run it per client)
- Evening digest, post-meeting dynamic crons
- Weekly-reset cron enablement (script exists, cron commented out)
- Onboarding UI (API is the contract; UI is later)

## Test plan

- [x] `npx vitest run` — 380/380 (with `TEST_PG_*` env set so integration suites run)
- [x] `bats scripts/rascals/tests/` — 25/25
- [x] `shellcheck scripts/rascals/**/*.sh` — clean
- [x] `tsc --noEmit -p apps/api` — clean
- [x] Live smoke on host: fresh-install path — import Darla → enable → task seeded → wake → save → Weaviate object lands → task advanced

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Dispatch the code-reviewer subagent**

Use the `Agent` tool with `subagent_type: superpowers:code-reviewer`. Prompt it with:
- Repo path, branch name, PR number
- Kevin's locked preferences (bulletproof > first-place, no scope creep, no hardcoded secrets)
- The specific things to check: shell-script safety (shellcheck already green but sanity-check locking semantics, error propagation, idempotence), TS registry soundness, whether the install README is complete enough that a clean host could be brought up from it alone, whether the scope line is actually held.

- [ ] **Step 4: Address review**

Apply any Critical + Important findings. Nits are optional. Push each fix as a follow-up commit — **do not amend** (per Kevin's git-safety protocol).

- [ ] **Step 5: Merge and tag**

```bash
cd /home/tcntryprd/boss-dev
# Verify mergeable
gh pr view --json mergeable,mergeStateStatus
# Squash merge
gh pr merge --squash --delete-branch
# Pull master, tag v1.4.0, push
git checkout master && git pull --ff-only
git tag -a v1.4.0 -m "v1.4.0 — Little Rascals orchestrator, Darla live"
git push origin v1.4.0
# Watch deploy
gh run list -R TCntryPrd/boss-dev --limit 1
```

- [ ] **Step 6: Post-deploy — install on host**

Follow `scripts/rascals/install/README.md` step-by-step. Systemd enable, cron install, confirm Darla session is up.

- [ ] **Step 7: Observation window**

Let the cron fire once naturally (wait until the next 7:00 AM weekday). Check:
- `/home/tcntryprd/rascals/logs/wake-darla.log` — did wake fire?
- `/home/tcntryprd/rascals/darla/output/` — did save capture something?
- `boss_tasks` where `assigned_agent='darla'` — did status advance?
- Weaviate Knowledge objects with `agent='darla'` — did ingest land?

If all four are green: v1.4.0 is validated. Close the loop by posting a brief note to Kevin's session summary. If any are off: debug per `superpowers:systematic-debugging`.

---

## Self-Review Checklist

### Spec coverage
- ✅ Component 1 (boot) — Task 7. Now API-driven: iterates over `GET /api/agents/rascals?enabled=true`.
- ✅ Component 2 (wake + lock) — Task 8. Validates handle via per-handle API lookup before acting.
- ✅ Component 3 (save) — Task 9. Unchanged — save is per-handle and doesn't need registry lookup beyond the handle argument.
- ✅ Component 4 (weekly reset) — Task 10. Fetches registry from API; cron enablement deferred.
- ✅ Component 5 (cron schedule) — Task 11. Empty template + per-rascal append pattern in README.
- ✅ Component 6 (prompt templates) — Task 12 (`install/examples/darla/`).
- ✅ Component 7 (Kevin's control interface) — `tmux attach -t darla` + `wake-agent.sh` + new CRUD API cover it.
- ✅ Kevin's per-client onboarding rule (locked 2026-04-24) — new Tasks 2/2.5/2.75/3 establish the DB-backed registry + import-presets + full CRUD. Task 13 smoke test starts from zero rascals.
- ✅ Master plan Phase 2 ship gate — Task 13 (end-to-end smoke including the import).
- ✅ Kevin's other locked preferences — Non-negotiables section at top + scope boundary in PR description.

### Placeholder scan
- No `TODO`/`TBD`/`implement later` in step bodies. One intentional placeholder: Darla's `examples/CLAUDE.md` "What you know about Debbie / TTC" section is explicitly `(TODO — Kevin to replace this section before enabling Darla's cron)`. Content gap Kevin owns, not a plan gap.

### Type consistency
- Handle strings (`'darla'`, `'maryann'` — no dash, one word) are used consistently across TS, SQL, and bash.
- Pipe-delimited registry lines (`handle|cli|project_dir`) are consistent between `rascals_fetch_registry` in common.sh and the consumers in boot / reset.
- Log file naming (`boot.log`, `wake-{handle}.log`, `save-{handle}.log`, `reset.log`) is consistent.
- Tenant pattern: every TS function and every bash API call passes `default` (explicitly via `BOSS_TENANT_ID`). No silent assumptions.

### Coverage gaps flagged
- **Completion detection** (reference spec §Component 2 point 4) is intentionally NOT implemented in wake-agent.sh. Instead, a second cron entry ~15 min later calls `agent-save.sh`. Reliable prompt-regex detection is fragile; the time-gap approach is bulletproof for v1.4.0. Follow-up: replace the +15min save cron with a proper watch once the CLI emits a reliable completion signal.
- **Dynamic post-meeting crons** (reference spec §Component 5, Phase 3) — the write-one-shot-cron-then-self-delete plumbing is not implemented. Deferred to v1.4.x.
- **Watchdog** ("if lock held > 15 min, kill + restart") — the timeout + graceful exit is implemented via `RASCALS_WAKE_TIMEOUT_SEC`. Automatic session kill + relaunch is NOT. Deferred.
- **Client record linkage** — the `client` column is free-form TEXT. A proper `boss_clients` table and FK live in the broader CRM scope (Phase 9 per master plan), not here. This plan explicitly keeps that boundary.

---

## Execution Handoff

Plan complete and saved to `/home/tcntryprd/boss-dev/docs/superpowers/plans/2026-04-24-little-rascals-orchestrator.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Protects main context from shell-test output noise. Each task is self-contained.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`. Batched with checkpoints between Tasks 2/3 (TS land), Tasks 6–10 (shell land), Tasks 11–13 (install + smoke), Task 14–15 (ship). Faster if no context pressure.

**Which approach?**
