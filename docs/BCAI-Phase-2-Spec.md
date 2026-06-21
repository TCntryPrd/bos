# BCAI Phase 2 -- Full AI Assistance + Sovereign LLM + Expanded Integrations

## BodyShopConnect AI | Micazen Consulting & Technologies

| Field | Value |
|-------|-------|
| **Document Version** | 2.0 |
| **Date** | April 7, 2026 |
| **Timeline** | 2--3 months after Phase 1 completion |
| **Investment** | $35,000--$65,000 CAD |
| **Billing** | Milestone-based: 30% at kickoff, 40% at mid-point review, 30% at acceptance |
| **Prerequisite** | Phase 1 accepted and in production |
| **Deliverable Summary** | Sovereign LLM (self-hosted, Canadian infrastructure), AI-assisted workflow suggestions with human confirmation, full scheduling, full inventory/parts management, customer notifications, offline capability with sync, Spanish language, Zoho Desk native integration, guided walkthroughs, cloud media storage integrations, recommendation engine, custom roles, job costing. |

---

## Table of Contents

1. [Sovereign LLM Deployment](#1-sovereign-llm-deployment)
2. [AI-Assisted Workflow Suggestions](#2-ai-assisted-workflow-suggestions)
3. [Full Scheduling System](#3-full-scheduling-system)
4. [Full Inventory and Parts Management](#4-full-inventory-and-parts-management)
5. [Customer Notification Engine](#5-customer-notification-engine)
6. [Offline Capability and Sync](#6-offline-capability-and-sync)
7. [Job Costing](#7-job-costing)
8. [Guided Walkthroughs and Interactive Help](#8-guided-walkthroughs-and-interactive-help)
9. [Recommendation Engine (Self-Healing)](#9-recommendation-engine-self-healing)
10. [Custom Roles](#10-custom-roles)
11. [Scheduled and Emailed Reports](#11-scheduled-and-emailed-reports)
12. [Two-Factor Authentication](#12-two-factor-authentication)
13. [What Is Sellable vs Internal Testing](#13-what-is-sellable-vs-internal-testing)
14. [What AI Can Do at This Phase](#14-what-ai-can-do-at-this-phase)
15. [Integrations Included](#15-integrations-included)
16. [Multi-Language Coverage](#16-multi-language-coverage)
17. [Support Model](#17-support-model)
18. [What Is NOT in This Phase](#18-what-is-not-in-this-phase)
19. [Acceptance Criteria](#19-acceptance-criteria)

---

## 1. Sovereign LLM Deployment

### Purpose

Replace the cloud LLM API used in Phase 1 with a self-hosted, sovereign AI model running on Canadian infrastructure. No tenant data leaves Canada. No third-party AI provider sees shop data.

### Architecture

| Component | Detail |
|-----------|--------|
| Model | NVIDIA Nemotron 70B (or equivalent open-weight model at time of deployment) |
| Hosting | Dedicated GPU instance(s) in AWS ca-central-1 (Montreal) |
| Runtime | vLLM or TensorRT-LLM for inference optimization |
| Data isolation | Model serves all tenants but has zero persistent memory between requests; no cross-tenant context |
| Fine-tuning | Base model fine-tuned on collision repair terminology, BC workflow patterns, and industry SOPs |
| Fallback | If sovereign LLM is unavailable, system degrades gracefully: click-to-talk shows "BC is temporarily processing slower" and queues commands |

### Training Data

| Source | Content | Privacy |
|--------|---------|---------|
| BC help articles (1000+) | Step-by-step guides for every BC function | Public within BC |
| Industry SOPs (provided by Micazen) | Standard operating procedures for collision repair workflow | Anonymized before training |
| CIECA specifications | Data format documentation for estimating system imports | Public standard |
| Collision repair terminology | Industry glossary: RO, DRP, CSI, cycle time, dwell time, touch time, etc. | Public domain |

No customer data used for training. No cross-tenant data used for training. Training data is static and curated by Micazen.

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **AI System Health** | Micazen Admin | Model status, inference latency, request volume, error rate |
| **AI Training Data** | Micazen Admin | View/manage training corpus; add new SOPs or help content |

---

## 2. AI-Assisted Workflow Suggestions

### Purpose

BC proactively suggests next actions based on RO state, shop patterns, and best practices. All suggestions require human confirmation -- BC never acts autonomously.

### Suggestion Types

| Trigger | Suggestion | Confirmation Required |
|---------|-----------|----------------------|
| RO in "Parts Received" for >4 hours | "All parts are received for RO 4521. Schedule for production?" | Yes -- user confirms or dismisses |
| RO in "Quality Check" passed | "QC complete for RO 4521. Notify customer for pickup?" | Yes -- shows draft notification |
| Estimate imported with high supplement probability | "This estimate has items commonly supplemented. Flag for supplement review?" | Yes |
| Technician logs final labor hour | "All labor complete on RO 4521. Move to Quality Check?" | Yes |
| Customer communication overdue (>3 days no update sent) | "No customer update sent for RO 4521 in 3 days. Send status update?" | Yes -- shows draft message |
| Parts backordered >5 days | "Parts for RO 4521 backordered for 5 days. Contact vendor for update?" | Yes |
| RO approaching cycle time threshold | "RO 4521 is at 8 days. Average cycle time is 6 days. Review for bottleneck?" | Yes -- navigates to bottleneck analysis |

### UI

| Element | Detail |
|---------|--------|
| Notification | Toast notification in top-right corner; persists until dismissed or acted on |
| Suggestion panel | Collapsible right sidebar showing all pending suggestions for current user |
| Badge | Number badge on suggestion icon showing unread suggestions |
| History | Log of all suggestions: accepted, dismissed, and expired (30-day retention) |

### Behavior Rules

| Rule | Detail |
|------|--------|
| No autonomous action | BC NEVER executes an action without explicit user confirmation. "That's dangerous" -- Sharon |
| RBAC scoped | Technicians see suggestions for their assigned ROs only; managers see all |
| Frequency cap | Maximum 5 suggestions per user per hour to prevent notification fatigue |
| Dismissable | User can dismiss any suggestion; dismissed suggestions do not repeat for the same RO event |
| Configurable | Admin can enable/disable suggestion types per shop |

---

## 3. Full Scheduling System

### Purpose

Schedule vehicle intake, production bay assignments, and technician workload. Visual calendar view.

### Screens

| Screen | Purpose | Access |
|--------|---------|--------|
| **Schedule Calendar** | Weekly/daily view of bay assignments and technician schedules | Admin, Manager |
| **Bay Management** | Define bays (name, type: body, frame, paint, assembly), capacity, hours of operation | Admin |
| **Technician Schedule** | Per-technician daily schedule showing assigned ROs with estimated hours | Admin, Manager, Technician (own schedule) |
| **Intake Calendar** | Schedule customer drop-offs; shows available slots based on bay capacity | Admin, Manager, Receptionist |
| **Scheduling Settings** | Shop hours, bay definitions, scheduling rules, overbooking limits | Admin |

### Data Fields

| Field | Type | Description |
|-------|------|-------------|
| Bay | Dropdown | Which physical bay the work is scheduled in |
| Technician | Dropdown | Assigned technician |
| RO | Linked record | Which RO is being worked on |
| Start date/time | DateTime | Scheduled start |
| End date/time | DateTime | Scheduled end (based on estimated hours) |
| Status | Enum | Scheduled, In Progress, Complete, Rescheduled, Cancelled |
| Conflict | Boolean | Flag if bay/tech double-booked |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Conflict detection | System flags if a bay or technician is double-booked; allows override with reason |
| Drag-and-drop | Drag ROs onto calendar slots to schedule |
| Auto-suggest | AI suggests optimal bay/tech assignment based on RO type and tech specialization (suggestion only, human confirms) |
| Capacity view | Visual indicator showing % bay utilization per day |
| Integration with production board | Scheduling updates reflect on production board; production board updates reflect on schedule |

---

## 4. Full Inventory and Parts Management

### Purpose

Complete parts lifecycle: ordering, receiving, tracking, returns, vendor management.

### Screens

| Screen | Purpose | Access |
|--------|---------|--------|
| **Parts List (per RO)** | All parts on an RO with status per part | All roles (read); Parts Manager, Manager, Admin (write) |
| **Parts Order** | Create purchase order to vendor; line items from RO estimate | Parts Manager, Admin |
| **Parts Receiving** | Receive parts against a PO; scan or manual entry; partial receiving supported | Parts Manager |
| **Backorder Tracking** | List of all backordered parts across all ROs; vendor, ETA, age | Parts Manager, Manager, Admin |
| **Parts Return** | Create return/credit for incorrect or damaged parts; linked to original PO | Parts Manager, Admin |
| **Vendor Management** | Add/edit vendors (name, contact, account number, lead time); vendor performance metrics | Admin |
| **Parts Inventory** | Stock levels for commonly kept parts; reorder alerts | Parts Manager, Admin |

### Data Fields per Part

| Field | Type |
|-------|------|
| Part number | String |
| Part name / description | String |
| OEM / aftermarket / used | Enum |
| Vendor | Linked record |
| Unit price | Currency |
| Quantity ordered | Integer |
| Quantity received | Integer |
| Quantity backordered | Integer |
| ETA | Date |
| Status | Enum: ordered, shipped, received, backordered, returned, cancelled |
| PO number | String |
| RO number | Linked record |

### Behaviors

| Behavior | Detail |
|----------|--------|
| PO generation | Auto-generate PO from RO estimate parts list; editable before sending |
| Receiving workflow | Receive against PO; partial receives allowed; marks parts as received on RO |
| Backorder alerts | Parts not received within configured days (default 5) flagged as backordered |
| Return workflow | Create return against received part; generates credit note; updates RO cost |
| Print | Print PO, print receiving slip, print credit return slip |
| Vendor performance | Track: average lead time, backorder rate, return rate per vendor |

---

## 5. Customer Notification Engine

### Purpose

Automated and manual customer notifications via email and SMS at defined workflow triggers.

### Automated Triggers

| Trigger | Channel | Content |
|---------|---------|---------|
| RO moved to "Authorization" | Email | "Your vehicle is awaiting authorization. We'll update you when approved." |
| RO moved to "In Production" (Body/Frame) | Email + SMS | "Repair has started on your [vehicle]. Estimated completion: [date]." |
| RO moved to "Ready for Pickup" | Email + SMS | "Your [vehicle] is ready for pickup. Please contact us at [phone] to arrange." |
| RO Delivered | Email | "Thank you for choosing [shop name]. Please let us know about your experience." |
| Parts backordered | Email | "A part for your repair is on backorder. New estimated completion: [date]." |
| Supplement required | Email | "Additional damage was found on your [vehicle]. We are seeking authorization for additional repairs." |

### Configuration

| Setting | Detail |
|---------|--------|
| Per shop | Each trigger can be enabled/disabled per shop |
| Template editing | Admin can edit notification templates (subject, body); merge fields for RO data, customer data, shop data |
| Channel preference | Respects customer's preferred contact method (email, SMS, both) from customer record |
| Language | Notification sent in the language associated with the customer record |
| Opt-out | Customer can opt out of automated notifications; manual notifications still allowed |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Notification Templates** | Admin | Edit templates per trigger, per language |
| **Notification History** | Admin, Manager, Receptionist | Log of all sent notifications; status (sent, delivered, failed, bounced) |
| **Notification Settings** | Admin | Enable/disable triggers, configure channels, set timing delays |

---

## 6. Offline Capability and Sync

### Purpose

System must function when internet connection is lost and sync data when connection is restored. Sharon (Mar 18): "if my internet might not be great, and then it'll sync back when the internet goes on."

### What Works Offline

| Feature | Offline Capability |
|---------|-------------------|
| View current ROs | Yes -- cached from last sync |
| Update RO status | Yes -- queued for sync |
| Add notes | Yes -- queued for sync |
| Log labor hours | Yes -- queued for sync |
| View production board | Yes -- cached from last sync |
| View schedule | Yes -- cached from last sync |
| CIECA import | No -- requires server processing |
| Accounting export | No -- requires API connection |
| Click-to-talk AI | No -- requires LLM processing; shows "BC is offline" |
| Send email/SMS | No -- queued for sync, sent on reconnection |
| Reports | Yes -- cached data, may be stale; shows "Data as of [timestamp]" |

### Technical Implementation

| Component | Detail |
|-----------|--------|
| Local cache | Service Worker + IndexedDB for local data storage |
| Sync engine | Queue-based: offline changes stored locally with timestamps; sync on reconnection |
| Conflict resolution | Last-write-wins with conflict log for admin review; concurrent edits to same field flagged |
| Sync indicator | UI shows "Online" (green) / "Offline" (amber) / "Syncing" (blue pulse) in header bar |
| Cache size | Up to 30 days of active RO data cached locally |
| PWA | Full Progressive Web App with install prompt; works as standalone app on desktop and mobile |

---

## 7. Job Costing

### Purpose

Detailed cost tracking per RO: labor cost, parts cost, paint material cost, sublet cost, versus billed amounts. Margin calculation.

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Job Cost Detail (per RO)** | Admin, Manager, Accounting | Full cost breakdown vs. billed amounts per RO |
| **Job Cost Summary Report** | Admin, Manager, Accounting | Aggregate job cost analysis across all ROs for a period |
| **Manual Cost Entry** | Admin, Manager | Enter sublet costs, miscellaneous costs, paint material overrides |

### Data Fields per RO

| Field | Source | Description |
|-------|--------|-------------|
| Labor cost | Calculated | Tech hourly rate x actual hours logged, per tech, per operation |
| Parts cost | PO data | Total parts cost from purchase orders |
| Paint material cost | Manual or calculated | Paint and materials used; formula-based or manual entry |
| Sublet cost | Manual entry | Outsourced work (towing, glass, PDR, mechanical) |
| Total cost | Calculated | Sum of all cost categories |
| Total billed | Estimate/invoice | Total billed to insurance + customer |
| Gross margin | Calculated | (Total billed - Total cost) / Total billed x 100 |
| Margin flag | Calculated | Red if margin < configurable threshold (default 30%) |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Real-time calculation | Job cost updates as labor hours logged and parts received |
| Manual cost entry | Sublet and misc costs entered manually with description |
| Report integration | Job cost data feeds into Revenue Summary and Job Cost Summary reports |
| Per-RO visibility | Job cost tab on RO detail screen |
| Print | Print job cost breakdown per RO |

---

## 8. Guided Walkthroughs and Interactive Help

### Purpose

Interactive step-by-step guidance overlays that walk users through any process in BC. Reduces training time and support load. Sharon (Mar 18): "it's actually walking you through step by step."

### Implementation

| Element | Detail |
|---------|--------|
| Trigger | "Help" button on every screen + "BC, help with [topic]" voice command |
| Format | Step-by-step overlay: highlights the relevant UI element, shows instruction tooltip with arrow pointing to next click target |
| Content | Written for every major workflow: create RO, import estimate, export to accounting, schedule vehicle, update status, run report, manage users, configure settings, order parts, receive parts |
| Language | Available in all supported languages (EN, FR, ES in Phase 2) |
| Progress | User can skip steps, go back, or exit walkthrough at any time |
| First-run | New users see optional walkthrough on first login; can be triggered again from Help Center |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Help Center** | All users | Searchable list of all walkthroughs and help articles; categorized by workflow area |
| **Walkthrough Editor** | Micazen Admin | Create and edit walkthrough steps per screen/workflow; preview mode |

---

## 9. Recommendation Engine (Self-Healing)

### Purpose

System observes usage patterns and reports recommendations to authorized reviewers for approval. Does NOT make autonomous changes. Sharon (Roadmap): "That's dangerous" regarding autonomous changes.

### What It Reports

| Pattern Detected | Recommendation | Delivered To |
|-----------------|----------------|-------------|
| 80% of users skip a specific workflow step | "Step X in workflow Y is being skipped by most users. Consider removing or simplifying." | Sharon/Jim via weekly digest |
| Average cycle time increasing month-over-month | "Cycle time trend: up 12% over 3 months. Stage [X] shows longest dwell time increase." | Shop Admin + Micazen Admin |
| Specific error recurring | "Error [X] has occurred 15 times this month across 3 shops. Playbook review recommended." | D. Caine Solutions |
| Feature unused by >90% of users | "Feature [X] has <10% adoption. Consider training content or UI improvement." | Sharon/Jim via monthly digest |
| Vendor backorder rate above threshold | "Vendor [X] has 40% backorder rate vs. 15% average. Consider alternative vendors." | Shop Admin |
| RO bottleneck pattern | "ROs are consistently stalling at [stage] for >3 days. Common factor: [analysis]." | Shop Admin + Manager |

### Behavior Rules

| Rule | Detail |
|------|--------|
| No autonomous changes | System recommends only. All changes require human approval. Period. |
| Report delivery | Weekly email digest to configured recipients + in-app recommendation panel |
| Dismiss/acknowledge | Each recommendation can be acknowledged, dismissed, or marked "in progress" |
| Privacy | Recommendations are per-tenant only. No cross-tenant pattern analysis. |
| Override | Sharon/Jim can globally disable any recommendation type |

---

## 10. Custom Roles

### Purpose

Allow shop admins to create custom roles with granular permissions instead of the fixed roles from Phase 1.

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Role Editor** | Admin | Create custom role: name, description, permission checkboxes per feature area |
| **Role Assignment** | Admin | Assign any role (built-in or custom) to users |
| **Permission Matrix** | Admin (view) | Full matrix view: roles x permissions; exportable |

### Permission Categories

| Category | Granular Permissions |
|----------|-----------|
| RO Management | View all / view assigned only / create / edit / void / delete |
| Estimates | View / create / edit / import CIECA |
| Parts | View / order / receive / return / manage vendors / view inventory |
| Financials | View costs / view billing / export accounting / record payments / view job costing |
| Scheduling | View / create / edit / delete / view all bays / view own schedule only |
| Reporting | View / export / schedule / manage |
| User Management | View / create / edit / deactivate / manage roles |
| Settings | View / edit shop settings / edit system settings |
| AI Commands | All / limited to own data / view-only responses / disabled |
| Display Boards | View / configure |
| Notifications | View history / edit templates / configure triggers |

---

## 11. Scheduled and Emailed Reports

### Additions to Phase 1 Reports

| Feature | Detail |
|---------|--------|
| Schedule | Any report can be scheduled: daily, weekly, monthly; configurable day and time |
| Email delivery | Scheduled reports emailed as PDF attachment to configured recipients |
| Dashboard widgets | Key metrics displayed as cards on home screen: open ROs, avg cycle time, revenue MTD, overdue parts, bay utilization |

### New Reports in Phase 2

| Report | Description | Access |
|--------|-------------|--------|
| **Job Cost Summary** | Aggregate cost vs. billed analysis for a period; margin by RO, by tech, by insurance | Admin, Manager, Accounting |
| **Vendor Performance** | Lead time, backorder rate, return rate per vendor; trend charts | Admin, Parts Manager |
| **Customer Communication Log** | All notifications sent per customer per RO; delivery status | Admin, Manager, Receptionist |
| **Scheduling Utilization** | Bay and technician utilization % per day/week/month | Admin, Manager |
| **AI Usage Report** | Commands issued, success rate, most common requests, errors | Micazen Admin |
| **Recommendation Summary** | Recommendations generated, accepted, dismissed, pending | Micazen Admin |

---

## 12. Two-Factor Authentication

| Detail | Value |
|--------|-------|
| Method | TOTP (Google Authenticator, Authy, or equivalent) |
| Enforcement | Optional per shop; admin can require for specific roles (e.g., mandatory for Admin, optional for Tech) |
| Setup | QR code scan during first enable; backup recovery codes generated (one-time use) |
| Bypass | Admin can temporarily disable 2FA for a locked-out user (action logged in audit trail) |

---

## 13. What Is Sellable vs Internal Testing

| Feature | Sellable | Internal Testing Only |
|---------|----------|----------------------|
| Everything from Phase 1 | Yes -- remains in production | -- |
| Sovereign LLM (no data leaves Canada) | Yes -- privacy selling point for Canadian shops and networks | -- |
| AI-assisted workflow suggestions | Yes -- "BC suggests, you confirm" is the productivity differentiator | -- |
| Full scheduling | Yes -- shops need scheduling to manage intake and bays | -- |
| Full parts management | Yes -- parts lifecycle is core to daily operations | -- |
| Customer notifications | Yes -- automated customer updates reduce inbound calls | -- |
| Job costing | Yes -- financial management is essential for profitability | -- |
| Offline capability | Yes -- shops with unreliable internet can still operate | -- |
| Spanish language | Yes -- opens US market | -- |
| Guided walkthroughs | Yes -- reduces onboarding time for new shops | -- |
| Recommendation engine | Yes -- shops value insights (recommends only, no autonomous changes) | -- |
| Zoho Desk native integration | Yes -- seamless support flow | -- |
| Custom roles | Yes -- shops with unique org structures benefit | -- |
| Cloud media integrations | Yes -- shops already using Google Drive/Dropbox/OneDrive | -- |

**Phase 2 is the "complete independent shop" release.** After Phase 2, any independent or small MSO shop can fully run their business on BCAI with AI assistance, offline capability, full parts/scheduling/costing, trilingual support, and cloud media storage.

---

## 14. What AI Can Do at This Phase

Everything from Phase 1 (find, add notes, update status, show summary, send communications, report queries, navigate, help), PLUS:

| What You Say | What BC Does |
|-------------|-------------|
| "BC, schedule the Smith repair for Bay 2 on Tuesday" | Creates schedule entry in Bay 2 for Tuesday; confirms details before saving |
| "BC, order parts for RO 4521" | Generates PO from estimate parts list; shows PO for review and confirmation |
| "BC, check if parts are in for the Johnson repair" | Reports parts status per line item: received, ordered, backordered with ETA |
| "BC, receive parts for PO 8834" | Opens receiving screen pre-populated with PO; user checks off received items |
| "BC, what's the job cost on RO 4521?" | Reports cost breakdown: labor $X, parts $X, paint $X, sublet $X, margin X% |
| "BC, which technician was most efficient last month?" | Queries productivity report; returns ranking by hours-per-RO ratio |
| "BC, create a widget showing open ROs by stage" | Generates dashboard widget; saved to user's home screen |
| "BC, should I move the Honda to paint?" | Checks prerequisites (parts received, body work complete); recommends yes/no with reasons |
| "BC, notify the customer on RO 4521 that parts are delayed" | Drafts notification in customer's preferred language/channel; shows preview for confirmation |
| "BC, what's my schedule today?" | Shows technician's daily schedule: which ROs, which bays, estimated hours |
| "BC, help me set up a new vendor" | Launches guided walkthrough for vendor management |
| "BC, show me the recommendation report" | Opens recommendation engine panel with pending suggestions |
| "BC, which vendors have the highest backorder rate?" | Queries vendor performance data; returns ranked list |
| "BC, how's our bay utilization this week?" | Returns utilization percentages per bay |

**What BC still CANNOT do in Phase 2:**
- Operate hands-free without clicking microphone button (Phase 4 -- wake word)
- Execute actions without human confirmation
- Access data from other shops/tenants
- Order parts directly from supplier systems without user review (electronic PO sending is available but requires confirmation)
- Make autonomous changes to workflows, settings, or business rules

---

## 15. Integrations Included

### New in Phase 2

| Integration | Type | Direction | Detail |
|-------------|------|-----------|--------|
| Google Drive | OAuth 2.0 API | Bidirectional | Upload/download photos and documents linked to ROs; per-tenant folder structure |
| Dropbox | OAuth 2.0 API | Bidirectional | Upload/download media linked to ROs |
| OneDrive | OAuth 2.0 API | Bidirectional | Upload/download media linked to ROs |
| Zoho Desk | REST API | Bidirectional | Auto-create tickets from in-app issue reporting; sync ticket status back; playbook access from within Zoho |
| Paint scale vendors | Vendor-specific API | Bidirectional | Import paint formulas; write back paint usage data to vendor system |
| AutoHouse | API/file push | Outbound | Push delivery data and vehicle info on RO completion |
| ClaimsCorp | API/file push | Outbound | Push claim completion data |
| Parts supplier ordering (pilot: 2-3 vendors) | Vendor API | Outbound | Submit purchase orders electronically; receive order confirmations |

### Cumulative Integration List (Phase 1 + Phase 2)

| # | Integration | Phase Introduced |
|---|-------------|-----------------|
| 1 | CCC ONE (CIECA import) | Phase 1 |
| 2 | Mitchell (CIECA import) | Phase 1 |
| 3 | Audatex (CIECA import) | Phase 1 |
| 4 | QuickBooks Online | Phase 1 |
| 5 | QuickBooks Desktop | Phase 1 |
| 6 | Sage 50 | Phase 1 |
| 7 | Sage Cloud | Phase 1 |
| 8 | Xero | Phase 1 |
| 9 | SendGrid (email) | Phase 1 |
| 10 | Twilio (SMS) | Phase 1 |
| 11 | Google Drive | Phase 2 |
| 12 | Dropbox | Phase 2 |
| 13 | OneDrive | Phase 2 |
| 14 | Zoho Desk | Phase 2 |
| 15 | Paint scale vendors | Phase 2 |
| 16 | AutoHouse | Phase 2 |
| 17 | ClaimsCorp | Phase 2 |
| 18 | Parts suppliers (pilot) | Phase 2 |

### Deferred Integrations

| Integration | Phase |
|-------------|-------|
| CSI platform data pushes (trigger on delivery date) | Phase 3 |
| Insurance carrier integrations | Phase 3 |
| Serbia DMS | Phase 3 |
| Full parts supplier network (beyond pilot vendors) | Phase 3 |
| DRP scorecard integrations | Phase 3 |

---

## 16. Multi-Language Coverage

| Language | UI | AI (Click-to-Talk) | Help / Walkthroughs | Reports | Customer Notifications |
|----------|-----|-------------------|-------------------|---------|----------------------|
| English | Full | Full | Full | Full | Full |
| French | Full | Full | Full | Full | Full |
| Spanish | Full (NEW) | Full (NEW) | Full (NEW) | Full (NEW) | Full (NEW) |

Spanish language is added to all UI elements, AI responses, guided walkthroughs, report labels and headers, and customer notification templates.

### Deferred Languages

| Language | Phase |
|----------|-------|
| Romanian | Phase 3+ |
| Italian | Phase 3+ |
| Hindi | Phase 3+ |

---

## 17. Support Model

### SLA (unchanged from Phase 1)

| Priority | Identification | Resolution |
|----------|---------------|------------|
| Critical (system down) | 2 hours | 12 hours |
| High (feature broken, workaround exists) | 12 hours | 24 hours |
| Medium (not as expected, non-blocking) | 24 hours | 72 hours |
| Low (enhancement, minor feedback) | 48 hours | Next scheduled release |

### Enhancements from Phase 1

| Enhancement | Detail |
|-------------|--------|
| Zoho Desk native integration | Tickets flow automatically: in-app report -> Zoho Desk -> D. Caine Solutions; no manual routing needed |
| Playbook growth | All Phase 1 entries carried forward; new entries for every Phase 2 feature area |
| Sovereign LLM monitoring | D. Caine Solutions monitors LLM health, inference latency, error rates; AI-specific SLA: if LLM degrades, identification within 1 hour |
| Recommendation engine alerts | System self-identifies recurring issues and flags them before users report |

---

## 18. What Is NOT in This Phase

| Feature | Deferred To | Reason |
|---------|------------|--------|
| Network-level admin (Regional + Network RBAC tiers) | Phase 3 | Requires network architecture, SOP engine, and pilot partner |
| SOP enforcement engine | Phase 3 | Requires standardized SOPs and network admin tier |
| Native mobile app (App Store / Play Store) | Phase 3 | PWA sufficient for current market; native adds complexity |
| Customer-facing portal | Phase 3 | Not needed until network rollout targets |
| Advanced analytics / cross-shop benchmarking | Phase 3 | Requires network-level data aggregation with privacy controls |
| CSI platform data pushes | Phase 3 | Network-level feature; insurance DRP requirement |
| Insurance carrier integrations | Phase 3 | Network-level feature |
| Serbia DMS interface | Phase 3 | Specialized; lower priority for Phase 2 market |
| Wake word ("Hey BC") hands-free operation | Phase 4 | Requires hardware + Picovoice integration |
| Voice in every bay (Brad) | Phase 4 | Per-bay hardware + per-bay agents |
| Per-bay autonomous workflow agents | Phase 4 | Requires mature AI and shop-floor hardware |
| Hardware (speakers, microphones per bay) | Phase 4 | Physical deployment |
| Data migration from existing BodyShopConnect | Phase 5 | New customers first; migration after system proven |
| White-label platform | Phase 5 | Platform maturity required |
| API ecosystem for third-party developers | Phase 5 | Platform maturity required |
| Romanian, Italian, Hindi languages | Phase 3+ | Low priority for current markets |

---

## 19. Acceptance Criteria

| # | Criterion |
|---|----------|
| 1 | Sovereign LLM is running on AWS ca-central-1; no AI requests route to external providers |
| 2 | All Phase 1 click-to-talk commands function correctly with sovereign LLM (no degradation from Phase 1) |
| 3 | AI workflow suggestion appears when RO enters "Parts Received" for >4 hours; user can accept or dismiss |
| 4 | AI suggestions respect RBAC: technician sees only suggestions for own assigned ROs |
| 5 | No AI-suggested action executes without explicit user confirmation |
| 6 | A vehicle can be scheduled into a bay on a specific date; double-booking is detected and flagged |
| 7 | A purchase order can be generated from RO estimate, reviewed, confirmed, and submitted to vendor |
| 8 | Partial parts receiving works: 3 of 5 parts received, 2 remain on backorder with ETA |
| 9 | Customer receives automated email + SMS when RO moves to "Ready for Pickup" in their preferred language |
| 10 | System functions offline: user can view ROs, update status, add notes with no internet connection |
| 11 | Offline changes sync correctly when reconnected; no data loss; conflict log shows any concurrent edits |
| 12 | Job cost detail shows correct margin for a completed RO: labor + parts + paint + sublet vs. billed |
| 13 | Guided walkthrough for "Create RO" launches correctly; overlay highlights correct UI elements step-by-step |
| 14 | Recommendation engine generates weekly digest with at least one pattern-based recommendation |
| 15 | Recommendation engine makes zero autonomous changes to any data, setting, or workflow |
| 16 | Custom role "Senior Tech" can be created with specific permissions (e.g., view parts but cannot order) |
| 17 | A report can be scheduled for weekly email delivery; recipient receives PDF |
| 18 | Full UI displays correctly in Spanish (all labels, menus, buttons, error messages) |
| 19 | Click-to-talk AI responds correctly when spoken to in Spanish |
| 20 | Photos upload to shop's Google Drive folder and link to correct RO |
| 21 | In-app issue report auto-creates Zoho Desk ticket with full context (no manual steps for Micazen team) |
| 22 | 2FA can be enabled; login requires TOTP code after password |
| 23 | "BC, schedule Smith for Bay 2 on Tuesday" creates correct schedule entry after confirmation |
| 24 | "BC, what's the job cost on RO 4521?" returns accurate cost breakdown from sovereign LLM |
| 25 | "BC, which technician was most efficient last month?" returns correct ranked list |
| 26 | Parts credit return prints correctly with all required fields |
| 27 | Vendor performance report shows correct lead time, backorder rate, and return rate per vendor |

---

**End of Phase 2 Specification**

*This document is a technical specification for red-line review. No sales language. No value propositions. No revenue projections. Features, screens, fields, behaviors.*
