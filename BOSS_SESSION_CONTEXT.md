# IR Custom AIOS — Session Context (Updated April 9, 2026)

Read this file on every new session or after compaction.

## Architecture

```
Dashboard Tabs (port 8005 via Docker nginx):
  / Dashboard    → Command Center + tmux brain stream
  /calendar      → Google Calendar (5 accounts, 30+ calendars)
  /paperclip     → Paperclip agent orchestration (Tailscale :10443 → localhost:9147)
  /crm           → GoHighLevel CRM (app.industryrockstars.ch)
  /code          → Claude Code web UI (stream-json, per-message --resume)

API (port 8010, host-native):
  95+ tools, 13 integrations, 9 CRM tools (GHL)
  Brain: Claude Code CLI in tmux session (boss-brain-claude, grouped with boss-dev)
  Code UI: /api/code/* — session mgmt, SSE streaming, project/session listing

Background Agents:
  Email triage (15 min, 5 accounts, P1-P5 priority)
  Telegram bot (3s polling)
  Kevin Intel (4h)
  Persistent scheduler (60s)

Ports:
  8010  — IR Custom AIOS API (host-native)
  8005  — Dashboard (Docker nginx)
  7749  — n8n (Docker, path /ops/)
  9147  — Paperclip (non-standard, Tailscale :10443)
  64837 — OpenClaw
  8003  — OpenVoice TTS
  8123  — Home Assistant (Tailscale :8443)
  11434 — Ollama (gemma4 installed)
```

## Tailscale Serve (CRITICAL)
Root `/` = dead end. ONLY modify via LocalAPI:
```bash
sudo curl --unix-socket /var/run/tailscale/tailscaled.sock -X GET "http://local-tailscaled.sock/localapi/v0/serve-config"
sudo curl --unix-socket /var/run/tailscale/tailscaled.sock -X POST "http://local-tailscaled.sock/localapi/v0/serve-config" -d @config.json
```
NEVER use `tailscale serve` or `tailscale funnel` CLI commands.

## Claude Code Web UI (/code tab)
- Backend: `apps/api/src/routes/code.ts` — per-message `claude -p --resume <sessionId> --output-format stream-json`
- Frontend: `apps/web/src/pages/Code.tsx` — SSE stream, left sidebar (projects/sessions/skills/MCPs)
- Color scheme: black (#0a0a0a), purple (#a855f7), green (#22c55e), white (#f4f4f5) — Kevin wants this globally
- Sessions stored in `~/.claude/projects/` as JSONL files, read via /api/code/session/history
- Projects decoded from dir names to real paths + package.json names
- Paperclip agents decoded from AGENTS.md instruction files
- Old/archived sessions moved to `~/.claude/projects/_archived_20260409/`

## Google OAuth Token Handling
- 5 accounts: d.caine@dcaine.com, kevin@starrpartners.ai, kevinstarr@industryrockstar.com, travelcraft.dc@gmail.com, absoluterecoverybureau@gmail.com
- Encryption: AES-256-GCM, 16-byte IV (format: iv_hex:authTag_hex:ciphertext_hex)
- CRITICAL: email-triage.ts was using 12-byte IV — FIXED on Apr 9. All tokens re-encrypted.
- Drive uploads: Use running API to refresh tokens first (hit calendar/accounts), then grab from DB
- d.caine@dcaine.com is primary Drive account

## SP Productions (Paperclip)
Company: 9e393025-1323-457f-824b-fdc71a654484
9 agents: CEO, Research Lead, Research Writer, Writer, Editor, Producer, Publisher, Travel Writer, Travel Researcher
5 goals, 3 projects in Paperclip DB

## Social Media Crons (via OpenClaw scripts)
- 8 AM CDT: post-morning.sh
- 1 PM CDT: post-midday.sh
- 5 PM CDT: post-ainews.sh
- 6 PM CDT: post-afternoon.sh
- 11 AM Sunday: post-sunday.sh
Pipeline: Grok → Gemini → Grok image → gog Drive upload → Make webhook

## CRM
Provider: GoHighLevel
Location: NymYyL8jmYkUtvAkDH2e
API key in runtime_config table

## Client Work — Debbie Subcontractor Onboarding
- Original proposal Aug 2025: $22.5K Phase 1, $7.5K Phase 2
- Client went offshore, vendor failed halfway, Debbie requesting rescue Apr 2026
- Reviewed: implementation brief + 8-tab spreadsheet (23-step process)
- Reply drafted and pushed to Drive: Phase 0 audit $5K (non-negotiable), est $42-47K total
- Drive file: 145D_-vyMqLpIi_FjIIjsvpe5wdfgNVHK

## Claude Code Internals Research
Full analysis at `/home/tcntryprd/sp-hub/CLAUDE_CODE_INTERNALS_RESEARCH.json`
Key patterns: Bearer auth, Zod tool schemas, fork-subagent for cache-optimal parallel, 5-tier skills, token budget 90% threshold
Purpose: Model IR Custom AIOS brain architecture — NOT copy code

## Key Files
- Productions: /home/tcntryprd/boss-dev/productions/
- Social scripts: /home/tcntryprd/.openclaw/workspace/post-social.sh
- Voice guide: /home/tcntryprd/sp-brand/kevin-voice-guide.md
- Travel state: productions/state/newsroom/travel-countries-used.json
- Micazen docs: /home/tcntryprd/boss-dev/docs/BCAI-Phase-*-Spec.md + governance docs
- Session memory: ~/.claude/projects/-home-tcntryprd-sp-hub/memory/
- Claude Code internals: /home/tcntryprd/sp-hub/CLAUDE_CODE_INTERNALS_RESEARCH.json
- Archived sessions: ~/.claude/projects/_archived_20260409/
