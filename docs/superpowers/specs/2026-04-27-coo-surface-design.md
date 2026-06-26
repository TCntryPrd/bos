# COO Surface — Design Spec

**Date:** 2026-04-27
**Target ship:** v1.7.7
**Author:** brainstorm session, Kevin Starr + Claude
**Surface:** `/coo` page in IR Custom AIOS (replaces current broken/placeholder chat)
**Audience:** Kevin only (single-user box; auth via existing global Bearer/JWT)

## Why this exists

The `/coo` surface currently exists in the codebase (`apps/web/src/pages/COO.tsx`) wired to a tmux-based "brain CLI" backend (`apps/api/src/routes/cli-brain.ts`) that returns 503 — the chat is non-functional. The OpenClaw frontend planned for v1.7.7 is being deferred to v1.7.8 so the COO can land first, because the COO is the surface Kevin actually wants to drive IR Custom AIOS from while the rest of the platform is still being built.

Goal: **a working COO chat where Kevin can talk to IR Custom AIOS and IR Custom AIOS can act** within the active workspace — file edits, bash commands, anything Claude Code can do.

This is the A-shape from the brainstorm (CC's full tool belt as a stepping stone). The B-shape (curated IR Custom AIOS-defined tool catalog) is a future migration; not in this spec.

## Architecture decisions (locked)

1. **Per-turn Claude Code subprocess.** Same pattern as the locked rascal-chat architecture (Architecture A from `project_boss_rascal_chat_architecture` memory). boss_api spawns `claude -p --output-format stream-json --resume <uuid>` per turn from the thread's workspace dir. NOT a long-lived tmux session. The existing tmux-based `cli-brain.ts` is the v1 path and is removed in v1.7.7.

2. **Multi-thread, manually created.** Kevin can spin up named threads, each with its own workspace and its own resumable CC session. Future v1.8+ may layer ChatGPT-style auto-fork (Q1 brainstorm option C); not in this spec.

3. **Per-thread workspace.** When a thread is created, Kevin picks a workspace dir (default `boss-dev`; dropdown of rascal + outsider dirs + custom path). The thread runs CC with `cwd = workspace_dir`. CC reads `<workspace_dir>/CLAUDE.md` plus the COO persona file (below).

4. **Bypass mode.** COO chat spawns use `--dangerously-skip-permissions`. Explicit Kevin authorization 2026-04-27 — exception to the standing rule that bans bypass on rascal/outsider spawns. Reasoning: in a web chat surface there is no terminal to approve CC's tool prompts; Kevin is chatting with himself; "have it do things" requires bypass or an approval UI, and an approval UI is its own scope. Bypass goes away when the B-shape (curated IR Custom AIOS tools) lands.

5. **Persona via committed file.** `boss-dev/docs/COO.md` is the canonical brief. Snapshotted into `boss_chat_sessions.system_prompt` at thread creation. Built-in fallback if the file is missing at creation time. Workspace `CLAUDE.md` still loads underneath via CC's normal mechanism.

6. **DB persistence reuses `boss_chat_sessions` + `boss_chat_messages`.** The schema generalized to support outsiders in v1.6.9 (migration 024); this spec extends `agent_kind` to include `'coo'` and adds a `workspace_dir` column. Messages are duplicated in DB (for fast load on thread switch) AND CC's JSONL persists raw session state for `--resume`.

## Non-goals (v1.7.7)

- **Twilio panel wiring.** The number is provisioned, but the right column is dropped from the layout for v1.7.7 to give the chat 100% of the right pane. Twilio is queued for a follow-up v1.7.x ship.
- **Voice mic in chat input.** STT/TTS containers are up. Wiring them through chat is its own scope; mic button stays `coming soon`.
- **Thread archive + delete.** Create + open + send + rename only in v1.7.7. Archive + delete = v1.7.8 (adds confirmation-dialog work).
- **Curated IR Custom AIOS-defined tool catalog (Q1's B-shape).** Future migration. CC's built-in tool belt is the entire "do things" surface for v1.7.7.
- **Any change to `apps/api/src/routes/brain.ts` BrainRouter.** 1362 lines, parallel adapter system, has consumers beyond COO. Untangling is a v1.8 concern.
- **Cross-device session continuity beyond what CC's `--resume` already gives.** The DB row is the source of truth; if Kevin opens a different machine and hits the same tenant, threads are reachable. Browser localStorage is not used.

## Components

### Backend

#### Migration `services/postgres/migrations/026_coo_chat_sessions.sql`

```sql
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

Idempotent. Backfill not required (no existing COO rows).

For `agent_kind = 'coo'` rows:
- `rascal_handle` is repurposed to carry the thread slug (kebab-case + 6-char suffix for uniqueness). Kept in this column instead of renamed to keep the migration trivial; the column name is misleading for COO rows but is internal-only and documented here.
- `workspace_dir` is required (route enforces; no DB constraint to keep rascal/outsider rows clean).
- `name` is the human label.

#### Route module `apps/api/src/routes/coo/`

All under `/api/coo/*`, registered in `apps/api/src/server.ts` via `await server.register(cooRoutes, { prefix: '/api/coo' })`. Global-auth gated (Bearer/JWT, no admin role check — matches the existing /coo frontend-gating pattern).

- **`index.ts`** — aggregator that registers child routes
- **`threads.ts`** —
  - `GET /api/coo/threads` → list threads for current tenant, ordered by `updated_at DESC`. Returns `{id, name, workspace_dir, created_at, updated_at, last_message_preview}`.
  - `POST /api/coo/threads` → create thread; body `{name, workspace_dir}`. Validates `workspace_dir` is one of the allowed dirs returned by `/api/coo/workspaces` (boss-dev, rascal dirs, outsider dirs). No free-form paths in v1.7.7. Snapshots `boss-dev/docs/COO.md` (or built-in fallback) into `system_prompt`. Returns the new thread row. **Does NOT mint a CC session yet** — that happens on first message.
  - `PATCH /api/coo/threads/:id` → rename only (`{name}`).
- **`messages.ts`** —
  - `GET /api/coo/threads/:id/messages` → load message history (paginated, default last 200 newest-first, `?before=<msg_id>` for older pages). Returns `[{id, role, content, tokens_in, tokens_out, created_at}, ...]`.
- **`chat.ts`** —
  - `POST /api/coo/threads/:id/chat` → SSE streaming chat turn; body `{message}`. Persists user message before spawn. On first call: `cc_session_id` is NULL → mint a new UUID, spawn with `--session-id`. On subsequent calls: spawn with `--resume <uuid>`. Persists assistant message + token counters on completion (or partial, on abort). Emits SSE events: `event: token` (per stream-json delta), `event: tool_use` (CC tool calls), `event: tool_result`, `event: error`, `event: done`.
- **`workspaces.ts`** —
  - `GET /api/coo/workspaces` → returns `[{label, path, kind}, ...]` where `kind` is `'boss-dev' | 'rascal' | 'outsider' | 'home'`. Used by the create-thread modal.

The chat route wraps `apps/api/src/agents/rascal-chat.ts:runChatTurn()` directly. Two changes to that helper:
- Add an optional `allowAllTools: true` flag that appends `--dangerously-skip-permissions` to the CC args.
- Confirm `cwd` passed via `projectDir` works for non-rascal directories (it should — it's just a path).

No new subprocess code — the rascal-chat helper is the integration boundary.

### Frontend

#### `apps/web/src/pages/COO.tsx` — rewrite

Three-column → **two-column** layout. Twilio panel removed. Grid becomes `grid-template-columns: 260px 1fr` (was `260px 1fr 320px`).

Existing `ChatPanel` and `TwilioPanel` inline components deleted. Existing `ThreadList` replaced with the new wired version. Layout chrome (header, page padding) preserved.

#### New components — `apps/web/src/components/coo/`

- **`ThreadList.tsx`** — fetches `GET /api/coo/threads` on mount; renders the list; `+ New thread` button at top opens `NewThreadModal`. Click-to-rename inline (double-click name → editable input → blur/Enter calls PATCH). Shows last-message preview + `updated_at` relative time per thread.
- **`NewThreadModal.tsx`** — modal with name field + workspace dropdown (populated from `GET /api/coo/workspaces`). Submit → POST → close → ThreadList refresh → switch active thread to the new one.
- **`ChatPane.tsx`** — replaces inline ChatPanel. On thread switch: `GET /api/coo/threads/:id/messages` to load history, render. Send → `POST /api/coo/threads/:id/chat` (SSE consumer). Renders `tool_use` / `tool_result` events as collapsible inline blocks (visual distinction from regular messages). Auto-scroll on new messages. Mic button stays as-is (`coming soon` tooltip).
- **`useThreadMessages.ts`** — small hook: `(threadId) => {messages, isLoading, append, replaceLast}`. Wraps the GET + state.
- **`useCooThreads.ts`** — small hook: `() => {threads, refresh, create, rename}`. Wraps the threads CRUD endpoints.

CSS additions go into the existing `apps/web/src/styles/` pattern (no new tokens). The chat pane SSE event handling and tool-call rendering are the only genuinely new visual elements; everything else reuses existing `vs-*` utility classes and the existing chat-bubble styles from the deleted inline ChatPanel.

### Persona file

#### `docs/COO.md` — new file in boss-dev repo

Initial draft (~40 lines). Committed in this same v1.7.7 ship. Iterated over time as IR Custom AIOS evolves; each iteration is a normal git commit, but **existing COO threads keep the snapshot they were created with** — they don't pick up edits to the file. To "refresh" a thread to the latest persona, Kevin creates a new thread.

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
```

The file's content is iterated freely after v1.7.7 ships; this is the seed.

## Data flow (single chat turn)

```
1. Kevin types in ChatPane, presses Enter
2. Frontend: POST /api/coo/threads/<thread-id>/chat {message}
3. Route: insert boss_chat_messages row (role='user', content=message)
4. Route: load thread row, get cc_session_id (may be NULL on first turn)
5. Route: call runChatTurn({
     message,
     projectDir: thread.workspace_dir,
     ccSessionId: thread.cc_session_id,
     model: thread.model,
     allowAllTools: true,
   }, sseRes)
6. runChatTurn: spawn(claude -p --output-format stream-json --verbose
                       --dangerously-skip-permissions
                       (--session-id <new-uuid> | --resume <existing-uuid>),
                     cwd=workspace_dir, env={HOME, ...})
7. Subprocess streams stream-json frames to runChatTurn → SSE to browser
8. On 'close': route updates thread.cc_session_id (if first turn) and
   inserts boss_chat_messages row (role='assistant', content=aggregated,
   tokens_in, tokens_out). Updates thread.updated_at.
9. SSE 'done' event closes the connection
```

Token counts come from the stream-json `result` frame at the end of CC's output.

## Error handling

- **CC subprocess fails to spawn** → SSE `error` event with `{code: 'spawn-failed', message}`, no DB write for assistant message, thread.updated_at unchanged.
- **CC exits non-zero mid-stream** → SSE `error` event with `{code: 'cc-exit', code, stderrTail}`. Whatever was aggregated before exit is persisted as the assistant message with a `[truncated: cc exited <n>]` suffix.
- **Client disconnects mid-stream** → `abortSignal` fires, subprocess killed (SIGTERM), partial assistant text persisted with `[aborted]` suffix (matches existing rascal-chat behavior).
- **DB write fails on user-message insert** → 500, no spawn, no SSE.
- **DB write fails on assistant-message insert** → log and continue; user already saw the streamed response, losing the persistence is preferable to a crash. Counter-metric on the dropped write (IR Custom AIOS's existing logging pattern).
- **`workspace_dir` no longer exists at spawn time** → CC subprocess will fail; surface as a clear error message in chat, do not crash the route.

## Testing

### Unit

- `runChatTurn` — already covered. Add test for `allowAllTools: true` adding the bypass flag.
- Route tests for `/api/coo/threads` CRUD using the existing route-test pattern (`*.test.ts` adjacent to route file).

### Integration

The chat route is hard to unit-test because it spawns a real CC subprocess. Coverage comes from the deploy-smoke instead (below).

### Deploy-smoke #32

Add to `scripts/deploy.sh`:

```bash
# Smoke #32: COO chat end-to-end
echo "==> [smoke #32] COO chat end-to-end"
THREAD_ID=$(docker exec boss_api wget -qO- \
  --header='X-BOSS-Internal: true' \
  --header='Content-Type: application/json' \
  --post-data='{"name":"deploy-smoke","workspace_dir":"/home/tcntryprd/boss-dev"}' \
  http://127.0.0.1:8001/api/coo/threads | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$THREAD_ID" ] || die "smoke #32: thread create failed"

# Send one short message; expect 'done' SSE event within 60s
docker exec boss_api timeout 60 wget -qO- \
  --header='X-BOSS-Internal: true' \
  --header='Content-Type: application/json' \
  --post-data='{"message":"Reply with the single word OK and nothing else."}' \
  "http://127.0.0.1:8001/api/coo/threads/$THREAD_ID/chat" 2>&1 \
  | grep -q 'event: done' || die "smoke #32: no done event"

# Confirm cc_session_id was minted
HAS_SID=$(docker exec boss_postgres psql -U postgres -d boss -tAc \
  "SELECT cc_session_id FROM boss_chat_sessions WHERE id = '$THREAD_ID';")
[ -n "$HAS_SID" ] || die "smoke #32: cc_session_id not minted"
```

This burns a real CC subscription token but only one short turn per ship. Matches existing rascal-chat smoke precedent.

## Standing rule additions

- **(v1.7.7) COO chat spawns may use `--dangerously-skip-permissions` (bypass mode).** Explicit Kevin authorization 2026-04-27. Does NOT extend to rascal/outsider spawns; they remain non-bypass per standing rule pre-existing.
- **(v1.7.7) `apps/api/src/routes/cli-brain.ts` removed** along with its tmux-based brain CLI. If anything still hits `/api/brain/cli/*` after v1.7.7, it's a stale frontend cache. The unrelated `apps/api/src/routes/brain.ts` BrainRouter is left intact.

## Open questions / risks

- **First turn cold-start.** A fresh CC subprocess takes a few seconds to start before stream-json frames flow. Existing rascal chat absorbs this with a "thinking…" indicator; same UX for COO. Not a defect, just a UX note.
- **Workspace bind-mounts.** boss-dev is bind-mounted into boss_api at `/home/tcntryprd/boss-dev` (per existing rascal-chat setup). Rascal dirs at `/home/tcntryprd/rascals/<handle>/` and outsider dirs at `/home/tcntryprd/outsiders/<handle>/` similarly. The workspaces dropdown is restricted to these known-mounted dirs; arbitrary paths are not accepted in v1.7.7 (would silently fail at spawn time when CC's cwd is not visible inside the container).
- **Persona-file drift.** Edits to `docs/COO.md` after a thread is created don't propagate. Acceptable trade — re-snapshotting on every turn would surprise an in-progress conversation. Documented in the persona file's own header.

## Files touched (estimate)

| File | Status | Approx LOC |
|---|---|---|
| `services/postgres/migrations/026_coo_chat_sessions.sql` | new | 15 |
| `apps/api/src/routes/coo/index.ts` | new | 20 |
| `apps/api/src/routes/coo/threads.ts` | new | 120 |
| `apps/api/src/routes/coo/messages.ts` | new | 60 |
| `apps/api/src/routes/coo/chat.ts` | new | 130 |
| `apps/api/src/routes/coo/workspaces.ts` | new | 50 |
| `apps/api/src/server.ts` | edit (1 register call) | +1 |
| `apps/api/src/agents/rascal-chat.ts` | edit (allowAllTools flag) | +5 |
| `apps/api/src/routes/cli-brain.ts` | delete | -305 |
| `apps/web/src/pages/COO.tsx` | rewrite | -200, +60 |
| `apps/web/src/components/coo/ThreadList.tsx` | new | 90 |
| `apps/web/src/components/coo/NewThreadModal.tsx` | new | 70 |
| `apps/web/src/components/coo/ChatPane.tsx` | new | 180 |
| `apps/web/src/components/coo/useThreadMessages.ts` | new | 40 |
| `apps/web/src/components/coo/useCooThreads.ts` | new | 50 |
| `docs/COO.md` | new | 40 |
| `scripts/deploy.sh` | edit (smoke #32) | +25 |

Total: ~1100 LOC net, ~17 files. Comparable in size to the v1.7.6 OpenClaw backend ship (797 LOC, 14 files).

## Process artifacts

- **Spec:** this file (`docs/superpowers/specs/2026-04-27-coo-surface-design.md`).
- **Plan:** to be written next via the `writing-plans` skill, saved to `docs/superpowers/plans/2026-04-27-coo-surface.md`.
- **Implementation:** subagent-driven-development per task in the plan, mirroring the v1.7.6 process.
