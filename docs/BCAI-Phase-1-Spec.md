# BCAI Phase 1 -- Core Platform + Click-to-Talk AI

## BodyShopConnect AI | Micazen Consulting & Technologies

| Field | Value |
|-------|-------|
| **Document Version** | 2.0 |
| **Date** | April 7, 2026 |
| **Timeline** | 6--8 weeks from contract execution |
| **Investment** | $40,000--$65,000 CAD |
| **Billing** | Milestone-based: 30% at kickoff, 40% at internal testing, 30% at acceptance |
| **Deliverable Summary** | Working collision repair management system with click-to-talk AI, CIECA imports, five accounting exports, four-tier RBAC, multi-tenant isolation, bilingual UI (EN/FR), mobile-responsive web, basic reporting, and production display boards. Sellable to independent shops on day one. |

---

## Table of Contents

1. [CIECA / Estimating System Imports](#1-cieca--estimating-system-imports)
2. [Accounting Exports](#2-accounting-exports)
3. [Core Repair Order Workflow](#3-core-repair-order-ro-workflow)
4. [Click-to-Talk AI (BC Voice)](#4-click-to-talk-ai-bc-voice)
5. [Role-Based Access Control (RBAC)](#5-role-based-access-control-rbac)
6. [Multi-Tenant Architecture](#6-multi-tenant-architecture)
7. [Basic Reporting](#7-basic-reporting)
8. [Production Display Boards (TV)](#8-production-display-boards-tv)
9. [Mobile-Responsive Web UI](#9-mobile-responsive-web-ui)
10. [Multi-Language Coverage](#10-multi-language-coverage)
11. [Authentication and Security](#11-authentication-and-security)
12. [Infrastructure](#12-infrastructure)
13. [What Is Sellable vs Internal Testing](#13-what-is-sellable-vs-internal-testing)
14. [What AI Can Do at This Phase](#14-what-ai-can-do-at-this-phase)
15. [Integrations Included](#15-integrations-included)
16. [Support Model](#16-support-model)
17. [Ongoing Development Model](#17-ongoing-development-model)
18. [What Is NOT in This Phase](#18-what-is-not-in-this-phase)
19. [Acceptance Criteria](#19-acceptance-criteria)

---

## 1. CIECA / Estimating System Imports

### Purpose

Import estimate data from the three major estimating systems (CCC ONE, Mitchell, Audatex) into BC via CIECA-standard XML/EMS files. These are competing estimating platforms -- BC imports data FROM them. BC does not partner with or embed these systems.

### Supported Import Sources

| Estimating System | Format | Import Method |
|-------------------|--------|---------------|
| CCC ONE | CIECA XML (BMS/EMS) | File upload + API endpoint |
| Mitchell | CIECA XML (BMS/EMS) | File upload + API endpoint |
| Audatex | CIECA XML (BMS/EMS) | File upload + API endpoint |

### Screens

| Screen | Purpose | Access |
|--------|---------|--------|
| **Import Queue** | List of all pending/processing/completed/failed imports with status badge, timestamp, source system, and linked RO number | Admin, Manager, Estimator |
| **Import Detail** | View raw estimate data mapped to BC fields before RO creation; allows field review and manual override before confirm | Admin, Manager, Estimator |
| **Import Settings** | Configure active estimating systems, default field mappings, duplicate detection rules, API endpoint credentials | Admin |
| **Import History** | Searchable log of all imports with date range filter, status filter, export to CSV | Admin, Manager |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Manual import | Upload CIECA XML/EMS file via drag-and-drop or file picker |
| API import | Dedicated endpoint per tenant receives CIECA XML; authenticates via tenant API key |
| RO creation | Import creates new RO or updates existing RO if claim number + VIN match |
| Duplicate detection | Match on claim number + VIN; prompt user on potential duplicate |
| Failure handling | Failed imports display error with problematic field highlighted; retry button available |
| Retention | Import history retained for 365 days minimum |
| Supplements | Re-import on existing claim number adds supplement lines to existing RO, flags for re-authorization |

### Data Fields Imported

| Category | Fields |
|----------|--------|
| Vehicle | Year, make, model, VIN, color, license plate, mileage |
| Owner | Name, phone, email, address |
| Insurance | Company name, claim number, policy number, adjuster name, adjuster phone, adjuster email |
| Damage Lines | Operation type (R&I, repair, replace, blend, refinish), part number, part name, labor hours, labor rate, paint hours, paint material cost, sublet cost |
| Totals | Parts total, labor total, paint total, sublet total, grand total |

---

## 2. Accounting Exports

### Purpose

Push financial data from completed ROs to the shop's accounting system. All five accounting systems currently supported by BodyShopConnect must be available at Phase 1 launch.

### Supported Systems

| System | Export Method | Data Format |
|--------|-------------|-------------|
| QuickBooks Online | REST API (OAuth 2.0) | JSON invoice with line items |
| QuickBooks Desktop | IIF file export (downloadable) | IIF format |
| Sage 50 | CSV export (downloadable) | Sage 50 import CSV format |
| Sage Cloud | REST API | JSON invoice with line items |
| Xero | REST API (OAuth 2.0) | JSON invoice with line items |

### Screens

| Screen | Purpose | Access |
|--------|---------|--------|
| **Export Queue** | List of ROs ready for accounting export; status column (pending, exported, failed, manually overridden) | Admin, Accounting |
| **Export History** | Completed exports with timestamp, target system, confirmation ID, export file download link | Admin, Accounting |
| **Accounting Settings** | Configure target system per shop, OAuth credentials, field mapping, chart of accounts mapping, tax rate configuration (GST, PST, HST) | Admin |
| **Export Preview** | View invoice data before export; allows manual adjustment of line items, tax codes, account codes | Admin, Accounting |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Trigger | Export available when RO status = "Completed" AND "Ready for Billing" |
| Line item mapping | Parts -> parts revenue account; Labor -> labor revenue account; Paint -> paint material account; Sublet -> sublet account |
| Tax calculation | Uses shop-configured tax rate(s) -- GST, PST, HST as applicable per province/state |
| Failure handling | Failed API exports retry once automatically, then flag for manual review with error detail |
| Manual trigger | Any completed RO can be manually exported or re-exported |
| File exports | QB Desktop IIF and Sage 50 CSV generate downloadable files; user clicks download |
| Audit | Every export logged with timestamp, user, target system, success/fail status |

### Data Fields Exported

| Category | Fields |
|----------|--------|
| Customer | Name, address, phone, email |
| Invoice | RO number, invoice date, due date, PO number (claim number) |
| Line Items | Description, quantity, unit price, tax code, GL account code |
| Totals | Subtotal, tax breakdown (by type), grand total |
| Payment | Method (cash, check, credit card, insurance direct), amount received, balance owing |

---

## 3. Core Repair Order (RO) Workflow

### Purpose

The daily operating system of a collision repair shop. Every vehicle is tracked as a Repair Order moving through defined production stages.

### RO Statuses

| Status | Description |
|--------|-------------|
| **Estimate** | Vehicle assessed, estimate received or imported |
| **Authorization** | Waiting for insurance or customer approval |
| **Parts Order** | Parts ordered, waiting for delivery |
| **Parts Received** | All parts received, ready for production scheduling |
| **Body** | Structural and body repair in progress |
| **Frame** | Frame straightening/alignment in progress |
| **Paint** | In paint booth or paint prep |
| **Assembly** | Reassembly after paint |
| **Quality Check (QC)** | Final inspection before delivery |
| **Ready for Pickup** | Complete, customer notified |
| **Delivered** | Vehicle picked up, RO closed |
| **Void** | RO cancelled (requires manager/admin approval) |

### Screens

#### 3a. Production Board (Primary Screen)

| Element | Detail |
|---------|--------|
| Layout | Kanban-style board with columns per production stage |
| Card content | RO number, vehicle (year/make/model), customer last name, days in current stage, assigned technician, insurance company, flagged status icon |
| Interaction | Drag-and-drop cards between stages (respects RBAC permissions) |
| Color coding | Green = on track; Yellow = exceeds stage threshold (configurable, default 2 days); Red = exceeds critical threshold (configurable, default 5 days) |
| Filters | By technician, by stage, by insurance company, by date range, by flagged status |
| Search | RO number, customer name, VIN, claim number, vehicle make/model |
| Refresh | Auto-refresh every 60 seconds; manual refresh button |

#### 3b. RO Detail Screen

| Tab | Fields / Content |
|-----|-----------------|
| **Header** (always visible) | RO number, current status, created date, target completion date, total estimate amount, insurance company, assigned technician, days open |
| **Vehicle** | Year, make, model, VIN, color, license plate, mileage, production date, photos (upload from device, drag-and-drop, max 50 per RO) |
| **Customer** | First name, last name, phone (primary), phone (secondary), email, address (street, city, province/state, postal/zip), preferred contact method (phone/email/text) |
| **Insurance** | Company, claim number, policy number, deductible amount, adjuster name, adjuster phone, adjuster email, authorization status (pending/approved/denied), authorization date, supplement history |
| **Estimate** | Imported estimate line items (from CIECA import, read-only source), manual line items (add/edit), parts list with status per part (ordered/received/backordered/returned), labor breakdown by operation type, paint materials, sublet items |
| **Assignments** | Assigned technician(s) per production stage, assignment date, estimated hours, actual hours logged |
| **Notes** | Timestamped notes from any user; note type tag (internal, customer communication, insurance communication, tech note); each note shows author, role, timestamp; notes are append-only (no edit/delete by non-admin) |
| **History / Audit** | Every status change, every field edit, every user login that accessed this RO; timestamp + user + before/after values |
| **Financials** | Estimate total, supplement totals, payments received (method + amount + date), balance due, accounting export status + timestamp |
| **Documents** | Uploaded files (PDF, images); linked to Google Drive/Dropbox/OneDrive if configured (read-only in Phase 1 -- full integration Phase 2) |

#### 3c. Create RO Screen

| Field | Required | Default |
|-------|----------|---------|
| Vehicle year | No | Blank |
| Vehicle make | No | Blank |
| Vehicle model | No | Blank |
| VIN | No | Blank (auto-populates year/make/model if entered) |
| Customer name | No | Blank |
| Customer phone | No | Blank |
| Insurance company | No | Blank |
| Claim number | No | Blank |
| Source | Yes | Manual (other option: CIECA Import) |

Note: "Create from CIECA Import" auto-populates all fields from import data.

#### 3d. RO List Screen

| Column | Sortable | Filterable |
|--------|----------|-----------|
| RO Number | Yes | Yes |
| Vehicle (year/make/model) | Yes | Yes (make, model) |
| Customer Name | Yes | Yes |
| Current Stage | Yes | Yes (dropdown) |
| Created Date | Yes | Yes (date range) |
| Age (days) | Yes | Yes (range) |
| Estimate Total | Yes | Yes (range) |
| Assigned Technician | Yes | Yes (dropdown) |
| Insurance Company | Yes | Yes (dropdown) |
| Status | Yes | Yes (active/closed/void) |

Export: CSV download of current filtered view.

#### 3e. Assignments Screen

| Element | Detail |
|---------|--------|
| Purpose | Assign technicians to ROs at specific production stages |
| View | Table: RO number, vehicle, current stage, assigned tech, estimated hours, actual hours |
| Action | Assign/reassign technician from dropdown; set estimated hours |
| Drag-and-drop | Assign by dragging tech name onto RO card in production board |

#### 3f. Void RO Screen

| Element | Detail |
|---------|--------|
| Trigger | "Void RO" button on RO detail (Manager/Admin only) |
| Requires | Reason for void (free text, mandatory) |
| Effect | RO status -> Void; all parts orders flagged for review; accounting export blocked; RO appears in void filter of RO List |
| Reversible | Admin can un-void within 30 days |

### Core Behaviors

| Behavior | Detail |
|----------|--------|
| Status change logging | Every stage transition logged: timestamp, user, from-stage, to-stage |
| Overdue alerts | Configurable threshold per stage; default: yellow at 2 days, red at 5 days |
| Supplement workflow | New estimate lines added to existing RO trigger re-authorization status; insurance tab updates |
| Gate: Ready for Pickup | Cannot move to "Ready for Pickup" unless all parts marked received AND all labor hours logged |
| Gate: Delivered | Cannot move to "Delivered" unless accounting export complete OR manager override with reason |
| Gate: Void | Requires Manager or Admin role + mandatory reason text |
| Print | Print RO summary, print invoice, print credit return slip (PDF generation, browser print dialog) |

---

## 4. Click-to-Talk AI (BC Voice)

### Purpose

The sales differentiator. A microphone button on every screen that lets the user speak natural-language commands to BC. Not full voice/wake word -- user clicks a button, speaks, BC executes. This is what makes Phase 1 sellable to independent shops, not just a "basic product."

### UI Element

| Element | Detail |
|---------|--------|
| Location | Persistent floating button, bottom-right of every screen (star icon with microphone) |
| Activation | Click/tap the button; button pulses to indicate listening |
| Feedback | Real-time transcription displayed in overlay panel; BC response displayed below |
| Cancel | Click button again or tap outside overlay to cancel |
| History | Last 20 commands visible in collapsible sidebar panel |
| Language | Responds in the UI language selected by user (English or French in Phase 1) |

### Commands Available in Phase 1

| Command Category | Example Phrases | Action |
|-----------------|-----------------|--------|
| **Find / Search** | "BC, find Smith" / "BC, pull up RO 4521" / "BC, show the file for the blue Honda" | Searches ROs by customer name, RO number, vehicle description; navigates to RO detail |
| **Add Notes** | "BC, add a note to the Smith file: customer called about pickup time" | Appends timestamped note to specified RO; confirms before saving |
| **Update Status** | "BC, move Smith to paint" / "BC, update RO 4521 to quality check" | Changes RO production stage; confirms before executing; respects gate rules |
| **Show Summary** | "BC, what's the status on the Johnson repair?" / "BC, give me a summary of RO 4521" | Reads back current stage, days open, assigned tech, next action needed |
| **Send Communication** | "BC, send an email to the customer on RO 4521 saying their vehicle is ready" / "BC, text Mrs. Johnson that her car is in paint" | Drafts email or SMS; shows draft to user for confirmation before sending |
| **Report Query** | "BC, how many open ROs do we have?" / "BC, what's our average cycle time this month?" | Queries live data; returns spoken + displayed answer |
| **Navigate** | "BC, go to reporting" / "BC, open the parts screen" | Navigates to specified screen |
| **Help** | "BC, how do I create a repair order?" / "BC, help with importing estimates" | Returns step-by-step instructions from help knowledge base |

### Behavior Rules

| Rule | Detail |
|------|--------|
| Confirmation | All write actions (add note, update status, send email/text) require explicit user confirmation before executing |
| RBAC enforcement | AI commands respect the user's role; a Technician cannot say "BC, void RO 4521" |
| Error handling | If BC cannot understand or execute, it says "I didn't understand that. Could you try rephrasing?" and suggests similar valid commands |
| Audit | Every AI command logged: timestamp, user, spoken text, interpreted action, result |
| Offline | Click-to-talk requires internet connection; displays "BC is offline" when no connection |
| Speed | Response within 3 seconds for search/navigate; within 5 seconds for data queries |

### Technical Implementation

| Component | Detail |
|-----------|--------|
| Speech-to-text | Browser Web Speech API (Chrome, Edge, Safari) + server-side Whisper fallback |
| NLU/Intent | Cloud-hosted LLM (Claude API or equivalent) for intent parsing + entity extraction; tenant-scoped context |
| Text-to-speech | Browser SpeechSynthesis API for spoken responses |
| Command routing | Parsed intent mapped to internal API calls; same API endpoints as manual UI actions |
| Privacy | Audio never stored; only transcribed text is logged; transcription processed per-tenant in isolation |

---

## 5. Role-Based Access Control (RBAC)

### Four-Tier Structure

BC operates on a four-tier access hierarchy reflecting the collision repair industry structure:

| Tier | Description | Scope |
|------|-------------|-------|
| **Single Store** | One shop, one location | See only own shop data |
| **MSO (Multi-Shop Operator)** | 2-10 locations under one owner | See all owned shop data; switch between shops |
| **Regional** | Area manager overseeing multiple MSOs or stores | See all shops in assigned region; aggregate reporting |
| **Network** | Franchise or corporate network (e.g., CSN, AutoCanada) | See all shops in network; network-wide reporting and SOP enforcement; manage regional admins |

Note: Phase 1 implements Single Store and MSO tiers. Regional and Network tiers are delivered in Phase 3.

### Roles Within a Shop (Single Store / MSO)

| Role | Permissions |
|------|------------|
| **Shop Owner / Admin** | Full access: all screens, all data, all settings, user management, accounting, reporting, AI commands (all) |
| **Manager** | Operations access: production board, all ROs, reporting, QC override, assignment management, AI commands (all except billing settings). No: billing settings, user management |
| **Estimator** | Estimate access: create/edit estimates, import CIECA, view RO status, add notes. No: financials, payments, labor costs, user management |
| **Technician** | Bay access: view assigned ROs only, update status on assigned ROs, add tech notes, log labor hours. No: customer contact info beyond name, financials, other techs' ROs. AI commands limited to own assignments |
| **Receptionist** | Front desk: customer intake, RO creation, status viewing, delivery processing, customer communication (email/text). No: labor details, cost details, job costing |
| **Parts Manager** | Parts access: parts ordering, parts receiving, backorder tracking, vendor management, parts-related reporting. No: financials beyond parts costs |
| **Accounting** | Financial access: accounting exports, payment recording, financial reports, invoice printing. No: production operations, technician management |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **User Management** | Admin only | Create, edit, deactivate, reactivate users; assign roles; reset passwords; view login history |
| **Role Configuration** | Admin only (view only in Phase 1) | View permissions matrix per role. Custom roles deferred to Phase 2 |
| **Shop Switcher** | MSO Admin, MSO Manager | Dropdown in header to switch between shops; shows shop name + location |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Login | Email + password |
| Session timeout | 8 hours (configurable by admin; range: 1-24 hours) |
| Password policy | Minimum 8 characters; must include uppercase, lowercase, number; expiry configurable (default 90 days) |
| Failed login lockout | 5 consecutive failures = 15-minute lockout; admin can unlock |
| Single role per user | A user has one role per shop (no multi-role in Phase 1) |
| Audit | Every login, failed login, role change, permission-level action logged with timestamp, user, IP address |
| Deactivation | Deactivated users cannot log in; their historical actions remain in audit trail |

---

## 6. Multi-Tenant Architecture

### Isolation Requirements

| Requirement | Implementation |
|-------------|---------------|
| Data isolation | Per-tenant schema within shared PostgreSQL instance; no cross-tenant queries possible at database level |
| API scoping | Every API request validated against tenant context via JWT claims; no endpoint returns cross-tenant data |
| File storage | Per-tenant prefix in S3-compatible storage (Canadian region); no shared buckets |
| AI isolation | Click-to-talk AI context scoped to current tenant; no cross-tenant learning, no cross-tenant data exposure |
| Backups | Per-tenant backup capability; tenant data exportable on request |
| GUID tracking | All records use GUID primary keys (consistent with existing BC architecture) |

### Tenant Provisioning

| Action | Detail |
|--------|--------|
| Create new shop | Admin panel: enter shop name, address, province/state, timezone, primary contact; tenant provisioned in under 5 minutes |
| Deactivate shop | Admin panel: deactivate tenant; data retained for 90 days; no user access |
| Reactivate shop | Admin panel: reactivate within 90-day window |
| Data export | Admin can trigger full tenant data export (CSV + media files) |

### What the Shop Sees

- Only their own data. Always.
- Shop name and logo in header.
- Their own user list, ROs, settings, reports.
- No awareness that other tenants exist.

### What Micazen Admin Sees

| Screen | Purpose |
|--------|---------|
| **Tenant Dashboard** | List of all active/inactive tenants with usage stats (active users, ROs this month, storage used) |
| **Tenant Detail** | Shop info, billing status, subscription tier (BC Light/Medium/Full + BCAI add-on), user count, last login |
| **Tenant Provisioning** | Create new tenant with wizard |
| **System Health** | Aggregate system metrics (not individual tenant data) |

---

## 7. Basic Reporting

### Reports Included

| Report | Description | Access | Export |
|--------|-------------|--------|--------|
| **Cycle Time** | Average days per RO from creation to delivery, broken down by stage | Admin, Manager | CSV, PDF |
| **RO Volume** | ROs created, completed, in-progress, void per day/week/month | Admin, Manager | CSV, PDF |
| **Technician Productivity** | Labor hours logged per technician per day/week/month; estimated vs. actual | Admin, Manager | CSV, PDF |
| **Parts Status** | Parts on order, received, backordered; age per outstanding part; vendor breakdown | Admin, Manager, Parts Manager | CSV, PDF |
| **Revenue Summary** | Total billed, total collected, total outstanding per period | Admin, Accounting | CSV, PDF |
| **Stage Bottleneck** | Which stages have most ROs stalled and for how long; average dwell time per stage | Admin, Manager | CSV, PDF |
| **Assignments Report** | Current technician workload; ROs per tech; hours per tech | Admin, Manager | CSV, PDF |
| **Void Report** | Voided ROs with reason, date, authorized by | Admin | CSV, PDF |

### Screens

| Screen | Detail |
|--------|--------|
| **Reports Dashboard** | Grid of available reports; last-generated date; click to open |
| **Report Viewer** | Rendered table/chart with date range selector (default: current month); export buttons (CSV, PDF) |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Data source | Live data (not pre-calculated snapshots) |
| Date filter | Every report has date range filter; presets: today, this week, this month, last month, custom |
| Scheduled reports | Not in Phase 1 (deferred to Phase 2) |
| Emailed reports | Not in Phase 1 (deferred to Phase 2) |
| Chart display | Bar charts for volume/time reports; tables for detail reports |

---

## 8. Production Display Boards (TV)

### Purpose

Wall-mounted TV screens in the shop showing real-time production status. Technicians, managers, and front desk see at a glance where every vehicle is.

### Screens

| Screen | Detail |
|--------|--------|
| **Display Board View** | Full-screen, auto-rotating production board optimized for 1080p/4K TV display |
| **Display Board Settings** | Configure which stages to show, rotation speed, color thresholds, shop branding |

### Display Board Content

| Element | Detail |
|---------|--------|
| Layout | Horizontal columns per production stage; large font, high contrast |
| Card content | RO number, vehicle (year/make/model/color), customer last name, days in stage, assigned tech |
| Color coding | Same as production board (green/yellow/red thresholds) |
| Auto-refresh | Every 30 seconds |
| Authentication | Display board URL is a special read-only token URL; no login required on the TV; token scoped to tenant |
| Branding | Shop logo and name displayed in header |

### Technical

| Detail | Value |
|--------|-------|
| Access | Dedicated URL per tenant (e.g., `app.bcai.ca/display/{tenant-token}`) |
| Browser | Any modern browser on smart TV, Chromecast, Fire TV, or dedicated PC |
| Orientation | Landscape only |
| No interaction required | Display-only; no input, no login screen |

---

## 9. Mobile-Responsive Web UI

### Breakpoints

| Device | Width | Layout |
|--------|-------|--------|
| Desktop | >1024px | Full layout: sidebar navigation + main content + detail panel |
| Tablet | 768--1024px | Sidebar collapses to icon rail; main content fills screen |
| Phone | <768px | Single column; bottom tab navigation; cards stack vertically |

### Key Behaviors per Device

| Feature | Desktop | Tablet | Phone |
|---------|---------|--------|-------|
| Production board | Full kanban | Full kanban, scrollable | Horizontal swipe between stages |
| RO detail | Tabbed sidebar | Full-screen tabs | Full-screen stacked tabs |
| Photo upload | Drag-and-drop + file picker | File picker + camera | Camera button (uses device camera) |
| Click-to-talk AI | Floating button, bottom-right | Floating button, bottom-right | Floating button, bottom-right |
| Notes input | Standard text area | Standard text area | Large touch-friendly text area |
| Touch targets | N/A | Minimum 44x44px | Minimum 44x44px |
| Print | Browser print dialog | Browser print dialog | PDF download (print from phone not practical) |

### Technology

| Component | Choice |
|-----------|--------|
| Frontend | Vue 3 + TypeScript |
| Styling | Tailwind CSS (responsive utilities) |
| Delivery | URL access; no app store. Bookmarkable. Add-to-home-screen supported (PWA manifest) |
| Browser support | Chrome, Firefox, Safari, Edge (latest 2 versions) |
| Desktop app | Electron wrapper available for download (optional); same codebase, runs locally with menu bar icon |

---

## 10. Multi-Language Coverage

### Phase 1 Languages

| Language | UI | Click-to-Talk AI | Help Content | Reports |
|----------|-----|-----------------|--------------|---------|
| English | Full | Full | Full | Full |
| French | Full | Full | Full | Full |

### Implementation

| Detail | Value |
|--------|-------|
| Language selector | Dropdown in top navigation bar; persists per user preference |
| UI translation | All labels, buttons, menus, error messages, confirmation dialogs translated |
| Data content | User-entered data (notes, names, etc.) is NOT translated -- stored as entered |
| AI responses | Click-to-talk responds in the language spoken to it; UI language determines default |
| Canadian legal | French/English bilingual requirement met per PIPEDA and Official Languages Act |
| Date/number format | Locale-aware: EN-CA uses YYYY-MM-DD, FR-CA uses YYYY-MM-DD; currency symbol $; decimal and thousands separators per locale |

### Deferred Languages

| Language | Phase |
|----------|-------|
| Spanish | Phase 2 |
| Romanian | Phase 3+ |
| Italian | Phase 3+ |
| Hindi | Phase 3+ |

---

## 11. Authentication and Security

| Requirement | Implementation |
|-------------|---------------|
| Login | Email + password |
| Password storage | bcrypt (cost factor 12) |
| Session management | JWT with 8-hour expiry; refresh tokens with 7-day expiry |
| HTTPS | TLS 1.3 mandatory; no HTTP fallback; HSTS headers |
| Data at rest | AES-256 encryption on all PII fields (name, email, phone, address) |
| API authentication | Bearer token per tenant; tokens rotatable |
| Audit logging | Every login, failed login, data change, admin action logged with timestamp, user, IP, before/after |
| PIPEDA compliance | All data hosted on Canadian infrastructure; no data transfer outside Canada; privacy impact assessment documented |
| Two-factor auth | Not in Phase 1 (deferred to Phase 2) |

---

## 12. Infrastructure

| Component | Technology |
|-----------|-----------|
| Backend | NestJS / TypeScript / Fastify adapter |
| Frontend | Vue 3 / TypeScript / Tailwind CSS |
| Database | PostgreSQL 16 (per-tenant schema isolation) |
| Vector search | Not in Phase 1 (deferred to Phase 2 with sovereign LLM) |
| Hosting | AWS ca-central-1 (Montreal, Canada) on Kubernetes |
| File storage | S3-compatible (Canadian region) with per-tenant prefix |
| AI (click-to-talk) | Cloud LLM API (Claude or equivalent) for NLU/intent parsing; no on-premise LLM in Phase 1 |
| CI/CD | GitHub Actions -> staging -> production |
| Monitoring | Health checks, error logging (structured JSON), uptime alerts, response time tracking |
| CDN | CloudFront (Canadian edge) for static assets |
| Email/SMS | SendGrid (email), Twilio (SMS) -- Canadian phone numbers |

---

## 13. What Is Sellable vs Internal Testing

| Feature | Sellable to Independent Shops | Internal Testing Only |
|---------|------------------------------|----------------------|
| CIECA imports (CCC, Mitchell, Audatex) | Yes -- shops cannot operate without importing estimates | -- |
| Accounting exports (all 5 systems) | Yes -- shops cannot close books without accounting export | -- |
| RO workflow (full lifecycle) | Yes -- this IS the daily operating system | -- |
| Click-to-talk AI | Yes -- THIS IS THE SALES DIFFERENTIATOR. Without it, "we just have a basic product" (Sharon, Apr 6) | -- |
| RBAC (Single Store + MSO) | Yes -- role security required for any customer deployment | -- |
| Multi-tenant isolation | Yes -- contractual and legal requirement | -- |
| Bilingual UI (EN/FR) | Yes -- legally required in Canada | -- |
| Production display boards | Yes -- shops with TVs expect this; existing BC feature | -- |
| Basic reporting | Yes -- shops need cycle time and productivity data | -- |
| Mobile-responsive web | Yes -- techs and managers use phones in the shop | -- |
| Desktop app (Electron) | Yes -- download option for shops with slow internet | -- |
| Offline capability | -- | Deferred to Phase 2 |
| Scheduling | -- | Deferred to Phase 2 |
| Full inventory/parts management | -- | Deferred to Phase 2 |
| Job costing (full) | -- | Deferred to Phase 2 |
| Customer-facing portal | -- | Deferred to Phase 3 |

**Phase 1 IS a sellable product.** An independent shop can run their daily operations: import estimates, move vehicles through production, assign techs, track parts, export to accounting, view production boards on TVs, talk to BC for quick actions, and do it all in English or French.

---

## 14. What AI Can Do at This Phase

These are the exact commands a user can speak to BC in Phase 1:

| What You Say | What BC Does |
|-------------|-------------|
| "BC, find Smith" | Searches all ROs for customer name "Smith"; shows results list |
| "BC, pull up RO 4521" | Opens RO detail screen for RO 4521 |
| "BC, show me the blue Honda" | Searches ROs by vehicle color + make; shows matches |
| "BC, add a note to the Smith file: customer wants Monday pickup" | Adds timestamped note to Smith's RO (confirms first) |
| "BC, move the Johnson repair to paint" | Updates RO stage to Paint (confirms first) |
| "BC, update RO 4521 to quality check" | Updates RO stage (confirms first) |
| "BC, what's the status on the Johnson repair?" | Speaks and displays: current stage, days open, assigned tech, next step |
| "BC, send an email to the customer on RO 4521 saying their car is ready for pickup" | Drafts email, shows preview, sends on confirmation |
| "BC, text Mrs. Johnson that her vehicle is in paint" | Drafts SMS, shows preview, sends on confirmation |
| "BC, how many open ROs do we have?" | Returns count of active ROs |
| "BC, what's our average cycle time this month?" | Queries and returns average cycle time |
| "BC, go to reporting" | Navigates to reports dashboard |
| "BC, help with importing estimates" | Shows step-by-step import instructions |

**What BC CANNOT do in Phase 1:**
- Order parts from suppliers
- Receive payments
- Create estimates (only import them)
- Modify business rules or settings
- Answer questions about other tenants' data
- Operate hands-free without clicking the microphone button

---

## 15. Integrations Included

### Phase 1 Integrations

| Integration | Type | Direction | Detail |
|-------------|------|-----------|--------|
| CCC ONE | CIECA XML import | Inbound | Import estimates FROM CCC |
| Mitchell | CIECA XML import | Inbound | Import estimates FROM Mitchell |
| Audatex | CIECA XML import | Inbound | Import estimates FROM Audatex |
| QuickBooks Online | REST API | Outbound | Export invoices TO QBO |
| QuickBooks Desktop | IIF file | Outbound | Generate IIF files for import into QB Desktop |
| Sage 50 | CSV file | Outbound | Generate CSV files for import into Sage 50 |
| Sage Cloud | REST API | Outbound | Export invoices TO Sage Cloud |
| Xero | REST API | Outbound | Export invoices TO Xero |
| SendGrid | REST API | Outbound | Transactional email (customer notifications, password reset) |
| Twilio | REST API | Outbound | SMS notifications to customers |
| Cloud LLM (Claude) | REST API | Outbound | Click-to-talk NLU processing (tenant-isolated) |

### Deferred Integrations

| Integration | Phase |
|-------------|-------|
| Google Drive / Dropbox / OneDrive (media storage) | Phase 2 |
| Paint scale vendors | Phase 2 |
| Parts supplier ordering | Phase 2 |
| AutoHouse data push | Phase 2 |
| ClaimsCorp data push | Phase 2 |
| CSI platform data pushes | Phase 3 |
| Insurance carrier integrations | Phase 3 |
| Zoho Desk (support ticketing) | Phase 2 |
| Serbia DMS | Phase 3 |

---

## 16. Support Model

### SLA

| Priority | Definition | Identification Time | Resolution Time |
|----------|-----------|-------------------|-----------------|
| **Critical** | System down; users cannot log in or core workflow broken | 2 hours | 12 hours |
| **High** | Feature broken but workaround exists; data not exporting correctly | 12 hours | 24 hours |
| **Medium** | Feature working but not as expected; cosmetic issues; non-blocking | 24 hours | 72 hours |
| **Low** | Enhancement request; minor UI feedback | 48 hours | Next scheduled release |

### Issue Reporting Flow

| Step | Detail |
|------|--------|
| 1 | Shop reports issue to Micazen tech support (phone, email, or Zoho Desk ticket) |
| 2 | Micazen tech support triages: is it a BC usage issue or a BCAI system issue? |
| 3 | If BCAI system issue: Micazen support creates ticket in Zoho Desk with tag "BCAI" |
| 4 | Automation routes tagged Zoho Desk ticket to D. Caine Solutions (Kevin's team) |
| 5 | Kevin's team acknowledges within SLA identification time |
| 6 | Resolution provided within SLA resolution time |
| 7 | Playbook entry created for every resolved issue (searchable by Micazen tech support) |

### Support Team Structure

| Role | Who |
|------|-----|
| Micazen Tech Support | Existing Micazen support team (stays in Zoho Desk, learns nothing new) |
| BCAI Engineering | D. Caine Solutions -- Kevin Starr + contracted dev team (6 humans + 5 AI agents) |
| Escalation Path | Micazen support -> Zoho Desk (auto-routed) -> D. Caine Solutions |

### Playbook System

| Detail | Value |
|--------|-------|
| Format | Searchable knowledge base accessible from within BCAI admin panel |
| Content per entry | Issue title, symptoms, diagnosis steps, resolution steps, preventive measures |
| Growth | New playbook entry created for every unique resolved issue |
| Access | Micazen tech support + Sharon/Jim + D. Caine Solutions |

### In-App Issue Reporting

| Detail | Value |
|--------|-------|
| Location | "Report Issue" button on every screen (bottom toolbar) |
| Behavior | Captures: current screen, user, tenant, browser info, optional screenshot, free-text description |
| Destination | Creates Zoho Desk ticket via API with all captured context |

---

## 17. Ongoing Development Model

### After Phase 1 Completion

| Model | Detail |
|-------|--------|
| **Phase-based pricing** | Each major phase (2, 3, 4, 5) has a defined scope and price, paid on milestones |
| **Continuous development** | Between phases, ongoing feature additions, integrations, and bug fixes |
| **Monthly releases** | Minimum one release per month with new features and fixes (matching current BC cadence) |
| **Feature pricing** | New features outside defined phase scope are scoped and quoted individually; small features ($2K--$5K CAD); medium features ($5K--$15K CAD); large features/integrations ($15K--$30K CAD) |
| **Retainer option** | Optional monthly retainer ($5,000--$10,000 CAD/month) for ongoing development hours, priority support, and continuous feature delivery |
| **Scope change process** | Sharon/Jim submit feature request -> Kevin scopes and quotes -> approval -> build -> deploy in next release |

---

## 18. What Is NOT in This Phase

Every item below is explicitly excluded from Phase 1 and assigned to a specific future phase.

| Feature | Deferred To | Reason |
|---------|------------|--------|
| Sovereign LLM (self-hosted Nemotron) | Phase 2 | Requires significant infrastructure; cloud LLM adequate for Phase 1 AI commands |
| Full AI-assisted workflow suggestions ("should I send to paint next?") | Phase 2 | Requires training on shop patterns |
| Wake word ("Hey BC") hands-free | Phase 4 | Hardware + Picovoice integration |
| Voice in every bay (Brad) | Phase 4 | Per-bay hardware + agents |
| Offline capability + sync | Phase 2 | Requires local data cache + sync engine |
| Full scheduling system | Phase 2 | Complex business rules; not minimum for first customers |
| Full inventory management | Phase 2 | Parts tracking included; full vendor ordering/receiving is Phase 2 |
| Full job costing | Phase 2 | Basic estimate/total tracking included; detailed cost allocation is Phase 2 |
| Customer-facing portal | Phase 3 | Not needed for independent shop launch |
| Native mobile app (App Store / Play Store) | Phase 3 | PWA + responsive web sufficient for Phase 1 |
| Network-level admin (Regional + Network tiers) | Phase 3 | Phase 1 serves Single Store + MSO only |
| SOP enforcement engine | Phase 3 | Requires network admin + standardized SOPs |
| Advanced analytics / benchmarking | Phase 3 | Basic reporting covers Phase 1 needs |
| Custom roles (editable permission matrix) | Phase 2 | Fixed roles sufficient for Phase 1 |
| Scheduled/emailed reports | Phase 2 | On-demand reports sufficient for Phase 1 |
| Google Drive / Dropbox / OneDrive integration | Phase 2 | Photo upload to S3 sufficient for Phase 1 |
| Paint scale vendor integrations | Phase 2 | Not blocking for independent shop launch |
| Parts supplier ordering integrations | Phase 2 | Manual parts management sufficient for Phase 1 |
| Spanish language | Phase 2 | EN/FR meets Canadian legal requirement |
| Two-factor authentication | Phase 2 | Email+password sufficient for launch |
| Zoho Desk native integration | Phase 2 | Manual routing via automation sufficient for Phase 1 |
| Self-healing / recommendation engine | Phase 2 | Recommendation only (no autonomous changes) |
| Guided walkthroughs / interactive help | Phase 2 | Help articles + AI help command sufficient for Phase 1 |
| Data migration from existing BC | Phase 5 | New system launches with new customers first |

---

## 19. Acceptance Criteria

Phase 1 is complete when ALL of the following are verified:

| # | Criterion |
|---|----------|
| 1 | A CIECA XML file from CCC ONE can be imported and creates a correct, complete RO with all data fields populated |
| 2 | A CIECA XML file from Mitchell can be imported and creates a correct, complete RO |
| 3 | A CIECA XML file from Audatex can be imported and creates a correct, complete RO |
| 4 | A completed RO can be exported to QuickBooks Online and creates a correct invoice with line items and tax |
| 5 | A completed RO can be exported to QuickBooks Desktop via IIF file, importable into QB Desktop |
| 6 | A completed RO can be exported to Sage 50 via CSV file, importable into Sage 50 |
| 7 | A completed RO can be exported to Sage Cloud via API and creates a correct invoice |
| 8 | A completed RO can be exported to Xero via API and creates a correct invoice |
| 9 | An RO can be created, moved through all 12 stages (Estimate through Delivered), and marked complete |
| 10 | An RO can be voided with mandatory reason by a Manager or Admin |
| 11 | The production board shows all active ROs with correct stage, age, assignments, and color coding |
| 12 | A user can click the microphone button and say "BC, find Smith" and the system navigates to the correct RO |
| 13 | A user can say "BC, add a note to RO 4521: test note" and the note appears on the RO after confirmation |
| 14 | A user can say "BC, move Smith to paint" and the RO status updates after confirmation |
| 15 | A user can say "BC, send an email to the customer on RO 4521" and a draft email is shown for approval |
| 16 | A technician can log in and see ONLY their assigned ROs; they cannot see other technicians' assignments |
| 17 | A receptionist cannot see labor costs or financial details |
| 18 | An MSO admin can switch between two shops and see only that shop's data in each view |
| 19 | Two shops on the same system cannot see each other's data under any circumstances |
| 20 | The entire UI displays correctly in French when French is selected |
| 21 | Click-to-talk AI responds correctly when spoken to in French |
| 22 | The system works on Chrome on Android phone (responsive layout, all functions accessible) |
| 23 | The system works on Safari on iPhone (responsive layout, all functions accessible) |
| 24 | A production display board URL loads on a TV browser and auto-refreshes without login |
| 25 | All data is hosted in AWS ca-central-1 (Canada); no data leaves Canadian infrastructure |
| 26 | The cycle time report shows correct average days from creation to delivery for a date range |
| 27 | A completed RO export to accounting includes correct tax calculation per configured rates |
| 28 | The "Report Issue" button creates a ticket in Zoho Desk with screen context and user info |
| 29 | Sharon and Jim can log into the Micazen admin panel and provision a new tenant shop in under 5 minutes |
| 30 | The desktop app (Electron) launches, displays the full application, and click-to-talk AI functions correctly |

---

**End of Phase 1 Specification**

*This document is a technical specification for red-line review. No sales language. No value propositions. No revenue projections. Features, screens, fields, behaviors.*
