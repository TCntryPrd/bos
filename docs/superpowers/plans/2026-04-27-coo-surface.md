# COO Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/coo` page a working multi-thread chat with IR Custom AIOS, where each thread is a resumable Claude Code session running in a per-thread workspace with bypass-mode tool access.

**Architecture:** Mirrors the locked rascal-chat pattern — boss_api spawns `claude -p --output-format stream-json --resume <uuid>` per turn, with `--dangerously-skip-permissions` added for COO. DB-backed thread storage in the existing `boss_chat_sessions` table (extended to support `agent_kind='coo'` + `workspace_dir`). Old tmux-based `cli-brain.ts` is removed. Frontend is rewritten as a two-column layout (threads + chat).

**Tech Stack:** Node 22 / Fastify 5 / TypeScript / Postgres 16 / pg / vitest (api tests) / React 18 / Vite / TailwindCSS / SSE for streaming.

**Spec:** `docs/superpowers/specs/2026-04-27-coo-surface-design.md`

---

## File map

**Created:**
- `services/postgres/migrations/026_coo_chat_sessions.sql`
- `apps/api/src/routes/coo/index.ts`
- `apps/api/src/routes/coo/threads.ts`
- `apps/api/src/routes/coo/messages.ts`
- `apps/api/src/routes/coo/chat.ts`
- `apps/api/src/routes/coo/workspaces.ts`
- `apps/api/src/routes/coo/threads.test.ts`
- `apps/api/src/routes/coo/messages.test.ts`
- `apps/api/src/routes/coo/workspaces.test.ts`
- `apps/web/src/components/coo/ThreadList.tsx`
- `apps/web/src/components/coo/NewThreadModal.tsx`
- `apps/web/src/components/coo/ChatPane.tsx`
- `apps/web/src/components/coo/useCooThreads.ts`
- `apps/web/src/components/coo/useThreadMessages.ts`
- `docs/COO.md` (persona file, snapshotted at thread creation)

**Modified:**
- `apps/api/src/agents/rascal-chat.ts` — add `allowAllTools` flag (~5 lines)
- `apps/api/src/server.ts` — register cooRoutes (1 line)
- `apps/web/src/pages/COO.tsx` — full rewrite (3-col → 2-col, wires new components)
- `scripts/deploy.sh` — add smoke #32 (~25 lines)

**Deleted:**
- `apps/api/src/routes/cli-brain.ts` (and its server.ts registration)

---

## Task 1 — DB migration 026 (schema extension)

**Files:**
- Create: `services/postgres/migrations/026_coo_chat_sessions.sql`

- [ ] **Step 1.1: Write the migration**

```sql
-- 026_coo_chat_sessions.sql — extend boss_chat_sessions to support COO threads.
--
-- Background: boss_chat_sessions was generalized in migration 024 to allow
-- agent_kind IN ('rascal','outsider'). v1.7.7 introduces COO chat — a third
-- kind where each row represents one thread of Kevin's private chat with
-- IR Custom AIOS, scoped to a per-thread workspace directory.
--
-- For agent_kind='coo' rows, rascal_handle is reused as the thread slug
-- (kebab-cased name + 6-char suffix). workspace_dir is required at the
-- application layer; no DB constraint to keep rascal/outsider rows clean.
--
-- Idempotent.

ALTER TABLE boss_chat_sessions
  DROP CONSTRAINT IF EXISTS boss_chat_sessions_agent_kind_ck;
ALTER TABLE boss_chat_sessions
  ADD CONSTRAINT boss_chat_sessions_agent_kind_ck
  CHECK (agent_kind IN ('rascal','outsider','coo'));

ALTER TABLE boss_chat_sessions
  ADD COLUMN IF NOT EXISTS workspace_dir TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_coo
  ON boss_chat_sessions (tenant_id, agent_kind, updated_at DESC)
  WHERE agent_kind = 'coo';
```

- [ ] **Step 1.2: Apply locally and verify**

Run:
```bash
docker exec -i boss_postgres psql -U boss -d boss_db < services/postgres/migrations/026_coo_chat_sessions.sql
docker exec boss_postgres psql -U boss -d boss_db -c \
  "INSERT INTO boss_chat_sessions (tenant_id, agent_kind, rascal_handle, name, workspace_dir) \
   VALUES ('default','coo','smoke-thread','Smoke','/home/tcntryprd/boss-dev') RETURNING id;"
docker exec boss_postgres psql -U boss -d boss_db -c \
  "DELETE FROM boss_chat_sessions WHERE rascal_handle='smoke-thread';"
```

Expected: insert succeeds (returns a UUID); delete succeeds. If the CHECK constraint rejects 'coo', the migration didn't apply.

- [ ] **Step 1.3: Commit**

```bash
git add services/postgres/migrations/026_coo_chat_sessions.sql
git commit -m "feat(db): migration 026 — coo agent_kind + workspace_dir"
```

---

## Task 2 — `runChatTurn` allowAllTools flag

**Files:**
- Modify: `apps/api/src/agents/rascal-chat.ts`
- Test: `apps/api/src/agents/rascal-chat.test.ts` (new)

- [ ] **Step 2.1: Write the failing test**

Create `apps/api/src/agents/rascal-chat.test.ts`:

```typescript
/**
 * Unit tests for the rascal-chat allowAllTools flag.
 *
 * We can't easily mock the spawn() call without complex DI, so this
 * test asserts the flag-handling indirectly by inspecting the args
 * we pass to a fake spawn implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture spawn() args via vi.mock
const spawnCalls: Array<{ bin: string; args: string[]; opts: unknown }> = [];

vi.mock('node:child_process', () => ({
  spawn: (bin: string, args: string[], opts: unknown) => {
    spawnCalls.push({ bin, args, opts });
    return {
      stdin: { write: () => {}, end: () => {} },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (evt: string, cb: (...a: unknown[]) => void) => {
        if (evt === 'close') queueMicrotask(() => cb(0));
      },
      kill: () => {},
    };
  },
}));

describe('runChatTurn — allowAllTools flag', () => {
  beforeEach(() => { spawnCalls.length = 0; });

  it('omits --dangerously-skip-permissions by default', async () => {
    const { runChatTurn } = await import('./rascal-chat.js');
    const fakeSse = { write: () => {} } as unknown as Parameters<typeof runChatTurn>[1];
    await runChatTurn(
      { message: 'hi', projectDir: '/tmp', ccSessionId: null },
      fakeSse,
    );
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).not.toContain('--dangerously-skip-permissions');
  });

  it('includes --dangerously-skip-permissions when allowAllTools is true', async () => {
    const { runChatTurn } = await import('./rascal-chat.js');
    const fakeSse = { write: () => {} } as unknown as Parameters<typeof runChatTurn>[1];
    await runChatTurn(
      { message: 'hi', projectDir: '/tmp', ccSessionId: null, allowAllTools: true },
      fakeSse,
    );
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('--dangerously-skip-permissions');
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/agents/rascal-chat.test.ts`
Expected: 2 tests, both fail (the second because `allowAllTools` does not yet add the flag).

- [ ] **Step 2.3: Add the flag**

In `apps/api/src/agents/rascal-chat.ts`, find the `ChatTurnInput` interface and add:

```typescript
export interface ChatTurnInput {
  message: string;
  projectDir: string;
  ccSessionId: string | null;
  model?: string;
  abortSignal?: AbortSignal;
  allowAllTools?: boolean;
}
```

Then in `runChatTurn`, after the existing `--session-id` / `--resume` push and before the `spawn(CLAUDE_BIN, args, ...)` call, append:

```typescript
  if (input.allowAllTools) {
    args.push('--dangerously-skip-permissions');
  }
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/agents/rascal-chat.test.ts`
Expected: 2 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/agents/rascal-chat.ts apps/api/src/agents/rascal-chat.test.ts
git commit -m "feat(rascal-chat): allowAllTools flag for COO bypass mode"
```

---

## Task 3 — Persona file `docs/COO.md`

**Files:**
- Create: `docs/COO.md`

- [ ] **Step 3.1: Write the persona file**

Create `docs/COO.md` with:

```markdown
# IR Custom AIOS · COO

You are IR Custom AIOS, Kevin Starr's Chief Operating Officer.

