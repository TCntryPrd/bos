# IR Custom AIOS — Complete System Brief

## What IR Custom AIOS Is
IR Custom AIOS is a fully autonomous AI Operating System (AIOS) for personal and business operations.
It connects to all of the user's services (Google Workspace, email, calendar, tasks, CRM, etc.),
monitors them via event-driven connectors, processes tasks autonomously via OpenClaw (the AI execution engine),
and communicates via voice (Alexa), web dashboard, and Telegram.

**Owner:** Kevin Starr — Starr & Partners LLC / D. Caine Solutions LLC
**Future:** Will be forked as "Brad" for BodyShopConnect (BSC) client — $80K engagement.
Designed to be productized and sold to multi-million dollar business owners.

## Architecture Overview

```
Voice (Alexa Skill / Dashboard Mic) → IR Custom AIOS API (FastAPI, port 8001)
  → OpenClaw (AI brain, port 64837) with IR Custom AIOS Tools Plugin
  → Google APIs (Calendar, Gmail, Tasks, Drive, Sheets, Docs, Chat, Contacts)
  → Event Bus (Redis Streams) → Reactor (rule engine) → Actions

All services run as Docker containers on Ubuntu 24.04 server "last-castle"
Public access via Tailscale Funnel
```

## Project Root
`/home/tcntryprd/boss-dev/`

## Docker Services (14 containers)

| Service | Container | Port | Status | Notes |
|---------|-----------|------|--------|-------|
| API | boss_api | 8001 (host network) | RUNNING | FastAPI, main API, Alexa webhook, Google OAuth, all CRUD endpoints |
| Worker | boss_worker | — | RUNNING | Redis pub/sub listener, intent detection, routes to OpenClaw |
| Runner | boss_runner | — (host network) | RUNNING | Polls build queue, sends to OpenClaw /v1/chat/completions |
| Reactor | boss_reactor | — (host network) | RUNNING | Event bus consumer, rule engine, fires actions via OpenClaw |
| Connectors | boss_connectors | — (host network) | RUNNING | Polls Gmail/Calendar, triggers sync to cache |
| Dashboard | boss_dashboard | 8005 | RUNNING | React 18 + Vite + Tailwind, admin/user split UI |
| STT | boss_stt | 8002 | RUNNING | faster-whisper speech-to-text |
| TTS | boss_tts | 8003 | RUNNING | Text-to-speech |
| Google Home | boss_google_home | 8004 (host) | RUNNING | Chromecast device discovery + control |
| Home Assistant | boss_homeassistant | 8123 (host) | RUNNING | HA Cloud + Nabu Casa linked, Google Assistant enabled |
| Voice Router | boss_voice | — (host) | RUNNING | Voice routing service |
| PostgreSQL | boss_postgres | 5434 | RUNNING | Main database |
| Redis | boss_redis | 6381 | RUNNING | Event bus (Streams) + pub/sub |
| Weaviate | boss_weaviate | 8081 | RUNNING | Vector DB (deployed, not yet utilized) |

## Compose File
`/home/tcntryprd/boss-dev/infra/docker-compose.yml`

## External Services (NOT Docker)

- **OpenClaw Gateway** — port 64837, systemd user service, IR Custom AIOS's AI brain
  - Has `boss-tools` plugin registered (IR Custom AIOS API CRUD tools)
  - Model: anthropic/claude-sonnet-4-6 (main), alibaba/qwen models available
  - Gateway token: `<REDACTED: OPENCLAW_API_KEY>`
