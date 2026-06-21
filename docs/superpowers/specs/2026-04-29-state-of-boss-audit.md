# State of IR Custom AIOS — Audit (2026-04-29)

**Author:** background audit agent (read-only)
**Scope:** Master Plan progress + sovereignty + durability
**Inputs read:** `BOSS_MASTER_PLAN.md`, MEMORY.md (v1.1.0 → v1.7.12), `BOSS_HANDOFF.md`, live host state, `boss-dev` source
**Stance:** snapshot of reality, not a wish-list. Honest diagnosis as requested.

---

## 0. State summary

- master HEAD: `d098c5a` (auto-backup commit on top of `31a3759` = v1.7.12)
- Tags: 30+, latest `v1.7.12`
- Containers running: 12 (4 IR Custom AIOS app + 4 infra + 2 voice + n8n + n8n-postgres + home-assistant)
- All IR Custom AIOS app containers on `:1.7.12`, healthy ~4 hours
- 27 migrations applied (latest `027_kanban.sql` 2026-04-28)
- 12 rascals on disk (`/home/tcntryprd/rascals/`), 2 outsiders (`ajbloom`, `ponyboy`)
- 130 brain tools registered across 26 source files
- ~45 deploy smokes in `scripts/deploy.sh` (memory says "40", grep counts more)

---

## 1. v2 Master Plan progress (phase-by-phase)

| Phase | Plan target | Status | Actual ship | Notes |
|---|---|---|---|---|
| 1 — Pipeline Engine backend | v1.3.0 | SHIPPED | v1.3.0 + v1.3.1 hotfix | Migration 014 + 015, `apps/api/src/routes/pipeline.ts`, brain tools `boss_task_list/advance/create`, 5 templates seeded. Per `project_boss_v131_shipped.md`. |
| 2 — Little Rascals orchestrator | v1.4.0 | SHIPPED (scope shifted) | v1.4.0–v1.4.3 + later refactor | All 10 numbered classic rascals onboarded (DB+cron+tmux). Plan called for "start with Darla only"; reality jumped straight to all 10. The chat architecture was later **redesigned** at v1.6.x: tmux/scrollback dropped, replaced by CC CLI subprocess + bind-mounts (`project_boss_rascal_chat_architecture.md`), so the original Phase 2 ship gate (Darla wakes on cron, advances task) is partially obsolete. Cron-driven `wake-agent.sh` is still alive only for `ajbloom` + `msroberts` (2 of 13). Other rascals are no longer cron-woken. |
| 3 — UI v2 shell | v1.5.0 | SHIPPED | v1.5.0–v1.5.8 | Design tokens, NavRail+TopBar+StatusBar, AdminOverlay, web→api routing fix, JWT tenant fix. |
| 4 — Kanban surface | v1.6.0 | SHIPPED (very late, scope changed) | v1.7.11 + v1.7.11.1 + v1.7.12 | The plan slot `v1.6.0` instead got Rascal Workspace (off-plan). Kanban actually landed at v1.7.11. Implements both required views (Client Status 5-col + Project Status 9-col). DnD landed v1.7.12 today. Brain tools (`boss_tasks_move/advance/block`) deferred to v1.7.14. |
| 5 — Whiteboard | v1.7.0 | NOT-STARTED | — | The decision point ("native vs iframe") never happened. v1.7.0 instead shipped `boss_executor` container + Sonnet 4.6 model column + Ponyboy outsider. Whiteboard is unbuilt. |
| 6 — Dashboard restyle | v1.8.0 | NOT-STARTED | — | Dashboard.tsx still the legacy 2,761-line beast (per handoff). |
| 7 — COO surface | v1.9.0 | SCOPE-CHANGED + SHIPPED EARLY | v1.7.7 | Plan called for Twilio side-channel + spend tracker (v1.9.0). What shipped at v1.7.7 was a **completely different COO**: working multi-thread CC chat with bypass mode (5 routes under `/api/coo`, migration 026, max=5 active threads). No Twilio. No spend tracker. The plan-7 "COO" never happened. |
| 8 — Advisors Counsel | v1.10.0 | NOT-STARTED | — | No `counsel_sessions` table, no round-table UI. The "permanent IR Custom AIOS + Kevin seats" rule from reconciliation 1 is unimplemented. |
| 9 — Surface restyles (Calendar/CRM/Code/COE) | v2.0.0-rc1 | PARTIAL | v1.7.9 (COE only) | OC.tsx → COE re-skin landed at v1.7.9 ("Layout B" with status strip + accordion + Gio chat + ⋯ controls). Calendar.tsx, CRM.tsx, Code.tsx still legacy. |
| 10 — Polish + release | v2.0.0 | NOT-STARTED | — | No motion spec, no density tweaks, no mobile decision, no v2.0.0 tag. |