You operate inside whatever workspace the current thread points at.
Read `CLAUDE.md` in that workspace for project-specific context — but
your identity is IR Custom AIOS, not the workspace's resident agent. If
`CLAUDE.md` describes a rascal, you are not that rascal; you are the
COO consulting on that rascal's project.

You have full read/write access to the active workspace via Claude
Code's standard tool belt. Bypass mode is on — Kevin authorized it
explicitly. Don't ask before reasonable actions; do them.

## Voice

- Be terse. Kevin reads diffs.
- Don't recap what you just did.
- State results and decisions directly.
- Match the response length to the task. A simple question gets a
  direct answer, not headers and sections.

## Context Kevin assumes you have

- IR Custom AIOS is his AI Operating System; you (the COO) are its operator-facing
  surface.
- The platform runs on a single Ubuntu host (Last Castle / HP box).
- Rascals are per-client autonomous agents; Outsiders are per-AI-personality
  agents (Ponyboy is the only one).
- "OpenClaw" is the previous-gen agent stack on probation, surfaced at /oc.

## Escalation

If a request would touch shared state (deploys, git push, force-push,
external messages, infrastructure beyond the active workspace), pause
and confirm before acting.

---

This file is the canonical COO brief. It is snapshotted into a thread
at thread-creation time; existing threads keep their snapshot. Edit
freely — new threads will pick up changes.
```

- [ ] **Step 3.2: Commit**

```bash
git add docs/COO.md
git commit -m "feat(docs): seed COO persona brief"
```

---

## Task 4 — Workspaces route (`/api/coo/workspaces`)

**Files:**
- Create: `apps/api/src/routes/coo/workspaces.ts`
- Test: `apps/api/src/routes/coo/workspaces.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `apps/api/src/routes/coo/workspaces.test.ts`:

```typescript
/**
 * Tests for GET /api/coo/workspaces — returns the dropdown source for
 * the new-thread modal. Reads the host filesystem (rascal + outsider
 * dirs); we stub via env for determinism.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server.js';
import { closeDb } from '../../db.js';

const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

let server: FastifyInstance | null = null;
let scratchHome: string;

beforeAll(async () => {
  scratchHome = mkdtempSync(join(tmpdir(), 'coo-ws-'));
  mkdirSync(join(scratchHome, 'boss-dev'), { recursive: true });
  mkdirSync(join(scratchHome, 'rascals/darla'), { recursive: true });
  mkdirSync(join(scratchHome, 'rascals/spanky'), { recursive: true });
  mkdirSync(join(scratchHome, 'outsiders/ponyboy'), { recursive: true });
  writeFileSync(join(scratchHome, 'boss-dev', '.git'), 'gitdir: x');
  process.env.BOSS_HOME_OVERRIDE = scratchHome;
  server = await buildServer();
});

afterAll(async () => {
  if (server) await server.close();
  await closeDb();
  rmSync(scratchHome, { recursive: true, force: true });
  delete process.env.BOSS_HOME_OVERRIDE;
});

describe('GET /api/coo/workspaces', () => {
  it('returns boss-dev + rascal dirs + outsider dirs', async () => {
    const res = await server!.inject({
      method: 'GET',
      url: '/api/coo/workspaces',
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ label: string; path: string; kind: string }>;
    expect(body).toContainEqual(expect.objectContaining({ kind: 'boss-dev' }));
    expect(body.filter((w) => w.kind === 'rascal').map((w) => w.label).sort()).toEqual(['darla', 'spanky']);
    expect(body.filter((w) => w.kind === 'outsider').map((w) => w.label)).toEqual(['ponyboy']);
  });

  it('returns 401 without auth header', async () => {
    const res = await server!.inject({ method: 'GET', url: '/api/coo/workspaces' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/coo/workspaces.test.ts`
Expected: route 404s; tests fail. Confirms route doesn't exist yet.

- [ ] **Step 4.3: Write the route**

Create `apps/api/src/routes/coo/workspaces.ts`:

```typescript
/**
 * GET /api/coo/workspaces — workspace options for the new-thread modal.
 *
 * Source of truth is the bind-mounted host directories visible to
 * boss_api: boss-dev (singleton), ~/rascals/* (one per rascal),
 * ~/outsiders/* (one per outsider). BOSS_HOME_OVERRIDE swaps the
 * root for tests.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

interface Workspace {
  label: string;
  path: string;
  kind: 'boss-dev' | 'rascal' | 'outsider';
}

const HOME = process.env.BOSS_HOME_OVERRIDE ?? '/home/tcntryprd';

function listSubdirs(parent: string): string[] {
  try {
    return readdirSync(parent)
      .filter((name) => {
        try { return statSync(join(parent, name)).isDirectory(); }
        catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
}

export async function workspacesRoutes(server: FastifyInstance) {
  server.get('/workspaces', async (_req: FastifyRequest, reply: FastifyReply) => {
    const home = process.env.BOSS_HOME_OVERRIDE ?? HOME;
    const out: Workspace[] = [];
    out.push({ label: 'boss-dev', path: join(home, 'boss-dev'), kind: 'boss-dev' });
    for (const handle of listSubdirs(join(home, 'rascals'))) {
      out.push({ label: handle, path: join(home, 'rascals', handle), kind: 'rascal' });
    }
    for (const handle of listSubdirs(join(home, 'outsiders'))) {
      out.push({ label: handle, path: join(home, 'outsiders', handle), kind: 'outsider' });
    }
    return reply.status(200).send(out);
  });
}
```

- [ ] **Step 4.4: Wire into the cooRoutes aggregator**

We don't have the aggregator yet; create a stub now and finalize in Task 8. Create `apps/api/src/routes/coo/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { workspacesRoutes } from './workspaces.js';

export async function cooRoutes(server: FastifyInstance) {
  await server.register(workspacesRoutes);
}
```

Then register in `apps/api/src/server.ts` — find the openclaw route registration (`await server.register(openclawRoutes)`) and add immediately after:

```typescript
  await server.register(cooRoutes, { prefix: '/api/coo' });
