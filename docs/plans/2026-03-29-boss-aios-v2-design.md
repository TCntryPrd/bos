# IR Custom AIOS v2 — Complete System Design

**Date:** 2026-03-29
**Author:** Claude Code (Lead Engineer)
**Approved by:** Kevin Starr
**Status:** Approved — Ready for Implementation

---

## 1. Vision

IR Custom AIOS v2 is a brain-agnostic, voice-first AI Operating System for personal and business operations. It connects to a user's business suite (Microsoft 365 or Google Workspace), learns their patterns and preferences over time, and operates autonomously — handling communications, scheduling, task management, file organization, and business workflows with minimal human intervention.

It is self-healing, self-learning, and self-improving. The longer it runs, the more reliable it becomes and the better it knows its human.

**Owner:** Kevin Starr — Starr & Partners LLC / D. Caine Solutions LLC
**Prototype for:** BSC/Brad — BodyShopConnect ($660K / 24-month engagement)
**Productization:** Designed to be deployed for multi-million dollar business owners as single-tenant or multi-tenant SaaS.

---

## 2. Architecture Overview

```
Voice Devices (HA Voice PE) ────┐
Web UI (React) ─────────────────┤
Windows App (Electron) ────────┼──> IR Custom AIOS Core API (Fastify/TypeScript)
Mobile App (React Native) ─────┘         |
                                         |-- Brain Router (capability-based)
                                         |     |-- Claude Code adapter
                                         |     |-- OpenAI/Codex adapter
                                         |     |-- Gemini adapter
                                         |     |-- OpenClaw adapter
                                         |     +-- Custom OpenAPI adapter
                                         |
                                         |-- Connector Layer
                                         |     |-- Microsoft 365 (Graph API)
                                         |     |-- Google Workspace (APIs)
                                         |     +-- Unified Interface
                                         |
                                         |-- Self-Healing Engine
                                         |     |-- Health monitor (30s heartbeat)
                                         |     |-- Diagnostic agent (3 attempts before escalate)
                                         |     +-- Playbook builder (immune memory)
                                         |
                                         |-- Learning Engine
                                         |     |-- Onboarding deep dive (historical ingest)
                                         |     |-- Behavioral observer (passive pattern learning)
                                         |     |-- Explicit preferences (user corrections)
                                         |     |-- Business intelligence (org-level patterns)
                                         |     +-- Device ingest & cleanup agent
                                         |
                                         +-- Data Layer
                                               |-- Postgres (structured data, per-tenant schemas)
                                               |-- Weaviate (vector embeddings, semantic memory)
                                               |-- Redis (event bus, cache, pub/sub)
                                               +-- Encrypted backup system (double-auth, 30-60min interval)
```

**Stack:** TypeScript everywhere — Fastify API, React web, Electron desktop, React Native mobile. One language across the entire system.

**Tenant model:** Single-tenant Docker Compose for premium/self-hosted. Multi-tenant with schema-isolated databases for SaaS. Same codebase, tenant config determines mode.

---

## 3. Brain Router & Capability System

The Brain Router is the core abstraction that makes IR Custom AIOS brain-agnostic. Every AI interaction flows through it. It doesn't care which brain is behind it — it cares what the brain can do.

### 3.1 Capability Interface

```typescript
interface BrainCapabilities {
  // Core
  canChat: boolean;              // Basic prompt -> response
  canStream: boolean;            // Streaming responses
  canUseTools: boolean;          // Function/tool calling

  // Advanced
  canAccessMCP: boolean;         // Native MCP connections (Claude)
  canExecuteCode: boolean;       // Run code autonomously (Codex, Claude Code)
  canSpawnAgents: boolean;       // Multi-agent orchestration
  canMaintainMemory: boolean;    // Persistent context across sessions

  // Media
  canProcessVoice: boolean;      // Audio input/output
  canProcessImages: boolean;     // Vision capabilities
  canProcessDocuments: boolean;  // PDF, spreadsheet analysis
}
```

