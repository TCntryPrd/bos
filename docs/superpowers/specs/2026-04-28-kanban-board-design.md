# Kanban Board — Design Spec

**Date:** 2026-04-28
**Target ships:** v1.7.11 → v1.7.14 (staged, 4 ships)
**Author:** brainstorm session, Kevin Starr + Claude
**Surfaces:** new `/kanban` global page + Kanban tab inside `/coo`, `/oc`, `/rascals/<handle>`, `/outsiders/<handle>`
**Audience:** Kevin only (single-user box; auth via existing global Bearer/JWT)
**Predecessor plan:** `sp-hub/plans/plan-kanban-board.md` (Apr 23) — superseded for column scheme + per-agent scope; pipeline-engine prereq honored

## Why this exists

A new paying client signed and paid deposit (2026-04-28). Kevin needs a working task-visualization surface that covers the entire fleet — every rascal, every outsider, COE (Gio/OpenClaw), COO (IR Custom AIOS itself), AND a global aggregate — so he can see where every piece of work sits and drive it forward.

Most of the groundwork already exists:
- `boss_tasks` table is shape-correct: `view_column` enum (5-column personal-productivity scheme), `current_stage` text (free-form for the 9-stage project lifecycle), `assigned_agent`, `assigned_client`, `priority`, `due_at`, `pipeline_id`, `stage_history jsonb`, `context jsonb`. 6 seed rows already loaded.
- `NavRail.tsx` line 143 has a `<NavTab disabled comingSoon icon={Columns3} label="Kanban" />` slot — wired, just disabled.
- `apps/api/src/routes/pipeline.ts` already does CRUD on `boss_tasks` (will not be touched by this spec — Kanban gets its own route).
- Brain tool `boss_tasks_create` is in the registry (`apps/api/src/tools/trust.ts`, `voice-agents.ts`); COO and rascals can already create tasks via tool-use.

What's missing: the Kanban UI, the `/api/kanban` route family, mount points in the 4 existing workspace surfaces, and 3 new brain tools (move/advance/block). This spec is what gets built.

## Architecture decisions (locked)

1. **One reusable component, scope passed as prop.** `<KanbanBoard scope={...} />` is the single implementation. Mounted in 5 places: `/kanban` (global), tabs inside `/coo`, `/oc`, `/rascals/<handle>`, `/outsiders/<handle>`. No per-surface duplication.

2. **Two views, both available everywhere, orthogonal to scope.**
   - **View 1 — My Client** (default): 5 columns from existing `view_column` enum: `Inbox / Today / In Progress / To Close / Done`.
   - **View 2 — Project Status**: 9 columns stored in `current_stage` (existing free-text field): `Initiated → Assessment → Value & Process Mapping → KFR & Roadmap forward → L1 Implementation → L2 Implementation → Delivered → Support → Closed`.
   - Both views write to **different columns on the same row** — same task can appear in different positions depending on view, no data duplication.
   - View persists per-scope in `localStorage[kanban_view_<scope>]`.

3. **No schema migration for the column scheme.** `view_column` is already enum-constrained for the 5 client columns. `current_stage` is free-text — the 9 project stages are validated at API boundary via constants in `apps/api/src/constants/kanban.ts`. Frontend imports the same constants.

4. **One small migration: `archived_at TIMESTAMPTZ` on `boss_tasks`** plus a partial index. Enables soft-archive without losing data; default boards filter `archived_at IS NULL`. Migration also normalizes any existing seed-row `current_stage` values that don't match the 9-stage set to `'Initiated'` (safe default).

5. **Single SSE stream, client-side scope filtering.** `GET /api/kanban/stream` emits one `task.changed` event per mutation. Each connected client decides whether the change is in-scope and updates its own state. Same pattern as `/api/coo/stream` (proven in v1.7.7). Visibility-aware via the `visibilityPolling.ts` helper from v1.7.10.1 (standing rule: pause background polling when tab hidden).