```

Add the import at the top of server.ts:

```typescript
import { cooRoutes } from './routes/coo/index.js';
```

- [ ] **Step 4.5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/coo/workspaces.test.ts`
Expected: 2 tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add apps/api/src/routes/coo/ apps/api/src/server.ts
git commit -m "feat(api): GET /api/coo/workspaces — dropdown source"
```

---

## Task 5 — Threads CRUD route (list + create + rename)

**Files:**
- Create: `apps/api/src/routes/coo/threads.ts`
- Test: `apps/api/src/routes/coo/threads.test.ts`
- Modify: `apps/api/src/routes/coo/index.ts`

- [ ] **Step 5.1: Write the failing test**

Create `apps/api/src/routes/coo/threads.test.ts` (mirror the rascals.test.ts scratch-DB pattern):

```typescript
/**
 * Integration tests for /api/coo/threads — list / create / rename.
 *
 * Uses the rascals.test.ts pattern: scratch DB at 5434, applies migrations
 * 014/015/016/020/021/024/026 (everything chat_sessions touches plus the new
 * COO migration). If Postgres is unreachable, the suite is skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server.js';
import { closeDb } from '../../db.js';

const { Client } = pg;

const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASS = process.env.TEST_PG_PASSWORD ?? '';
const auth = PG_PASS ? `${PG_USER}:${PG_PASS}` : PG_USER;
const ADMIN_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_coo_threads_${process.pid}`;
const SCRATCH_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
const MIGRATIONS_DIR = resolve(__dirname, '../../../../../services/postgres/migrations');

const FOUNDATION_FN = `
  CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;
`;

const MIGRATIONS = [
  '014_pipeline_engine.sql',
  '015_pipeline_seeds.sql',
  '016_rascals.sql',
  '020_chat_sessions.sql',
  '021_chat_session_cc_id.sql',
  '022_outsiders.sql',
  '023_outsiders_seed_backfill.sql',
  '024_chat_sessions_agent_kind.sql',
  '026_coo_chat_sessions.sql',
];

const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

let server: FastifyInstance | null = null;
let scratchHome: string;

async function pgReachable(): Promise<boolean> {
  const c = new Client({ connectionString: ADMIN_URL });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const reachable = await pgReachable();

beforeAll(async () => {
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();
  const scratch = new Client({ connectionString: SCRATCH_URL });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  for (const m of MIGRATIONS) {
    await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, m), 'utf-8'));
  }
  await scratch.end();

  scratchHome = mkdtempSync(join(tmpdir(), 'coo-th-'));
  mkdirSync(join(scratchHome, 'boss-dev/docs'), { recursive: true });
  mkdirSync(join(scratchHome, 'rascals/darla'), { recursive: true });
  writeFileSync(join(scratchHome, 'boss-dev/docs/COO.md'), '# Test COO brief\nshort.\n');

  process.env.DATABASE_URL = SCRATCH_URL;
  process.env.BOSS_HOME_OVERRIDE = scratchHome;
  server = await buildServer();
});

afterAll(async () => {
  if (!reachable) return;
  if (server) await server.close();
  await closeDb();
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
  rmSync(scratchHome, { recursive: true, force: true });
  delete process.env.BOSS_HOME_OVERRIDE;
});

beforeEach(async () => {
  if (!reachable) return;
  const c = new Client({ connectionString: SCRATCH_URL });
  await c.connect();
  await c.query("DELETE FROM boss_chat_sessions WHERE agent_kind='coo';");
  await c.end();
});

describe.skipIf(!reachable)('/api/coo/threads', () => {
  it('POST creates a thread with snapshotted persona', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Main', workspace_dir: join(scratchHome, 'boss-dev') },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; workspace_dir: string; system_prompt: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('Main');
    expect(body.system_prompt).toContain('Test COO brief');
  });

  it('POST falls back to built-in persona when COO.md is missing', async () => {
    rmSync(join(scratchHome, 'boss-dev/docs/COO.md'));
    const res = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Fallback', workspace_dir: join(scratchHome, 'boss-dev') },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { system_prompt: string }).system_prompt).toContain('You are IR Custom AIOS');
    // restore for later tests
    writeFileSync(join(scratchHome, 'boss-dev/docs/COO.md'), '# Test COO brief\nshort.\n');
  });

  it('POST rejects workspace_dir not in the allowlist', async () => {
    const res = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Bad', workspace_dir: '/etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET lists threads for the tenant, newest first', async () => {
    const dir = join(scratchHome, 'boss-dev');
    for (const n of ['A', 'B', 'C']) {
      await server!.inject({
        method: 'POST',
        url: '/api/coo/threads',
        headers: { ...H, 'content-type': 'application/json' },
        payload: { name: n, workspace_dir: dir },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const res = await server!.inject({ method: 'GET', url: '/api/coo/threads', headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ name: string }>;
    expect(body.map((t) => t.name)).toEqual(['C', 'B', 'A']);
  });

  it('PATCH renames a thread', async () => {
    const dir = join(scratchHome, 'boss-dev');
    const created = await server!.inject({
      method: 'POST',
      url: '/api/coo/threads',
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Original', workspace_dir: dir },
    });
    const { id } = created.json() as { id: string };
    const renamed = await server!.inject({
      method: 'PATCH',
      url: `/api/coo/threads/${id}`,
      headers: { ...H, 'content-type': 'application/json' },
      payload: { name: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { name: string }).name).toBe('Renamed');
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/coo/threads.test.ts`
Expected: tests fail (route doesn't exist) OR are skipped if Postgres at :5434 is unreachable. Postgres should be reachable since boss_postgres is up; if skipped, run `docker port boss_postgres` to confirm and set TEST_PG_PORT.

- [ ] **Step 5.3: Write the route**

Create `apps/api/src/routes/coo/threads.ts`:

```typescript
/**
 * /api/coo/threads — COO thread CRUD (list, create, rename).
 *
 * Threads are stored in boss_chat_sessions with agent_kind='coo'.
 * rascal_handle holds a kebab-case slug; workspace_dir is the cwd for
 * Claude Code spawns; system_prompt snapshots boss-dev/docs/COO.md
 * (or the built-in fallback) at create-time.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db.js';

const HOME = () => process.env.BOSS_HOME_OVERRIDE ?? '/home/tcntryprd';
const COO_MD_PATH = () => join(HOME(), 'boss-dev/docs/COO.md');

const FALLBACK_PERSONA = `You are IR Custom AIOS, Kevin Starr's Chief Operating Officer.

You operate inside whatever workspace the current thread points at.
Read CLAUDE.md in that workspace for project-specific context — but
your identity is IR Custom AIOS, not the workspace's resident agent.

You have full read/write access to the active workspace via Claude
Code's standard tool belt. Bypass mode is on. Don't ask before
reasonable actions; do them.

Be terse. Kevin reads diffs.`;

function readPersona(): string {
  try {
    if (existsSync(COO_MD_PATH())) {
      return readFileSync(COO_MD_PATH(), 'utf-8');
    }
  } catch { /* fall through */ }
  return FALLBACK_PERSONA;
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'thread';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

async function isAllowedWorkspace(tenantId: string, dir: string): Promise<boolean> {
  // workspace_dir must equal one entry returned by /api/coo/workspaces.
  // Recompute the allowlist server-side to avoid relying on the client.
  const home = HOME();
  const { readdirSync, statSync } = await import('node:fs');
  const allowed = new Set<string>();
  allowed.add(join(home, 'boss-dev'));
  for (const sub of ['rascals', 'outsiders']) {
    try {
      for (const handle of readdirSync(join(home, sub))) {
        try {
          if (statSync(join(home, sub, handle)).isDirectory()) {
            allowed.add(join(home, sub, handle));
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return allowed.has(dir);
}

interface CreateBody { name: string; workspace_dir: string; }
interface RenameBody { name: string; }

export async function threadsRoutes(server: FastifyInstance) {
  // GET /api/coo/threads
  server.get('/threads', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
    const { rows } = await getPool().query(
      `SELECT s.id, s.name, s.workspace_dir, s.created_at, s.updated_at,
              (SELECT content FROM boss_chat_messages
                 WHERE session_id = s.id
                 ORDER BY created_at DESC LIMIT 1) AS last_message_preview
         FROM boss_chat_sessions s
        WHERE s.tenant_id = $1
          AND s.agent_kind = 'coo'
          AND s.archived = FALSE
        ORDER BY s.updated_at DESC`,
      [tenantId],
    );
    return reply.status(200).send(rows);
  });

  // POST /api/coo/threads
  server.post<{ Body: CreateBody }>('/threads', async (req, reply) => {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
    const { name, workspace_dir } = req.body ?? {} as CreateBody;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ error: 'name required' });
    }
    if (!workspace_dir || typeof workspace_dir !== 'string') {
      return reply.status(400).send({ error: 'workspace_dir required' });
    }
    if (!(await isAllowedWorkspace(tenantId, workspace_dir))) {
      return reply.status(400).send({ error: 'workspace_dir not in allowlist' });
    }
    const slug = slugify(name);
    const persona = readPersona();
    const { rows } = await getPool().query(
      `INSERT INTO boss_chat_sessions
         (tenant_id, agent_kind, rascal_handle, name, workspace_dir, system_prompt)
       VALUES ($1, 'coo', $2, $3, $4, $5)
       RETURNING id, name, workspace_dir, system_prompt, created_at, updated_at`,
      [tenantId, slug, name.trim(), workspace_dir, persona],
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /api/coo/threads/:id
  server.patch<{ Params: { id: string }; Body: RenameBody }>('/threads/:id', async (req, reply) => {
    const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
    const { id } = req.params;
    const { name } = req.body ?? {} as RenameBody;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ error: 'name required' });
    }
    const { rows } = await getPool().query(
      `UPDATE boss_chat_sessions
          SET name = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND agent_kind = 'coo'
        RETURNING id, name, workspace_dir, created_at, updated_at`,
      [id, tenantId, name.trim()],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'thread not found' });
    return reply.status(200).send(rows[0]);
  });
}
```

- [ ] **Step 5.4: Wire into the cooRoutes aggregator**

In `apps/api/src/routes/coo/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { workspacesRoutes } from './workspaces.js';
import { threadsRoutes } from './threads.js';

