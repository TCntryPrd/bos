# BCAI Phase 5 -- Migration + Scale + API Ecosystem + Predictive AI

## BodyShopConnect AI | Micazen Consulting & Technologies

| Field | Value |
|-------|-------|
| **Document Version** | 2.0 |
| **Date** | April 7, 2026 |
| **Timeline** | Ongoing after Phase 4; no fixed end date |
| **Investment** | Variable -- scoped per initiative; estimated $50,000--$100,000+ CAD for migration tooling; ongoing development billed per feature or retainer |
| **Billing** | Per-initiative milestone billing OR monthly retainer ($5,000--$15,000 CAD/month) for continuous development |
| **Prerequisite** | Phase 4 accepted; BCAI proven in production with independent shops + network pilot (AutoCanada) |
| **Deliverable Summary** | Migration tooling for existing BodyShopConnect customers, customer migration execution, network-wide rollout support, white-label platform, public API ecosystem, predictive AI (demand forecasting, parts prediction, revenue modeling), legacy system decommissioning, continuous feature development. |

---

## Table of Contents

1. [Migration Tooling](#1-migration-tooling)
2. [Customer Migration Execution](#2-customer-migration-execution)
3. [Network Rollout Program](#3-network-rollout-program)
4. [White-Label Platform](#4-white-label-platform)
5. [Public API Ecosystem](#5-public-api-ecosystem)
6. [Predictive AI](#6-predictive-ai)
7. [Legacy System Decommissioning](#7-legacy-system-decommissioning)
8. [Continuous Development Model](#8-continuous-development-model)
9. [What Is Sellable vs Internal Testing](#9-what-is-sellable-vs-internal-testing)
10. [What AI Can Do at This Phase](#10-what-ai-can-do-at-this-phase)
11. [Integrations Included](#11-integrations-included)
12. [Multi-Language Coverage](#12-multi-language-coverage)
13. [Support Model](#13-support-model)
14. [What Is NOT in This Phase](#14-what-is-not-in-this-phase)
15. [Acceptance Criteria](#15-acceptance-criteria)

---

## 1. Migration Tooling

### Purpose

Build the tools that move existing BodyShopConnect customers (PHP/Yii2/MySQL/Vue 2 system) to the new BCAI platform. This is the "delete database, delete database" path Sharon described -- but done safely, with rollback capability.

### Migration Architecture

| Component | Detail |
|-----------|--------|
| Source system | Existing BodyShopConnect: PHP/Yii2, MySQL (one database per tenant), Elasticsearch 6.8, Vue 2 |
| Target system | BCAI: NestJS, PostgreSQL (per-tenant schema), sovereign LLM, Vue 3 |
| Migration engine | Custom ETL pipeline: extract from MySQL, transform to BCAI schema, load into PostgreSQL |
| Migration tool | CLI + web admin interface for running and monitoring migrations |

### Data Migration Scope

| Data Category | Fields / Content | Complexity |
|--------------|-----------------|-----------|
| **Repair Orders** | All RO data: vehicle, customer, insurance, estimates, parts, labor, notes, history, status, financials | High -- 200+ business rules must be preserved |
| **Customer records** | Names, contact info, vehicle history, communication preferences | Medium |
| **Vendor records** | Vendor names, contacts, account numbers, PO history | Medium |
| **User accounts** | Users, roles, permissions, login history | Medium -- role mapping from old to new system |
| **Media/attachments** | Photos, PDFs, scanned documents linked to ROs | High -- large data volume; cloud storage migration |
| **Accounting history** | Export history, invoice records, payment records | Medium |
| **Templates** | Email templates, notification templates, report templates | Low |
| **Settings** | Shop configuration, tax rates, accounting mappings, CIECA settings, automation rules | Medium -- must map old config structures to new |
| **Integration configs** | API keys, OAuth tokens, endpoint configurations for 35+ integrations | High -- credentials must be re-established in new system |
| **Historical reports** | Archived report data, analytics snapshots | Low -- may be migrated as static records |

### Migration Tool Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Migration Dashboard** | Micazen Admin | List of all tenants with migration status: not started, in progress, validating, complete, failed |
| **Migration Plan** | Micazen Admin | Per-tenant migration plan: data categories, estimated records, estimated time, dependencies |
| **Pre-Migration Validation** | Micazen Admin | Run validation on source data before migration: identify orphaned records, data integrity issues, missing fields |
| **Migration Execution** | Micazen Admin | Start migration; real-time progress bar per data category; error log |
| **Post-Migration Validation** | Micazen Admin | Compare record counts, spot-check data integrity, run automated validation suite |
| **Rollback** | Micazen Admin | Revert migration for a tenant; restore original system access |

### Migration Behaviors

| Behavior | Detail |
|----------|--------|
| Non-destructive | Source system is NOT modified during migration; data is copied, not moved |
| Parallel operation | During migration period, both old and new systems can run simultaneously; data changes on old system can be incrementally synced |
| Incremental sync | After initial migration, changes on old system are incrementally pushed to new system until cutover |
| Cutover | Explicit cutover event: old system goes read-only, final incremental sync runs, new system becomes primary |
| Rollback window | 30 days post-cutover: if issues arise, rollback to old system is possible |
| Data validation | Automated validation suite checks: record counts match, financial totals match, RO statuses match, no orphaned records |
| Per-tenant execution | Each tenant migrated independently; schedule per shop to minimize disruption |

### Migration Timeline per Tenant

| Step | Duration | Detail |
|------|----------|--------|
| Pre-migration validation | 1-2 days | Scan source data; identify issues; generate migration plan |
| Data migration (initial) | 4-24 hours | Bulk data transfer (depends on data volume) |
| Post-migration validation | 1-2 days | Automated + manual data integrity checks |
| Parallel operation | 1-4 weeks | Both systems live; staff trained on new system |
| Cutover | 1 day | Old system read-only; final sync; DNS/access switch |
| Monitoring | 2-4 weeks | Intensive monitoring post-cutover; fast response to issues |

---

## 2. Customer Migration Execution

### Purpose

Execute the actual migration of existing BodyShopConnect customers from old system to BCAI. Phased approach -- not all at once.

### Migration Phases

| Phase | Customers | Approach |
|-------|-----------|---------|
| **Wave 1: Volunteers** | 3-5 early-adopter shops who have previously helped test (Sharon's "ledge-steppers") | Hands-on migration with intensive support; feedback drives tool refinement |
| **Wave 2: Independents** | Remaining independent shop customers (5-10 per month) | Standardized migration process; self-service with support available |
| **Wave 3: Small MSOs** | 2-5 location MSO customers | MSO-level migration: all shops in an MSO migrate together |
| **Wave 4: Networks** | CSN Collision, AutoCanada (remaining locations), Simplicity, Car Stars | Network-level migration: coordinated with network admin; regional rollout |

### Customer Communication Plan

| Timing | Communication | Channel |
|--------|--------------|---------|
| 60 days before wave | "We're upgrading to BCAI. Here's what's changing and what's improving." | Email + in-app banner |
| 30 days before migration | "Your migration is scheduled for [date]. Here's how to prepare." | Email + phone call (for MSO+) |
| 7 days before | "Your migration starts next week. Here's what to expect." | Email |
| Day of | "Migration in progress. Your system is in read-only mode during cutover." | Email + in-app |
| Day after | "Welcome to BCAI. Here's your new login. Here's your guided walkthrough." | Email + in-app |
| 7 days after | "How's it going? Any issues?" | Email (automated) + phone call (for MSO+) |
| 30 days after | "Old system access will be removed on [date]." | Email |

### Migration Support Staffing

| Role | Responsibility |
|------|---------------|
| Migration coordinator (Micazen) | Schedule migrations; communicate with customers; manage wave progression |
| Technical migration (D. Caine Solutions) | Execute migration tooling; troubleshoot data issues; handle rollbacks |
| Training (Micazen support) | Deliver training on new system; leverage guided walkthroughs |
| Escalation (Sharon/Jim) | Handle customer concerns, business decisions, exceptions |

---

## 3. Network Rollout Program

### Purpose

Expand BCAI deployment from AutoCanada pilot to full AutoCanada fleet and other networks (CSN Collision, Simplicity, Car Stars).

### Rollout Approach per Network

| Step | Detail |
|------|--------|
| 1. Contract | Network-level agreement: per-shop pricing, SLA, compliance requirements |
| 2. SOP onboarding | Import or create network SOPs in BCAI SOP engine |
| 3. Admin provisioning | Set up Network Admin, Regional Admin accounts; configure network hierarchy |
| 4. Pilot expansion | Expand from pilot locations to additional regions (10-20 shops per wave) |
| 5. Training | Train corporate trainers; trainers then train shop staff (train-the-trainer model) |
| 6. Full rollout | All network locations on BCAI |
| 7. Legacy decommission | Old system access removed for migrated network shops |

### Network-Specific Configurations

| Network | Estimated Locations | Special Requirements |
|---------|--------------------|--------------------|
| AutoCanada | ~80 | Publicly traded; strict data sovereignty; corporate SOPs; corporate trainers |
| CSN Collision | ~500 | Franchise model; independently owned; inconsistent SOPs; need baseline SOP templates |
| Simplicity | Variable | Corporate-owned; no formal SOPs ("the boys don't have anything"); need SOP creation assistance |
| Car Stars | Variable | Had "Car Stars Operating System" SOPs; may be importable |

---

## 4. White-Label Platform

### Purpose

Allow Micazen to offer BCAI under other brands or allow network partners to apply their own branding. The technology is the same; the presentation is customizable.

### White-Label Capabilities

| Element | Customizable |
|---------|-------------|
| Logo | Per-network or per-shop |
| Color scheme | Primary, secondary, accent colors |
| App name | Display name in browser tab, mobile app, splash screen |
| Login page | Custom background, logo, welcome text |
| Email templates | Branded header/footer, custom from-address |
| Customer portal | Custom URL, branding, colors |
| Display boards | Custom shop/network branding |
| Mobile app icon | Per-network custom app icon (requires separate App Store listing per network) |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Brand Configuration** | Network Admin, Micazen Admin | Configure branding elements per network or per shop |
| **Brand Preview** | Network Admin | Preview branded screens before publishing |

### Technical

| Detail | Value |
|--------|-------|
| CSS theming | CSS custom properties (variables) per tenant; no code changes needed for branding |
| Asset storage | Per-tenant logo and brand assets stored in tenant S3 prefix |
| Email branding | SendGrid dynamic templates with per-tenant merge fields |
| App Store | Separate App Store listing per major network (if requested); significant lead time (4-8 weeks per listing) |

---

## 5. Public API Ecosystem

### Purpose

Expose BCAI capabilities via a documented REST API so third-party developers, integration partners, and Micazen's own dev team can build on top of BCAI.

### API Scope

| API Category | Endpoints | Use Cases |
|-------------|-----------|-----------|
| **RO Management** | CRUD on repair orders, status updates, notes, attachments | Third-party dashboards, custom reporting, mobile apps |
| **Parts** | PO management, receiving, returns, inventory queries | Parts supplier integrations, custom ordering systems |
| **Scheduling** | Bay and technician scheduling, availability queries | Third-party scheduling tools, customer booking portals |
| **Customer** | Customer records, communication history, portal links | CRM integrations, marketing automation |
| **Reporting** | Report queries, KPI endpoints, data export | Business intelligence tools, custom dashboards |
| **AI** | Submit commands to BC; receive responses | Custom AI interfaces, chatbots, voice integrations |
| **Webhooks** | Event subscriptions: RO status change, part received, customer message, etc. | Real-time integrations, automation triggers |
| **Admin** | Tenant provisioning, user management, settings | Management automation, bulk operations |

### API Infrastructure

| Component | Detail |
|-----------|--------|
| Authentication | OAuth 2.0 with API keys per tenant; rate limiting per key |
| Documentation | OpenAPI 3.0 specification; interactive documentation (Swagger UI or Redoc) |
| Versioning | URL-based versioning (`/api/v1/`, `/api/v2/`); deprecation policy: 12-month notice |
| Rate limits | Configurable per tenant; default: 1000 requests/minute |
| Webhooks | Configurable per tenant; retry policy: 3 attempts with exponential backoff |
| Sandbox | Sandbox environment for third-party developers to test against without affecting production data |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **API Key Management** | Admin | Generate, rotate, revoke API keys; view usage statistics |
| **Webhook Configuration** | Admin | Subscribe to events; configure endpoint URLs; view delivery logs |
| **API Documentation** | Public (with auth) | Interactive API documentation |
| **Developer Portal** | Public | Registration, API key request, documentation, sandbox access |

---

## 6. Predictive AI

### Purpose

Use historical data accumulated through Phases 1-4 to predict future events and optimize shop operations. All predictions are recommendations -- not autonomous actions.

### Prediction Models

| Model | Input | Output | Use Case |
|-------|-------|--------|----------|
| **Cycle Time Predictor** | Vehicle type, damage severity, parts list, tech assignment, historical shop data | Predicted completion date with confidence interval | Set realistic customer expectations; improve scheduling accuracy |
| **Parts Demand Forecasting** | Historical parts usage by vehicle type, season, shop volume | Predicted parts needs for next 30/60/90 days | Pre-order common parts; reduce backorder delays |
| **Revenue Forecasting** | Historical revenue, seasonal patterns, pipeline (open ROs), new shop growth | Projected monthly/quarterly revenue | Business planning; staffing decisions |
| **Supplement Predictor** | Estimate line items, vehicle type, damage description, historical supplement rates | Probability of supplement for this RO | Flag high-supplement-probability ROs early; improve accuracy |
| **Technician Matching** | Tech specialization, efficiency by repair type, current workload, certification | Optimal tech assignment for each RO | Improve cycle time and repair quality |
| **Customer Churn Risk** | Communication history, satisfaction scores, cycle time deviation, billing disputes | Risk score per customer | Proactive customer retention outreach |

### Behavior Rules

| Rule | Detail |
|------|--------|
| Recommendations only | All predictions are displayed as suggestions with confidence levels; no autonomous action |
| Accuracy tracking | System tracks prediction accuracy over time; displays confidence metrics |
| Minimum data | Predictions require minimum 3 months of shop data; new shops see "Not enough data for predictions yet" |
| Privacy | Predictions use only the individual tenant's historical data; no cross-tenant training |
| Configurable | Admin can enable/disable specific prediction models per shop |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Predictions Dashboard** | Admin, Manager | All active predictions with confidence scores; trend charts |
| **Prediction Detail** | Admin, Manager | Per-prediction drill-down: input factors, confidence, accuracy history |
| **Prediction Settings** | Admin | Enable/disable models; configure minimum confidence threshold for display |
| **Accuracy Report** | Admin, Micazen Admin | Prediction accuracy over time; model performance metrics |

---

## 7. Legacy System Decommissioning

### Purpose

Safely shut down the existing BodyShopConnect system (PHP/Yii2/MySQL/Vue 2) once all customers have been migrated to BCAI.

### Decommissioning Steps

| Step | Detail |
|------|--------|
| 1. Verify all tenants migrated | Confirm every tenant has been successfully migrated and is operating on BCAI |
| 2. Verify no rollbacks pending | Confirm all tenants are past their 30-day rollback window |
| 3. Data archive | Archive all legacy MySQL databases to cold storage (S3 Glacier or equivalent); retain for 7 years per PIPEDA |
| 4. Access shutdown | Disable all user access to legacy system; redirect legacy URLs to BCAI |
| 5. Infrastructure teardown | Decommission legacy servers, Elasticsearch cluster, Vue 2 frontend |
| 6. DNS migration | Point all legacy domains to BCAI infrastructure |
| 7. Documentation | Document what was decommissioned, when, and where archived data resides |

### Timeline

| Milestone | Estimated |
|-----------|-----------|
| Last tenant migrated | 12-18 months after migration tooling deployed |
| Rollback windows closed | 30 days after last migration |
| Archive complete | 2 weeks after all rollback windows |
| Infrastructure shutdown | 4 weeks after archive verified |

---

## 8. Continuous Development Model

### Purpose

BCAI is never "done." After Phase 5 deliverables, ongoing development continues indefinitely. This section defines how continuous feature development, integrations, and improvements are scoped, priced, and delivered.

### Development Models (Customer Chooses)

| Model | Detail | Best For |
|-------|--------|----------|
| **Per-Feature** | Scope and quote each feature request individually; milestone billing | Infrequent, large features |
| **Monthly Retainer** | Fixed monthly budget ($5,000--$15,000 CAD/month); features prioritized from backlog; unused hours do not roll over | Continuous feature pipeline |
| **Sprint-Based** | 2-week sprints; scope agreed at sprint planning; deliverable reviewed at sprint end; billed per sprint | Rapid iteration phases |

### Feature Request Workflow

| Step | Detail |
|------|--------|
| 1. Submit | Sharon/Jim submit feature request via Zoho Desk or direct email |
| 2. Triage | D. Caine Solutions triages: size estimate (S/M/L/XL), complexity, dependencies |
| 3. Scope | Written scope document with screens, fields, behaviors; sent for review |
| 4. Approve | Sharon/Jim approve scope and price |
| 5. Build | D. Caine Solutions builds; updates progress via agreed channel |
| 6. Review | Sharon/Jim review in staging environment |
| 7. Deploy | Deployed to production in next release |

### Release Cadence

| Cadence | Detail |
|---------|--------|
| Minimum | One production release per month (matching current BC cadence) |
| Hotfixes | Critical bug fixes deployed within SLA resolution time (same day if needed) |
| Major releases | Feature releases deployed on a scheduled cadence (biweekly or monthly as agreed) |
| Release notes | Published with every release: what changed, what's new, what's fixed |

---

## 9. What Is Sellable vs Internal Testing

| Feature | Sellable | Internal Testing Only |
|---------|----------|----------------------|
| Everything from Phase 1 + 2 + 3 + 4 | Yes | -- |
| Migration from old BC to new BCAI | Yes -- existing customers upgrade | -- |
| White-label platform | Yes -- networks can run BCAI under their brand | -- |
| Public API ecosystem | Yes -- third-party integrations and custom builds | -- |
| Predictive AI | Yes -- shops value data-driven predictions for scheduling, parts, revenue | -- |
| Continuous development | Yes -- ongoing feature pipeline ensures system keeps improving | -- |

**Phase 5 is the "mature platform" release.** BCAI serves all market segments: independents, MSOs, and enterprise networks. Legacy BC is retired. The platform has a public API ecosystem, predictive AI, and continuous development cadence.

---

## 10. What AI Can Do at This Phase

Everything from Phase 1 + 2 + 3 + 4, PLUS:

| What You Say | What BC Does |
|-------------|-------------|
| "Hey BC, when will the Johnson repair be done?" | Returns predicted completion date with confidence: "Based on current progress and parts status, estimated completion is Thursday +/- 1 day (85% confidence)" |
| "Hey BC, what parts should we stock for next month?" | Returns parts demand forecast based on historical data and current pipeline |
| "Hey BC, what's our revenue forecast for Q3?" | Returns projected revenue with confidence interval based on pipeline and historical trends |
| "Hey BC, is this estimate likely to need a supplement?" | Returns supplement probability: "This RO has a 73% probability of supplement based on damage pattern and vehicle type" |
| "Hey BC, who's the best tech for this frame repair?" | Returns optimal tech assignment based on specialization, efficiency, and workload |
| "Hey BC, which customers are at risk of churning?" | Returns risk-scored customer list with factors |
| "Hey BC, show me the API usage for this month" | Returns API call volume, top endpoints, error rates |
| "Hey BC, how accurate have the cycle time predictions been?" | Returns prediction accuracy metrics over time |

---

## 11. Integrations Included

### New in Phase 5

| Integration | Type | Direction | Detail |
|-------------|------|-----------|--------|
| Public REST API | HTTP/JSON | Bidirectional | Full API for third-party developers |
| Webhooks | HTTP callbacks | Outbound | Event-driven notifications to external systems |
| Migration ETL (MySQL -> PostgreSQL) | Custom pipeline | Inbound | Migrate data from legacy BC databases |
| S3 Glacier (archive) | AWS API | Outbound | Archive legacy data to cold storage |
| Developer Portal | Web application | Public | API documentation, sandbox, key management |

### Total Integration Count: 35+

All integrations from Phase 1-4 maintained, plus Phase 5 API ecosystem and migration tooling. This meets Sharon's stated "35+ third-party integrations" baseline.

---

## 12. Multi-Language Coverage

| Language | UI | AI | Help | Reports | Notifications | Customer Portal | Voice |
|----------|----|----|------|---------|--------------|----------------|-------|
| English | Full | Full | Full | Full | Full | Full | Full |
| French | Full | Full | Full | Full | Full | Full | Full |
| Spanish | Full | Full | Full | Full | Full | Full | Full |
| Romanian | Full (NEW) | Full (NEW) | Partial | Full | Full | Full | Full |
| Italian | Full (NEW) | Full (NEW) | Partial | Full | Full | Full | Full |
| Hindi | Full (NEW) | Full (NEW) | Partial | Full | Full | Full | Full |

Note: Romanian, Italian, and Hindi are added to the sovereign LLM training data and UI translation files in Phase 5. Help content for these languages starts with the most common workflows and expands over time.

---

## 13. Support Model

### SLA (unchanged core)

| Priority | Identification | Resolution |
|----------|---------------|------------|
| Critical | 2 hours | 12 hours |
| High | 12 hours | 24 hours |
| Medium | 24 hours | 72 hours |
| Low | 48 hours | Next release |

### Phase 5 Enhancements

| Enhancement | Detail |
|-------------|--------|
| Migration-specific support | Dedicated migration support channel during active migration waves; SLA: migration issues treated as High priority |
| API support | Developer support channel for API consumers; response within 24 hours for API-related issues |
| Network rollout support | Dedicated contact during network rollout waves; weekly status calls with network admin |
| Predictive AI monitoring | Model accuracy monitoring; alerts if prediction accuracy drops below threshold |
| Knowledge base expansion | All migration playbooks, API guides, and predictive AI documentation added to searchable knowledge base |

---

## 14. What Is NOT in This Phase

Phase 5 is ongoing. There is no "Phase 6." Instead, new capabilities are continuously scoped, prioritized, and delivered through the continuous development model defined in Section 8.

Items that may be prioritized during Phase 5 continuous development:

| Potential Future Feature | Description |
|------------------------|-------------|
| Augmented reality (AR) repair guides | AR overlay showing repair procedures on vehicle through phone/tablet camera |
| Computer vision damage assessment | AI analyzes photos to estimate damage severity and suggest repair operations |
| Integration marketplace | Self-service marketplace where shops can enable/disable integrations |
| Advanced Siri/Google Assistant integration | Platform-level voice assistant integration (Sharon's original question) |
| Multi-country compliance | GDPR (Europe), additional privacy frameworks as BC expands internationally |
| Blockchain audit trail | Immutable audit record for insurance and legal compliance |

These are listed for visibility only. None are committed. Each would be scoped and priced through the continuous development workflow.

---

## 15. Acceptance Criteria

| # | Criterion |
|---|----------|
| 1 | Migration tool can extract all data categories from a legacy BC MySQL database and load into BCAI PostgreSQL schema |
| 2 | Pre-migration validation identifies data integrity issues before migration starts |
| 3 | Post-migration validation confirms: record counts match, financial totals match, RO statuses correct, no orphaned records |
| 4 | Parallel operation works: changes on old system incrementally sync to new system |
| 5 | Cutover executes cleanly: old system goes read-only, final sync completes, new system becomes primary |
| 6 | Rollback within 30-day window restores access to old system with no data loss |
| 7 | Wave 1 migration: 3-5 volunteer shops successfully migrated with no critical data issues |
| 8 | White-label configuration: network admin can apply custom logo, colors, and branding; branded UI renders correctly |
| 9 | Public API: all documented endpoints return correct data; authentication and rate limiting work; webhook delivery succeeds |
| 10 | API documentation (OpenAPI 3.0) is complete and interactive; developer can build a simple integration using only the docs |
| 11 | Sandbox environment available for third-party developers to test against |
| 12 | Cycle time prediction provides estimate with confidence interval for an RO with >3 months of shop history |
| 13 | Parts demand forecast returns correct prediction based on historical usage patterns |
| 14 | Supplement predictor correctly identifies high-probability supplement ROs (>70% accuracy after 6 months of data) |
| 15 | All predictions are displayed as recommendations with confidence scores; no autonomous actions from predictions |
| 16 | Legacy system archive: MySQL databases archived to cold storage; archived data retrievable within 24 hours |
| 17 | Legacy URLs redirect to BCAI after decommissioning |
| 18 | Continuous development workflow: feature request submitted via Zoho Desk -> scoped within 48 hours -> delivery per agreed timeline |
| 19 | Romanian, Italian, and Hindi UI translations render correctly for all core screens |
| 20 | Monthly release cadence maintained: at least one production release per month with release notes |

---

## Appendix A: Full Integration Map (All Phases)

| # | Integration | Phase | Type | Direction |
|---|-------------|-------|------|-----------|
| 1 | CCC ONE (CIECA import) | 1 | XML file/API | Inbound |
| 2 | Mitchell (CIECA import) | 1 | XML file/API | Inbound |
| 3 | Audatex (CIECA import) | 1 | XML file/API | Inbound |
| 4 | QuickBooks Online | 1 | REST API | Outbound |
| 5 | QuickBooks Desktop | 1 | IIF file | Outbound |
| 6 | Sage 50 | 1 | CSV file | Outbound |
| 7 | Sage Cloud | 1 | REST API | Outbound |
| 8 | Xero | 1 | REST API | Outbound |
| 9 | SendGrid (email) | 1 | REST API | Outbound |
| 10 | Twilio (SMS) | 1 | REST API | Outbound |
| 11 | Cloud LLM (Phase 1 only) | 1 | REST API | Outbound |
| 12 | Google Drive | 2 | OAuth API | Bidirectional |
| 13 | Dropbox | 2 | OAuth API | Bidirectional |
| 14 | OneDrive | 2 | OAuth API | Bidirectional |
| 15 | Zoho Desk | 2 | REST API | Bidirectional |
| 16 | Paint scale vendors | 2 | Vendor API | Bidirectional |
| 17 | AutoHouse | 2 | API/file | Outbound |
| 18 | ClaimsCorp | 2 | API/file | Outbound |
| 19 | Parts suppliers (pilot) | 2 | Vendor API | Outbound |
| 20 | Sovereign LLM (Nemotron) | 2 | Local inference | Internal |
| 21 | CSI platforms | 3 | API push | Outbound |
| 22 | Insurance carriers | 3 | API/EDI | Bidirectional |
| 23 | Serbia DMS | 3 | API/file | Bidirectional |
| 24 | Full parts supplier network | 3 | Vendor APIs | Bidirectional |
| 25 | Apple App Store | 3 | Distribution | Outbound |
| 26 | Google Play Store | 3 | Distribution | Outbound |
| 27 | Apple Push Notifications | 3 | Push API | Outbound |
| 28 | Firebase Cloud Messaging | 3 | Push API | Outbound |
| 29 | Picovoice Porcupine | 4 | Local SDK | On-device |
| 30 | Whisper (local STT) | 4 | Local inference | On-device |
| 31 | Coqui TTS (local) | 4 | Local inference | On-device |
| 32 | Bay hardware management | 4 | Custom protocol | Bidirectional |
| 33 | USB camera API | 4 | Local | Inbound |
| 34 | Public REST API | 5 | HTTP/JSON | Bidirectional |
| 35 | Webhooks | 5 | HTTP callbacks | Outbound |
| 36 | Migration ETL | 5 | Custom pipeline | Inbound |
| 37 | S3 Glacier (archive) | 5 | AWS API | Outbound |

**Total: 37 integrations across all phases** (exceeds the 35+ requirement stated by Sharon).

---

## Appendix B: Pricing Summary (All Phases, CAD)

| Phase | Timeline | Investment (CAD) | Cumulative (CAD) |
|-------|----------|-----------------|-----------------|
| Phase 1 | 6-8 weeks | $40,000--$65,000 | $40,000--$65,000 |
| Phase 2 | 2-3 months after P1 | $35,000--$65,000 | $75,000--$130,000 |
| Phase 3 | 3-4 months after P2 | $40,000--$75,000 | $115,000--$205,000 |
| Phase 4 | 6-12 months after P3 | $50,000--$100,000 (software) | $165,000--$305,000 |
| Phase 4 Hardware | Per bay | $800--$2,400/bay | Varies per shop |
| Phase 5 | Ongoing | $50,000--$100,000+ (migration tooling) | $215,000--$405,000+ |
| Ongoing | Monthly | $5,000--$15,000 CAD/month retainer (optional) | -- |

All prices in Canadian Dollars (CAD).

---

## Appendix C: Tiered Product Summary

| Tier | Monthly Price (set by Micazen) | Included Features |
|------|-------------------------------|-------------------|
| **BC Light** | TBD by Sharon | RO creation, tracking, CIECA import, accounting export, basic production board, basic assignments, basic parts tracking, basic reporting (3 reports), EN/FR |
| **BC Medium** | TBD by Sharon | Everything in Light + display boards, full assignments, full parts management, job costing, scheduling, automated customer notifications, standard reporting, offline capability |
| **BC Full** | TBD by Sharon | Everything in Medium + customer portal, advanced analytics/benchmarking, SOP enforcement |
| **BCAI Add-On** | TBD by Sharon | Click-to-talk AI, AI-assisted suggestions, recommendation engine, AI reporting queries; available on any tier |
| **Brad Add-On** | TBD by Sharon | Wake word, per-bay voice agents, hardware integration; available on BC Full + BCAI |

Note: Customer-facing pricing is set by Micazen, not by D. Caine Solutions. The tier definitions above determine which features are gated by product tier.

---

**End of Phase 5 Specification**

*This document is a technical specification for red-line review. No sales language. No value propositions. No revenue projections. Features, screens, fields, behaviors.*
