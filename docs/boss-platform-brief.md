# IR Custom AIOS — Platform Brief for IR Custom AIOS, Starr & Partners

## What IR Custom AIOS Is

The proprietary AI Operating System powering Starr & Partners. Host-native on the last-castle server (Ubuntu). Every agent, automation, and client delivery runs through it.

## Architecture

```
[Dashboard UI :8005] → nginx → [IR Custom AIOS API :8010] → [Claude Code tmux brain]
                                      ↓
                              [Background Agents]
                              - Email triage (5 Google accounts, 15 min)
                              - Telegram bot (3s polling)
                              - Kevin Intel (4h learning cycle)
                              - Persistent agent scheduler (60s)
                                      ↓
                              [Postgres :5434]
                              - Auth, tokens, conversations, memory
                              - Email logs, persistent agents
```

## What Is Built and Working

### Core Platform
- Host-native agent (NOT Docker) — direct filesystem/shell/git/docker access
- CLI brain adapter — persistent Claude Code tmux session as the primary brain
- SSE streaming — dashboard streams live tmux output at 200ms
- Default brain is Claude Code CLI — terminal view in dashboard
- 9-digit passkey auth, Postgres-backed conversations (500 msg, survives restarts)
- 95+ tools across 15 integrations

### Integrations (13 connected)
Google (5 accounts), n8n, Notion, Airtable, Slack, Telegram, Make, Stripe, Home Assistant, Gemini, GitHub, YouTube, Spotify

### Background Agents Running
- **Email triage:** 5 accounts, P1/P2/P3/AUTOMATED/PROMO classification, Telegram P1 alerts, ARB/TC auto-archive promo
- **Telegram bot:** paired users, send-and-wait approval flow
- **Kevin Intel:** learns from email/calendar/drive patterns
- **Persistent agent scheduler:** cron-based, Postgres-backed

### Operations Agents (DEFINED, ready for Paperclip scheduling)
- **Email triage team** (4 agents): categorizer, P1 drafter, P2 drafter, logger
- **Outreach & CRM** (6 agents): sheet reader, prioritizer, personalizer, sender (10/day cap), followup, reporter
- **Client support** (6 agents): status checker, deliverables tracker, Magnussen Friday, Micazen monitor, Pessy pusher, weekly report
- **Infra & ops** (5 agents): health checker, rate monitor, drive organizer, Tailscale enforcer, daily report

### Dashboard UI
- Terminal view into Claude Code brain session
- Tiles: Make, Stripe, Notion, Airtable, Slack, Telegram, YouTube, Spotify
- Spotify player with Web Playback SDK
- Drag-to-reorder tiles, resizable chat panel

### Voice
- Home Assistant Voice PE with custom boss_conversation component

### Client Work
- Micazen/BodyShopConnect SOWs ready (V3: $135K-$240K, V4: $195K-$360K)
- Strategic brief + SOWs in Google Drive

## Beta Blockers

### P0
1. **Git push blocked** — 106MB AppImage in history, needs force push
2. **Desktop app untested** — Electron AppImage built, never launched
3. **Register 21 ops agents in Paperclip** — sync script ready at `productions/scripts/sync-to-paperclip.ts`
4. **Email triage draft replies** — classification works, drafting agents need Paperclip scheduling

### P1
5. Spotify dev mode restrictions
6. Voice PE hardware testing
7. SSH to Kevin's laptop (Windows OpenSSH)
8. Outreach pipeline testing (245 leads in Google Sheet)

### P2
9. Desktop app auto-update
10. Client support agent testing
11. Infra monitoring agent testing

## Tech Stack
Node.js 20+ / TypeScript / Fastify 5 / React + Vite + Tailwind / Postgres / Claude Code CLI (tmux) / Paperclip (port 3100) / edge-tts + OpenVoice / ffmpeg / Electron / Tailscale / Caddy

## Key Files
- API: `apps/api/src/index.ts`
- Brain: `apps/api/src/brain/cli-adapter.ts`
- Tools: `apps/api/src/tools/executor.ts` (~5000 lines)
- Dashboard: `apps/web/src/pages/Dashboard.tsx`
- Ops agents: `productions/agents/<name>/agent.yaml` + `prompt.md`
- Paperclip sync: `productions/scripts/sync-to-paperclip.ts`
- Client SOWs: `docs/SOW-BCAI-V3-Sovereign-AI.md`, `docs/SOW-BCAI-V4-Sovereign-Ted.md`