export async function cooRoutes(server: FastifyInstance) {
  await server.register(workspacesRoutes);
  await server.register(threadsRoutes);
}
```

- [ ] **Step 5.5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/coo/threads.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add apps/api/src/routes/coo/threads.ts apps/api/src/routes/coo/threads.test.ts apps/api/src/routes/coo/index.ts
git commit -m "feat(api): /api/coo/threads CRUD (list/create/rename)"
```

---

## Task 6 — Messages route (`GET /api/coo/threads/:id/messages`)

**Files:**
- Create: `apps/api/src/routes/coo/messages.ts`
- Test: `apps/api/src/routes/coo/messages.test.ts`
- Modify: `apps/api/src/routes/coo/index.ts`

- [ ] **Step 6.1: Write the failing test**

Create `apps/api/src/routes/coo/messages.test.ts`. It uses the same scratch-DB harness as `threads.test.ts` but inserts messages directly via SQL.

```typescript
/**
 * Integration tests for GET /api/coo/threads/:id/messages.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server.js';
import { closeDb } from '../../db.js';

const { Client } = pg;
const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5434);
const PG_USER = process.env.TEST_PG_USER ?? 'boss';
const PG_PASS = process.env.TEST_PG_PASSWORD ?? '';
const auth = PG_PASS ? `${PG_USER}:${PG_PASS}` : PG_USER;
const ADMIN_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/postgres`;
const SCRATCH_DB = `boss_test_coo_msgs_${process.pid}`;
const SCRATCH_URL = `postgresql://${auth}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
const MIGRATIONS_DIR = resolve(__dirname, '../../../../../services/postgres/migrations');
const FOUNDATION_FN = `CREATE OR REPLACE FUNCTION boss_set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;`;
const MIGRATIONS = ['014_pipeline_engine.sql','015_pipeline_seeds.sql','016_rascals.sql','020_chat_sessions.sql','021_chat_session_cc_id.sql','022_outsiders.sql','023_outsiders_seed_backfill.sql','024_chat_sessions_agent_kind.sql','026_coo_chat_sessions.sql'];
const H = { 'X-BOSS-Internal': 'true', 'X-Tenant-ID': 'default' } as const;

let server: FastifyInstance | null = null;
let scratchHome: string;
let threadId: string;

async function pgReachable(): Promise<boolean> {
  const c = new Client({ connectionString: ADMIN_URL });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const reachable = await pgReachable();

beforeAll(async () => {
  if (!reachable) return;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();
  const scratch = new Client({ connectionString: SCRATCH_URL });
  await scratch.connect();
  await scratch.query(FOUNDATION_FN);
  for (const m of MIGRATIONS) await scratch.query(readFileSync(resolve(MIGRATIONS_DIR, m), 'utf-8'));
  await scratch.end();

  scratchHome = mkdtempSync(join(tmpdir(), 'coo-msg-'));
  mkdirSync(join(scratchHome, 'boss-dev/docs'), { recursive: true });
  writeFileSync(join(scratchHome, 'boss-dev/docs/COO.md'), '# brief\n');
  process.env.DATABASE_URL = SCRATCH_URL;
  process.env.BOSS_HOME_OVERRIDE = scratchHome;
  server = await buildServer();

  const created = await server.inject({
    method: 'POST', url: '/api/coo/threads',
    headers: { ...H, 'content-type': 'application/json' },
    payload: { name: 'msgs', workspace_dir: join(scratchHome, 'boss-dev') },
  });
  threadId = (created.json() as { id: string }).id;

  const c = new Client({ connectionString: SCRATCH_URL });
  await c.connect();
  for (let i = 0; i < 5; i += 1) {
    await c.query(
      `INSERT INTO boss_chat_messages (session_id, role, content) VALUES ($1, $2, $3)`,
      [threadId, i % 2 === 0 ? 'user' : 'assistant', `m${i}`],
    );
    await c.query(`SELECT pg_sleep(0.01)`);
  }
  await c.end();
});

afterAll(async () => {
  if (!reachable) return;
  if (server) await server.close();
  await closeDb();
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
  rmSync(scratchHome, { recursive: true, force: true });
  delete process.env.BOSS_HOME_OVERRIDE;
});

describe.skipIf(!reachable)('GET /api/coo/threads/:id/messages', () => {
  it('returns messages oldest-first', async () => {
    const res = await server!.inject({ method: 'GET', url: `/api/coo/threads/${threadId}/messages`, headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ role: string; content: string }>;
    expect(body.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('404s for unknown thread', async () => {
    const res = await server!.inject({
      method: 'GET',
      url: '/api/coo/threads/00000000-0000-0000-0000-000000000000/messages',
      headers: H,
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/coo/messages.test.ts`
Expected: tests fail; route doesn't exist.

- [ ] **Step 6.3: Write the route**

Create `apps/api/src/routes/coo/messages.ts`:

```typescript
/**
 * GET /api/coo/threads/:id/messages — load message history for a thread.
 *
 * Returns oldest-first (chat reading order) so the frontend can append
 * new turns without reversing.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db.js';

export async function messagesRoutes(server: FastifyInstance) {
  server.get<{ Params: { id: string } }>(
    '/threads/:id/messages',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
      const { id } = req.params;
      const sess = await getPool().query(
        `SELECT id FROM boss_chat_sessions
          WHERE id = $1 AND tenant_id = $2 AND agent_kind = 'coo'`,
        [id, tenantId],
      );
      if (sess.rows.length === 0) return reply.status(404).send({ error: 'thread not found' });
      const { rows } = await getPool().query(
        `SELECT id, role, content, tokens_in, tokens_out, created_at
           FROM boss_chat_messages
          WHERE session_id = $1
          ORDER BY created_at ASC
          LIMIT 200`,
        [id],
      );
      return reply.status(200).send(rows);
    },
  );
}
```

- [ ] **Step 6.4: Wire into aggregator**

Update `apps/api/src/routes/coo/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { workspacesRoutes } from './workspaces.js';
import { threadsRoutes } from './threads.js';
import { messagesRoutes } from './messages.js';

export async function cooRoutes(server: FastifyInstance) {
  await server.register(workspacesRoutes);
  await server.register(threadsRoutes);
  await server.register(messagesRoutes);
}
```