6. **Server-side column grouping.** `GET /api/kanban/board` returns columns pre-grouped by view; frontend doesn't reduce. Within each column, tasks ordered by `priority DESC, due_at ASC NULLS LAST, updated_at DESC`.

7. **No vertical reordering inside columns (v1).** Server controls intra-column order via priority/due/updated. Drag is column→column only. Vertical drag = no-op snap-back.

8. **Optimistic drag-drop.** Card moves visually on drop; server rejection (rare) reverts + shows toast. Same pattern as v1.7.10.1 set-model UX.

9. **Three new brain tools** wrapping the same routes: `boss_tasks_move`, `boss_tasks_advance` (project-view next-stage), `boss_tasks_block` (sets `status='blocked'` so it surfaces with 🔒 for Kevin). Existing `boss_tasks_create` stays untouched.

10. **Tenant isolation via existing middleware.** Every query scoped by `WHERE tenant_id = $1` from JWT. Standing rule #32 (rascal `tenant_id` MUST be Kevin's actual UUID, not `'default'`) honored automatically — Kanban only reads/writes; doesn't seed.

## Non-goals (v1.7.11–v1.7.14)

- **Client-number color tier system** (the original plan's 01–10 mapping → purple/blue/green/orange tones). Day-1 uses agent-handle hash tint on card border-left. Color-tier system deferred to a later polish ship.
- **Vertical reordering inside columns.** Server-side ordering only.
- **Mobile responsiveness pass beyond "renders without breaking."** Kevin's primary surface is laptop; phone is acceptable but not optimized.
- **Per-pipeline-template view** (the original plan's "Pipeline View"). The 9 project stages cover this in spirit; per-pipeline filtering deferred.
- **Auto-archive Done after 7 days.** The original plan called for this; v1 is manual-archive-only via per-card action.
- **Cross-column aggregations / stats header.** Column headers show their own count; cross-column totals deferred.
- **Hard-deleting tasks outside the Done column.** Hard-delete only allowed when card is in `done` column; everywhere else it's archive.
- **Twilio / mic / voice integration.** Out of scope.

## Components

### Frontend (new files)

```
apps/web/src/components/kanban/
  kanban.types.ts        — KanbanScope, KanbanView, KanbanTask, column constants
  KanbanBoard.tsx        — top-level: data fetch, view toggle, scope-aware filter, dnd context, SSE
  KanbanColumn.tsx       — single column, dnd-kit drop zone, header w/ count
  KanbanCard.tsx         — single task card, dnd-kit draggable
  ViewToggle.tsx         — Client / Project segmented control, persists to localStorage
  NewTaskDialog.tsx      — modal: title, agent, client, view_column, current_stage, priority, due_at
  TaskDetailPanel.tsx    — slide-in side panel: full task incl. stage_history, context, actions
apps/web/src/pages/
  Kanban.tsx             — global page; renders <KanbanBoard scope={{kind:'global'}}/>
```

### Frontend (mount-point edits)

```
apps/web/src/components/shell/NavRail.tsx     — remove `disabled comingSoon` from Kanban NavTab
apps/web/src/App.tsx                          — register /kanban route
apps/web/src/pages/COO.tsx                    — add Kanban tab → <KanbanBoard scope={{kind:'coo'}}/>
apps/web/src/pages/OC.tsx                     — add Kanban tab → <KanbanBoard scope={{kind:'coe'}}/>
apps/web/src/pages/RascalWorkspace.tsx        — add Kanban tab → <KanbanBoard scope={{kind:'rascal',handle}}/>
apps/web/src/pages/Outsiders.tsx              — add Kanban tab → <KanbanBoard scope={{kind:'outsider',handle}}/>
```

### Backend (new files)

```
apps/api/src/routes/kanban.ts             — 7 endpoints (board/tasks/move/approve/archive/stream + create)
apps/api/src/lib/emitTaskChanged.ts       — SSE fan-out helper, called from every kanban + brain-tool mutation
apps/api/src/constants/kanban.ts          — PROJECT_STAGES (9), CLIENT_COLUMNS (5)
apps/api/src/routes/kanban.test.ts        — endpoint tests, tenant isolation, stage_history append
db/migrations/027_kanban.sql              — archived_at + index + seed normalization
```

### Backend (existing files touched)

```
apps/api/src/server.ts                    — register kanban route
apps/api/src/tools/registry.ts            — add 3 new tools
apps/api/src/tools/trust.ts               — declare trust levels for the 3 new tools
```

### Scope shape (the prop)

```ts
type KanbanScope =
  | { kind: 'global' }
  | { kind: 'rascal';   handle: string }
  | { kind: 'outsider'; handle: string }
  | { kind: 'coo' }
  | { kind: 'coe' };

type KanbanView = 'client' | 'project';
```

Server maps scope → SQL `WHERE`:

| Scope | Filter |
|---|---|
| `{kind:'global'}` | `tenant_id = $1` only |
| `{kind:'rascal', handle:'darla'}` | `tenant_id=$1 AND assigned_agent='darla'` |
| `{kind:'outsider', handle:'ponyboy'}` | `tenant_id=$1 AND assigned_agent='ponyboy'` |
| `{kind:'coo'}` | `tenant_id=$1 AND assigned_agent='coo'` |
| `{kind:'coe'}` | `tenant_id=$1 AND assigned_agent='coe'` |

**NULL `assigned_agent` semantics:** Unassigned tasks (`assigned_agent IS NULL`) appear ONLY on the global board. They do not appear on COO, COE, rascal, or outsider boards. To put a task on a specific board, it must be assigned. The `NewTaskDialog` pre-fills `assigned_agent` based on current scope so this is automatic for tasks created from a non-global board.

**Reassign picker scope:** offers all enabled rascals + enabled outsiders + literal `'coo'` + literal `'coe'` + `'unassigned'` (sets `assigned_agent` to NULL).

## Data flow

### Endpoint catalog

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/kanban/board` | List tasks for a scope, grouped into columns |
| `POST` | `/api/kanban/tasks` | Create a task |
| `PATCH` | `/api/kanban/tasks/:id` | Partial update (title, priority, due_at, assigned_agent, etc.) |
| `POST` | `/api/kanban/tasks/:id/move` | Drag-drop: change `view_column` (client view) or `current_stage` + append `stage_history` (project view) |
| `POST` | `/api/kanban/tasks/:id/approve` | Unblock: `status='blocked'` → `status='active'` |
| `POST` | `/api/kanban/tasks/:id/archive` | Soft-archive: set `archived_at = now()` |
| `DELETE` | `/api/kanban/tasks/:id` | Hard-delete (only if card is in `done` column; 403 otherwise) |
| `GET` | `/api/kanban/stream` | SSE — push `task.changed` events |

### `GET /api/kanban/board` query shape

```
?scope=global
?scope=rascal&handle=darla
?scope=outsider&handle=ponyboy
?scope=coo
?scope=coe
&view=client          (default; groups by view_column)
&view=project         (groups by current_stage)
&include_archived=0   (default; 1 to include archived)
```

Response:

```jsonc
{
  "view": "client",
  "scope": { "kind": "rascal", "handle": "darla" },
  "columns": [
    { "key": "inbox",       "label": "Inbox",       "count": 3, "tasks": [...] },
    { "key": "today",       "label": "Today",       "count": 1, "tasks": [...] },
    { "key": "in_progress", "label": "In Progress", "count": 2, "tasks": [...] },
    { "key": "to_close",    "label": "To Close",    "count": 0, "tasks": [] },
    { "key": "done",        "label": "Done",        "count": 5, "tasks": [...] }
  ]
}
```

### Move semantics — `POST /api/kanban/tasks/:id/move`

```jsonc
// client-view body (5-column scheme)
{ "view": "client",  "to": "today" }
// → UPDATE boss_tasks SET view_column='today' WHERE id=$1 AND tenant_id=$2

// project-view body (9-stage scheme)
{ "view": "project", "to": "Assessment" }
// → UPDATE boss_tasks
//      SET current_stage='Assessment',
//          stage_history = stage_history || jsonb_build_object(
//            'from', current_stage, 'to', 'Assessment', 'at', now(), 'by', 'kevin'
//          )
//   WHERE id=$1 AND tenant_id=$2
```

API validates `to` against `CLIENT_COLUMNS` or `PROJECT_STAGES` from `constants/kanban.ts`. Rejects unknown values with 400.

### SSE stream — `GET /api/kanban/stream`

Single endpoint, no scope filter at connection level:

```
event: task.changed
data: { "id": "uuid", "tenantId": "...", "task": { /* full row, may have archived_at set */ } | null }
```

**`task: null` only on hard-delete.** Archive emits the full row with `archived_at` populated; clients filter the row out (or keep it) based on their own `show-archived` toggle. This keeps the SSE payload semantically simple — clients always know "this is the new state of task X" except in the hard-delete case.

Client-side filter by scope. Reconnect: 3s backoff, re-fetch board on reconnect (no event-replay buffer — board re-fetch is cheap). Connection drops when `document.hidden`, reopens on visible (via `visibilityPolling`).

Fired by every successful `POST /tasks`, `PATCH /tasks/:id`, `/move`, `/approve`, `/archive`, `DELETE`, and any of the 3 new brain tools that mutate. Single helper `emitTaskChanged(task | null)`.

### Migration `027_kanban.sql`

```sql
ALTER TABLE boss_tasks ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX idx_boss_tasks_archived
  ON boss_tasks (tenant_id, archived_at)
  WHERE archived_at IS NULL;

-- Normalize any pre-existing current_stage values not in the 9-stage set
UPDATE boss_tasks
   SET current_stage = 'Initiated'
 WHERE current_stage NOT IN (
   'Initiated','Assessment','Value & Process Mapping','KFR & Roadmap forward',
   'L1 Implementation','L2 Implementation','Delivered','Support','Closed'
 );
```

**Concrete impact on existing data (verified 2026-04-28):** 6 seed rows exist. All 6 have `current_stage` in `{review, deliver, transcript_pull}` — none match the 9-stage set, so all 6 normalize to `'Initiated'`. 4 are assigned to `darla`, 2 are unassigned (will appear only on global). View 1 (My Client) places all 6 in `inbox` already (their existing `view_column`).

### Constants — `apps/api/src/constants/kanban.ts`

```ts
export const PROJECT_STAGES = [
  'Initiated',
  'Assessment',
  'Value & Process Mapping',
  'KFR & Roadmap forward',
  'L1 Implementation',
  'L2 Implementation',
  'Delivered',
  'Support',
  'Closed',
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const CLIENT_COLUMNS = [
  'inbox', 'today', 'in_progress', 'to_close', 'done',
] as const;
export type ClientColumn = (typeof CLIENT_COLUMNS)[number];

export const CLIENT_COLUMN_LABELS: Record<ClientColumn, string> = {
  inbox:       'Inbox',
  today:       'Today',
  in_progress: 'In Progress',
  to_close:    'To Close',
  done:        'Done',
};
```

### Brain tools (extend `apps/api/src/tools/registry.ts`)

| Tool | Wraps | Trust |
|---|---|---|
| `boss_tasks_create` (existing) | `POST /api/kanban/tasks` | observer |
| `boss_tasks_move` | `POST /api/kanban/tasks/:id/move` | observer |
| `boss_tasks_advance` | move to next stage in `PROJECT_STAGES` | observer |
| `boss_tasks_block` | `PATCH /api/kanban/tasks/:id { status: 'blocked' }` | observer |

## Interactions

### Drag-and-drop

| Action | Effect | API call |
|---|---|---|
| Drag card column→column (client view) | `view_column` updates | `POST /tasks/:id/move {view:'client', to}` |
| Drag card column→column (project view) | `current_stage` updates + `stage_history` appended | `POST /tasks/:id/move {view:'project', to}` |
| Reorder card within same column | No-op snap-back | none |
| Drop card on disabled column | No-op snap-back | none |

Optimistic update: card moves immediately on drop; server rejection reverts + toast.

### Click + button

| Where | Action |
|---|---|
| Click card body | Opens `<TaskDetailPanel>` (slide-in from right, ~480px) — title, full `context` jsonb, `stage_history`, agent, client, due, priority |
| Click 🔒 on blocked card | `POST /tasks/:id/approve` |
| Detail panel `Reassign` | Inline rascal/outsider picker → `PATCH {assigned_agent}` |
| Detail panel `Archive` | `POST /tasks/:id/archive` |
| Detail panel `Delete` | Hard delete — confirm dialog, only if `view_column='done'` |
| `[+ New Task]` button (top-right) | Opens `<NewTaskDialog>` pre-filled with current scope's agent + first column |
| Card header `⚡ P{n}` | One-click cycle priority 1/3/5/7/9 |

### Filters bar (top of board, all scopes)

- Search box — substring on title (client-side filter on already-fetched tasks)
- Client filter — dropdown of distinct `assigned_client` values present in current data
- Hide done — toggle, filters Done column to last 7 days only
- Show archived — toggle, calls `/board?include_archived=1`

Filters preserved across view-toggle switches.

### Card design (3 lines, fits across all scopes)

```
┌─────────────────────────────────────┐
│ ● Leslie Bodine        ⚡ P3   ⏱ 2h │  client badge · priority · last activity
│ TTC Phase 1 SOW Draft               │  title
│ 🤖 darla     Stage: draft   🔒      │  assigned agent · current_stage · 🔒 if blocked
└─────────────────────────────────────┘
```

Border-left tinted by `assigned_agent` handle hash → existing IR Custom AIOS accent palette (purple/blue/green/orange/pink). `status='blocked'` → red 🔒 badge overrides agent tint visually.

### Empty / loading / error

- Loading: skeleton columns with shimmer cards.
- Empty column: dotted border, muted label `"Drop here"` (so it's an obvious target during drag).
- Empty board: centered message + `[+ New Task]` CTA.
- Fetch error: red banner at top with retry button; columns show stale data if any.

## Phasing — staged across 4 ships

### v1.7.11 — Backend foundation + global page (read-only + create)

**Goal:** `/kanban` page renders, displays existing tasks, can create new ones. No DnD yet.

- Migration `027_kanban.sql` (archived_at + seed normalization)
- `apps/api/src/constants/kanban.ts`
- `apps/api/src/routes/kanban.ts` — all GET/POST/PATCH/DELETE/SSE endpoints
- `apps/api/src/lib/emitTaskChanged.ts`
- `apps/api/src/server.ts` registers route
- `kanban.test.ts` covering each endpoint, tenant isolation, view validation, stage_history append on project moves
- Frontend: `kanban.types.ts`, `KanbanCard.tsx`, `KanbanColumn.tsx`, `ViewToggle.tsx`, `KanbanBoard.tsx` (fetch + render only), `Kanban.tsx` (global page), route registered, NavTab un-disabled
- `NewTaskDialog.tsx` so Kevin can create immediately
- Deploy-smoke #38: `GET /api/kanban/board?scope=global` returns valid shape
- Deploy-smoke #39: project-view move appends to `stage_history`

### v1.7.12 — Interactivity + actions

**Goal:** Full DnD, all card actions, real-time SSE updates.

- `@dnd-kit/core` + `@dnd-kit/sortable` install
- DnD wiring in `KanbanColumn` + `KanbanCard`, optimistic updates
- `TaskDetailPanel.tsx`
- Approve / Reassign / Archive / Delete actions
- Filters bar (search, client, hide-done, show-archived)
- `visibilityPolling`-aware SSE consumer
- Deploy-smoke #40: SSE emits on POST/PATCH/move/archive

### v1.7.13 — Mount everywhere (per-agent + COO + COE)

**Goal:** Kanban tab present in `/coo`, `/oc`, `/rascals/<handle>`, `/outsiders/<handle>`.

- Mount tab in `COO.tsx`, `OC.tsx`, `RascalWorkspace.tsx`, `Outsiders.tsx`
- Same `<KanbanBoard scope={...}/>` everywhere
- Per-tab smoke: render board with non-global scope and verify scope filter is applied (deploy-smoke #41)

### v1.7.14 — Polish + brain tools wired

**Goal:** 3 new brain tools, agent-handle hash tint, all polish items.

- `boss_tasks_move`, `boss_tasks_advance`, `boss_tasks_block` — registered in `tools/registry.ts`, trust in `tools/trust.ts`
- Agent-handle hash tint on card border-left
- Skeleton loading, empty states, error banner refinement
- One-click priority cycle on `⚡ P{n}`
- Manual browser pass: golden path in each of the 5 mount points
- Deploy-smoke #42: brain tool `boss_tasks_move` invocation actually moves a task

## Definition of done (v1.7.14 final)

- All 5 mount points show a working board with both view toggles
- Drag in client view moves `view_column`; drag in project view moves `current_stage` + appends `stage_history`
- Create / approve / reassign / archive / delete all work end-to-end
- SSE pushes board updates to all connected clients
- 5 new deploy-smokes green (#38–#42)
- All 4 ship tags landed, all 4 containers on `:latest`
- Brain tools `boss_tasks_move`, `boss_tasks_advance`, `boss_tasks_block` invocable by COO

## Risk register

1. **Auto-backup cron at `:00`** — proven to interfere mid-ship (v1.7.10.1). Mitigation: tag during a non-`:00` window, or use the cherry-pick-onto-clean-branch dance.
2. **6 existing seed rows' `current_stage`** may not match the 9-stage set. Mitigation: migration `027` normalizes them to `'Initiated'`.
3. **DnD library bundle size** — `@dnd-kit/core` + `sortable` ≈ 30KB gzipped. Acceptable for an admin tool.
4. **SSE reconnect storm** — if `boss_api` restarts during the deploy, all open Kanban clients reconnect ~simultaneously. Existing 3s-backoff jitter pattern handles this; same as `/coo` SSE.
5. **`current_stage` length** — column header for "Value & Process Mapping" is 23 chars, "KFR & Roadmap forward" is 21 chars. Project view will be wider than client view. Layout uses horizontal scroll on the columns container; UI test must verify this on a 1440px display.

## Open questions (none blocking)

- Should `boss_tasks_advance` skip terminal stages (`Delivered`, `Support`, `Closed`)? Probably yes — calling advance on a Closed task should be a no-op or 400. Decide in v1.7.14 implementation.
- Filter UI for the project view (9 columns is wide) — any need for column collapse? Answer: not v1; horizontal scroll only. Revisit if Kevin reports friction.

## References

- Original plan: `sp-hub/plans/plan-kanban-board.md` (Apr 23 — superseded by this spec for column scheme + per-agent scopes)
- Pipeline engine spec: `sp-hub/plans/plan-pipeline-engine.md` (prereq, shipped v1.3.0)
- COO surface spec: `docs/superpowers/specs/2026-04-27-coo-surface-design.md` (mount point)
- Gio dashboard spec: `docs/superpowers/specs/2026-04-27-gio-openclaw-dashboard-design.md` (mount point)
- Memory: `project_boss_v1710_shipped.md`, `project_boss_v178_v179_shipped.md`
