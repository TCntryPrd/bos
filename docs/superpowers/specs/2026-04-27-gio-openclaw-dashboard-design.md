# Gio / OpenClaw Dashboard — Design Spec

**Date:** 2026-04-27
**Target ship:** v1.7.6
**Author:** brainstorm session, Kevin Starr + Claude
**Surface:** `/oc` page in IR Custom AIOS (replaces current `comingSoon` placeholder)
**Audience:** admin only (Kevin); same gating as the existing "COE - Gio" NavRail entry

## Why this exists

IR Custom AIOS is the apex of Kevin's agent stack. OpenClaw was the previous home; today it's on probation — Kevin is justifying whether to keep it. This dashboard exists so Kevin can:

1. **See OpenClaw's full state at a glance** — gateway up/down, agent + active model, channel status, memory index health, skill inventory.
2. **Talk to Gio** without leaving IR Custom AIOS, with persistent session memory so it feels like the tmux-window setup he used previously (CC + terminal + OC).
3. **Run a small set of safe operator actions** — restart gateway, reindex memory, take a backup, swap model — so he can poke without dropping into a separate shell.
4. **Decide what to keep** — by surfacing the inventory (skills, providers, channels), the dashboard makes the keep / fork / kill decision visible.

The three concrete OpenClaw assets that justify keeping it (per Kevin's brainstorm answers):

- **Telegram channel** — owns the text-modality path to Kevin (IR Custom AIOS's Twilio owns voice, in parallel; they don't compete).
- **Skill / plugin / tools framework** — 52 bundled skills (21 currently ready). Reusable surface that IR Custom AIOS rascals don't have a parallel for.
- **Multi-provider runtime including xAI / Grok** — IR Custom AIOS is locked to Anthropic via `claude -p`; OpenClaw can run Grok, ollama, etc.

## Non-goals (v1)

- Editing memory files (SOUL/IDENTITY/MEMORY/USER/HEARTBEAT) from the dashboard. Read-only viewer in v1.
- Sending outbound messages *as Gio* to a channel.
- Skill enable / disable / install UX.
- Killing or starting individual channels.
- Cross-device session continuity (v1 uses browser localStorage; if Kevin opens a different machine, he gets a fresh chat).
- DB tables for OpenClaw state. All read-through from CLI; no caching layer.
- Reverse-engineering the OpenClaw HTTP gateway endpoints. CLI shell-out is the integration boundary.

## Architecture

### Boundary

IR Custom AIOS treats OpenClaw as an external service with a CLI binding, the same way a git client treats `git`. **No code changes to OpenClaw itself.** IR Custom AIOS shells out to `/usr/bin/openclaw <subcommand> --json` per request and parses the result.

```
Browser
  → boss_web (proxy)
  → boss_api: GET/POST /api/openclaw/...
  → child_process.spawn('openclaw', [...args, '--json'])
  → openclaw CLI talks to its own gateway daemon (host: 127.0.0.1:18789, token-auth)
  → JSON stdout
  → boss_api parses + returns to browser
```

### Container wiring

Add to the `boss_api` service in `docker-compose.yml` (and the production override file referenced by `scripts/deploy.sh`):

```yaml
volumes:
  - /usr/bin/openclaw:/usr/bin/openclaw:ro
  - /home/tcntryprd/.openclaw:/home/tcntryprd/.openclaw
```

`HOME=/home/tcntryprd` is already set on `boss_api` (per v1.7.1 standing rule #16), so `openclaw` resolves `~/.openclaw` correctly inside the container.

The `openclaw-gateway` daemon runs on the host (PID-1 systemd-managed, listening on `127.0.0.1:18789`). IR Custom AIOS does NOT manage that daemon; it's a host-side concern. IR Custom AIOS only invokes the CLI, which talks to the gateway over loopback inside the host network namespace. Because the CLI runs *inside* `boss_api`'s container, we may need `network_mode: host` on `boss_api` OR an extra step to expose the gateway to the container — **resolve during implementation by testing whether the CLI auto-connects via the bind-mounted `~/.openclaw/openclaw.json` (which contains the gateway URL + token) without needing host networking.** If host networking is required and conflicts with the existing reverse-proxy setup, fallback is to route gateway calls through a `host.docker.internal:18789` rewrite. The deploy-smoke (below) catches this regression.

### Code layout

**Backend** (`apps/api/src/`):

```
openclaw/
  runOpenclaw.ts          // wrapper: child_process.spawn('openclaw', [...args, '--json']) → JSON
  index.ts                 // route registration helper
routes/openclaw/
  overview.ts              // GET /api/openclaw/overview              — status strip (fan-out)
  channels.ts              // GET /api/openclaw/channels              — channel inventory + providers
  skills.ts                // GET /api/openclaw/skills                — list (52 / 21 ready)
                           // GET /api/openclaw/skills/:id            — detail (lazy on expand)
  memory.ts                // GET /api/openclaw/memory                — index status
                           // GET /api/openclaw/memory/files          — list workspace .md files
                           // GET /api/openclaw/memory/files/:name    — read file content
  models.ts                // GET /api/openclaw/models                — list (powers swap modal)
  chat.ts                  // POST /api/openclaw/chat                 — SSE stream
  control.ts               // POST /api/openclaw/control/:action      — restart / reindex / backup / set-model
```

Seven route files exposing ten endpoints.

All routes are admin-only. Reuse whatever guard the existing `/coo` route uses, or add the smallest possible `request.user.isAdmin` check if no such guard exists.

**Frontend** (`apps/web/src/`):

```
pages/OC.tsx               // full rewrite — Layout B (status strip + accordion + chat)
components/openclaw/
  StatusStrip.tsx          // top bar — pills
  InventoryAccordion.tsx   // left — Channels / Skills / Memory / Providers sections
  ChatPane.tsx             // right — SSE chat with Gio + "⋯" menu
  ControlsMenu.tsx         // contents of the "⋯" overflow menu
```

Reuses existing UI primitives (Card, Pill, Button) — no new design tokens.

## Data flow per panel

### Status strip (top, ~80px)

Single endpoint `GET /api/openclaw/overview` fans out to multiple CLI calls in parallel server-side and returns one merged JSON. Frontend polls one URL every **10s**.

| Pill | Source CLI | Field |
|---|---|---|
| Gateway state | `openclaw health` | `status === "live"` → green; else red |
| Active agent + model | `openclaw agents list --json` | default agent's `id` + `model` |
| Channel status | `openclaw channels list --json` | one pill per enabled channel |
| Memory index | `openclaw memory status --json` | green if index ready, amber if reindexing |
| Uptime | `openclaw daemon status` start-time | derived |

### Inventory accordion (left, ~40% width)

Four collapsible sections. Each section's data fetch is **lazy** (deferred until first expand) and then **polls every 30s** while open.

#### ▾ Channels
- **Endpoint:** `GET /api/openclaw/channels`
- **CLI:** `openclaw channels list --json`
- **Row:** name + transport (telegram/discord/etc) + enabled bool + auth state + mention-only flag
- **Click row:** inline expand showing channel's recent metadata (no probe call in v1)

#### ▾ Skills (52 / 21 ready as of writing)
- **List endpoint:** `GET /api/openclaw/skills`
- **List CLI:** `openclaw skills list --json`
- **Row:** emoji + skill name + ready/needs-setup status + source (`openclaw-bundled` vs other)
- **Click row:** inline expand → `GET /api/openclaw/skills/:id` → CLI `openclaw skills info <id>` → show full description + setup hints. No actions in v1 (no enable/disable/install).

#### ▾ Memory files
- **Endpoint:** `GET /api/openclaw/memory/files` returns the curated list (`SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `USER.md`, `HEARTBEAT.md`, `AGENTS.md`, `TOOLS.md`) plus any other top-level `.md` files in `~/.openclaw/workspace/`. Reads from the bind-mounted filesystem directly (not via CLI — files are local).
- **Row:** filename + size + last-modified
- **Click row:** inline expand → `GET /api/openclaw/memory/files/:name` → returns file contents → frontend renders markdown read-only.

#### ▾ Providers
- **Endpoint:** Reuses `GET /api/openclaw/channels` response (the `auth providers` section it returns).
- **Row:** provider id (e.g. `ollama:default`, `xai:default`) + auth-mode (`api_key`) + ready bool

### Chat — Gio (right, ~60% width)

Mirror of the existing rascal-chat pattern (see `apps/api/src/routes/rascals/chat.ts` for reference shape).

- **Persistence model:** browser stores `boss_oc_session_id` in localStorage. First chat turn on a fresh browser sends no session id; backend captures the id from the OpenClaw response and returns it; frontend stores it. Every subsequent turn passes it back.
- **Endpoint:** `POST /api/openclaw/chat` — request body `{ message, sessionId?, thinkingLevel? }`. Returns SSE stream.
- **CLI:** `openclaw agent --message "<msg>" --json --session-id <id?>` (omit `--session-id` on first turn). The CLI's stdout is line-delimited JSON; boss_api forwards each line as an SSE `data:` event.
- **Header:** "Chat — Gio" + the "⋯" menu.
- **Failure:** if openclaw exits non-zero, frontend shows "Gio is unreachable — gateway may be down" inline; the input is disabled until the next overview poll succeeds.

### "⋯" menu (chat header overflow) — controls

Each control hits `POST /api/openclaw/control/<action>`. Destructive actions show a confirm dialog before firing.

| Action | Endpoint slug | CLI | Confirm? |
|---|---|---|---|
| Restart gateway | `restart` | `openclaw daemon restart` | yes |
| Reindex memory | `reindex-memory` | `openclaw memory index` | no (idempotent) |
| Backup state | `backup` | `openclaw backup create` | no (additive) |
| Swap default model | `set-model` | `openclaw models set <provider/model> --agent main` | yes |
| Open OpenClaw Control UI | `open-ui` (frontend deeplink only) | n/a — `<a href="http://localhost:18789/" target="_blank">` | no |

**Model-swap UX:** clicking "Swap model" opens a modal; modal calls `GET /api/openclaw/models` (CLI: `openclaw models list --json`) to populate a grouped dropdown (provider → model). Selecting a model + confirm fires `POST /api/openclaw/control/set-model { provider, model }`. Status strip pill updates on the next 10s poll.

## Error handling

Three failure modes; each has a defined surface:

1. **Gateway down** — `openclaw health` returns non-`live`. Status pill flips to red `gateway down`. Chat input disables with hint `OpenClaw gateway is not responding — check 'openclaw daemon status' on host`. Inventory panels show last-cached values dimmed until the next polling success.
2. **CLI binary missing inside the container** — full-page error card: `OpenClaw not bound into this container — see deploy.sh openclaw smoke`. Caught by deploy-smoke (below).
3. **CLI returns non-JSON / malformed JSON** — log full stderr to api log, return `{ error, stderrTail }` to frontend. Affected panel shows inline `Couldn't parse OpenClaw response — see api log`. Other panels keep working.

All `runOpenclaw` invocations go through one wrapper that:
- Sets a 30-second timeout (kill child on overrun)
- Captures both stdout and stderr
- Logs `{ args, exitCode, stderrTail, durationMs }` on every call (debug-level)
- Surfaces non-zero exit with stderr tail to the calling route

## Deploy-smoke (per standing rule #4)

Add to `scripts/deploy.sh` immediately after the existing rascal-chat infra smokes:

```bash
# OpenClaw bind-mount smoke (v1.7.6): the /oc dashboard requires the
# openclaw CLI binary visible inside boss_api and the gateway daemon
# responsive on the host. If either is missing, the dashboard 503s on
# every read.
log "Running OpenClaw bind-mount smoke..."
oc_ver=$(docker exec boss_api sh -c 'openclaw --version' 2>/dev/null | tr -d '[:space:]')
if [ -z "$oc_ver" ]; then
    fail "OpenClaw smoke failed: 'openclaw' CLI not found inside boss_api. Check (a) /usr/bin/openclaw bind mount in docker-compose.yml, (b) /home/tcntryprd/.openclaw bind mount, (c) HOME=/home/tcntryprd env var (v1.7.1 rule #16)."
fi
oc_health=$(docker exec boss_api sh -c 'openclaw health 2>&1' | tr '\n' ' ' | head -c 200)
if ! echo "$oc_health" | grep -qE '"status":"live"|ok'; then
    fail "OpenClaw smoke failed: 'openclaw health' from inside boss_api did not return a live signal. Got: $oc_health. Gateway may not be running on host (try 'openclaw daemon status' on the host) or token in ~/.openclaw/openclaw.json may have rotated."
fi
log "OpenClaw smoke passed (binary v$oc_ver visible in api, gateway responsive)"
```

This becomes the 31st deploy-smoke (v1.7.4 baseline was 30).

## Ship slicing

### v1.7.6 (this ship — single PR + tag)

- Three docker-compose bind-mount additions on `boss_api` (and the production override block)
- `apps/api/src/openclaw/runOpenclaw.ts` wrapper
- Seven new route files under `apps/api/src/routes/openclaw/` exposing ten endpoints (overview, channels, skills + skills/:id, memory + memory/files + memory/files/:name, models, chat, control/:action)
- Full rewrite of `apps/web/src/pages/OC.tsx` to Layout B (read-only inventory + persistent chat + "⋯" controls)
- Five operator controls (restart / reindex / backup / set-model / open-ui-deeplink)
- Model-swap modal + `GET /api/openclaw/models` route
- Deploy-smoke (above)
- Admin-gating on every `/api/openclaw/*` route
- `.gitignore` entry for `.superpowers/` (cleanup of brainstorm noise — not strictly part of the feature, but ships in the same PR since the brainstorm transient files are blocking clean checkouts)

### v1.7.7+ (deferred, pull when actually needed)

- Memory file editing (with optimistic write + conflict detection against `mtime`)
- Send-message-as-Gio control (per-channel target picker)
- Skill enable / disable / install UX
- DB-backed cross-device chat-session persistence (move out of localStorage into a small `boss_oc_sessions` table)
- Per-channel kill / start controls
- Telegram message stream tail (live SSE of inbound traffic to Gio)

## Standing rules touched

- **Rule #4 (every ship adds a deploy-smoke):** satisfied by the OpenClaw bind-mount smoke above.
- **Rule #15 (new compose service in `APP_SERVICES` + image override):** N/A — no new service, just bind-mounts on existing `boss_api`.
- **Rule #16 (HOME=/home/tcntryprd):** required by this ship (already in place from v1.7.1).
- **Rule #2 (branch off last clean tag):** v1.7.6 branches off v1.7.4 (or whatever last clean tag exists when implementation begins).

## Open questions for implementation phase

These are deliberately deferred to the writing-plans / executing-plans phase:

1. **Container networking:** does `openclaw` CLI inside `boss_api` reach the host's `127.0.0.1:18789` gateway out-of-the-box (via the bind-mounted config + token), or do we need `network_mode: host` or `host.docker.internal` rewriting? Test in the first implementation step; the deploy-smoke catches the regression either way.
2. **Admin guard mechanism:** does the existing `/coo` route enforce admin-only via middleware, route config, or front-end-only? Match whatever pattern exists; if none exists, add the minimal guard.
3. **OpenClaw CLI subcommand exact flags:** `openclaw skills info <id>` — verify exact flag during implementation. Same for `openclaw memory status --json` (subcommand exists per `--help`; flag presence verified at impl time).
4. **Channel status freshness:** v1 skips `--probe` on channel listing (probe takes 10s default timeout per `openclaw status --probe` help). If the un-probed status is too stale to be useful, add a manual "Probe channels" button in v1.x.
5. **Session id capture on first turn:** the design assumes `openclaw agent --json` (with no `--session-id` passed) prints the newly-created session id somewhere in its JSON output that the wrapper can capture. Verify in the first implementation step. If not, fall back to creating the session up-front via a separate command and threading the id from there.

---

*End of spec.*