- [ ] **Step 6.5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/coo/messages.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add apps/api/src/routes/coo/messages.ts apps/api/src/routes/coo/messages.test.ts apps/api/src/routes/coo/index.ts
git commit -m "feat(api): GET /api/coo/threads/:id/messages — history"
```

---

## Task 7 — Chat SSE route (`POST /api/coo/threads/:id/chat`)

**Files:**
- Create: `apps/api/src/routes/coo/chat.ts`
- Modify: `apps/api/src/routes/coo/index.ts`

> **Why no unit test:** The chat route's only branchless behavior is "spawn CC subprocess and pipe stream-json frames as SSE". The existing rascal-workspace chat path is the validated reference; mirroring it is straightforward. Coverage comes from the deploy-smoke (Task 11), which exercises the route end-to-end against a real CC subprocess.

- [ ] **Step 7.1: Write the route**

Create `apps/api/src/routes/coo/chat.ts`:

```typescript
/**
 * POST /api/coo/threads/:id/chat — SSE streaming chat turn for COO.
 *
 * Mirrors the rascal-workspace chat handler with three deltas:
 *   1. agent_kind='coo' (not rascal/outsider)
 *   2. cwd = thread.workspace_dir (picked at thread creation)
 *   3. allowAllTools: true (bypass mode — explicit Kevin authorization)
 *
 * SSE event shape:
 *   event: frame      — every stream-json frame from CC (raw passthrough)
 *   event: error      — terminal error before/after spawn
 *   event: done       — terminal success marker emitted just before close
 *
 * Heartbeats every 15s while the subprocess runs.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db.js';
import { runChatTurn } from '../../agents/rascal-chat.js';

interface ChatBody { message: string; }

export async function chatRoutes(server: FastifyInstance) {
  server.post<{ Params: { id: string }; Body: ChatBody }>(
    '/threads/:id/chat',
    async (req: FastifyRequest<{ Params: { id: string }; Body: ChatBody }>, reply: FastifyReply) => {
      const tenantId = (req.headers['x-tenant-id'] as string) ?? 'default';
      const { id } = req.params;
      const { message } = req.body ?? {} as ChatBody;
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.status(400).send({ error: 'message required' });
      }

      const sessRes = await getPool().query(
        `SELECT id, cc_session_id, model, workspace_dir, system_prompt
           FROM boss_chat_sessions
          WHERE id = $1 AND tenant_id = $2 AND agent_kind = 'coo'`,
        [id, tenantId],
      );
      if (sessRes.rows.length === 0) return reply.status(404).send({ error: 'thread not found' });
      const session = sessRes.rows[0];

      await getPool().query(
        `INSERT INTO boss_chat_messages (session_id, role, content)
           VALUES ($1, 'user', $2)`,
        [session.id, message],
      );

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const heartbeat = setInterval(() => {
        try { reply.raw.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
      }, 15_000);

      const abortController = new AbortController();
      const onClose = () => abortController.abort();
      reply.raw.on('close', onClose);

      try {
        const turn = await runChatTurn(
          {
            message,
            projectDir: session.workspace_dir,
            ccSessionId: session.cc_session_id,
            model: session.model,
            abortSignal: abortController.signal,
            allowAllTools: true,
          },
          reply.raw,
        );

        await getPool().query(
          `UPDATE boss_chat_sessions
             SET cc_session_id = COALESCE(cc_session_id, $2),
                 updated_at = now()
            WHERE id = $1`,
          [session.id, turn.ccSessionId],
        );
        const persistedText = turn.aborted
          ? `${turn.assistantText}\n\n[interrupted]`
          : turn.assistantText;
        await getPool().query(
          `INSERT INTO boss_chat_messages
             (session_id, role, content, tokens_in, tokens_out)
           VALUES ($1, 'assistant', $2, $3, $4)`,
          [session.id, persistedText, turn.tokensIn, turn.tokensOut],
        );
        try { reply.raw.write(`event: done\ndata: {"ok":true}\n\n`); } catch { /* ignore */ }
      } catch (err) {
        req.log.error({ err, threadId: id }, 'COO chat turn failed');
        try { reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`); } catch { /* ignore */ }
      } finally {
        clearInterval(heartbeat);
        reply.raw.removeListener('close', onClose);
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    },
  );
}
```

- [ ] **Step 7.2: Wire into aggregator**

Update `apps/api/src/routes/coo/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { workspacesRoutes } from './workspaces.js';
import { threadsRoutes } from './threads.js';
import { messagesRoutes } from './messages.js';
import { chatRoutes } from './chat.js';

export async function cooRoutes(server: FastifyInstance) {
  await server.register(workspacesRoutes);
  await server.register(threadsRoutes);
  await server.register(messagesRoutes);
  await server.register(chatRoutes);
}
```

- [ ] **Step 7.3: Verify typecheck and existing tests still green**

Run:
```bash
cd apps/api && npm run lint && npx vitest run src/routes/coo/
```
Expected: tsc passes; all 9 COO tests pass (workspaces 2 + threads 5 + messages 2).

- [ ] **Step 7.4: Commit**

```bash
git add apps/api/src/routes/coo/chat.ts apps/api/src/routes/coo/index.ts
git commit -m "feat(api): POST /api/coo/threads/:id/chat — SSE streaming"
```

---

## Task 8 — DEFERRED to v1.7.8

**Original intent:** delete `cli-brain.ts` route and unregister from server.ts. **Why deferred:** cli-brain.ts has a consumer the spec missed — `apps/web/src/components/shell/IR Custom AIOSOrb.tsx` (the NavRail chat orb, global across the app). Removing the route would break the orb across every page, not just /coo. The orb is already non-functional at 503 today, so leaving the route in place is no regression. v1.7.8 will either rewire IR Custom AIOSOrb to call `/api/coo/threads/:id/chat` against a singleton "main" thread, or rebuild the orb against the new architecture; cli-brain.ts removal happens there.

**Consequence for v1.7.7:** the standing rule "If anything hits /api/brain/cli/* after v1.7.7, it's a stale frontend cache" does NOT ship.

Below content kept for v1.7.8 reference.

---

## Task 8 (deferred) — Remove old `cli-brain.ts` route

**Files:**
- Delete: `apps/api/src/routes/cli-brain.ts`
- Modify: `apps/api/src/server.ts` (drop import + register)

- [ ] **Step 8.1: Confirm no remaining consumers**

Run:
```bash
cd /home/tcntryprd/boss-dev && grep -rn 'brain/cli\|cliBrainRoutes\|cli-brain' apps/ services/ scripts/ 2>/dev/null
```
Expected: only matches in `apps/api/src/server.ts` (the import + register lines) and `apps/api/src/routes/cli-brain.ts` itself, plus the soon-to-be-rewritten COO.tsx (already replaced in Task 9 below — check that grep result has no other consumers like Slack, healing, etc.).

If anything outside server.ts/COO.tsx/cli-brain.ts still references it, STOP and surface the consumer before deleting.

- [ ] **Step 8.2: Delete the route file and unregister**

```bash
rm apps/api/src/routes/cli-brain.ts
```

In `apps/api/src/server.ts`, remove:
- The import line `import { cliBrainRoutes } from './routes/cli-brain.js';`
- The registration line `await server.register(cliBrainRoutes, { prefix: '/api/brain/cli' });`

- [ ] **Step 8.3: Typecheck and run all api tests**

Run:
```bash
cd apps/api && npm run lint && npm test
```
Expected: tsc passes (no missing imports). All existing tests still pass.

- [ ] **Step 8.4: Commit**

```bash
git add apps/api/src/routes apps/api/src/server.ts
git commit -m "chore(api): remove legacy tmux-based cli-brain route"
```

---

## Task 9 — Frontend: useCooThreads hook

**Files:**
- Create: `apps/web/src/components/coo/useCooThreads.ts`

> Frontend has no test framework; verification is `npm run typecheck` from `apps/web`.

- [ ] **Step 9.1: Write the hook**

Create `apps/web/src/components/coo/useCooThreads.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';

export interface CooThread {
  id: string;
  name: string;
  workspace_dir: string;
  created_at: string;
  updated_at: string;
  last_message_preview: string | null;
}

export interface CooWorkspace {
  label: string;
  path: string;
  kind: 'boss-dev' | 'rascal' | 'outsider';
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useCooThreads() {
  const [threads, setThreads] = useState<CooThread[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('api/coo/threads', { headers: authHeaders() });
      if (!res.ok) throw new Error(`threads list ${res.status}`);
      setThreads(await res.json() as CooThread[]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(async (name: string, workspace_dir: string): Promise<CooThread> => {
    const res = await fetch('api/coo/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name, workspace_dir }),
    });
    if (!res.ok) throw new Error(`create thread ${res.status}`);
    const t = await res.json() as CooThread;
    setThreads((prev) => [t, ...prev]);
    return t;
  }, []);

  const rename = useCallback(async (id: string, name: string): Promise<void> => {
    const res = await fetch(`api/coo/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`rename thread ${res.status}`);
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { threads, isLoading, error, refresh, create, rename };
}

export async function fetchWorkspaces(): Promise<CooWorkspace[]> {
  const res = await fetch('api/coo/workspaces', { headers: authHeaders() });
  if (!res.ok) throw new Error(`workspaces ${res.status}`);
  return await res.json() as CooWorkspace[];
}
```

- [ ] **Step 9.2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: clean.

- [ ] **Step 9.3: Commit**

```bash
git add apps/web/src/components/coo/useCooThreads.ts
git commit -m "feat(web): useCooThreads hook"
```

---

## Task 10 — Frontend: useThreadMessages hook

**Files:**
- Create: `apps/web/src/components/coo/useThreadMessages.ts`

- [ ] **Step 10.1: Write the hook**

Create `apps/web/src/components/coo/useThreadMessages.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';

