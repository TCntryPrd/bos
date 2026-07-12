# Rascal Lifecycle — Create / Activate / Retire

**Audience:** Kevin (or any future IR Custom AIOS agent acting on his behalf).
**Status:** Living doc. Update as the architecture evolves.
**Locked architecture:** rascal chat = `claude -p --resume <uuid>` per turn from the rascal's `projectDir` (see memory: `project_boss_rascal_chat_architecture.md`). Tmux is NOT required for chat, only for cron-scheduled jobs that need a long-running session.

---

## What a "rascal" actually is

Five orthogonal pieces. A rascal is fully working only when all five are aligned.

| # | Piece | Where it lives | Required for |
|---|---|---|---|
| 1 | DB row | `boss_rascals` table (per-tenant) | Showing up in `/rascals`, `/api/agents/rascals`, dashboard panels |
| 2 | Project dir | `~/rascals/<handle>/` (or `~/outsiders/<handle>/`) | CC subprocess `cwd`, persistent files |
| 3 | Persona files | `CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, `TOOLS.md`, `README.md` in the project dir | Persona + tool-belt context the CC subprocess loads each turn |
| 4 | Tmux session *(optional)* | `tmux ls` shows `<handle>` | **Only** if you have cron jobs that need a long-running CC pane |
| 5 | Cron schedule *(optional)* | Either host `crontab -l` OR `boss_executor` internal crond | Recurring automated jobs (transcript pulls, daily pings, etc.) |

**All five pieces are required.** Every rascal is both a coordinator (chat-driven, on-demand) and scheduled-job (cron-driven, autonomous). A rascal without a tmux session and at least one baseline cron is half-built and won't behave like Darla. Dial them in fully before flipping `enabled=true`.

---

## CREATE — bringing a new rascal online

### Step 1 — pick the handle

Constraint: `^[a-z]{2,24}$` (DB CHECK constraint `boss_rascals_handle_ck`). Lowercase letters only, 2–24 chars. No digits, no dashes, no underscores.

Examples that work: `darla`, `msroberts`, `petey`.
Examples that don't: `ms-roberts`, `roberts2`, `MsRoberts`.

### Step 2 — create the DB row

Three equivalent paths. Pick whichever you have at hand.

> **CRITICAL — tenant_id pitfall.** The `/rascals` surface filters by the JWT's tenant claim. Kevin's actual tenant is `d05cde41-4754-4f1f-ae13-ecb0be8b6fad`, NOT the literal string `'default'`. If you create a rascal under `'default'`, she's invisible from Kevin's dashboard. Always pass `X-Tenant-ID: d05cde41-4754-4f1f-ae13-ecb0be8b6fad` (or whatever the live tenant is — query `SELECT DISTINCT tenant_id FROM boss_rascals` for the canonical set), or use a route that derives tenant from a real auth header. Ms. Roberts hit this on first creation; the fix was a one-row `UPDATE boss_rascals SET tenant_id = '<real-uuid>' WHERE handle = 'msroberts'`.

**Path A — HTTP (preferred when shipping from the COO surface):**
```bash
TENANT='d05cde41-4754-4f1f-ae13-ecb0be8b6fad'  # Kevin's tenant. NOT 'default'.
curl -s -X POST http://127.0.0.1:8001/api/agents/rascals \
  -H 'X-BOSS-Internal: true' -H "X-Tenant-ID: $TENANT" \
  -H 'Content-Type: application/json' \
  -d '{
    "handle":"msroberts",
    "displayName":"Ms. Roberts",
    "cli":"claude",
    "client":"Leslie Bodine",
    "projectDir":"/home/tcntryprd/rascals/msroberts",
    "model":"claude-sonnet-4-6",
    "enabled":false
  }'
```

`cli` is constrained to `claude` or `ollama` (CHECK constraint). `enabled:false` at create time is intentional — flip to `true` only after Step 3 + 4 finish.

**Path B — direct SQL (fallback, e.g. if api is down):**
```sql
INSERT INTO boss_rascals (tenant_id, handle, display_name, cli, client, project_dir, model, enabled)
VALUES ('d05cde41-4754-4f1f-ae13-ecb0be8b6fad', 'msroberts', 'Ms. Roberts', 'claude', 'Leslie Bodine',
        '/home/tcntryprd/rascals/msroberts', 'claude-sonnet-4-6', false);