**Score:** 3 of 10 cleanly shipped, 3 of 10 partial/scope-changed, 4 of 10 not-started.

---

## 2. Off-plan ships (not in the Master Plan)

These all happened during what the plan said should be Phases 4–7. Most are real value, but they pulled velocity away from the plan's spine.

| Tag | Off-plan addition | Purpose | Effect on plan |
|---|---|---|---|
| v1.4.4–v1.5.8 | UI shell sub-iterations (chat-and-voice-and-Dashboard trilogy, COO-not-rascal correction, design tokens, JWT tenantId fix) | Polished Phase 3 | Within plan, just deeper. |
| v1.6.3–v1.6.6 | **Rascal Workspace** (4-pane: chat sessions + file tree + editor + agenda) | New top-level surface; click rascal card → /rascals/<handle> | Off-plan. Plan never mentioned rascal workspaces; rascals were supposed to be cron-driven CLI agents. This added a whole UI and chat backend. |
| v1.6.6.3 | Editor-wrap hotfix | Small | — |
| v1.6.7 | NavRail re-org (OpenClaw→COE-Gio rename, Outsiders comingSoon) | Nav tweak | Renames a plan item early. |
| v1.6.8 + v1.6.8.1 | **Outsiders surface** (`boss_outsiders` + Ponyboy seed + tenant backfill hotfix) | New agent kind alongside rascals | Off-plan. Plan only knows "system agents" (IR Custom AIOS Assistants like Gio) and "client-use agents" (Rascals). Outsider was added for social/marketing pipeline (Ponyboy). |
| v1.6.9 | Kind-aware AgentWorkspace factory | DRY refactor | — |
| v1.7.0–v1.7.4 | **boss_executor container** (claude+ffmpeg+gog+python3+tmux+crond), Sonnet 4.6 column, Ponyboy social pipeline migrated INTO executor with internal crond, **Meta Graph API webhook receiver** at `/api/webhooks/meta` with HMAC sig verify | Foundational; gives the system a job runner | Off-plan. This is the cron+execution backbone the plan never wrote down. |
| v1.7.6 | Gio/OpenClaw dashboard backend (5 read routes + Node 22 bump) | Phase 9 prep, early | Pulls Phase 9's COE work forward. |
| v1.7.7 | **COO surface** (multi-thread CC chat + bypass mode) | New control surface | Replaces plan's Phase 7 entirely. |
| v1.7.8 + v1.7.8.1 | IR Custom AIOSOrb rewired from dead `/api/brain/cli` to `/api/coo` singleton thread | Glue | — |
| v1.7.9 | **OpenClaw `/oc` (now COE) frontend Layout B** + control.ts route | Phase 9 surface restyle | Knocks out one of four Phase 9 surfaces. |
| v1.7.10–v1.7.10.2 | Chat polish (model-swap key fix, timestamps, textarea wrap, COO h-full) + Ms. Roberts rascal | — | — |
| v1.7.11 + v1.7.11.1 + v1.7.12 | **Kanban v1** | Plan's Phase 4 finally lands | At `v1.7.x` instead of `v1.6.0`. |

**Pattern:** the plan's order (Pipeline → Rascals → UI → Kanban → Whiteboard → Dashboard → COO → Counsel → Restyles → Polish) was executed as **Pipeline → Rascals (heavy) → UI → Rascal Workspace (off-plan) → Outsiders (off-plan) → Executor (off-plan) → COO-redefined → COE → Kanban**. Whiteboard, Dashboard restyle, real COO (Twilio), and Counsel are all skipped.

---

## 3. Sovereignty inventory

### 3.1 Brain tools (130 total)

Source: `apps/api/src/tools/registry.ts` (assembly), `apps/api/src/tools/trust.ts` (trust gates), individual tool files.