export interface CooMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useThreadMessages(threadId: string | null) {
  const [messages, setMessages] = useState<CooMessage[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`api/coo/threads/${id}/messages`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`messages ${res.status}`);
      setMessages(await res.json() as CooMessage[]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    void load(threadId);
  }, [threadId, load]);

  const append = useCallback((m: CooMessage) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const updateLast = useCallback((mut: (m: CooMessage) => CooMessage) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      next[next.length - 1] = mut(next[next.length - 1]);
      return next;
    });
  }, []);

  return { messages, isLoading, error, append, updateLast, reload: () => threadId && load(threadId) };
}
```

- [ ] **Step 10.2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: clean.

- [ ] **Step 10.3: Commit**

```bash
git add apps/web/src/components/coo/useThreadMessages.ts
git commit -m "feat(web): useThreadMessages hook"
```

---

## Task 11 — Frontend: ThreadList component

**Files:**
- Create: `apps/web/src/components/coo/ThreadList.tsx`

- [ ] **Step 11.1: Write the component**

Create `apps/web/src/components/coo/ThreadList.tsx`:

```tsx
import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import type { CooThread } from './useCooThreads.js';

interface Props {
  threads: CooThread[];
  activeId: string | null;
  isLoading: boolean;
  onPick: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onNew: () => void;
}

export function ThreadList({ threads, activeId, isLoading, onPick, onRename, onNew }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  return (
    <aside className="rounded-xl bg-surface-1/70 border border-border backdrop-blur-md p-2 flex flex-col gap-1 overflow-y-auto">
      <div className="flex items-center justify-between px-2 pt-1 pb-2">
        <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-info">Threads</div>
        <button
          type="button"
          onClick={onNew}
          className="vs-mono text-[10px] tracking-[0.18em] text-text-muted hover:text-text-primary flex items-center gap-1"
          title="New thread"
        >
          <Plus className="w-3 h-3" /> NEW
        </button>
      </div>
      {isLoading && threads.length === 0 && (
        <div className="vs-mono text-[10px] text-text-muted px-2">loading…</div>
      )}
      {!isLoading && threads.length === 0 && (
        <div className="vs-mono text-[10px] text-text-muted px-2 leading-relaxed">
          No threads yet. Click NEW to start.
        </div>
      )}
      {threads.map((t) => {
        const on = activeId === t.id;
        const isEditing = editingId === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => !isEditing && onPick(t.id)}
            onDoubleClick={() => { setEditingId(t.id); setDraftName(t.name); }}
            className={`text-left rounded-md px-2.5 py-2 transition-colors border-l-2 ${
              on ? 'border-l-info bg-surface-2/60 text-info' : 'border-l-transparent hover:bg-surface-2/40 text-text-primary'
            }`}
          >
            {isEditing ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={async () => {
                  if (draftName.trim() && draftName.trim() !== t.name) {
                    await onRename(t.id, draftName.trim());
                  }
                  setEditingId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
                  if (e.key === 'Escape') { setEditingId(null); }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-[12.5px] text-text-primary focus:outline-none focus:border-accent"
              />
            ) : (
              <>
                <div className={`text-[12.5px] ${on ? 'font-semibold' : 'font-medium'} truncate`}>{t.name}</div>
                <div className="vs-mono text-[10px] text-text-muted mt-0.5 truncate">
                  {t.workspace_dir.split('/').slice(-2).join('/')}
                </div>
                {t.last_message_preview && (
                  <div className="text-[10.5px] text-text-muted mt-1 truncate">{t.last_message_preview}</div>
                )}
              </>
            )}
          </button>
        );
      })}
    </aside>
  );
}
```

- [ ] **Step 11.2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: clean.

- [ ] **Step 11.3: Commit**

```bash
git add apps/web/src/components/coo/ThreadList.tsx
git commit -m "feat(web): COO ThreadList component"
```

---

## Task 12 — Frontend: NewThreadModal component

**Files:**
- Create: `apps/web/src/components/coo/NewThreadModal.tsx`

- [ ] **Step 12.1: Write the component**

Create `apps/web/src/components/coo/NewThreadModal.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { fetchWorkspaces, type CooWorkspace } from './useCooThreads.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, workspace_dir: string) => Promise<void>;
}

export function NewThreadModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [workspaces, setWorkspaces] = useState<CooWorkspace[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName('');
    fetchWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        const def = ws.find((w) => w.kind === 'boss-dev') ?? ws[0];
        setWorkspaceDir(def?.path ?? '');
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim() || !workspaceDir) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(name.trim(), workspaceDir);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[420px] rounded-xl border border-border p-5 flex flex-col gap-4"
        style={{ background: 'linear-gradient(180deg, rgba(26,31,48,0.95), rgba(14,18,30,0.98))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="vs-mono text-[10px] tracking-[0.22em] text-info">New COO thread</div>
            <div className="text-[11px] text-text-muted mt-1">Pick a workspace; CC spawns there.</div>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="vs-mono text-[10px] tracking-[0.18em] text-text-muted">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="e.g. Demo prep"
            className="px-3 py-2 rounded-md bg-surface-2/60 border border-border text-text-primary text-[12.5px] focus:outline-none focus:border-accent/60"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="vs-mono text-[10px] tracking-[0.18em] text-text-muted">Workspace</label>
          <select
            value={workspaceDir}
            onChange={(e) => setWorkspaceDir(e.target.value)}
            className="px-3 py-2 rounded-md bg-surface-2/60 border border-border text-text-primary text-[12.5px] focus:outline-none focus:border-accent/60"
          >
            {workspaces.map((w) => (
              <option key={w.path} value={w.path}>
                [{w.kind}] {w.label} — {w.path}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="text-[11px] text-warning">{error}</div>}
        <div className="flex justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-[12px] text-text-muted hover:text-text-primary border border-border"
          >Cancel</button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!name.trim() || !workspaceDir || submitting}
            className="px-3.5 py-1.5 rounded-md text-[12px] font-semibold text-[#0a0c12] disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)' }}
          >{submitting ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 12.2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: clean.

- [ ] **Step 12.3: Commit**

```bash
git add apps/web/src/components/coo/NewThreadModal.tsx
git commit -m "feat(web): COO NewThreadModal component"
```

---

## Task 13 — Frontend: ChatPane component

**Files:**
- Create: `apps/web/src/components/coo/ChatPane.tsx`

- [ ] **Step 13.1: Write the component**

Create `apps/web/src/components/coo/ChatPane.tsx`:

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Send } from 'lucide-react';
import type { CooThread } from './useCooThreads.js';
import { useThreadMessages, type CooMessage } from './useThreadMessages.js';

interface Props { thread: CooThread | null; }

function authToken(): string {
  return localStorage.getItem('boss_token') ?? '';
}

export function ChatPane({ thread }: Props) {
  const { messages, append, updateLast, reload } = useThreadMessages(thread?.id ?? null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !thread) return;
    setSending(true);
    setInput('');
    setBusy(true);

    const nowIso = new Date().toISOString();
    append({ id: `local-user-${Date.now()}`, role: 'user', content: text, tokens_in: null, tokens_out: null, created_at: nowIso });
    append({ id: `local-asst-${Date.now()}`, role: 'assistant', content: '', tokens_in: null, tokens_out: null, created_at: nowIso });

    try {
      const res = await fetch(`api/coo/threads/${thread.id}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
        },
        body: JSON.stringify({ message: text }),
      });
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done = false;
      let aggregate = '';
      while (!done) {
        const r = await reader.read();
        done = r.done;
        if (r.value) {
          buf += decoder.decode(r.value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const event = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const lines = event.split('\n');
            let evType = '';
            let dataStr = '';
            for (const ln of lines) {
              if (ln.startsWith('event:')) evType = ln.slice(6).trim();
              else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
            }
            if (evType === 'frame' && dataStr) {
              try {
                const frame = JSON.parse(dataStr) as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
                if (frame.type === 'assistant') {
                  for (const block of frame.message?.content ?? []) {
                    if (block.type === 'text' && block.text) aggregate += block.text;
                  }
                  updateLast((m) => ({ ...m, content: aggregate }));
                }
              } catch { /* skip malformed */ }
            } else if (evType === 'done') {
              setBusy(false);
            } else if (evType === 'error' && dataStr) {
              updateLast((m) => ({ ...m, content: `${m.content}\n\n[error] ${dataStr}` }));
              setBusy(false);
            }
          }
        }
      }
      // Refresh from DB so we replace optimistic IDs with persisted ones
      reload();
    } catch (e) {
      updateLast((m) => ({ ...m, content: `${m.content}\n\n[network error] ${String(e)}` }));
    } finally {
      setSending(false);
      setBusy(false);
    }
  }, [input, sending, thread, append, updateLast, reload]);

  if (!thread) {
    return (
      <section className="rounded-xl border border-border flex items-center justify-center text-text-muted text-[12.5px]">
        Pick or create a thread to start.
      </section>
    );
  }

  return (
    <section
      className="rounded-xl border border-border overflow-hidden flex flex-col min-h-0"
      style={{ background: 'linear-gradient(180deg, rgba(26,31,48,0.5), rgba(14,18,30,0.75))', backdropFilter: 'blur(18px)' }}
    >
      <header className="px-4 py-2.5 border-b border-border flex items-center gap-3">
        <div
          className="w-7 h-7 rounded-full grid place-items-center"
          style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)', boxShadow: '0 0 14px rgba(181,108,255,0.4)' }}
          aria-hidden
        >
          <span className="block w-2.5 h-2.5 rotate-45 bg-[#0a0c12] rounded-[1px]" />
        </div>
        <div>
          <div className="text-[13px] font-semibold text-text-primary leading-none">{thread.name}</div>
          <div className="vs-mono text-[9.5px] mt-1 leading-none tracking-[0.14em] text-text-muted">
            {thread.workspace_dir}
          </div>
        </div>
        <div className="ml-auto vs-mono text-[10px] text-text-muted tracking-wider">claude · cli · bypass</div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2.5">
        {messages.map((m: CooMessage) => (
          <div key={m.id} className={`flex gap-2.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role !== 'user' && (
              <div
                className="w-6 h-6 rounded-md grid place-items-center flex-shrink-0 mt-0.5"
                style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)' }}
                aria-hidden
              >
                <span className="block w-2 h-2 rotate-45 bg-[#0a0c12]" />
              </div>
            )}
            <div className="max-w-[78%]">
              <div
                className={`px-3 py-2 rounded-lg text-[12.5px] leading-relaxed border ${
                  m.role === 'user' ? 'text-white border-accent/40' : 'text-text-primary border-border'
                }`}
                style={
                  m.role === 'user'
                    ? { background: 'linear-gradient(135deg, rgba(181,108,255,0.25), rgba(92,200,255,0.18))', boxShadow: '0 0 14px rgba(181,108,255,0.15)' }
                    : { background: 'rgba(255,255,255,0.03)' }
                }
              >
                <div className="whitespace-pre-wrap break-words">{m.content || (busy && m === messages[messages.length - 1] ? '…' : '')}</div>
              </div>
            </div>
          </div>
        ))}
        {busy && (
          <div className="vs-chip purple self-start">
            <span className="dot" style={{ background: '#b56cff', animation: 'vs-pulse 1s infinite' }} />
            thinking…
          </div>
        )}
      </div>

      <footer className="px-3 py-3 border-t border-border flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Talk to IR Custom AIOS · bypass mode is on"
          className="flex-1 px-3 py-2 rounded-md bg-surface-2/60 border border-border text-text-primary text-[12.5px] placeholder:text-text-muted focus:outline-none focus:border-accent/60"
          disabled={sending}
        />
        <button
          type="button"
          className="p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 border border-border transition-colors"
          aria-label="Voice memo"
          title="Voice memo (coming soon)"
          disabled
        >
          <Mic className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!input.trim() || sending}
          className="px-3.5 py-2 rounded-md text-[12px] font-semibold text-[#0a0c12] disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, #b56cff 0%, #5cc8ff 100%)', boxShadow: '0 0 14px rgba(92,200,255,0.3)' }}
        >
          <Send className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Send
        </button>
      </footer>
    </section>
  );
}
```

- [ ] **Step 13.2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: clean.

- [ ] **Step 13.3: Commit**

```bash
git add apps/web/src/components/coo/ChatPane.tsx
git commit -m "feat(web): COO ChatPane (SSE consumer + bypass label)"
```

---

## Task 14 — Frontend: COO.tsx rewrite

**Files:**
- Modify: `apps/web/src/pages/COO.tsx` (full rewrite)

- [ ] **Step 14.1: Rewrite COO.tsx**

Replace the entire contents of `apps/web/src/pages/COO.tsx` with:

```tsx
/**
 * COO — IR Custom AIOS's own surface.
 *
 * "COO" in the v2 design IS IR Custom AIOS (this operator), not a Rascal. This
 * page is IR Custom AIOS's private channel with the user. Each thread is a
 * resumable Claude Code session running with bypass-mode tool access
 * inside a per-thread workspace.
 *
 * Two-column layout: thread list (left) + chat pane (right). The Twilio
 * panel that lived here in v1.7.6 was dropped; Twilio wiring is queued
 * for a follow-up v1.7.x ship.
 */