### 3.2 Runtime Flow

```
User request arrives
  -> Brain Router checks active brain capabilities
  -> If brain canUseTools: send as tool-calling request
     Else: send as plain prompt, parse response, execute internally
  -> If brain canAccessMCP: use MCP connections directly
     Else: use IR Custom AIOS's native connector layer
  -> Result returned to user
```

### 3.3 Adapter Structure

```
src/brain/
  |-- router.ts           // Capability detection, request routing
  |-- types.ts            // BrainCapabilities, BrainRequest, BrainResponse
  |-- adapters/
  |   |-- claude-code.ts  // Claude Code via CLI/API, full capabilities
  |   |-- openai.ts       // OpenAI/Codex via API
  |   |-- gemini.ts       // Gemini via API
  |   |-- openclaw.ts     // OpenClaw via HTTP
  |   +-- custom.ts       // Any OpenAPI-spec endpoint
  +-- middleware/
      |-- context.ts      // Injects user profile + memory before each call
      |-- learning.ts     // Captures decisions/patterns after each call
      +-- fallback.ts     // If primary brain fails, try backup
```

### 3.4 Key Design Decision

IR Custom AIOS's native connectors (M365, Google Workspace) are always available regardless of brain. If someone picks OpenAI as their brain — which can't access MCP — IR Custom AIOS's own connector layer handles the calendar/email/drive operations. The brain decides *what* to do, IR Custom AIOS handles *how*.

### 3.5 Onboarding Brain Selection