#### Categories

| Category | Tools | Count | Trust gate |
|---|---|---|---|
| Self-modification | `boss_bash`, `boss_self_patch`, `boss_self_grep`, `boss_self_build`, `boss_self_test`, `boss_self_git`, `boss_self_introspect` | 7 | **admin** |
| System monitoring | `boss_sys_info`, `boss_sys_updates`, `boss_sys_docker`, `boss_sys_services` | 4 | **observer** (read-only) |
| Filesystem | `boss_fs_read/list/search/write/append` | 5 | observer (read), assistant (write) |
| Memory | `boss_memory_save/recall/list` | 3 | observer/assistant |
| Sub-agent spawning | `boss_spawn_agent`, `boss_spawn_parallel` | 2 | operator |
| Persistent agents | `boss_create/list/update/delete_persistent_agent` | 4 | observer/operator/admin |
| Pipeline (Phase 1 backbone) | `boss_task_list/advance/create`, `boss_tasks_pending/create/complete/delete` | 7 | observer/assistant |
| Google Workspace (Calendar/Gmail/Tasks/Drive/Contacts) | `boss_calendar_*`, `boss_gmail_*`, `boss_tasks_*`, `boss_drive_*`, `boss_contacts_search` | 19 | mixed |
| n8n | `boss_n8n_*` (list/get/run/create/update/activate/deactivate/delegate/templates) | 11 | observer/operator |
| Home Assistant | `boss_ha_*` | 6 | observer/operator |
| Slack | 4 | mixed |
| Telegram | 4 | mixed |
| Notion | 4 | observer/assistant |
| Airtable | 6 | observer/assistant/operator |
| Make.com | 10 | observer/operator/admin |
| Stripe | 5 | observer/operator |
| Gemini (image gen/edit/describe) | 3 | (default observer) |
| GitHub | 6 | (default observer) |
| YouTube | 2 | observer |
| TTS | 1 | observer |
| Web (search/fetch) | 2 | observer |
| Email agent | `boss_email_attention/digest/search/keyword_search` | 4 | observer |
| CRM (GoHighLevel) | 9 | (default observer) |
| Voice agent routing | `boss_voice_*` | 3 | observer |
| Knowledge / Weaviate | `boss_knowledge_search` | 1 | observer |
| UI command bridge | `boss_ui_command` | 1 | observer |
| Read-local-file | `boss_read_local_file` | 1 | operator |

#### Trust tiers (`apps/api/src/tools/trust.ts:40-182`)

- **observer** — read/list/search only
- **assistant** — observer + create/send (default authenticated user)
- **operator** — assistant + run/modify
- **admin** — operator + delete/configure (gates `boss_self_*` and `boss_bash`)

Mapping (`tierFromRole`, lines 208–222):
- `'admin'` / `'owner'` → admin
- `'user'` → assistant
- everything else → observer (fail-closed)

### 3.2 Bypass mode

Searched the routes tree for "bypass" / "allowAllTools" / "--dangerously-skip-permissions":

- `apps/api/src/routes/coo/index.ts:9` — "bypass mode on (Kevin authorization)"
- `apps/api/src/routes/coo/chat.ts:7,71` — `allowAllTools: true` per Kevin
- `apps/api/src/routes/code.ts:81` — `--dangerously-skip-permissions` flag for the Code surface (separate from chat bypass)

Bypass mode is **only on the COO surface**. Rascal chat (`apps/api/src/agents/rascal-chat.ts` callers in rascal-workspace) does NOT pass `allowAllTools`. So:

- **COO chat** = IR Custom AIOS running unrestricted Claude Code subprocess (Kevin's surface)
- **Rascal chat** = sandboxed CC subprocess
- **Outsider chat** = sandboxed CC subprocess
- **Brain tools** = trust-tier filtered (admin role gets the dangerous ones)

### 3.3 "IR Custom AIOS herself" — host vs container

The plan and Kevin's vision call for a persistent **IR Custom AIOS** identity that runs across host AND containers and can answer "what's the state of the server."

What exists today:

- `boss-agent.service` — host-native systemd service on port 8010 (per self-mod tool docs at `tools/self-mod.ts:135-136`). This is a "host-native agent" referenced but its source is at `apps/agent/` (legacy/unused per handoff comment "apps/agent isn't in active deploy" — but the systemd service is RUNNING, so something at port 8010 is alive).
- `boss-gateway.service` — port 65138, running.
- `openclaw-gateway.service` — port from `~/.openclaw/openclaw.json`, running. Houses Gio/Grok agent.
- `boss_api` container — has admin trust + self-mod tools + bash tool that explicitly states "Default cwd is /home/tcntryprd/boss-dev. Max timeout 5 minutes" → so the **API container can shell to host paths via bind-mounts**. That's the closest thing to "IR Custom AIOS herself" today.

There is **no single named "IR Custom AIOS" agent** distinct from rascals/COO/Gio. IR Custom AIOS "is" three things at once:
1. Kevin's main Claude Code session (per `project_boss_coo_identity.md`)
2. The COO surface threads (5 max, bypass-on)
3. The brain tools surface accessible from the orb / IR Custom AIOSOrb

There is no "IR Custom AIOS Self" agent that wakes herself, nor a single thread Kevin can address as "IR Custom AIOS-the-COO" with persistent memory across sessions beyond Postgres-stored chat history.

### 3.4 Self-modification capability

Today, with admin trust, IR Custom AIOS **can**:

- Read any file in `/home/tcntryprd/boss-dev` (`boss_fs_read`, `boss_self_grep`)
- Edit files (`boss_self_patch`, `boss_fs_write`)
- Run shell commands (`boss_bash`, blocks `rm -rf /`, `sudo`, `shutdown`, `reboot`, `mkfs`, `dd`)
- Run tests (`boss_self_test` → vitest)
- Build & rebuild containers (`boss_self_build`)
- Commit on a `boss/*` branch (`boss_self_git`, locked to non-master per tool docstring)
- Inspect own state (`boss_self_introspect`)

IR Custom AIOS **cannot today** (without external help):

- Open a PR (no `boss_github_open_pr` tool — `github.ts` only has 6 read tools: list_issues, list_repos, read_file, repo_tree, search_code, search_repos)
- Merge to master (deliberately blocked: tool docstring says "NEVER to master. Kevin approves merges.")
- Push tags / kick CI (no tag tool; would have to use `boss_bash` to run `git push origin <tag>` — possible but not packaged)
- Run `apt` updates (`boss_sys_updates` is read-only; `boss_bash` can technically `apt-get` but `sudo` is blocked → so `apt` install/upgrade are blocked since they need sudo)
- Restart systemd services (the bash safety list blocks `shutdown`/`reboot`; `systemctl restart` is *not* explicitly blocked but the host services run as user units so it'd at most touch those — and `boss-agent` restart is documented in tool prose, line 137)
- Modify host crontab (no tool; `boss_bash` from the API container with mounted home + a host crontab file would work but is friction)
- Configure firewall / `ufw` / `iptables` (sudo-blocked)
- Manage Docker beyond `docker ps` reads (`boss_sys_docker` is read; `boss_bash` could `docker stop`/`docker compose up` — that flow exists but isn't first-class)

### 3.5 "What's the state of the server" — answerable today?

Yes, partially. With admin trust the orb can call:
- `boss_sys_info` → hostname/OS/uptime/CPU/mem/disk/containers/network
- `boss_sys_docker` → all containers w/ status & resources
- `boss_sys_services` → systemd services
- `boss_sys_updates` → apt upgradable list

What it can NOT report directly:
- Backup health / last-successful-backup timestamp (no tool, would have to read log file)
- n8n workflow inventory + activation state (`boss_n8n_list_workflows` exists; works)
- Cron status (no tool, `boss_bash crontab -l` works)
- Firewall posture / open ports (no tool)
- SSL cert expiry / Let's Encrypt status (no tool)
- Recent CI runs / GitHub Actions status (no tool — no github_actions tool)

### 3.6 Bypass-aware persona / identity layer

The COO `/coo` surface uses bypass mode but the per-thread workspace_dir means each thread is a **different** Claude Code session with no shared memory. There's no "IR Custom AIOS = always this thread" singleton — except the **IR Custom AIOSOrb** which (per v1.7.8) was rewired to a singleton "IR Custom AIOS Orb" thread under `/api/coo`. So the orb IS a single perpetual COO thread. That is the closest thing to "IR Custom AIOS herself" today.

The `/api/openclaw/control/:action` route (`apps/api/src/routes/openclaw/control.ts`) lets the API mutate `~/.openclaw/openclaw.json` (set-model on an agent) and runs `openclaw daemon restart`. This is real host-config manipulation from a container — proof that the architecture for sovereignty exists. Just narrowly applied (set-model, reindex-memory, backup, restart for OpenClaw only).

---

## 4. Durability inventory

### 4.1 Code repos (sp-hub + 13 client workspaces)

| Mechanism | Path | Schedule | Status |
|---|---|---|---|
| Per-repo auto-commit + push | `scripts/auto-commit.sh` (boss-dev only) | Hourly :00 UTC (cron) | **WORKING** — last commit `d098c5a` 2026-04-29 20:00 UTC. |
| All-repos sweep | `scripts/auto-commit-all.sh` (sp-hub + 13 client trees) | Hourly :15 UTC (cron) | **PRESUMED WORKING** — log file at `scripts/logs/auto-commit-all.log` (not read but cron entry verified). Includes secret-pattern guard that rejects `.env`, `*.key`, `id_rsa`, etc. |
| Push target | `github.com/TCntryPrd/<repo>` | — | All 14 repos push to `main` branch on private GitHub. |

Status: **BACKED-UP-VERIFIED** for `boss-dev`. **BACKED-UP-CLAIMED-NOT-VERIFIED** for the other 13 (cron entry exists; log not inspected this audit).

### 4.2 Postgres (`boss_postgres`)

| Aspect | State |
|---|---|
| Encryption | AES-256-CBC per file (`scripts/backup.sh:80-95`) |
| Schedule | Daily 04:00 UTC via cron (verified) |
| Local artifacts | `/tmp/boss-backups/` — 9 daily snapshots Apr 21–29, sizes 5.3MB → 7.3MB (growing) |
| Last successful local | **2026-04-29 04:00 UTC** (boss_pg_20260429_040001.sql.gz.enc, 7.25 MB) |
| Off-host upload | **FAILING since 2026-04-23** |
| Failure mode | Git push to `github.com/TCntryPrd/boss-backups` rejected by GitHub's 100MB file-size limit. Triggered by `boss_wv_20260423_040001.tar.gz.enc` (Weaviate dump grew to 173.94 MB). Once a >100MB file is committed to the local backup repo, EVERY subsequent push fails because the rejected file is still in the local `git` history and gets resent on every push. |
| Postgres dump itself | Postgres dumps are **<10 MB** and would push fine — but they're chained behind the failing Weaviate file in the same commit history. |
| Retention | 15 days locally (`BACKUP_RETENTION_DAYS=15`); S3 not configured; git side stuck. |

Status: **PARTIAL** — local snapshots are accumulating (good), but **off-host replication has been broken for 6 days**. If the host disk fails, the backups die with it.

### 4.3 Weaviate (`boss_weaviate`)

- Backed up by the same `backup.sh` (Weaviate scroll API export → tar.gz → AES-encrypt)
- Daily 04:00 UTC
- **Local artifact size: 211 MB on 2026-04-29** (and growing — was 82 MB on Apr 21–22, jumped to 173 MB on Apr 23 when SP/screenpipe+drive ingest filled it)
- Same off-host upload failure as Postgres above
- **Same "BACKED-UP-VERIFIED locally / NOT-BACKED-UP off-host" status**

### 4.4 Redis (`boss_redis`)

- AOF persistence enabled (`services/redis/redis.conf:18-21`): `appendonly yes`, `appendfsync everysec`, AOF rewrite at 100% growth from 64MB
- RDB snapshots: `save 900 1 300 10 60 10000`
- Volume: `boss-v2_redis_data` (Docker volume)
- **No external backup script touches Redis.** AOF/RDB are inside the volume; if the volume is lost, Redis state is lost.

Status: **NOT-BACKED-UP** (off-host). Live persistence within the volume only.

### 4.5 n8n workflows

This is Kevin's specifically-flagged fear. Investigated:

- Container: `n8n` (image `n8nio/n8n`), Docker-compose stack: `/home/tcntryprd/n8n/`
- Volume: `n8n_n8n_data`
- Postgres backend: `n8n-postgres-1` container (volume `n8n_postgres_data`)
- Workflows live in n8n's Postgres, not in the n8n_data volume directly
- `docker exec n8n n8n list:workflow` returns **17 workflows** including SP Lead Pipeline Engine (×2 IDs — duplicate?), Pessy Outbound Gmail learning, EB Daily Calendar Check, Drive→Weaviate ingestion, etc.

**No backup script touches n8n_postgres or n8n_n8n_data volumes.** Searched for n8n in cron, found nothing. Searched for `n8n*` files on disk, found a stale `n8n-client-intake-workflow.json` (one workflow exported manually) and a 2025 zip in `_Archives/`. The workflows themselves are NOT exported to git.

The `boss_n8n_*` brain tools (11 of them) include `boss_n8n_get_workflow` which COULD be used to dump each workflow to JSON, but no automation does this.

Status: **NOT-BACKED-UP**. Kevin's fear is correct: if the n8n volume or n8n-postgres volume is lost, the 17 workflows are lost. Including the SP Lead Pipeline Engine — which the memory shows is load-bearing for IR Custom AIOS's lead intake.

### 4.6 Memory files (`~/.claude/projects/-home-tcntryprd--claude/memory/`)

- 42 files in the dir (MEMORY.md + 41 body files + this audit's parent context)
- Path: `/home/tcntryprd/.claude/projects/-home-tcntryprd--claude/memory/`
- The `auto-commit-all.sh` sweep does NOT include `/home/tcntryprd/.claude/`
- Searched for `.claude` in the REPOS array of `auto-commit-all.sh:18-32`: not present
- The `~/.claude/backups` dir found (per find) is the harness's own internal backup, not a user-managed one

Status: **NOT-BACKED-UP**. If the home dir is wiped, every memory note is lost. (The skills mirror at `~/.claude/skills` is a symlink to `/home/tcntryprd/sp-hub/skills/` which IS backed up via `auto-commit-all.sh`, so skills are safe — but memory is not.)

### 4.7 IR Custom AIOS config (`~/.openclaw/openclaw.json`, `~/.claude/settings.json`)

- `~/.openclaw/openclaw.json` exists (verified; defines main agent + grok-4 model)
- Not in any backup script
- `~/.claude/settings.json` — same situation

Status: **NOT-BACKED-UP**.

### 4.8 Container images

- All `:1.7.12` images are at `ghcr.io/tcntryprd/boss-{api,web,worker,executor}:1.7.12`
- Build artifacts ARE in GHCR (off-host) — that's a form of durability
- Source code that produces them is in `boss-dev` (off-host via auto-commit + GHA)

Status: **BACKED-UP-VERIFIED** (images in GHCR + source in github.com/TCntryPrd).

### 4.9 Summary table

| Asset | Status | Last verified snapshot | Off-host? |
|---|---|---|---|
| `boss-dev` source | BACKED-UP-VERIFIED | 2026-04-29 20:00 UTC | Yes (github) |
| sp-hub + 13 client trees | BACKED-UP-CLAIMED-NOT-VERIFIED | per cron `:15` hourly | Yes (github) |
| Postgres (boss_db) | LOCAL-only since 2026-04-23 | 2026-04-29 04:00 UTC | **No** (push broken) |
| Weaviate | LOCAL-only since 2026-04-23 | 2026-04-29 04:02 UTC | **No** (push broken) |
| Redis | volume-only | per AOF (everysec) | **No** |
| **n8n workflows** | **NOT-BACKED-UP** | — | **No** |
| **Memory files** (`~/.claude/...`) | **NOT-BACKED-UP** | — | **No** |
| `~/.openclaw/openclaw.json` | NOT-BACKED-UP | — | **No** |
| `~/.claude/settings.json` | NOT-BACKED-UP | — | **No** |
| Container images | BACKED-UP-VERIFIED | continuous via CI | Yes (GHCR) |
| Crontab | NOT-BACKED-UP (in any dump) | — | **No** |
| Host systemd unit files (`boss-agent.service`, etc.) | UNCLEAR (would be in `~/.config/systemd/user/` if user units; not searched) | — | likely **No** |

---

## 5. Gap summary

### 5.1 What's working well

- **Pipeline Engine + Kanban as a unit** — the v1.3.0 backbone fed cleanly into v1.7.11/12 Kanban; data model didn't break across 8 months of versioning.
- **Trust-tier model (`tools/trust.ts`)** — clean, fail-closed, easy to extend. `admin`-gated `boss_self_*` tools are a real foundation for sovereignty.
- **Self-mod tool surface** — 7 tools (`bash`, `self_patch`, `self_grep`, `self_build`, `self_test`, `self_git`, `self_introspect`) genuinely give the brain Claude-Code-equivalent capability against `boss-dev`.
- **CI is bulletproof** — self-hosted runner on `last-castle`, `DEPLOY_HOST=127.0.0.1`, 30+ tags shipped in 6 days with zero failed deploys per memory.
- **Deploy-smoke discipline** — 45+ smokes wired into `scripts/deploy.sh`. Kevin's "if it escaped unit tests, add a smoke" rule is being followed (memory `feedback_deploy_smoke_pattern.md`).
- **CC subprocess + bind-mount architecture** — locked at v1.6.x; rascal/outsider/COO chat all share `runChatTurn` plumbing. Solid base.
- **Deploy ceremony** — `feedback_no_skip_ship_ceremony.md` is being adhered to. Tags + PRs + smokes all green.
- **Code repo durability for source trees** — auto-commit hourly, secret-pattern guard, multi-repo sweep. Solid.

### 5.2 What's missing for sovereignty

1. **No PR/merge automation tool.** IR Custom AIOS can edit + commit on `boss/*` branches but cannot open PRs (no `boss_github_open_pr`), can't merge to master (deliberately blocked), can't push tags. So "IR Custom AIOS ships her own updates" is **half-true** — she can write the code, can't ship it. Kevin is still the bottleneck for every release.
2. **No host-OS management.** `apt` blocked (sudo gate). No systemd unit-level write tool. Firewall/iptables: zero coverage. "Apply OS updates, security config, manage host services" — currently impossible without escalating bash safety AND adding sudoers rules.
3. **No singleton "IR Custom AIOS Self" identity.** The closest things are (a) the perpetual IR Custom AIOSOrb COO thread and (b) the host-native `boss-agent` service on :8010 (which appears to be the legacy `apps/agent` codebase per the v1711 handoff). Neither is wired to be the canonical "IR Custom AIOS herself" Kevin describes. There's no `/me` endpoint, no `boss.identity` brain tool, no thread that survives both restarts AND model swaps with consistent memory.
4. **No CI/PR introspection.** IR Custom AIOS cannot see her own GitHub Actions runs, cannot read PR comments, cannot react to review feedback. `tools/github.ts` is read-only and doesn't include workflow_runs, pull request comments, or check status APIs.
5. **No "host vs container" abstraction.** The `boss_bash` tool runs in the API container with bind-mounts to host paths. That's enough to read host files but not enough for proper host service management. There's no host-level RPC. (The `boss-agent` :8010 service could be that bridge but appears unwired.)
6. **No defensive posture tools.** `boss_sys_*` is observe-only. No fail2ban view, no auth.log scan, no SSH key inventory, no certificate expiry check, no port-exposure audit, no Docker network firewall view.

### 5.3 What's missing for durability (concrete loss exposure)

1. **n8n workflows have ZERO off-host backup.** 17 active workflows in n8n's Postgres (separate `n8n-postgres-1` from IR Custom AIOS's Postgres). No script exports them. The `boss_n8n_get_workflow` tool exists but no cron uses it. **A `docker volume rm n8n_postgres_data` would erase all 17.** This is exactly Kevin's stated fear.
2. **Postgres + Weaviate off-host replication broken since 2026-04-23.** A 173.94 MB Weaviate snapshot exceeded GitHub's 100MB file size limit, broke the `backups` branch push, and **6 consecutive nightly backups have failed silently**. All are local-only in `/tmp/boss-backups/` (which on most Linux systems is tmpfs / ephemeral on reboot — needs verification but `/tmp` is risky regardless). The cron writes to `scripts/logs/backup.log` but there's no alert; the only reason this audit caught it is the 100MB error message in the log.
3. **Memory files are unbacked.** 41 individual body files in `~/.claude/projects/.../memory/`. Each one is the result of a session-of-work decision. None are in git. None are in `auto-commit-all.sh`. A user-home wipe (or even a ham-fisted `rm -rf ~/.claude`) destroys the institutional memory.

---

## 6. Bonus findings (out-of-scope but worth flagging)

- `boss-agent.service` (port 8010) — the host-native daemon — is RUNNING but `apps/agent/package.json` uses `workspace:*` (per v1711 handoff line 56) which is incompatible with the npm workspace setup the rest of the repo uses. The handoff explicitly noted `apps/agent isn't in active deploy` yet the service is alive. Either the service was last restarted before the workspace state matters, or it runs from a stale build. Worth investigating before claiming this is the "IR Custom AIOS Self" host bridge.
- `paperclip/` directory still on disk (and `/paperclip` route+page in `apps/web/src/pages/Paperclip.tsx`) despite Master Plan reconciliation 3 saying "Drop /paperclip route and page from nav." Reconciliation #3 is unimplemented.
- `~/.openclaw/openclaw.json` defines the Gio/COE primary agent's model as `xai/grok-4` (NOT Sonnet 4.6). Memory `project_boss_v17x_shipped.md` references "Sonnet 4.6 default model column on rascals/outsiders" — but that column is for rascals; Gio is on Grok. Inconsistent with plan reconciliation 1 ("Gio at the COE role" with no model spec, but the design pattern is Anthropic).
- `boss_gateway.service` (port 65138) is running but its purpose isn't documented in any memory file — possibly leftover from earlier Tier 3 voice overlay (per `project_boss_tier3_voice_overlay.md`).
- 12 rascals on disk, 13 in the locked roster (`project_little_rascals_roster.md`). Mary Ann is the missing one. Per handoff: 3 unnumbered classics (waldo, woim, maryann) still in `/home/tcntryprd/clients/`, not in `rascals/`. Plan-stated 13-rascal roster is 12+1 split between two trees.
- No `counsel_sessions` table (Phase 8). No `whiteboards` table (Phase 5). Plan slots for these are empty.
- The cron `0 4 * * * backup.sh` runs IN PARALLEL with the 04:02 weaviate finish — so if backup.sh runs >2 minutes (which it does — Weaviate scroll alone is slow), there's no overlap protection. Currently fine because it only runs once daily, but worth knowing.
- `n8n` container has been up 4 days. `boss_homeassistant`, `boss_postgres`, `boss_redis`, `boss_weaviate` all up 4 weeks. `boss_tts` up 6 days. Stack stability is high.

---

## 7. References (file:line citations)

- Master Plan: `/home/tcntryprd/BOSS_MASTER_PLAN.md`
- Trust model: `apps/api/src/tools/trust.ts:24-32` (tier types), `apps/api/src/tools/trust.ts:40-182` (per-tool gates), `apps/api/src/tools/trust.ts:208-222` (role mapping)
- Tool registry: `apps/api/src/tools/registry.ts:64-198` (assembly + gating), `apps/api/src/tools/index.ts` (executor entry)
- Self-mod tools: `apps/api/src/tools/self-mod.ts` (7 tools, all admin-gated)
- System tools: `apps/api/src/tools/system.ts` (4 read-only)
- Bypass mode: `apps/api/src/routes/coo/index.ts:9`, `apps/api/src/routes/coo/chat.ts:7,71`
- COE control (host-config write): `apps/api/src/routes/openclaw/control.ts:40-80`
- Backup script: `scripts/backup.sh:101-194` (postgres/weaviate dumps), `scripts/backup.sh:199-236` (git upload)
- Backup failures: `scripts/logs/backup.log` (every entry since 2026-04-23 shows the 173.94MB rejection)
- Auto-commit (boss-dev): `scripts/auto-commit.sh`
- Auto-commit (sp-hub + 13 clients): `scripts/auto-commit-all.sh:18-32`
- Compose topology: `docker-compose.yml`
- Migration ledger: Postgres `schema_migrations` table (filename, applied_at)
- Smoke catalogue: `scripts/deploy.sh` (45 `log .Smoke` references)
- IR Custom AIOSOrb singleton: `project_boss_v178_v179_shipped.md`
- COO singleton thread: `apps/api/src/routes/coo/threads.ts`
- v1.7.12 ship: `project_boss_v1712_shipped.md`
- Sovereignty inventory: derived from registry.ts + trust.ts cross-check

---

*End of audit.*