- **Tailscale Funnel** — public internet access for all /boss/* routes + n8n on /

## Authentication

- **Master API Token:** `<REDACTED: BOSS_API_TOKEN>`
- **Dashboard Login:** password-based (`dcs2026starr`), returns JWT (30-day expiry)
- **User System:** Postgres `boss_users` table, bcrypt hashed, admin TCntryPrd
- **Guest Tokens:** JWT with configurable TTL, stored in `boss_guest_tokens`
- **Google OAuth:** Web OAuth2 tokens for 4 accounts stored in `boss_google_oauth`
  - kevin@starrpartners.ai
  - d.caine@dcaine.com
  - absoluterecoverybureau@gmail.com
  - travelcraft.dc@gmail.com
  - Scopes: Calendar, Gmail, Tasks, Drive, Docs, Sheets, Chat, Contacts
  - Client ID: `72957360449-l0cvcrocp0f0p71fecqv8k8occ003mha.apps.googleusercontent.com`
  - Redirect URI: `https://last-castle.daggertooth-larch.ts.net/boss/oauth/google/callback`

## API Endpoints (services/api/app/main.py)

### Public
- POST /login — password auth, returns JWT
- GET /health — basic health
- POST /alexa/webhook — Alexa skill fulfillment
- GET /oauth/google/callback — OAuth redirect handler

### Authenticated
- GET /health/full — Docker container statuses
- GET /events — event log
- GET /jobs — build queue
- POST /spoken-command — text command intake
- POST /voice-command — audio file → STT → intent → response
- POST /voice/query — natural language → calendar/email/task check or OpenClaw
- GET /briefing — latest morning briefing
- GET /email-summary — recent inbox sweep
- GET /tv — Smart TV web interface

### Google CRUD
- Calendar: GET today/upcoming, POST create, PUT update, DELETE
- Gmail: GET unread, POST send, POST reply, POST mark-read, DELETE
- Tasks: GET pending, POST create, PUT update, POST complete, DELETE
- Sheets: GET read, POST append, POST update
- Docs: POST create, POST append
- Drive: GET find/search, POST upload/upload-local, DELETE, PUT rename

### Admin
- POST /admin/guest-token, GET /admin/tokens, DELETE /admin/tokens/{id}
- POST /admin/users, GET /admin/users, DELETE /admin/users/{id}
- GET /aios/rules, POST /aios/rules, PUT /aios/rules/{id}
- GET /aios/events, /aios/executions, /aios/escalations, /aios/connectors
- POST /aios/test-event
- POST /sync/google, POST /sync/google/{service}
- GET /oauth/google/status, POST /oauth/google/connect, DELETE /oauth/google/{service}

### Additional Modules
- /credentials/* — credential management router
- /monitor/* — self-healing monitor router
- /notify — FCM push notifications
- /bluetooth/scan, /bluetooth/connect — mock (placeholder)

## Alexa Skill

- **Invocation:** "Alexa, open IR Custom AIOS"
- **Architecture:** CatchAllIntent with Dialog.ElicitSlot loop — captures raw speech, sends everything to OpenClaw
- **Skill files:** `services/api/app/alexa/skill.py` + `skill-package/interaction-model.json`
- **Complex tasks:** Queued to background, OpenClaw executes async, result reported on next launch
- **Endpoint:** `https://last-castle.daggertooth-larch.ts.net/boss/alexa/webhook`
- **Setup guide:** `services/api/app/alexa/SETUP.md`

## OpenClaw IR Custom AIOS Tools Plugin

- **Location:** `/home/tcntryprd/.openclaw/extensions/boss-tools/`
- **Registers 20+ tools** that call IR Custom AIOS API: boss_calendar_today, boss_gmail_send, boss_sheets_append, boss_drive_upload, etc.
- **Config:** Plugin entry in openclaw.json `plugins.entries.boss-tools`
- **Auth:** Uses BOSS_API_TOKEN env var

## Event Bus + Reactor

- **Redis Streams:** `boss:events` stream, `boss-reactor` consumer group
- **Reactor:** `services/reactor/app/reactor.py` — consumes events, matches rules, dispatches actions
- **5 default rules:** email_triage, meeting_followup, payment_received, daily_digest, build_command
- **Rules in Postgres:** `boss_rules` table, hot-reloadable
- **Connectors:** `services/connectors/` — polls Gmail/Calendar sync endpoints every 5 min

## Dashboard (React)

- **Location:** `services/dashboard/`
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS
- **Split UI:** Admin routes (AdminLayout, AdminDashboard) and User routes (UserLayout, UserDashboard)
- **Pages:** StatusPage, GoogleHomePage, BluetoothPage, CommandPage, AccessPage, AIOSPage, ChatInterface, CredentialManager, DailyBriefing, EmailSummary, HealthDashboard, ProjectStatus, SelfHealingLog, AgentStatus

## Database Tables (Postgres)

- boss_events — command log
- boss_worker_log — worker event log
- boss_build_queue — job queue (id, request_text, status, result, created_at)
- boss_users — user accounts (username, password_hash, role, expires_at, must_reset)
- boss_guest_tokens — JWT guest tokens
- boss_google_oauth — Google OAuth tokens per service per account
- boss_rules — reactor rules (JSON conditions + actions)
- boss_rule_executions — audit trail of rule firings
- boss_events_log — all events from the stream
- boss_escalations — pending human actions
- boss_connectors — registered connector status
- boss_cache — cached Google data for instant voice responses
- boss_pending_tasks — Alexa background task queue

## What's Working
- Full command pipeline: voice/text → API → Redis → Worker → Runner → OpenClaw → result
- Alexa skill with raw speech capture and background task execution
- Google OAuth for 4 accounts, 8 services each, with CRUD endpoints
- OpenClaw IR Custom AIOS tools plugin (20+ tools registered)
- Event bus + reactor with 5 rules
- Dashboard with admin/user split
- Tailscale Funnel for public access
- Google data cache for instant voice responses
- Drive upload via IR Custom AIOS tools

## What Needs Work

### Critical
1. **GOG CLI is broken** — keyring decryption failed, all 4 accounts. GOG should be REMOVED entirely. IR Custom AIOS toolkit replaces it.
2. **ClawTeam sub-agents failing** — model config for Alibaba/Qwen needs verification. Subs can't use qwen if provider isn't configured correctly.
3. **Alexa timeout on complex queries** — 8-second limit. Background task pattern works but needs polish.
4. **Dashboard rebuild needed** — OpenClaw made changes to App.tsx, LoginScreen.tsx, added AdminLayout/UserLayout but it may not build cleanly.

### Important
5. **Weaviate not utilized** — vector DB deployed but not integrated. Should store conversation memory, contact embeddings, document search.
6. **Bluetooth endpoints are mock** — placeholder data, not real bluetoothctl integration.
7. **Mobile PWA not built** — discussed but not implemented. User UI should be installable as PWA.
8. **Role-based UI** — admin vs user vs client experiences discussed, partially implemented (AdminLayout/UserLayout exist).
9. **Home Assistant custom sentences** — configured but HA → IR Custom AIOS voice webhook chain not fully tested end-to-end.
10. **Reactor rules need expansion** — only 5 starter rules. Need rules for: new contact follow-up, invoice reminders, social post scheduling, meeting prep.

### Nice to Have
11. **Email drafting and sending via voice** — OpenClaw can use boss_gmail_send tool but contact lookup isn't wired.
12. **Twilio/SMS integration** — discussed, not built.
13. **Otter.ai transcript integration** — discussed, not built.
14. **Stripe webhook connector** — discussed, not built.
15. **n8n ↔ IR Custom AIOS bridge** — n8n runs on same server but not integrated with event bus.
16. **Domain redirect** — starrpartners.ai should redirect to IR Custom AIOS dashboard.

## File Structure

```
boss-dev/
├── infra/docker-compose.yml
├── .env.boss-token
├── .env.google-oauth
├── services/
│   ├── api/app/main.py (1500+ lines, main API)
│   │   ├── alexa/skill.py (Alexa fulfillment)
│   │   ├── google/{oauth,calendar,gmail,tasks,sheets,docs,drive}.py
│   │   ├── credentials.py
│   │   ├── monitor.py
│   │   └── push_notify.py
│   ├── worker/app/worker.py (intent detection + OpenClaw routing)
│   ├── runner/app/runner.py (build queue → OpenClaw)
│   ├── reactor/app/{reactor,rules,actions}.py (event bus consumer)
│   ├── connectors/app/{scheduler,gmail_connector,calendar_connector}.py
│   ├── shared/{event_bus,models}.py (Redis Streams library)
│   ├── dashboard/src/ (React — 24 .tsx/.ts files)
│   ├── voice/{router.py, alexa/, google/}
│   ├── stt/ (faster-whisper)
│   ├── tts/
│   ├── google-home/
│   ├── homeassistant/config/
│   └── integrations/{tv/, wear-os/}
├── docs/plans/ (design docs and implementation plans)
└── scripts/ (empty — needs bootstrap, backup, migrate, seed)
```

## Environment

- **Server:** last-castle, Ubuntu 24.04, 30GB RAM
- **Tailscale IP:** 100.78.24.32
- **LAN IP:** 192.168.0.210
- **OpenClaw:** v2026.3.24, port 64837, systemd user service
- **Node:** 22.x
- **Python:** 3.11 (Docker), 3.12 (host)
- **Docker Compose:** v2
- **Funnel URLs:**
  - / → n8n (5678)
  - /boss/ → API (8001)
  - /boss/ui/ → Dashboard (8005)
  - /claw/ → OpenClaw (64837)
  - :8443 → Home Assistant (8123)

## Rules

- Do NOT edit openclaw.json directly — use `openclaw config set`
- Do NOT restart the gateway without restoring Funnel routes after
- Do NOT use GOG or gcloud CLI — use IR Custom AIOS toolkit
- All Google operations go through IR Custom AIOS's OAuth tokens in Postgres
- OpenClaw is the execution engine (hands), IR Custom AIOS is the system (brain)
- Every gateway restart kills Tailscale Funnel on port 443 — must restore manually