During setup, the user chooses their brain:
1. Claude Code
2. OpenClaw
3. OpenAI / Codex
4. Gemini 3.0 Pro (or Google's agent)
5. Custom orchestration agent (provide OpenAPI endpoint)

---

## 4. Native Connector Layer (M365 + Google Workspace)

Two first-class connector suites, same interface, swappable at onboarding. This replaces all the custom OAuth and API endpoint code from IR Custom AIOS v1.

### 4.1 Connector Architecture

```
src/connectors/
  |-- types.ts              // Unified interface for all services
  |-- auth/
  |   |-- oauth2.ts         // Shared OAuth2 flow (both providers use it)
  |   |-- token-store.ts    // Encrypted token storage in Postgres (AES-256)
  |   +-- refresh.ts        // Auto-refresh before expiry
  |-- microsoft/
  |   |-- graph-client.ts   // Microsoft Graph API base client
  |   |-- mail.ts           // Outlook mail (read, send, reply, search)
  |   |-- calendar.ts       // Outlook calendar (CRUD, free/busy)
  |   |-- tasks.ts          // Microsoft To Do
  |   |-- drive.ts          // OneDrive (files, search, share)
  |   |-- teams.ts          // Teams messages, channels
  |   +-- contacts.ts       // People/contacts
  |-- google/
  |   |-- api-client.ts     // Google API base client
  |   |-- gmail.ts          // Gmail (read, send, reply, labels)
  |   |-- calendar.ts       // Google Calendar (CRUD, free/busy)
  |   |-- tasks.ts          // Google Tasks
  |   |-- drive.ts          // Google Drive (files, docs, sheets)
  |   |-- contacts.ts       // Google Contacts
  |   +-- chat.ts           // Google Chat
  +-- unified/
      |-- mail.ts           // send(to, subject, body) -> works with either
      |-- calendar.ts       // createEvent(event) -> works with either
      |-- tasks.ts          // addTask(task) -> works with either
      |-- files.ts          // upload(file) -> works with either
      +-- contacts.ts       // findContact(query) -> works with either
```

### 4.2 Unified Layer

The unified layer is what the brain talks to. When the brain says "send an email to John," it calls `mail.send()`. The unified layer checks which provider the tenant uses and routes to Microsoft Graph or Google API accordingly. The brain never knows or cares which one.

### 4.3 Auth Flow

1. User picks: Microsoft 365 or Google Workspace
2. IR Custom AIOS redirects to OAuth consent screen
3. User grants permissions (mail, calendar, files, etc.)
4. Tokens encrypted (AES-256) and stored in Postgres
5. Refresh handled automatically — user never re-auths unless they revoke

### 4.4 Multi-Account Support

A user can connect multiple Google accounts or mix M365 for work + Google for personal. The unified layer tags each connection with an account label.

---

## 5. Voice Pipeline & Always-Listening Architecture

Voice is the primary interface. Two halves — edge devices (Home Assistant Voice PE satellites) and server-side voice engine.

### 5.1 Edge Devices (Voice PE)

```
Voice PE in each room
  -> MicroWakeWord v2 running on-device ("Hey IR Custom AIOS")
  -> Wake detected -> streams raw audio over WiFi to IR Custom AIOS
  -> Receives TTS audio back -> plays through speaker
  -> LED feedback: listening / processing / responding
```

Home Assistant Voice PE chosen for:
- Dual I2S buses (true full-duplex, no walkie-talkie)
- XMOS XU-316 DSP (hardware echo cancellation + noise suppression)
- Custom wake word support via MicroWakeWord v2
- ~$65/unit — production-grade at reasonable cost

Wake-word detection runs locally on-device. No audio leaves the device until the wake word is detected. Privacy by design.

### 5.2 Server-Side Voice Engine

```
src/voice/
  |-- server.ts             // WebSocket server, manages device connections
  |-- devices.ts            // Device registry (which room, status, last heard)
  |-- stt/
  |   |-- engine.ts         // STT abstraction
  |   |-- whisper.ts        // Local faster-whisper (privacy, no cloud)
  |   +-- cloud.ts          // Azure/Google/Deepgram STT (lower latency option)
  |-- tts/
  |   |-- engine.ts         // TTS abstraction
  |   |-- elevenlabs.ts     // ElevenLabs (most natural voice)
  |   |-- openai-tts.ts     // OpenAI TTS
  |   +-- piper.ts          // Piper local TTS (free, offline)
  |-- pipeline.ts           // Full flow: audio in -> STT -> brain -> TTS -> audio out
  +-- context.ts            // Room awareness (which device heard the command)
```

### 5.3 Full Voice Flow

```
"Hey IR Custom AIOS, what's on my calendar tomorrow?"
  1. Voice PE detects wake word on-device          (~200ms)
  2. Streams audio to IR Custom AIOS via WebSocket          (~50ms)
  3. STT converts speech to text (faster-whisper)   (~500ms)
  4. Brain Router processes intent + calls calendar  (~1-2s)
  5. Response text generated                         (~200ms)
  6. TTS converts to speech audio                    (~300ms)
  7. Audio streamed back to Voice PE                 (~50ms)
  Total: ~2-3 seconds end-to-end
```

### 5.4 Room Awareness

IR Custom AIOS knows which device heard the command. "Turn off the lights" in the bedroom means bedroom lights, not the garage. Each Voice PE registers with a room label on first setup.

### 5.5 Cross-Platform Voice

Web, desktop, and mobile apps use the same pipeline — different transport. Browser/app uses Web Speech API or native mic access instead of Voice PE WebSocket. Same STT -> Brain -> TTS path on the server.

### 5.6 TTS Voice Selection

Configurable per deployment. Setting at onboarding: pick provider, pick voice, done.

---

## 6. Self-Healing Autonomic Engine

Three layers — monitor, diagnose, learn — each escalating only when the layer below can't handle it.

### 6.1 Layer 1 — Health Monitor (Heartbeat)

Every service, connector, brain adapter, and voice device has a health check on a 30-second interval. Not just "is the process alive" but "can it actually do its job."

```
Health checks:
  - Brain: send a trivial prompt, get a response         (brain is thinking)
  - M365/Google: call a lightweight endpoint with token   (auth is valid)
  - Voice devices: WebSocket ping each satellite          (device is online)
  - Postgres: run a simple query                          (DB is responsive)
  - Weaviate: check cluster status                        (vector DB is up)
  - Redis: PING                                           (event bus is alive)
  - Backup system: last backup age < 2x interval          (backups running)
```

If a check fails -> retry once -> still failing -> pass to Layer 2.

### 6.2 Layer 2 — Diagnostic Agent

A ClawTeam worker spins up to diagnose and fix the issue.

```
src/healing/
  |-- monitor.ts          // Health check scheduler + status registry
  |-- diagnostics.ts      // Diagnostic agent spawner
  |-- actions/
  |   |-- restart.ts      // Restart a service/container
  |   |-- refresh-auth.ts // Rotate expired OAuth tokens
  |   |-- clear-cache.ts  // Flush stuck Redis/cache state
  |   |-- reconnect.ts    // Re-establish dropped connections
  |   +-- rollback.ts     // Revert last config/code change
  |-- playbooks/
  |   |-- store.ts        // CRUD for playbook entries in Postgres
  |   |-- matcher.ts      // Match current failure to known playbook
  |   +-- builder.ts      // Create new playbook from successful fix
  +-- escalation.ts       // Human notification when all else fails
```

**Diagnostic protocol:**
1. Read last 5 minutes of logs for the failing service
2. Check if a playbook exists for this failure pattern
3. If playbook exists -> execute known fix -> verify -> done
4. If no playbook -> analyze logs, attempt a fix
5. **3 fix attempts maximum.** If fix works on any attempt -> write a new playbook
6. If all 3 attempts fail -> escalate to human with full diagnostic report

### 6.3 Layer 3 — Playbook Builder (Immune Memory)

```typescript
interface Playbook {
  id: string;
  failure_signature: string;     // regex/pattern that identifies this failure
  service: string;               // which service/component
  severity: 'low' | 'medium' | 'high' | 'critical';
  diagnosis_steps: string[];     // what to check
  fix_steps: string[];           // what to do
  verification: string;          // how to confirm it's fixed
  success_count: number;         // times this playbook resolved the issue
  last_used: Date;
  created_from_incident: string; // link to original incident
}
```

Month one, most failures escalate to human. Month six, the system handles 90% silently. The `success_count` on each playbook shows which fixes are battle-tested.

### 6.4 Escalation Format

When escalation is required, IR Custom AIOS sends:
- What failed
- What it tried (all 3 attempts)
- Why each attempt didn't work
- What it recommends the human do
- Full log excerpt

Delivered via Slack, push notification to mobile app, or voice announcement on nearest Voice PE device.

---

## 7. Learning Engine

Three types of learning, all stored locally in Postgres + Weaviate.

### 7.1 Onboarding Deep Dive

When accounts are connected, IR Custom AIOS runs a full historical ingest before it considers itself ready.

**Platforms ingested:**

```
Gmail/Outlook:
  - Last 6-12 months of sent mail (who you write to, tone, style, frequency)
  - Inbox patterns (what you open, ignore, response times)
  - Labels/folders/rules (your existing organization system)
  - Most-contacted vs dormant contacts

Calendar:
  - Last 12 months of events (recurring meetings, patterns, no-go times)
  - Cancellation/reschedule history
  - Who you meet with and how often
  - Time blocks and naming conventions

Drive/OneDrive:
  - Folder structure (how you organize)
  - Recent documents (what you're actively working on)
  - Shared files (who you collaborate with)
  - File naming conventions

Tasks/To Do:
  - Completion patterns (what you finish vs what lingers)
  - Priority patterns, recurring tasks

Slack/Teams:
  - Channels you're active in vs muted
  - DM frequency and contacts
  - Communication style (emoji, message length, response speed)
  - Topics you engage on vs skip

Stripe/Financial:
  - Customer list, revenue patterns, subscription tiers
  - Invoice cadence, payment collection patterns
  - Refund/dispute history

Smart Home Devices:
  - Device inventory and room assignments
  - Existing automation routines
  - Usage patterns (lights, thermostat, etc.)

Laptop/Desktop (via IR Custom AIOS desktop app):
  - File system structure and naming conventions
  - Browser bookmarks and history
  - Installed applications
  - Desktop clutter identification
  - Local documents not yet in cloud storage
```

**Ingest runs as background process** with progress indicator:

```
"Learning your business... 34% complete"
  Done: Gmail - 2,847 emails analyzed
  Done: Calendar - 14 months mapped
  Working: Drive - scanning 1,204 files...
  Queued: Slack
  Queued: Devices
```

### 7.2 Device Cleanup Agent

After ingesting a laptop/desktop, IR Custom AIOS proposes organization and cleanup.

**Phase 1 — Audit (no changes, report only)**
- Stale downloads, duplicate files, unnamed screenshots
- Unstructured document folders, orphaned files

**Phase 2 — Propose (plan presented, approval required)**
- Folder reorganization suggestions
- Rename files with sensible names (vision for screenshots)
- Sync important local files to cloud backup
- Ongoing maintenance rules

**Phase 3 — Execute (only after explicit approval per category)**
- Moves files to organized structure
- Deduplicates (keeps newest, logs removals)
- Sets up ongoing rules (Downloads auto-cleaned weekly, etc.)

**Safety rule:** IR Custom AIOS never deletes without approval. Files move to a "IR Custom AIOS Review" folder first. 7-day window to object before cleanup. Anything flagged as important gets learned permanently.

```
src/learning/
  |-- onboarding/
  |   |-- sprint.ts           // Orchestrates the full deep dive
  |   |-- progress.ts         // Tracks % complete, surfaces to user
  |   |-- gmail-ingest.ts
  |   |-- calendar-ingest.ts
  |   |-- drive-ingest.ts
  |   |-- tasks-ingest.ts
  |   |-- comms-ingest.ts     // Slack/Teams history
  |   |-- financial-ingest.ts
  |   |-- devices-ingest.ts   // Smart home
  |   |-- device-ingest.ts    // Laptop/desktop file system
  |   |-- cleanup-planner.ts
  |   |-- cleanup-executor.ts
  |   |-- file-rules.ts       // Learned file organization rules
  |   +-- synthesizer.ts      // Combines all ingested data into initial profile
```

### 7.3 Behavioral Patterns (Passive Learning)

IR Custom AIOS passively observes and builds a profile:
- Communication timing, frequency, tone
- Meeting behavior (which you protect vs reschedule)
- Task completion patterns
- Delegation patterns
- Peak productivity hours

Stored as embeddings in Weaviate with structured metadata in Postgres.

### 7.4 Explicit Preferences (User Corrections)

Direct instructions and corrections. Higher weight than behavioral patterns.

```
"IR Custom AIOS, never schedule anything before 9am"
"When John emails, always flag it"
"Don't reply to cold sales emails — just archive them"
```

If behavior and preference conflict, preference wins.

### 7.5 Business Intelligence (Org-Level Learning)

For client deployments:
- Customer communication patterns
- Revenue cycles and invoice cadence
- Team dynamics and escalation chains
- Seasonal patterns
- Vendor relationships

### 7.6 Privacy and Control

- User can ask "what do you know about me?" and get a full readout
- User can delete any learned pattern or preference
- Business deployments can set boundaries ("don't learn from HR emails")
- All learning data stays in local Postgres + Weaviate — never sent to brain provider

### 7.7 Continuous Refinement

The onboarding deep dive gives a strong baseline. Every interaction after refines, corrects, and updates. Recurring situations increase confidence. Detected drift triggers profile adjustment. Learning never stops.

---

## 8. Project Structure

### 8.1 Monorepo Layout

```
boss-aios/
|-- package.json                    // Workspace root
|-- docker-compose.yml              // Single-tenant deployment
|-- docker-compose.multi.yml        // Multi-tenant overlay
|-- tsconfig.base.json
|
|-- packages/
|   |-- core/                       // Shared types, utils, constants
|   |-- brain/                      // Brain router + all adapters
|   |-- connectors/                 // M365 + Google Workspace + unified layer
|   |-- voice/                      // Voice pipeline (STT, TTS, device mgmt)
|   |-- healing/                    // Self-healing engine + playbooks
|   |-- learning/                   // Observer, preferences, onboarding sprint
|   +-- backup/                     // Encrypted backup system
|
|-- apps/
|   |-- api/                        // Fastify server (main API)
|   |-- web/                        // React web dashboard
|   |-- desktop/                    // Electron Windows app
|   |-- mobile/                     // React Native (iOS + Android)
|   +-- worker/                     // Background job processor (Redis consumer)
|
|-- services/
|   |-- postgres/                   // DB migrations, seeds, schema
|   |-- redis/                      // Event bus config
|   |-- weaviate/                   // Vector DB schema + collections
|   +-- voice-satellite/           // ESPHome configs for Voice PE devices
|
|-- scripts/
|   |-- setup.sh                    // First-time deployment
|   |-- onboard-tenant.sh          // Add a new tenant (multi-tenant mode)
|   |-- backup.sh                   // Manual backup trigger
|   +-- health-check.sh            // Quick system status
|
+-- docs/
    |-- architecture.md
    |-- onboarding-guide.md
    |-- brain-adapters.md
    +-- deployment.md
```

### 8.2 Single-Tenant Docker Compose (7 containers)

```
api        — Fastify API server
worker     — Background job processor
web        — React dashboard (nginx)
postgres   — Database
redis      — Event bus + cache
weaviate   — Vector storage
stt        — Speech-to-text (faster-whisper)
```

Down from 14 containers in IR Custom AIOS v1. TTS runs inside the API process (external API call to ElevenLabs/OpenAI). Voice PE devices connect over LAN as edge hardware.

### 8.3 Multi-Tenant Docker Compose

Same containers plus a reverse proxy (nginx/Traefik) for tenant subdomain routing. Every request carries a `tenant_id`. Isolation:
- Postgres: schema-per-tenant (`tenant_abc.users`, `tenant_abc.preferences`)
- Weaviate: collection-per-tenant (prefixed)
- Redis: key-prefixed by tenant ID

### 8.4 Backup System

```
src/backup/
  |-- scheduler.ts        // 30-60 min interval, configurable
  |-- postgres-dump.ts    // pg_dump -> encrypted file
  |-- weaviate-export.ts  // Collection export -> encrypted file
  |-- encrypt.ts          // AES-256 encryption per file (Layer 2 auth)
  |-- destinations/
  |   |-- git.ts          // Push to private repo (Layer 1 auth)
  |   |-- s3.ts           // AWS S3 / compatible (Layer 1 auth)
  |   +-- both.ts         // Dual destination
  +-- retention.ts        // Auto-delete after 15-30 days configurable
```

Two authentication layers:
- **Layer 1:** Credentials to access backup destination (Git SSH key / S3 IAM)
- **Layer 2:** Each backup file encrypted with separate key (AES-256, rotated weekly)

---

## 9. Client Onboarding Flow

```
1. Admin creates tenant           -> DB schema, Weaviate collections, Redis prefix
2. Tenant picks their brain       -> Claude Code / OpenAI / Gemini / OpenClaw / Custom
3. Tenant connects business suite -> Microsoft 365 or Google Workspace OAuth
4. Tenant connects optional       -> Slack, Stripe, smart home, etc.
5. Deep dive sprint kicks off     -> Background ingest of all connected history
6. Voice devices provisioned      -> ESPHome flashed with tenant's wake word
7. Desktop/mobile apps configured -> API endpoint + auth token
8. System goes live               -> Monitoring, healing, learning all active
```

---

## 10. Voice Hardware Specification

**Selected device:** Home Assistant Voice PE (~$65/unit)

**Reasons:**
- Dual I2S buses — true full-duplex (mic and speaker simultaneous)
- XMOS XU-316 DSP — hardware echo cancellation and noise suppression
- Custom wake word support via MicroWakeWord v2
- Reference device for Home Assistant voice team (most stable firmware path)

**Initial deployment (Kevin's home):**
- Office: 1x Voice PE
- Living room / kitchen doorway: 1x Voice PE
- Garage (shop space): 1x Voice PE
- Bedroom (master bed/bath): 1x Voice PE

**Starting with 1x Voice PE for testing** while software stack is built.

---

## 11. Implementation Priority

### Phase 1 — Foundation
- Monorepo scaffolding, TypeScript workspace config
- Postgres schema + migrations
- Redis event bus setup
- Core types and shared utilities
- Fastify API server with health endpoint
- Docker Compose (single-tenant)

### Phase 2 — Brain
- Brain Router with capability detection
- Claude Code adapter (primary brain for Kevin's deployment)
- Context middleware (inject profile before each call)
- Fallback middleware

### Phase 3 — Connectors
- OAuth2 flow (shared)
- Google Workspace connectors (Gmail, Calendar, Tasks, Drive, Contacts)
- Microsoft 365 connectors (Graph API — Mail, Calendar, To Do, OneDrive, Teams, Contacts)
- Unified interface layer

### Phase 4 — Voice
- WebSocket server for Voice PE devices
- STT integration (faster-whisper)
- TTS integration (ElevenLabs)
- Voice pipeline (audio in -> STT -> brain -> TTS -> audio out)
- Room awareness
- ESPHome config for Voice PE with custom wake word

### Phase 5 — Learning
- Onboarding deep dive sprint (all platform ingest)
- Behavioral observer
- Preference store
- User profile synthesis
- Device ingest + cleanup agent

### Phase 6 — Self-Healing
- Health monitor (30s heartbeat)
- Diagnostic agent (3-attempt protocol)
- Playbook system (store, match, build)
- Escalation system (Slack, push, voice)

### Phase 7 — Interfaces
- React web dashboard (professional, medium-business grade)
- Electron Windows app (with device ingest + always-listening)
- React Native mobile app

### Phase 8 — Backup & Multi-Tenant
- Encrypted backup system (dual-auth, 30-60min interval, 15-30 day retention)
- Multi-tenant overlay (schema isolation, tenant routing)
- Onboarding flow for new tenants

---

## 12. Technology Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (everywhere) |
| API Server | Fastify |
| Web Dashboard | React 18 + Tailwind CSS |
| Desktop App | Electron |
| Mobile App | React Native |
| Database | PostgreSQL |
| Vector DB | Weaviate |
| Event Bus / Cache | Redis (Streams + pub/sub) |
| STT | faster-whisper (local) |
| TTS | ElevenLabs / OpenAI TTS / Piper (configurable) |
| Voice Hardware | Home Assistant Voice PE |
| Wake Word | MicroWakeWord v2 (on-device) |
| Containers | Docker Compose v2 |
| Monorepo | npm workspaces |
| Orchestration | ClawTeam + Claude Code |

---

## 13. Non-Functional Requirements

- **Latency:** Voice round-trip < 3 seconds end-to-end
- **Availability:** Self-healing targets 99.5% uptime without human intervention after month 6
- **Security:** AES-256 token encryption, OAuth2 with auto-refresh, dual-auth backups
- **Privacy:** All learning data stays on-premise, no data sent to brain providers beyond prompts
- **Scalability:** Single-tenant handles 1 user + 10 voice devices. Multi-tenant handles 50+ tenants on shared infrastructure
- **Portability:** Brain-agnostic, provider-agnostic, deployable on any Linux server or cloud VM
