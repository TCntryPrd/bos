# BCAI Phase 4 -- Voice in Every Bay (Brad) + Autonomous Workflow

## BodyShopConnect AI | Micazen Consulting & Technologies

| Field | Value |
|-------|-------|
| **Document Version** | 2.0 |
| **Date** | April 7, 2026 |
| **Timeline** | 6--12 months after Phase 3 completion |
| **Investment** | $50,000--$100,000 CAD (software); hardware costs per shop are additional and quoted separately |
| **Billing** | Milestone-based: 20% at kickoff, 20% at wake word functional, 20% at per-bay agents operational, 20% at pilot deployment, 20% at acceptance |
| **Prerequisite** | Phase 3 accepted; AutoCanada pilot validated; minimum 20 active shops on BCAI |
| **Deliverable Summary** | Wake word activation ("Hey BC"), per-bay voice agents (Brad), hardware integration (speakers + microphones per bay), autonomous workflow execution with approval gates, voice-first technician experience, multi-bay orchestration, advanced voice analytics, additional languages. |

---

## Table of Contents

1. [Wake Word Activation](#1-wake-word-activation)
2. [Per-Bay Voice Agents (Brad)](#2-per-bay-voice-agents-brad)
3. [Hardware Integration](#3-hardware-integration)
4. [Autonomous Workflow with Approval Gates](#4-autonomous-workflow-with-approval-gates)
5. [Voice-First Technician Experience](#5-voice-first-technician-experience)
6. [Multi-Bay Orchestration](#6-multi-bay-orchestration)
7. [Voice Analytics](#7-voice-analytics)
8. [What Is Sellable vs Internal Testing](#8-what-is-sellable-vs-internal-testing)
9. [What AI Can Do at This Phase](#9-what-ai-can-do-at-this-phase)
10. [Integrations Included](#10-integrations-included)
11. [Multi-Language Coverage](#11-multi-language-coverage)
12. [Support Model](#12-support-model)
13. [What Is NOT in This Phase](#13-what-is-not-in-this-phase)
14. [Acceptance Criteria](#14-acceptance-criteria)

---

## 1. Wake Word Activation

### Purpose

Hands-free activation of BC using the wake word "Hey BC." No button click required. Technicians working on a vehicle can speak commands without stopping work.

### Technical Implementation

| Component | Detail |
|-----------|--------|
| Wake word engine | Picovoice Porcupine (local processing, no cloud required for wake word detection) |
| Wake word | "Hey BC" (custom trained; alternatives: "BC" alone, configurable per shop) |
| Processing | Wake word detection runs locally on bay hardware (no network latency for detection) |
| Privacy | Audio is NOT recorded or streamed to server until wake word is detected; wake word detection is on-device only |
| Post-wake | After wake word detected, audio streams to sovereign LLM for processing (same as click-to-talk but triggered by voice) |
| Feedback | Audible tone confirms wake word detected ("listening..."); visual indicator on bay display if present |
| Timeout | 15 seconds of silence after wake word = auto-cancel; audible "cancelled" tone |
| Noise handling | Configured for shop floor noise levels (compressors, paint booths, tools); tunable sensitivity per bay |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Wake Word Settings** | Admin | Enable/disable wake word per bay; configure sensitivity; test mode |
| **Voice Activity Log** | Admin, Manager | Log of all wake word activations per bay: timestamp, user (if identified), command, result |

---

## 2. Per-Bay Voice Agents (Brad)

### Purpose

Each bay in the shop has its own AI agent instance ("Brad") that knows the context of the vehicle currently in that bay. Brad is the bay-level assistant. When a technician says "Hey BC, what parts are left on this vehicle?" Brad knows which vehicle is in Bay 3 because it is the Bay 3 agent.

### Architecture

| Component | Detail |
|-----------|--------|
| Agent per bay | Each bay has a named agent instance (e.g., "Brad - Bay 1", "Brad - Bay 2") |
| Context binding | Each bay agent is bound to the RO currently scheduled/assigned to that bay |
| Auto-context | When a tech walks into Bay 3 and says "Hey BC, what's the status?" -- Brad-Bay-3 responds with the status of the vehicle in Bay 3 |
| Context switching | If the tech says "Hey BC, switch to the Honda in Bay 5" -- the agent switches context (requires permission if not assigned to that bay) |
| Memory | Brad remembers the conversation history for the current shift (cleared at end of shift or configurable) |
| Personality | Configurable per shop: formal/casual tone; response verbosity (brief/detailed); name (default "Brad", shop can rename) |

### Bay Agent Capabilities

| Capability | Detail |
|-----------|--------|
| Vehicle context | Knows: vehicle info, RO status, estimate lines, parts status, labor logged, notes, customer info (per RBAC) |
| Technician context | Knows: who is assigned to this bay, their schedule, their role permissions |
| Proactive alerts | "Heads up: the fender for this vehicle is still on backorder. ETA is Thursday." |
| Multi-step commands | "Hey BC, log 2 hours of body work and move this to paint" -- executes both with confirmation |
| Photo capture | "Hey BC, take a photo" -- triggers connected camera (if equipped) or prompts mobile device |
| SOP guidance | "Hey BC, what's the next SOP step?" -- reads the next required step for the current workflow stage |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Bay Agent Dashboard** | Admin, Manager | Status of all bay agents: active/inactive, current RO bound, last command, agent health |
| **Bay Agent Configuration** | Admin | Configure per bay: agent name, personality, context rules, enabled capabilities |
| **Bay Agent Conversation History** | Admin, Manager | View conversation log per bay per shift |

---

## 3. Hardware Integration

### Purpose

Physical hardware deployed in each bay to enable voice interaction. This is a per-shop hardware kit with installation and configuration.

### Hardware Components per Bay

| Component | Specification | Purpose |
|-----------|--------------|---------|
| Microphone array | Far-field USB microphone array (3-5m range) | Voice capture in noisy shop environment |
| Speaker | Weatherproof powered speaker (IP54+ rated) | Brad's voice responses audible over shop noise |
| Processing unit | Mini PC (Intel NUC or equivalent) or Raspberry Pi 5 | Local wake word detection; audio processing; network bridge |
| Display (optional) | 10" tablet or wall-mounted display | Visual feedback; RO summary; SOP checklists |
| Camera (optional) | USB webcam (mounted above bay) | Photo capture via voice command |

### Hardware Kit Pricing (Per Bay, Estimated)

| Configuration | Components | Estimated Cost (CAD) |
|--------------|-----------|---------------------|
| Basic | Microphone + Speaker + Mini PC | $800--$1,200 |
| Standard | Basic + 10" Tablet Display | $1,200--$1,800 |
| Full | Standard + Camera | $1,600--$2,400 |

Note: Hardware costs are separate from software Phase 4 investment. Quoted per shop based on bay count.

### Network Requirements per Bay

| Requirement | Detail |
|-------------|--------|
| Connectivity | Wired Ethernet preferred; Wi-Fi 5/6 supported |
| Bandwidth | Minimum 5 Mbps per bay (for audio streaming to sovereign LLM) |
| Latency | <100ms to BCAI server for responsive voice interaction |
| Firewall | Outbound HTTPS to BCAI server only; no inbound ports required |

### Installation

| Step | Detail |
|------|--------|
| Site survey | Assess shop layout, noise levels, network infrastructure, power availability per bay |
| Hardware delivery | Ship kit to shop; pre-configured with shop's BCAI credentials |
| Installation | Mount microphone and speaker; connect processing unit to network; connect optional display/camera |
| Configuration | Register bay in BCAI admin; bind agent to bay; test wake word detection; calibrate noise threshold |
| Training | On-site or video training session for shop staff |

---

## 4. Autonomous Workflow with Approval Gates

### Purpose

BC can now execute multi-step workflows autonomously -- but ONLY within defined approval boundaries. The principle: BC proposes a plan, human approves the plan, BC executes the plan. "That's dangerous" if there are no gates. So there are gates.

### Approval Tiers

| Tier | Description | Approval Required |
|------|-------------|-------------------|
| **Auto-execute** | Low-risk, high-frequency actions | None -- BC executes immediately |
| **Single confirm** | Medium-risk actions | One confirmation from any authorized user |
| **Manager approve** | High-risk or financial actions | Manager or Admin must approve |
| **Dual approve** | Critical actions | Two authorized users must approve |

### Action Classification

| Action | Approval Tier | Rationale |
|--------|--------------|-----------|
| Add note to RO | Auto-execute | Low risk; append-only; audited |
| Update RO stage (forward) | Single confirm | Standard workflow; tech confirms |
| Send customer notification (template) | Single confirm | Using pre-approved template |
| Send custom customer email | Manager approve | Custom content needs review |
| Create purchase order | Manager approve | Financial commitment |
| Void RO | Dual approve | Destructive action |
| Modify SOP | Dual approve | Network-level change |
| Modify user permissions | Dual approve | Security-sensitive |
| Accounting export | Single confirm | Financial data leaving system |
| Change billing/pricing | Dual approve | Financial impact |

### Configuration

| Screen | Access | Purpose |
|--------|--------|---------|
| **Approval Rules** | Admin, Network Admin | Configure which actions require which approval tier; per-shop or network-wide |
| **Approval Queue** | Manager, Admin | List of pending approvals; approve/reject with reason |
| **Approval History** | Admin | Log of all approvals: who requested, who approved, timestamp, action taken |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Workflow planning | BC can plan multi-step workflows: "I'll update the status, notify the customer, and schedule QC. Approve?" |
| Batched approval | User can approve an entire planned workflow at once rather than step-by-step |
| Timeout | Pending approvals expire after configurable period (default 24 hours); escalation to next approver |
| RBAC enforcement | Approval authority tied to role; technician cannot approve manager-tier actions |
| Audit trail | Every autonomous action logged: what BC did, which approval it operated under, who approved |

---

## 5. Voice-First Technician Experience

### Purpose

Redesign the technician workflow to be voice-primary. Technicians wearing gloves, holding tools, or under a vehicle should be able to complete all their workflow tasks by voice.

### Voice-First Workflows

| Workflow | Voice Interaction |
|----------|------------------|
| **Start shift** | "Hey BC, I'm starting my shift" -- logs shift start; shows today's schedule |
| **Get assignment** | "Hey BC, what's my first job?" -- reads current assignment: vehicle, RO, stage, estimated hours |
| **Log time** | "Hey BC, I've been on this for 2 hours" -- logs 2 hours of labor |
| **Request parts** | "Hey BC, I need a left fender for this vehicle" -- checks inventory; creates request if not in stock |
| **Report issue** | "Hey BC, I found additional damage on the left quarter panel" -- creates supplement note with description |
| **Complete stage** | "Hey BC, body work is done on this one" -- moves RO to next stage (with confirmation) |
| **Take photo** | "Hey BC, take a photo of the damage" -- triggers camera capture; attaches to RO |
| **SOP check** | "Hey BC, what's the next step?" -- reads next SOP checkpoint |
| **End shift** | "Hey BC, I'm done for the day" -- logs shift end; summarizes hours logged |

### Technician Voice Dashboard (Bay Display)

| Element | Detail |
|---------|--------|
| Current RO | Vehicle info, stage, time logged, remaining estimated hours |
| Parts status | Green/yellow/red indicators for parts on this RO |
| SOP progress | Checklist with completed/remaining steps |
| Next up | Next RO in tech's queue |
| Messages | Any notes or messages from manager |

---

## 6. Multi-Bay Orchestration

### Purpose

BC coordinates across all bays in a shop. Manager can get a shop-wide view and issue commands that affect multiple bays.

### Manager Voice Commands

| Command | Action |
|---------|--------|
| "Hey BC, shop status" | Reads status of every active bay: what vehicle, what stage, who's working |
| "Hey BC, who's available?" | Lists technicians not currently assigned or approaching task completion |
| "Hey BC, reassign the Honda from Bay 3 to Bay 5" | Updates assignment and notifies affected technicians |
| "Hey BC, priority alert: the Camry needs to ship today" | Escalates RO priority; notifies all relevant staff |
| "Hey BC, morning briefing" | Reads: ROs due today, parts arriving today, scheduled intake, any overdue items |

### Multi-Bay Awareness

| Feature | Detail |
|---------|--------|
| Load balancing suggestions | BC recommends: "Bay 2 is idle. Suggested to move RO 4530 (parts received) into Bay 2." |
| Bottleneck detection | BC alerts: "3 vehicles waiting for paint. Paint booth has been occupied for 6 hours. Should we reschedule?" |
| Cross-bay coordination | When a vehicle moves from Body (Bay 2) to Paint (Bay 4), Brad-Bay-4 automatically picks up the context |

---

## 7. Voice Analytics

### Purpose

Analyze voice interaction patterns to improve BC's accuracy and the shop's efficiency.

### Reports

| Report | Description | Access |
|--------|-------------|--------|
| **Voice Command Success Rate** | % of commands correctly understood and executed per bay, per user | Admin, Manager |
| **Most Common Commands** | Ranked list of what staff are asking BC to do most often | Admin |
| **Failed Command Analysis** | Commands BC could not understand or execute; patterns for improvement | Micazen Admin, D. Caine Solutions |
| **Voice vs. Manual** | Ratio of tasks completed via voice vs. traditional UI input | Admin, Manager |
| **Response Time** | Average time from voice command to BC response per bay | Admin |

### Privacy

| Rule | Detail |
|------|--------|
| No audio storage | Audio is processed in real-time and discarded; only transcribed text is logged |
| Transcription logs | Stored per-tenant; accessible only by authorized roles |
| No cross-tenant analysis | Voice analytics are per-shop only |

---

## 8. What Is Sellable vs Internal Testing

| Feature | Sellable | Internal Testing Only |
|---------|----------|----------------------|
| Everything from Phase 1 + 2 + 3 | Yes | -- |
| Wake word ("Hey BC") | Yes -- hands-free operation is a major selling point for techs | -- |
| Per-bay voice agents (Brad) | Yes -- every bay has its own AI assistant | -- |
| Hardware kit (per bay) | Yes -- sold/leased as add-on with installation | -- |
| Autonomous workflow with approval gates | Yes -- productivity multiplier with safety controls | -- |
| Voice-first technician experience | Yes -- techs can work without touching a screen | -- |
| Multi-bay orchestration | Yes -- manager commands across the whole shop | -- |
| Voice analytics | Yes -- shops can optimize their voice usage | -- |

**Phase 4 is the "smart shop" release.** The shop floor becomes voice-activated. Technicians interact with BC hands-free. Managers orchestrate the shop with voice commands. Every bay has its own AI assistant that knows the context of the vehicle being worked on.

---

## 9. What AI Can Do at This Phase

Everything from Phase 1 + 2 + 3, PLUS -- all available hands-free via wake word:

| What You Say | What BC Does |
|-------------|-------------|
| "Hey BC" | Activates listening (no button click required) |
| "Hey BC, I'm starting my shift" | Logs shift start; reads today's assignments |
| "Hey BC, what's my first job?" | Reads current assignment details |
| "Hey BC, I've been on this for 2 hours" | Logs 2 hours of labor to current RO |
| "Hey BC, I need a left fender for this vehicle" | Checks inventory; creates parts request if needed |
| "Hey BC, body work is done on this one" | Proposes stage transition; executes on confirmation |
| "Hey BC, take a photo" | Captures photo via bay camera; attaches to current RO |
| "Hey BC, what's the next SOP step?" | Reads next required SOP checkpoint |
| "Hey BC, I'm done for the day" | Logs shift end; summarizes hours |
| "Hey BC, shop status" | (Manager) Reads all bay statuses |
| "Hey BC, reassign the Honda from Bay 3 to Bay 5" | (Manager) Moves assignment; notifies affected staff |
| "Hey BC, priority alert on the Camry" | (Manager) Escalates RO priority |
| "Hey BC, morning briefing" | (Manager) Reads daily overview: due, arriving, overdue |
| "Hey BC, who's available?" | (Manager) Lists idle or soon-idle technicians |
| "Hey BC, I found additional damage on the left quarter panel" | Creates supplement note; optionally takes photo |
| "Hey BC, approve the parts order for RO 4521" | (Manager) Approves pending PO from approval queue |
| "Hey BC, what's the voice success rate for Bay 3 this week?" | Returns voice analytics for specified bay |

---

## 10. Integrations Included

### New in Phase 4

| Integration | Type | Direction | Detail |
|-------------|------|-----------|--------|
| Picovoice Porcupine | Local SDK | On-device | Wake word detection running on bay processing unit |
| Whisper (local) | Local inference | On-device | Local speech-to-text for faster response; fallback to server-side |
| Coqui TTS (local) | Local inference | On-device | Local text-to-speech for Brad's voice responses |
| Bay hardware management | Custom protocol | Bidirectional | Monitor and configure bay hardware (mic, speaker, display, camera) |
| USB camera API | Local | Inbound | Photo capture from bay-mounted camera |

### Cumulative Integration Count: 31+

All Phase 1-3 integrations maintained, plus Phase 4 hardware and voice processing integrations.

---

## 11. Multi-Language Coverage

| Language | UI | AI (Voice + Text) | Help | Reports | Notifications | Customer Portal | Wake Word |
|----------|----|--------------------|------|---------|--------------|----------------|-----------|
| English | Full | Full | Full | Full | Full | Full | Full |
| French | Full | Full | Full | Full | Full | Full | Full |
| Spanish | Full | Full | Full | Full | Full | Full | Full |

### Wake Word Language Note

- Wake word "Hey BC" is language-agnostic (phonetically distinct enough to work across EN/FR/ES)
- Post-wake processing automatically detects the language being spoken and responds in that language
- Sovereign LLM handles multilingual voice commands natively

### Deferred Languages

| Language | Phase | Notes |
|----------|-------|-------|
| Romanian | Phase 5+ | Can be added to sovereign LLM training data when prioritized |
| Italian | Phase 5+ | Same |
| Hindi | Phase 5+ | Same |

---

## 12. Support Model

### SLA (unchanged core)

| Priority | Identification | Resolution |
|----------|---------------|------------|
| Critical | 2 hours | 12 hours |
| High | 12 hours | 24 hours |
| Medium | 24 hours | 72 hours |
| Low | 48 hours | Next release |

### Phase 4 Enhancements

| Enhancement | Detail |
|-------------|--------|
| Hardware support tier | New SLA category: hardware failure (microphone, speaker, processing unit) -- identification within 4 hours, replacement shipped within 48 hours |
| Voice-specific diagnostics | "Hey BC, run a system check" -- Brad tests mic, speaker, network, and reports issues |
| Remote hardware monitoring | D. Caine Solutions monitors hardware health per bay; proactive alerts for failures |
| On-site installation support | Remote guided installation via video call; on-site technician available in major Canadian metro areas (additional cost) |

---

## 13. What Is NOT in This Phase

| Feature | Deferred To | Reason |
|---------|------------|--------|
| Existing BC customer data migration | Phase 5 | Migration tooling is Phase 5 scope |
| White-label platform | Phase 5 | Platform maturity required |
| Public API ecosystem | Phase 5 | Platform maturity required |
| Predictive AI (demand forecasting, parts prediction) | Phase 5 | Requires historical data from Phases 1-4 |
| Existing BC system decommissioning | Phase 5 | Depends on successful migration |
| Romanian, Italian, Hindi | Phase 5+ | Lower priority |

---

## 14. Acceptance Criteria

| # | Criterion |
|---|----------|
| 1 | Wake word "Hey BC" activates listening from 3 meters distance in a shop environment with background noise (compressor, radio) |
| 2 | Wake word detection operates locally on bay processing unit; no network request needed for detection |
| 3 | Audio is NOT recorded or stored; only transcribed text is logged |
| 4 | Brad in Bay 1 knows the context of the vehicle assigned to Bay 1 without the user specifying it |
| 5 | "Hey BC, what parts are left on this vehicle?" returns correct parts status for the RO in that bay |
| 6 | "Hey BC, I've been on this for 2 hours" logs exactly 2 hours to the current RO for the identified tech |
| 7 | "Hey BC, take a photo" captures a photo from the bay camera and attaches it to the current RO |
| 8 | Manager can say "Hey BC, shop status" and get a spoken summary of all active bays |
| 9 | Manager can say "Hey BC, reassign the Honda from Bay 3 to Bay 5" and the assignment updates correctly |
| 10 | Autonomous workflow respects approval tiers: auto-execute actions execute immediately; manager-approve actions queue for approval |
| 11 | Multi-step workflow plan is presented for approval: "I'll update status, notify customer, and schedule QC. Approve?" -- user says "approve" and all three execute |
| 12 | Approval queue shows all pending items; manager can approve/reject with voice or UI |
| 13 | Voice-first shift start/end correctly logs technician hours |
| 14 | Hardware kit installs and connects to BCAI within 30 minutes (after network is available) |
| 15 | Bay display shows current RO, parts status, SOP progress in real-time |
| 16 | Voice command success rate >85% in shop floor conditions after calibration |
| 17 | Response time from voice command to Brad's response <5 seconds for standard queries |
| 18 | Multi-bay orchestration: when vehicle moves from Bay 2 to Bay 4, Brad-Bay-4 picks up context automatically |
| 19 | Voice analytics report shows correct success rate, common commands, and failed command patterns |
| 20 | "Hey BC, run a system check" tests and reports mic, speaker, network, and LLM connectivity status |

---

**End of Phase 4 Specification**

*This document is a technical specification for red-line review. No sales language. No value propositions. No revenue projections. Features, screens, fields, behaviors.*