import React, { useState } from 'react';
import { ThreadList } from '../components/coo/ThreadList.js';
import { NewThreadModal } from '../components/coo/NewThreadModal.js';
import { ChatPane } from '../components/coo/ChatPane.js';
import { useCooThreads } from '../components/coo/useCooThreads.js';

export default function COO() {
  const { threads, isLoading, create, rename } = useCooThreads();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const active = threads.find((t) => t.id === activeId) ?? null;

  return (
    <div className="flex-1 p-5 lg:p-6 flex flex-col min-h-0">
      <header className="flex items-end gap-4 mb-5">
        <div>
          <div className="vs-mono text-[10px] text-text-muted tracking-[0.28em]">SURFACE / COO</div>
          <h1 className="text-2xl font-semibold text-text-primary mt-1 leading-tight">
            IR Custom AIOS <span className="text-info">· your Chief Operating Officer</span>
          </h1>
          <p className="text-[12.5px] text-text-secondary mt-1">
            Private channel. Each thread is a resumable Claude Code session. Bypass mode on.
          </p>
        </div>
      </header>
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 min-h-0">
        <ThreadList
          threads={threads}
          activeId={activeId}
          isLoading={isLoading}
          onPick={setActiveId}
          onRename={rename}
          onNew={() => setModalOpen(true)}
        />
        <ChatPane thread={active} />
      </div>
      <NewThreadModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={async (name, workspace_dir) => {
          const t = await create(name, workspace_dir);
          setActiveId(t.id);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 14.2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: clean.

- [ ] **Step 14.3: Build to confirm bundling works**

Run: `cd apps/web && npm run build`
Expected: build succeeds; emits `dist/` artifacts. No new warnings introduced.

- [ ] **Step 14.4: Commit**

```bash
git add apps/web/src/pages/COO.tsx
git commit -m "feat(web): COO surface rewrite (two-column, multi-thread)"
```

---

## Task 15 — Manual smoke against running stack

**Files:** none (verification only)

> This is an in-cluster manual smoke before shipping. It validates the wired-together happy path on Kevin's actual stack, against real Postgres + real Claude Code.

- [ ] **Step 15.1: Apply the migration to the live DB**

```bash
docker exec -i boss_postgres psql -U boss -d boss_db < services/postgres/migrations/026_coo_chat_sessions.sql
```
Expected: ALTER TABLE / CREATE INDEX commands return without error.

- [ ] **Step 15.2: Build and load fresh api image**

The dev path is to rebuild the api container from the working tree. From repo root:

```bash
docker compose -f docker-compose.yml build boss_api
docker compose -f docker-compose.yml up -d boss_api
docker logs --tail 50 boss_api
```
Expected: container is healthy; logs show route registration without errors. If any other service depends on boss_api, restart that too — but in practice the api is independent.

- [ ] **Step 15.3: Probe the read endpoints**

```bash
# Workspaces
docker exec boss_api wget -qO- --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
  http://127.0.0.1:8001/api/coo/workspaces
# Threads (empty list expected on first run)
docker exec boss_api wget -qO- --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
  http://127.0.0.1:8001/api/coo/threads
```
Expected: workspaces returns boss-dev + the rascal/outsider list; threads returns `[]`.

- [ ] **Step 15.4: Create a thread + send one message**

```bash
THREAD_ID=$(docker exec boss_api wget -qO- \
  --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
  --header='Content-Type: application/json' \
  --post-data='{"name":"manual-smoke","workspace_dir":"/home/tcntryprd/boss-dev"}' \
  http://127.0.0.1:8001/api/coo/threads | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "thread: $THREAD_ID"

docker exec boss_api timeout 60 wget -qO- \
  --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
  --header='Content-Type: application/json' \
  --post-data='{"message":"Reply with the single word OK and nothing else."}' \
  "http://127.0.0.1:8001/api/coo/threads/$THREAD_ID/chat" 2>&1 | tail -c 800
```
Expected: SSE stream output ending in `event: done` line. The streamed `event: frame` payloads should include an assistant-type frame whose text contains `OK`.

- [ ] **Step 15.5: Confirm DB state**

```bash
docker exec boss_postgres psql -U boss -d boss_db -c \
  "SELECT id, name, agent_kind, workspace_dir, cc_session_id IS NOT NULL AS has_session
     FROM boss_chat_sessions WHERE name='manual-smoke';"
docker exec boss_postgres psql -U boss -d boss_db -c \
  "SELECT role, length(content) AS len FROM boss_chat_messages
     WHERE session_id=(SELECT id FROM boss_chat_sessions WHERE name='manual-smoke')
     ORDER BY created_at;"
```
Expected: thread row has `agent_kind='coo'`, `has_session=t`. Two messages: user + assistant; both with non-zero length.

- [ ] **Step 15.6: Browser smoke**

Open `https://<your-boss-host>/coo` in a browser. Confirm:
- Threads list shows `manual-smoke`.
- Click NEW → modal opens, workspace dropdown is populated.
- Click on `manual-smoke` → chat history renders.
- Type a message → SSE-streamed reply renders progressively, ends with the diamond avatar block.
- Reload the page → thread state survives, history reloads.

- [ ] **Step 15.7: Cleanup**

```bash
docker exec boss_postgres psql -U boss -d boss_db -c \
  "DELETE FROM boss_chat_sessions WHERE name='manual-smoke';"
```

No commit — verification only.

---

## Task 16 — Deploy-smoke #32

**Files:**
- Modify: `scripts/deploy.sh`

- [ ] **Step 16.1: Find the smoke block**

Run:
```bash
grep -n 'smoke #31\|smoke 31' scripts/deploy.sh | head -3
```
Expected: a line marker for the v1.7.6 OpenClaw bind-mount smoke. Insert the new smoke immediately AFTER that block but BEFORE any rollback/finalize logic at the end of the deploy script.

- [ ] **Step 16.2: Add the smoke**

Append the following block to the smoke section (right after smoke #31, replace any placeholder die/log helpers with the existing ones used by other smokes — they are available in scope; check the surrounding smokes for the exact helper name):

```bash
# Smoke #32: COO chat end-to-end (v1.7.7)
echo "==> [smoke #32] COO chat end-to-end"
SMOKE_NAME="deploy-smoke-$$"
THREAD_ID=$(docker exec boss_api wget -qO- \
  --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
  --header='Content-Type: application/json' \
  --post-data="{\"name\":\"$SMOKE_NAME\",\"workspace_dir\":\"/home/tcntryprd/boss-dev\"}" \
  http://127.0.0.1:8001/api/coo/threads 2>/dev/null \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$THREAD_ID" ] || die "smoke #32: thread create failed"

# Send one short message; expect 'event: done' in the SSE stream within 60s
SSE_OUT=$(docker exec boss_api timeout 60 wget -qO- \
  --header='X-BOSS-Internal: true' --header='X-Tenant-ID: default' \
  --header='Content-Type: application/json' \
  --post-data='{"message":"Reply with the single word OK and nothing else."}' \
  "http://127.0.0.1:8001/api/coo/threads/$THREAD_ID/chat" 2>&1)
echo "$SSE_OUT" | grep -q 'event: done' \
  || die "smoke #32: no 'event: done' in SSE stream within 60s"

# Confirm cc_session_id was minted
HAS_SID=$(docker exec boss_postgres psql -U boss -d boss_db -tAc \
  "SELECT cc_session_id FROM boss_chat_sessions WHERE id='$THREAD_ID';" 2>/dev/null)
[ -n "$HAS_SID" ] || die "smoke #32: cc_session_id not minted"

# Cleanup
docker exec boss_postgres psql -U boss -d boss_db -c \
  "DELETE FROM boss_chat_sessions WHERE id='$THREAD_ID';" >/dev/null 2>&1 || true
echo "==> [smoke #32] OK"
```

> If the existing scripts use a different fail-helper than `die`, copy that name from the smoke #31 block above — don't invent a new one.

- [ ] **Step 16.3: Test the smoke locally (without a full deploy)**

Run the smoke commands manually first to confirm they pass against the current container state:

```bash
bash -c "$(sed -n '/Smoke #32: COO chat/,/echo \"==> \[smoke #32\] OK\"/p' scripts/deploy.sh)"
```
Expected: prints `==> [smoke #32] OK`. If `die` is unbound here, you'll get a function-not-found error — that's fine for the local smoke; just confirm the body works and let `deploy.sh` provide `die` in context.

Alternative: copy the body into a scratch script with `die() { echo "FAIL: $*"; exit 1; }` at the top, then run.

- [ ] **Step 16.4: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(deploy): smoke #32 — COO chat end-to-end"
```

---

## Task 17 — Final verification, branch, ship

**Files:** none (process)

- [ ] **Step 17.1: Full test sweep**

Run:
```bash
cd /home/tcntryprd/boss-dev/apps/api && npm test
cd /home/tcntryprd/boss-dev/apps/web && npm run typecheck && npm run build
```
Expected: all tests pass; web typecheck and build clean.

- [ ] **Step 17.2: Working tree check**

Run: `git status -sb`
Expected: only commits on `feat/v1.7.7-coo-surface` branch (or whatever branch this work is on); no stray untracked files outside of the auto-backup noise patterns.

- [ ] **Step 17.3: Push and open PR**

Run:
```bash
git push -u origin feat/v1.7.7-coo-surface
gh pr create --title "feat: COO surface — multi-thread CC chat with bypass (v1.7.7)" \
  --body "$(cat <<'EOF'
## Summary
- Replaces broken tmux-based `cli-brain.ts` with a CC-subprocess-per-turn chat for `/coo`.
- Multi-thread (each thread = a resumable CC session, per-thread workspace).
- Bypass mode (`--dangerously-skip-permissions`) on COO spawns only — explicit Kevin authorization.
- Persona file at `docs/COO.md` snapshotted into thread.system_prompt at create-time.
- Twilio panel dropped (deferred); voice mic stays `coming soon`; archive/delete deferred to v1.7.8.

## Test plan
- [ ] Migration 026 applies cleanly to `boss` DB
- [ ] `npm test` in apps/api green (workspaces + threads + messages + rascal-chat unit)
- [ ] `npm run typecheck && npm run build` in apps/web green
- [ ] Manual smoke in browser at `/coo`: create thread, send message, reload, history persists
- [ ] CI deploy-smoke #32 passes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 17.4: After CI green, merge + tag**

```bash
gh pr merge <N> --squash --delete-branch
git checkout master && git pull --ff-only
git tag -a v1.7.7 -m "COO surface — multi-thread CC chat with bypass"
git push origin v1.7.7
gh run watch <ID> --exit-status --interval 25
docker ps --filter 'name=boss_' --format 'table {{.Names}}\t{{.Image}}'
```
Expected: 4 app containers on `:1.7.7`, all healthy. `/coo` works in the browser.

- [ ] **Step 17.5: Update standing rules + memory**

After ship, save a memory: `project_boss_v177_shipped.md` with:
- v1.7.7 ship summary (16 files, ~1100 LOC, deploy-smoke #32 added)
- Bypass-mode standing rule addition (COO only, explicit authorization 2026-04-27)
- `cli-brain.ts` removed
- Pointer to spec + plan for traceability

Update `MEMORY.md` index entry. The next handoff (v1.7.8) starts with the deferred OpenClaw frontend.

---

## Out of scope reminders (do NOT do as part of v1.7.7)

- Twilio panel wiring
- Voice mic STT/TTS wire-up
- Thread archive / delete
- Curated IR Custom AIOS-defined tool catalog (B-shape from brainstorm Q1)
- Refactor of `apps/api/src/routes/brain.ts` BrainRouter
- ChatGPT-style auto-fork threads (C-shape — future v1.8+)

If the implementer notices a clean addition that fits any of the above, defer it: append a one-line note to the v1.7.7 → v1.7.8 handoff and move on.
