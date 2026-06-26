# BCAI Phase 3 -- Network-Ready + AutoCanada Pilot + Native Mobile

## BodyShopConnect AI | Micazen Consulting & Technologies

| Field | Value |
|-------|-------|
| **Document Version** | 2.0 |
| **Date** | April 7, 2026 |
| **Timeline** | 3--4 months after Phase 2 completion |
| **Investment** | $40,000--$75,000 CAD |
| **Billing** | Milestone-based: 25% at kickoff, 25% at Regional/Network RBAC complete, 25% at pilot deployment, 25% at acceptance |
| **Prerequisite** | Phase 2 accepted and in production with independent shops |
| **Deliverable Summary** | Full four-tier RBAC (Regional + Network), AutoCanada pilot deployment, SOP enforcement engine, native mobile app (iOS + Android), customer-facing portal, advanced analytics with cross-shop benchmarking (privacy-controlled), CSI platform and insurance carrier integrations, additional third-party integrations, expanded language support. |

---

## Table of Contents

1. [Regional and Network RBAC Tiers](#1-regional-and-network-rbac-tiers)
2. [AutoCanada Pilot Program](#2-autocanada-pilot-program)
3. [SOP Enforcement Engine](#3-sop-enforcement-engine)
4. [Native Mobile App](#4-native-mobile-app)
5. [Customer-Facing Portal](#5-customer-facing-portal)
6. [Advanced Analytics and Benchmarking](#6-advanced-analytics-and-benchmarking)
7. [Tiered Product Configuration](#7-tiered-product-configuration)
8. [What Is Sellable vs Internal Testing](#8-what-is-sellable-vs-internal-testing)
9. [What AI Can Do at This Phase](#9-what-ai-can-do-at-this-phase)
10. [Integrations Included](#10-integrations-included)
11. [Multi-Language Coverage](#11-multi-language-coverage)
12. [Support Model](#12-support-model)
13. [What Is NOT in This Phase](#13-what-is-not-in-this-phase)
14. [Acceptance Criteria](#14-acceptance-criteria)

---

## 1. Regional and Network RBAC Tiers

### Purpose

Complete the four-tier RBAC hierarchy. Phase 1-2 delivered Single Store and MSO. Phase 3 adds Regional and Network tiers to support franchise networks (CSN Collision), corporate groups (AutoCanada, Simplicity), and multi-region operators.

### Four-Tier Hierarchy (Complete)

| Tier | Description | Data Scope | Admin Capabilities |
|------|-------------|-----------|-------------------|
| **Single Store** | One shop, one location | Own shop data only | Manage own shop users, settings, operations |
| **MSO** | 2-10 locations, single owner | All owned shops; switch between shops | Manage all owned shops; aggregate MSO reporting |
| **Regional** | Area manager covering multiple stores/MSOs | All shops in assigned region | Regional reporting; assign/manage shop admins; enforce regional SOPs; view (not edit) shop-level data |
| **Network** | Franchise/corporate HQ (CSN, AutoCanada) | All shops in network; aggregate and per-shop views | Network-wide reporting; SOP management; brand compliance; onboard/offboard shops; manage regional admins |

### Network Admin Screens

| Screen | Purpose | Access |
|--------|---------|--------|
| **Network Dashboard** | Aggregate KPIs across all network shops: total ROs, avg cycle time, revenue, utilization, SOP compliance % | Network Admin |
| **Shop Directory** | List of all shops in network with status (active, onboarding, suspended); click to view shop detail | Network Admin, Regional Admin |
| **Regional Management** | Create/edit regions; assign shops to regions; assign regional admins | Network Admin |
| **SOP Library** | Manage network-wide SOPs (see Section 3); assign SOPs to shops/regions | Network Admin |
| **Network Reporting** | Cross-shop comparison reports with privacy controls (see Section 6) | Network Admin, Regional Admin |
| **Brand Compliance** | Monitor: logo usage, naming conventions, UI customization within network guidelines | Network Admin |
| **Network User Management** | Manage network-level and regional-level users | Network Admin |

### Regional Admin Screens

| Screen | Purpose | Access |
|--------|---------|--------|
| **Regional Dashboard** | Aggregate KPIs for shops in assigned region | Regional Admin |
| **Regional Shop List** | Shops in region with drill-down to shop-level metrics | Regional Admin |
| **Regional SOP Compliance** | SOP adherence rates per shop in region | Regional Admin |
| **Regional Reporting** | Cross-shop comparison within region | Regional Admin |

### Sub-Tenant Architecture

| Concept | Detail |
|---------|--------|
| Network tenant | Parent tenant representing the network (e.g., "AutoCanada") |
| Shop tenant | Child tenant representing each individual shop location |
| Data isolation | Shop data isolated at database level (same as Phase 1-2); network admin sees aggregated metrics, NOT raw shop data unless explicitly granted |
| Privacy control | Network admin can view: aggregate metrics, SOP compliance, KPIs. Cannot view: individual RO details, customer PII, employee records -- unless shop admin grants explicit access |
| Cross-shop learning | NOT allowed. Each shop's AI context remains fully isolated. Network-level AI analyzes only aggregated, anonymized metrics. |

---

## 2. AutoCanada Pilot Program

### Purpose

Deploy BCAI to AutoCanada (~80 collision repair locations) as the first enterprise pilot. AutoCanada has corporate trainers, established SOPs, and structured feedback processes, making them the ideal validation partner.

### Pilot Scope

| Element | Detail |
|---------|--------|
| Initial locations | 3-5 AutoCanada locations selected jointly by Micazen and AutoCanada |
| Duration | 8-12 weeks per pilot phase |
| Success criteria | Defined jointly before deployment (see acceptance criteria section) |
| Feedback loop | Weekly feedback sessions with AutoCanada corporate trainers |
| Escalation path | Direct escalation channel: AutoCanada trainer -> Sharon/Jim -> D. Caine Solutions |

### Pilot-Specific Requirements

| Requirement | Detail |
|-------------|--------|
| Data sovereignty | AutoCanada is publicly traded; ALL data must remain in Canada (AWS ca-central-1); documented compliance certificate |
| SOP compliance tracking | AutoCanada has existing SOPs; system must enforce and track compliance (see Section 3) |
| Corporate reporting | AutoCanada HQ needs aggregate performance metrics across pilot locations |
| Trainer access | AutoCanada corporate trainers get Regional Admin access to monitor pilot locations |
| Onboarding package | Training materials, guided walkthroughs, and support playbook customized for AutoCanada workflows |

### Pilot Deployment Phases

| Phase | Duration | Scope |
|-------|----------|-------|
| Pilot A | Weeks 1-4 | Deploy to 1 location; intensive hands-on support; daily feedback |
| Pilot B | Weeks 5-8 | Expand to 2-3 additional locations; AutoCanada trainers lead onboarding |
| Pilot C | Weeks 9-12 | Full pilot cohort operational; performance metrics compared to baseline |
| Review | Week 12+ | Joint review with AutoCanada; go/no-go for broader rollout |

---

## 3. SOP Enforcement Engine

### Purpose

Define, assign, and track adherence to Standard Operating Procedures (SOPs) at the network, regional, or shop level. SOPs define the expected sequence of steps and checks for workflows like vehicle intake, QC inspection, or customer delivery.

### SOP Structure

| Element | Detail |
|---------|--------|
| SOP name | e.g., "Vehicle Intake Procedure" |
| Steps | Ordered list of required actions with descriptions |
| Checkpoints | Mandatory verification points (e.g., "Photo of VIN plate uploaded") |
| Assigned to | Network-wide, regional, or shop-specific |
| Linked workflow | Which BC workflow this SOP applies to (e.g., RO stage transition from Estimate to Authorization) |
| Compliance tracking | System tracks which steps were completed, skipped, or failed |

### Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **SOP Library** | Network Admin, Regional Admin, Shop Admin | Browse, search, and view SOPs applicable to the current scope |
| **SOP Editor** | Network Admin | Create and edit SOPs: name, description, steps, checkpoints, assignments, linked workflows |
| **SOP Compliance Dashboard** | Network Admin, Regional Admin, Shop Admin | Compliance rates by SOP, by shop, by region; trend charts; drill-down to non-compliant events |
| **SOP Compliance Detail** | Manager, Admin | Per-RO: which SOP steps were completed, which were skipped, who skipped them, timestamp |
| **SOP Enforcement Settings** | Network Admin, Shop Admin | Configure per SOP: soft enforcement (warning) vs. hard enforcement (blocks workflow progression until step completed) |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Soft enforcement | Warning displayed when SOP step skipped; user can override with reason; logged |
| Hard enforcement | Workflow blocked until mandatory SOP step completed (e.g., cannot move to "Delivered" without QC photos uploaded) |
| AI assistance | BC can prompt: "SOP requires a photo of the VIN plate before proceeding. Upload now?" |
| Reporting | SOP compliance feeds into network and regional reporting |
| Versioning | SOPs are versioned; changes require approval from Network Admin; previous versions archived |

---

## 4. Native Mobile App

### Purpose

Native iOS and Android applications for technicians, managers, and field staff. Supplements the responsive web UI with native device capabilities.

### Platforms

| Platform | Minimum Version | Distribution |
|----------|----------------|-------------|
| iOS | iOS 15+ | Apple App Store |
| Android | Android 10+ | Google Play Store |

### Native Capabilities (beyond web)

| Capability | Detail |
|-----------|--------|
| Push notifications | Native push for: RO status changes, AI suggestions, customer messages, SOP alerts |
| Camera integration | Direct camera access for photos; bulk photo capture mode for vehicle documentation |
| Barcode/QR scanning | Scan part barcodes for receiving; scan VIN barcodes for vehicle lookup |
| Offline mode | Full offline support (same as Phase 2 PWA, but native implementation for better performance) |
| Background sync | Data syncs in background even when app is not in foreground |
| Biometric login | Face ID / Touch ID (iOS) and fingerprint/face unlock (Android) |
| Click-to-talk | Native microphone access for BC voice commands; better audio quality than web |

### Screens

All screens from the web application are available in the native app, optimized for mobile interaction patterns:

| Screen | Mobile Optimization |
|--------|-------------------|
| Production board | Swipeable columns; pull-to-refresh; long-press for quick actions |
| RO detail | Tab bar at bottom for section switching; swipe between tabs |
| Camera/photos | Native camera UI; multi-photo capture; auto-upload to RO |
| Parts receiving | Barcode scanner launches from parts receiving screen |
| Schedule | Calendar with swipe navigation; tap to create/edit |
| Click-to-talk | Persistent mic button; haptic feedback on activation |

### What Is NOT in the Native App

| Feature | Reason |
|---------|--------|
| Admin/settings screens | Complex configuration done on desktop/tablet web |
| Report builder | Reports viewed on mobile; built/scheduled on desktop |
| SOP editor | SOP management done on desktop |
| Tenant provisioning | Admin function, desktop only |

---

## 5. Customer-Facing Portal

### Purpose

A web portal where vehicle owners can check repair status, view photos, communicate with the shop, and provide feedback -- without calling the shop.

### URL

`status.bcai.ca/{shop-slug}/{tracking-code}`

Customer receives a link via email or SMS when their RO is created. No login required; access via unique tracking code.

### Screens

| Screen | Content |
|--------|---------|
| **Status Overview** | Vehicle info, current repair stage (visual progress bar), estimated completion date, assigned shop contact |
| **Photo Gallery** | Photos uploaded by shop (before/during/after repair); optional -- shop controls visibility |
| **Communication** | Send message to shop (creates note on RO tagged as "customer message"); view shop responses |
| **Repair History** | Timeline of stage changes with dates |
| **Feedback** | Post-delivery satisfaction survey (1-5 stars + free text) |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Access control | Tracking code is unique per RO; expires 30 days after delivery |
| No login | Customer does not need an account; link + tracking code is access |
| Language | Portal renders in customer's preferred language from their record |
| Branding | Shop logo and name displayed; customizable color scheme per shop |
| Privacy | Customer sees only their own RO; no other shop data visible |
| Notifications | Customer gets email/SMS when stage changes (if opted in via Phase 2 notification engine) |

---

## 6. Advanced Analytics and Benchmarking

### Purpose

Cross-shop performance comparison with strict privacy controls. Network and regional admins can compare KPIs across shops without seeing individual shop operational data.

### New Reports

| Report | Description | Access | Privacy |
|--------|-------------|--------|---------|
| **Cross-Shop Cycle Time Comparison** | Average cycle time per shop in network/region; ranked; trend | Network Admin, Regional Admin | Aggregate metrics only |
| **Cross-Shop Revenue Comparison** | Revenue per shop; revenue per RO; trend | Network Admin | Aggregate metrics only |
| **Cross-Shop CSI Scores** | Customer satisfaction index per shop (from feedback portal + CSI platform data) | Network Admin, Regional Admin | Aggregate metrics only |
| **SOP Compliance Ranking** | Compliance rates ranked by shop across all enforced SOPs | Network Admin, Regional Admin | Compliance % only; no individual employee data |
| **Technician Efficiency Benchmark** | Anonymous percentile ranking: how does this shop's average tech efficiency compare to network average | Shop Admin, Manager | Own shop data + anonymized network averages |
| **Parts Cost Benchmark** | Average parts cost per RO type compared to network average | Shop Admin, Manager | Own shop data + anonymized network averages |
| **DRP Scorecard** | Metrics required by insurance DRP programs: cycle time, CSI, parts accuracy, supplement rate | Shop Admin, Manager, Network Admin | Per-shop for own data; aggregate for network |

### Privacy Controls

| Control | Detail |
|---------|--------|
| No individual data exposure | Network admin sees: Shop A avg cycle time = 6.2 days. NOT: "RO 4521 for John Smith took 8 days" |
| Anonymized benchmarks | "Your shop is in the 75th percentile for cycle time" -- no identification of which shops are above/below |
| Opt-in for detailed sharing | Shop admin can opt-in to share detailed metrics with network admin; off by default |
| Audit | All cross-shop data access logged |

### Dashboard Widgets (New)

| Widget | Description |
|--------|-------------|
| **Network Health** | Map view of all shops with color-coded status (green/yellow/red based on KPIs) |
| **SOP Compliance Gauge** | Circular gauge showing overall network SOP compliance % |
| **Cycle Time Trend** | Line chart showing network-wide cycle time trend over 6 months |
| **Revenue Trend** | Line chart showing network-wide revenue trend |
| **Active ROs** | Total active ROs across network/region |

---

## 7. Tiered Product Configuration

### Purpose

Implement the BC Light / BC Medium / BC Full + BCAI add-on product tiers that Sharon is launching May 1. Each tenant is assigned a tier that controls which features are available.

### Tier Definitions

| Feature | BC Light | BC Medium | BC Full | BCAI Add-On |
|---------|---------|----------|---------|------------|
| RO creation + tracking | Yes | Yes | Yes | -- |
| CIECA import | Yes | Yes | Yes | -- |
| Accounting exports | Yes | Yes | Yes | -- |
| Production board | Yes | Yes | Yes | -- |
| Display boards (TV) | No | Yes | Yes | -- |
| Assignments | Basic | Full | Full | -- |
| Parts management | Basic (tracking only) | Full (ordering, receiving, returns) | Full | -- |
| Job costing | No | Yes | Yes | -- |
| Scheduling | No | Yes | Yes | -- |
| Customer notifications | Manual only | Automated | Automated | -- |
| Customer portal | No | No | Yes | -- |
| Reporting | Basic (3 reports) | Standard (all reports) | Advanced (benchmarking) | -- |
| SOP enforcement | No | No | Yes | -- |
| Offline capability | No | Yes | Yes | -- |
| Click-to-talk AI (BC Voice) | -- | -- | -- | Yes |
| AI-assisted suggestions | -- | -- | -- | Yes |
| Recommendation engine | -- | -- | -- | Yes |
| AI reporting queries | -- | -- | -- | Yes |

### Configuration Screens

| Screen | Access | Purpose |
|--------|--------|---------|
| **Tenant Tier Management** | Micazen Admin | Assign tier to tenant; upgrade/downgrade; view feature availability |
| **Feature Gating** | Micazen Admin | Configure which features are included in each tier; override per tenant if needed |
| **Add-On Management** | Micazen Admin | Enable/disable BCAI add-on per tenant |

### Behaviors

| Behavior | Detail |
|----------|--------|
| Feature gating | Features not included in tenant's tier are hidden from UI; no "locked" or "upgrade" prompts in Phase 3 (marketing prompts deferred) |
| Tier change | Upgrade takes effect immediately; downgrade takes effect at next billing cycle |
| BCAI add-on | Available on any tier; adds all AI features to whichever tier the shop is on |

---

## 8. What Is Sellable vs Internal Testing

| Feature | Sellable | Internal Testing Only |
|---------|----------|----------------------|
| Everything from Phase 1 + 2 | Yes | -- |
| Network admin tier (for AutoCanada, CSN, Simplicity) | Yes -- required for any network/franchise sale | -- |
| Regional admin tier | Yes -- required for multi-region operators | -- |
| SOP enforcement | Yes -- networks require compliance tracking | -- |
| Native mobile app (iOS + Android) | Yes -- techs and managers prefer native apps | -- |
| Customer-facing portal | Yes -- reduces inbound customer calls; improves CSI scores | -- |
| Advanced analytics / benchmarking | Yes -- networks need cross-shop performance visibility | -- |
| Tiered product (Light/Medium/Full + BCAI) | Yes -- THIS IS THE PRICING AND PACKAGING MODEL | -- |
| CSI platform integrations | Yes -- required for DRP shops | -- |
| AutoCanada pilot | Internal testing at scale -- validates before broader network rollout | Initial pilot locations are testing; successful pilot leads to full rollout |

**Phase 3 is the "network-ready" release.** After Phase 3, BCAI can serve independent shops (Phase 1-2 market), MSOs, and enterprise networks. The tiered product model (Light/Medium/Full + BCAI) is live.

---

## 9. What AI Can Do at This Phase

Everything from Phase 1 + 2, PLUS:

| What You Say | What BC Does |
|-------------|-------------|
| "BC, how does Shop A compare to Shop B on cycle time?" | Returns cross-shop comparison (Network Admin only; respects privacy controls) |
| "BC, which shops are below 80% SOP compliance this month?" | Returns list of non-compliant shops (Network/Regional Admin only) |
| "BC, show me the DRP scorecard for this shop" | Displays DRP metrics: cycle time, CSI, parts accuracy, supplement rate |
| "BC, what SOPs apply to vehicle intake?" | Lists applicable SOPs with step descriptions |
| "BC, help the customer check their repair status" | Generates and sends customer portal link for the current RO |
| "BC, compare our parts costs to network average" | Returns anonymized benchmark comparison |
| "BC, show the SOP compliance trend for our region" | Displays regional compliance trend chart (Regional Admin) |
| "BC, which technicians need SOP training?" | Identifies techs with lowest SOP compliance rates (Shop Admin/Manager) |
| "BC, generate a network performance summary for this quarter" | Produces aggregate report across all network shops (Network Admin) |

---

## 10. Integrations Included

### New in Phase 3

| Integration | Type | Direction | Detail |
|-------------|------|-----------|--------|
| CSI platforms | API push | Outbound | Push customer satisfaction data triggered on delivery date; configurable per insurance carrier |
| Insurance carrier integrations | API/EDI | Bidirectional | DRP assignment data, claim status updates, authorization responses |
| Serbia DMS | API/file | Bidirectional | Vehicle and repair data exchange per Serbia DMS specification (25 additional items from recent rebuild) |
| Full parts supplier network | Vendor APIs | Bidirectional | Expand beyond Phase 2 pilot to full network of parts suppliers |
| Apple App Store | Distribution | Outbound | Publish native iOS app |
| Google Play Store | Distribution | Outbound | Publish native Android app |

### Cumulative Integration List (Phase 1 + 2 + 3)

| # | Integration | Phase |
|---|-------------|-------|
| 1 | CCC ONE (CIECA import) | 1 |
| 2 | Mitchell (CIECA import) | 1 |
| 3 | Audatex (CIECA import) | 1 |
| 4 | QuickBooks Online | 1 |
| 5 | QuickBooks Desktop | 1 |
| 6 | Sage 50 | 1 |
| 7 | Sage Cloud | 1 |
| 8 | Xero | 1 |
| 9 | SendGrid (email) | 1 |
| 10 | Twilio (SMS) | 1 |
| 11 | Google Drive | 2 |
| 12 | Dropbox | 2 |
| 13 | OneDrive | 2 |
| 14 | Zoho Desk | 2 |
| 15 | Paint scale vendors | 2 |
| 16 | AutoHouse | 2 |
| 17 | ClaimsCorp | 2 |
| 18 | Parts suppliers (pilot) | 2 |
| 19 | CSI platforms | 3 |
| 20 | Insurance carriers | 3 |
| 21 | Serbia DMS | 3 |
| 22 | Full parts supplier network | 3 |
| 23 | Apple App Store | 3 |
| 24 | Google Play Store | 3 |
| 25 | Apple Push Notification Service | 3 |
| 26 | Google Firebase Cloud Messaging | 3 |

---

## 11. Multi-Language Coverage

| Language | UI | AI | Help | Reports | Notifications | Customer Portal |
|----------|----|----|------|---------|--------------|----------------|
| English | Full | Full | Full | Full | Full | Full |
| French | Full | Full | Full | Full | Full | Full |
| Spanish | Full | Full | Full | Full | Full | Full |

### Deferred Languages

| Language | Phase | Notes |
|----------|-------|-------|
| Romanian | Phase 4+ | Available in existing BC system; will be ported when prioritized |
| Italian | Phase 4+ | Available in existing BC system; will be ported when prioritized |
| Hindi | Phase 4+ | Available in existing BC system; will be ported when prioritized |

---

## 12. Support Model

### SLA (unchanged)

| Priority | Identification | Resolution |
|----------|---------------|------------|
| Critical | 2 hours | 12 hours |
| High | 12 hours | 24 hours |
| Medium | 24 hours | 72 hours |
| Low | 48 hours | Next release |

### Phase 3 Enhancements

| Enhancement | Detail |
|-------------|--------|
| AutoCanada dedicated support channel | Priority escalation path for AutoCanada pilot locations |
| Network-level support dashboard | Micazen admin can view support ticket volume and SLA compliance per network |
| Mobile app crash reporting | Native app sends crash reports automatically; included in D. Caine monitoring |
| SOP-linked playbooks | Playbook entries linked to SOP steps; if a user fails an SOP step, relevant playbook is surfaced |

---

## 13. What Is NOT in This Phase

| Feature | Deferred To | Reason |
|---------|------------|--------|
| Wake word ("Hey BC") hands-free operation | Phase 4 | Requires hardware deployment |
| Voice in every bay (Brad) | Phase 4 | Per-bay hardware + per-bay agents |
| Per-bay autonomous workflow agents | Phase 4 | Requires mature AI + hardware |
| Bay hardware (speakers, microphones, displays) | Phase 4 | Physical deployment |
| Existing BC customer data migration | Phase 5 | System must be proven with new customers first |
| White-label platform | Phase 5 | Platform maturity required |
| Public API ecosystem | Phase 5 | Platform maturity required |
| Predictive AI (demand forecasting, parts prediction) | Phase 5 | Requires sufficient historical data |
| Romanian, Italian, Hindi UI | Phase 4+ | Lower priority |

---

## 14. Acceptance Criteria

| # | Criterion |
|---|----------|
| 1 | Network Admin can create a network, add regions, assign shops to regions, and assign regional admins |
| 2 | Network Admin can view aggregate KPIs across all shops without seeing individual RO details |
| 3 | Regional Admin can view aggregate KPIs for shops in their assigned region only |
| 4 | Shop data isolation is maintained: network admin cannot access customer PII or individual RO details without shop admin granting explicit access |
| 5 | AutoCanada pilot: 1 location onboarded, operational, and processing live ROs within Pilot A timeframe |
| 6 | SOP can be created, assigned to shops, and enforced (soft: warning on skip; hard: blocks progression) |
| 7 | SOP compliance dashboard shows correct compliance percentages per shop, per SOP |
| 8 | Native iOS app installs from TestFlight/App Store; all core features functional (production board, RO detail, camera, click-to-talk, offline) |
| 9 | Native Android app installs from Play Store; all core features functional |
| 10 | Push notifications received on mobile when RO status changes |
| 11 | Barcode scanning from native app correctly looks up parts by barcode |
| 12 | Customer portal accessible via unique tracking link; shows current repair stage, photos, and allows messaging |
| 13 | Customer portal renders in customer's preferred language |
| 14 | Cross-shop cycle time comparison report shows correct aggregate data for network admin |
| 15 | Anonymized benchmark: shop admin sees "Your shop is in the Xth percentile" without identifying other shops |
| 16 | BC Light tenant cannot access job costing, scheduling, or display boards; features are hidden |
| 17 | BC Full tenant has all features available |
| 18 | BCAI add-on can be enabled on any tier and all AI features become available |
| 19 | CSI platform receives data push on RO delivery |
| 20 | Insurance carrier integration: DRP assignment data received and linked to RO |
| 21 | "BC, how does Shop A compare to Shop B on cycle time?" returns correct comparison (Network Admin) |
| 22 | "BC, which shops are below 80% SOP compliance?" returns correct list (Network Admin) |
| 23 | Serbia DMS integration exchanges data correctly for all 25 required fields |

---

**End of Phase 3 Specification**

*This document is a technical specification for red-line review. No sales language. No value propositions. No revenue projections. Features, screens, fields, behaviors.*