```

**Path C — `/api/agents/rascals/import-presets`** if you're bringing in one of the classic 13 (Darla, Spanky, etc.) — handles + display names are seeded. **Verify the preset import respects the request's tenant — older import paths defaulted to `'default'`.**

### Step 3 — scaffold the project dir

The HTTP create route does NOT scaffold the dir. You scaffold by hand (or the COO does it via shell tools when bypass mode is on).

Minimum file set per rascal — copy from the closest existing rascal as a starting template, then edit:

```
~/rascals/<handle>/
├── CLAUDE.md          # the persona — this is what CC reads on every turn
├── AGENTS.md          # short ledger of WHO this rascal is in 2-3 lines
├── MEMORY.md          # rolling memory file — corrections, learnings (rascal updates this themselves)
├── README.md          # human-readable intro for someone opening the dir cold
├── TOOLS.md           # what tools the rascal has access to
├── crons/             # cron job scripts + prompts (one .md per scheduled job)
├── data/              # rascal's working data — transcripts, raw inputs
├── memory/            # weaviate-style structured memory (optional)
├── output/            # deliverables: <YYYY-MM-DD>-<slug>.md
├── playbooks/         # documented procedures the rascal can reference
├── skills/            # CC skills (optional)
└── state/             # logs, scratch, temp files
```

(Plus the standard hidden dotfiles — `.git/`, `.gitignore`, `.claude/` for CC config, `.boss/` for IR Custom AIOS-specific metadata stub. These are infrastructure and don't belong in the user-facing tree.)

Quick scaffold from a known-good example:
```bash
cp -r ~/rascals/darla ~/rascals/<handle>
cd ~/rascals/<handle>
rm -rf data/* output/* state/* sessions/* memory/*  # blank the working state
git init -q && git add -A && git commit -q -m "initial scaffold"
# now edit CLAUDE.md, AGENTS.md, README.md, TOOLS.md, MEMORY.md to reflect this rascal's identity
```

`CLAUDE.md` is the most important file — it's the persona contract. Tailor it to the rascal's role. Reference the client by name, list specific products / projects / deliverables, set the operating protocol (date-verification, MEMORY-first, etc. — Darla's CLAUDE.md is the canonical example of a thorough one).

### Step 4 — tmux + cron setup (every rascal)

This step is mandatory. A rascal isn't "ready to work" until they have a tmux session and at least one baseline cron job (typically a daily wake-and-check). Skipping this is what kept Ms. Roberts from being dialed in like Darla on first creation.

a. **Tmux session** (host):
```bash
tmux new-session -d -s <handle> -c ~/rascals/<handle>
tmux send-keys -t <handle> 'claude' Enter
```

b. **Cron entries**. Decide host vs `boss_executor`:
- **Host crontab** — best for jobs that need to interact with host services or files outside container bind-mounts.
- **`boss_executor` internal crond** — best for jobs that should follow the executor's lifecycle (gets restarted with deploys; logs go to executor stdout).

**Host pattern** (see `~/rascals/ajbloom/crons/wake-agent.sh` and the `crontab -l` entry):
```cron
17 8 * * * /home/tcntryprd/rascals/<handle>/crons/wake-agent.sh \
           /home/tcntryprd/rascals/<handle>/crons/prompts/daily-check.txt \
           >> /home/tcntryprd/rascals/<handle>/state/logs/cron.log 2>&1
```

Each prompt is a plain-text file the wake-agent script feeds to the rascal's tmux session via `tmux send-keys`.

**Executor pattern** — edit `boss-dev/apps/executor/crontab` (or wherever the executor's crontab is mounted in this branch), add an entry, rebuild + redeploy the executor service. Heavier-weight; do this only if you really want the lifecycle coupling.

### Step 5 — activate

```bash
curl -s -X PATCH http://127.0.0.1:8001/api/agents/rascals/<handle> \
  -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```
or
```sql
UPDATE boss_rascals SET enabled = true WHERE handle = '<handle>';
```

The dashboard's RASCALS counter now includes them. They appear in the AgentRoster card. Chat surfaces (orb, /coo, /rascals/<handle>) can spawn turns from their projectDir.

### Step 6 — verify

```bash
# DB row exists + enabled
PGPASSWORD='V@sari2026!Pr0d' psql -h 127.0.0.1 -p 5434 -U boss -d boss_db \
  -c "SELECT handle, display_name, enabled, model FROM boss_rascals WHERE handle='<handle>';"

# Project dir has the persona files
ls ~/rascals/<handle>/*.md

# Chat turn round-trip — pick rascal in /rascals/<handle> in browser, send "say OK"
# (or use curl against the rascal-chat API directly)

# tmux session present
tmux has-session -t <handle> && echo "tmux OK"

# cron entries present
crontab -l | grep -F "/<handle>/" | head
```

---

## RETIRE — bringing a rascal offline cleanly

Soft retirement is the default. Hard delete loses the project dir's git history and any in-flight conversations.

### Step 1 — flip the DB row off

```bash
curl -s -X PATCH http://127.0.0.1:8001/api/agents/rascals/<handle> \
  -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

This alone hides them from `/rascals` (admin can still see disabled), drops them from automation that filters on `enabled=true`, and stops the `RASCALS ACTIVE` count.

### Step 2 — kill the tmux session if any

```bash
tmux has-session -t <handle> 2>/dev/null && tmux kill-session -t <handle>
```

### Step 3 — remove cron entries

Host:
```bash
crontab -l | grep -vF "/<handle>/" | crontab -
```

Executor: edit `boss-dev/apps/executor/crontab`, drop the rascal's lines, redeploy.

### Step 4 — archive (don't delete) the project dir

```bash
mv ~/rascals/<handle> ~/rascals/_retired/<handle>-$(date -u +%Y%m%d)
```

The `_retired/` prefix is a convention — it's not magic, but it keeps the active tree clean and preserves the git history for audit.

### Step 5 — *(optional)* hard-delete the DB row

Only do this if the rascal was a mistake from day one (wrong handle, etc.) and you want the slot back. Otherwise leave the disabled row — it's tiny.

```bash
curl -s -X DELETE http://127.0.0.1:8001/api/agents/rascals/<handle> \
  -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default'
```

---

## Common gotchas

- **Handle constraint:** `^[a-z]{2,24}$`. The DB will reject `ms-roberts`, `MsRoberts`, `roberts2`. If a client name doesn't compress nicely, prefix with `ms`/`mr`/`dr` etc.
- **Tenant scoping:** every route requires `X-Tenant-ID`. If the row doesn't show up after create, check you wrote it under the same tenant the dashboard is reading.
- **CLI choice:** `cli='ollama'` makes the rascal use the local ollama runtime (chat won't go through Anthropic). Most rascals should be `claude`.
- **Project dir bind-mount:** `boss_api` has a same-path bind of `~/rascals` (and `~/outsiders`). Don't put rascals outside those trees — the chat-turn `cwd` won't resolve inside the container and `spawn()` will throw ENOENT.
- **Persona snapshots:** the COO surface (`/coo`) snapshots the persona file at thread create time. Edits to `CLAUDE.md` after a thread starts only affect future threads. (The chat surface for rascals re-reads `CLAUDE.md` every turn, so edits there ARE picked up live.)
- **Don't auto-bypass:** `--dangerously-skip-permissions` (bypass mode) is COO-only. Rascal/outsider spawns must remain non-bypass per standing rule #23.
- **Seeded rascals are tenant-aware:** never write `INSERT INTO boss_rascals (...) VALUES ('default', ...)` in a migration; backfill across tenants. (Standing rule, learned from v1.6.8.)

---

## Worked example — Ms. Roberts (created 2026-04-28)

State after the initial creation:
- DB row: handle `msroberts`, display_name `Ms. Roberts`, client `Leslie Bodine`, cli `claude`, model `claude-sonnet-4-6`, enabled `true`, project_dir `/home/tcntryprd/rascals/msroberts`. ✓
- Project dir scaffolded: `CLAUDE.md` (tailored to Sidekick + CourtReady), `AGENTS.md`, `MEMORY.md`, `README.md`, `TOOLS.md`. ✓
- **Missing:** tmux session, cron entries, full Darla-style operating protocol section in `CLAUDE.md`. ✗

This is the gap this playbook is meant to close. To finish dialing her in like Darla:
1. Port Darla's operating-protocol section into Ms. Roberts' `CLAUDE.md` (date-verification, MEMORY-first, no scatter-shot, etc.).
2. Create the tmux session: `tmux new-session -d -s msroberts -c ~/rascals/msroberts && tmux send-keys -t msroberts 'claude' Enter`.
3. Add a baseline `crons/morning-check.md` mirroring Darla's, plus a host crontab line that fires it at a sensible weekday hour.
4. Re-verify with the Step 6 commands.
