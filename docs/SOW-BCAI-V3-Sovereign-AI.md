# Statement of Work
# BCAI v3 -- Sovereign AI Platform for BodyShopConnect

---

**Prepared by:** D. Caine Solutions LLC
8104 E 35th St, Tulsa, OK 74145
inquiry@starrpartners.ai

**Prepared for:** Sharon Ashley & Jim Wraight
Micazen Consulting & Technologies
British Columbia, Canada

**Date:** April 2, 2026
**Version:** 3.0
**Project Code:** MIC-2026-V3
**Classification:** Confidential

---

## Table of Contents

1. The Market Opportunity
2. Go-To-Market Strategy
3. BCAI Core: What Ships First
4. Growth Path: Core to Enterprise
5. What We Do NOT Rebuild (Cost Savings)
6. Sovereign AI: Privacy and Compliance
7. Competitive Position
8. Investment by Phase (Milestone-Based)
9. IP and Ownership
10. Risk and Mitigation
11. Assumptions and Dependencies
12. Termination
13. Next Steps
14. Signatures

---

## 1. The Market Opportunity

Every collision repair technician in Canada spends 60+ minutes per shift on manual data entry -- status updates, notes, parts logging, production board changes. That is not overtime. That is not a new hire. That is money already in the building, currently spent on admin work instead of billable repair hours.

| Scale | Technicians | Annual Recovered Value |
|-------|-------------|----------------------|
| Single 8-tech shop | 8 | $150,000/year |
| AutoCanada (80 locations) | ~640 | $12,000,000/year |
| CSN Collision (~500 locations) | ~2,500 | $47,000,000/year |

BodyShopConnect is the only collision shop management system positioned to capture this value. No competitor -- not Mitchell, not CCC ONE, not Audatex, not Shop-Ware, not Tekmetric -- is building a sovereign AI platform for collision repair. The window is open now. It will not stay open indefinitely.

BCAI v3 is the platform that gets you to market first.

---

## 2. Go-To-Market Strategy

This go-to-market strategy reflects the decisions made in the March 31, 2026 meeting. It is Sharon's plan, built into the engineering scope.

### Phase 1: Independent Shops First

Launch BCAI Core with independent shops. These are lower-risk customers who provide real-world feedback without jeopardizing existing network relationships. If something breaks during early rollout, it gets fixed before any enterprise customer sees it. Jim is already selling new customers -- BCAI Core becomes what they onboard onto.

### Phase 2: AutoCanada Pilot

AutoCanada is the ideal pilot partner, not the hardest one. They have corporate trainers, established SOPs, and the operational discipline to run a new platform through its paces. A successful AutoCanada pilot gives Sharon the proof she needs for every other network conversation.

### Phase 3: Existing Customer Migration

Only after the platform is proven with independents and validated by AutoCanada do existing BodyShopConnect customers migrate. No shop downtime. No data loss. No disruption to the live system. The old platform stays running until the new one has earned the migration.

### Phase 4: Network Expansion

CSN Collision, Simplicity, Car Star, and other networks enter the conversation with a proven platform and a reference-ready AutoCanada deployment behind it.

---

## 3. BCAI Core: What Ships First

Sharon was clear on March 31: "Give me CIECA imports, accounting exports, and core workflow. That is what goes to market."

BCAI Core is the minimum product that generates revenue. It ships in 6-8 weeks from Phase 0 kickoff. Nothing else ships until this works.

### What BCAI Core Includes

| Capability | Description |
|------------|-------------|
| **CIECA/Estimating Imports** | CCC, Mitchell, Audatex estimate data flows directly into BCAI. Lifted from existing BC code -- battle-tested, 10+ years in production. |
| **Accounting Exports** | QuickBooks minimum. Sage and AutoHouse as fast-follows. Existing data mapping logic reused. |
| **Core RO Workflow** | Repair order creation, status tracking, card movement. The daily operating workflow every shop runs on. |
| **Role-Based Access** | Multi-level permissions mapped from BC's existing 5-tier RBAC model. |
| **Multi-Tenant Architecture** | Per-tenant database isolation. No cross-tenant data exposure. No cross-tenant learning. |
| **Basic Reporting** | Shop-level operational reports. Cycle time, work-in-progress, throughput. |
| **Mobile-Responsive Web UI** | Works on desktop and mobile browsers. Not a native app -- faster to ship, easier to support. |

### What BCAI Core Does NOT Include (Yet)

- Voice interaction (that is v4 -- Ted)
- AI-assisted workflow suggestions (Phase 2)
- Network-level multi-shop reporting (Phase 3)
- SOP enforcement automation (Phase 3)
- Customer migration tooling (Phase 4+)

BCAI Core is the product Sharon sells to independents. Everything else is a growth path.

---

## 4. Growth Path: Core to Enterprise

Sharon described this herself on March 31: "baby Brad, toddler Brad, 10-year-old Brad, 20-year-old Brad." This phase structure matches that mental model. Each phase is a decision point. Sharon and Jim decide at every gate whether to continue, pause, or adjust.

```
BCAI Core (Phase 1)  -->  BCAI Pro (Phase 2)  -->  BCAI Enterprise (Phase 3)  -->  BCAI + Ted (v4)
  Revenue starts            AI assists              Network-ready                 Voice in every bay
  Independents              Proven product           AutoCanada pilot              Category killer
  6-8 weeks                 Weeks 14-24             Months 6-10                   Months 10-18+
```

This is one product with a growth path -- not four separate products. Each phase adds capability. Each phase generates more revenue. Each phase makes the next phase lower-risk because it is built on proven, customer-tested foundations.

---

## 5. What We Do NOT Rebuild (Cost Savings)

BodyShopConnect has been running for over a decade. Significant portions of the existing codebase carry forward into BCAI, reducing cost and timeline. This is why the investment is dramatically lower than building from scratch.

### High Reuse Value -- Saves Significant Cost

| Existing BC Component | Current State | What We Do With It |
|----------------------|---------------|-------------------|
| **CIECA Import Pipeline** | Working, battle-tested, 10+ years | Lift core logic, modernize API layer. Do NOT rebuild from scratch. |
| **Role-Based Access Control** | Working, 5 permission levels | Map to new tenant model. Extend for multi-level tenancy, do not replace. |
| **RO Workflow Engine** | Working but monolithic | Extract business logic rules, re-implement in modern stack using same rules. |
| **Estimating Connectors (CCC, Mitchell, Audatex)** | Working | Wrap in new API boundary. Proven integration logic stays intact. |

### Medium Reuse Value -- Partial Savings

| Existing BC Component | Current State | What We Do With It |
|----------------------|---------------|-------------------|
| **Accounting Exports (QB, Sage, AutoHouse)** | Working, format-specific | Reuse data mapping logic. Rebuild transport layer for modern API standards. |
| **Reporting Engine** | Working but limited | Reuse report definitions and calculations. New visualization layer. |
| **User Management** | Working | Reuse user model. Extend for multi-level tenancy. |

### What We DO Rebuild (and Why)

| Component | Why Rebuild |
|-----------|------------|
| **Frontend (Vue 2)** | End-of-life framework. Business logic trapped in templates. Modern Vue 3 or equivalent. |
| **Multi-Tenant Architecture** | BC's own dev team acknowledges this was bolted on, not designed in. Redesign from scratch with per-tenant database isolation. |
| **Backend (PHP/Yii2)** | Cannot support AI integration. Modern NestJS/TypeScript backend required. |
| **ElasticSearch Layer** | EOL version. Replace with PostgreSQL full-text search + pgvector. Simplifies infrastructure. |

### Net Effect on Pricing

The high-reuse components -- CIECA, RBAC, RO workflow, estimating connectors -- represent roughly **30-40% of the Phase 1 build effort**. This is why Phase 1 costs $45K-$85K instead of $110K-$165K. The code audit in Phase 0 narrows this range to a firm number with specifics on what carries forward and what does not.

---

## 6. Sovereign AI: Privacy and Compliance

Sharon eliminated cloud AI (v2) from consideration on March 31 because of Canadian privacy law and network data agreements. The data cannot leave BC infrastructure. This is not a preference. It is a legal constraint.

### What Sovereign AI Means for BCAI

- **The AI runs on your infrastructure.** AWS Canada Central (Montreal) or on-premise. No US servers. No cross-border data transfer.
- **PIPEDA compliance is structural, not contractual.** There is no cross-border routing because there is no cross-border architecture. Compliance is built in, not enforced through contractual terms with a US API provider.
- **Zero per-query AI cost at scale.** No per-token billing. No API rate limits. No usage-based pricing surprises. At AutoCanada scale (80+ shops), this represents hundreds of thousands in avoided annual cost compared to cloud AI APIs.
- **Every AI decision is auditable.** Full local audit trail. Compliance auditors can inspect every AI decision, every data input, every agent output -- all on BC servers, all accessible without involving a third-party provider.

### What This Means for Enterprise Sales

When AutoCanada's legal and compliance teams evaluate AI features, the question is not just "what does it do?" but "where does our data go?" BCAI's answer is unambiguous: **your data never leaves Canada.** No cloud-API-dependent competitor can make that claim with the same architectural certainty.

For CSN Collision's franchise network -- hundreds of independently owned shops, each with their own privacy obligations -- sovereign AI means every franchisee's operational data stays within BC infrastructure. No cross-tenant learning. No data aggregation without consent.

### Tenant Isolation Architecture

| Design Principle | Implementation |
|-----------------|----------------|
| **Per-tenant database schema** | Every shop gets its own PostgreSQL schema. No shared tables for operational data. |
| **Zero cross-tenant queries** | Application layer enforces tenant boundary at every database call. No exceptions. |
| **Tenant-scoped AI** | AI agent runtime loads tenant context per session. No cross-tenant model contamination. |
| **Audit isolation** | Audit trail is per-tenant. One shop cannot see another shop's history. |
| **Provisioning automation** | New tenant onboarding creates isolated schema, seeds default config, provisions access. |

---

## 7. Competitive Position

Sharon's instinct on March 31 was correct: nobody in collision repair is building this. The competitive landscape confirms it.

### Current Competitor Status

| Competitor | What They Do | AI Status | Threat to BCAI |
|-----------|-------------|----------|---------------|
| **CCC Intelligent Solutions** | Photo-based damage assessment | Estimating AI (different layer -- insurance side) | Low |
| **Mitchell (Enlyte)** | Claims automation | Insurance-side AI | Low |
| **Audatex (Solera)** | Estimating | Estimating AI | Low |
| **Shop-Ware** | Modern shop management | No AI. Modern stack could add faster. | Medium |
| **Tekmetric** | Modern shop management | No AI. Modern stack could add faster. | Medium |

The closest threat is Shop-Ware or Tekmetric bolting on ChatGPT or a similar cloud API. That approach fails two tests immediately: Canadian data residency (PIPEDA) and network data agreements (AutoCanada, CSN). Cloud-API AI cannot offer what BCAI offers.

### BCAI's Four Moats

1. **Regulatory moat.** Sovereign AI on Canadian infrastructure. Data never leaves Canada. No competitor can match this without a full platform rebuild.
2. **Data moat.** 10+ years of collision repair operational data for AI training. A new competitor starts from zero.
3. **Distribution moat.** Existing relationships with AutoCanada, CSN, Simplicity, Car Star. These networks are already BC customers.
4. **Time moat.** First mover in AI collision shop management. By the time a competitor ships a prototype, BCAI will have trained its model on years of real operational data. The gap widens, not narrows.

---

## 8. Investment by Phase (Milestone-Based)

Every phase ends with a gate. Deliverables are demonstrated. Sharon and Jim review. The decision to proceed, adjust, or pause is theirs at every gate. No payment without delivery.

---

### PHASE 0: Foundation + Code Audit
**Timeline:** Weeks 1-6
**Investment:** $15,000 CAD (deposit, non-refundable)

| Deliverable | Description |
|-------------|-------------|
| Infrastructure sandbox | AWS/K8s environment in Canada alongside existing BC migration |
| Full codebase audit | Every existing BC component assessed for reuse potential |
| CIECA import prototype | First CIECA data import demonstrated using existing BC code as base |
| Tenant isolation design | Per-tenant database architecture documented and reviewed |
| Authentication framework | Identity and RBAC foundation |
| Code audit report | Specific components rated for reuse, with Phase 1 pricing narrowed to firm number |

**Gate Decision:** Kevin + Sharon/Jim review sandbox, CIECA prototype, and code audit. Go/no-go on Phase 1 with firm pricing based on actual code reuse findings.

---

### PHASE 1: BCAI Core
**Timeline:** Weeks 7-16 (BCAI Core Lite ready for market at week 6-8 from start)
**Investment:** $45,000 - $85,000 CAD (range narrows to firm number after Phase 0 code audit)

| Deliverable | Description |
|-------------|-------------|
| Core workflow engine | RO creation, status tracking, card movement |
| CIECA/estimating imports | CCC, Mitchell, Audatex -- lifted from existing BC code where possible |
| Accounting exports | QuickBooks minimum, Sage and AutoHouse as fast-follows |
| Role-based access | Multi-level permissions leveraging existing BC RBAC model |
| Multi-tenant architecture | Per-tenant database isolation |
| Basic reporting dashboard | Shop-level operational metrics |
| Mobile-responsive web UI | Desktop and mobile browser support |

**Gate Decision:** Kevin + Sharon/Jim review. Functional BCAI Core ready for first customer. Approve for market launch.

---

### PHASE 2: Market Launch + AI Assistance
**Timeline:** Weeks 14-24 (overlaps with Phase 1 completion)
**Investment:** $35,000 - $65,000 CAD

| Deliverable | Description |
|-------------|-------------|
| QA and security audit | Production-readiness verification |
| Independent shop onboarding | First 5-10 paying independent shop customers |
| Feedback loop and iteration | Rapid response to real customer usage |
| AI assistance layer | Sovereign AI (Nemotron) integration -- AI suggests, human confirms |
| Additional integrations | Based on customer demand from live shops |

**Gate Decision:** Kevin + Sharon/Jim review. Customer feedback assessment. Approve for network pilot.

---

### PHASE 3: Network Pilot -- AutoCanada
**Timeline:** Months 6-10
**Investment:** $40,000 - $75,000 CAD

| Deliverable | Description |
|-------------|-------------|
| AutoCanada pilot deployment | 3 shops recommended for initial rollout |
| Network-level SOP integration | AutoCanada provides corporate trainers + SOPs for codification |
| Multi-level reporting | Shop-level, MSO-level, and network-level views |
| AI SOP enforcement (initial) | System suggests compliance actions, human confirms |
| Performance benchmarking | Quantified ROI from pilot shops |

**Gate Decision:** Kevin + Sharon/Jim + AutoCanada feedback. Approve for existing customer migration.

---

### Total Investment Summary (Phases 0-3)

| Scenario | Total CAD | Timeline | Notes |
|----------|-----------|----------|-------|
| **Best case** (heavy code reuse, fast execution) | **$135,000** | ~8 months | Existing BC code carries forward cleanly |
| **Expected case** (moderate code reuse) | **$195,000** | ~10 months | Some components require more modernization |
| **Conservative case** (limited code reuse) | **$240,000** | ~12 months | Phase 0 code audit reveals more rebuild needed |

**Why this is lower than the original $850K/30-month estimate:**

1. **Phased scope.** Building what sells first, not everything at once.
2. **Existing code reuse.** CIECA, RBAC, estimating connectors, and RO workflow logic carry forward.
3. **Technology cost reductions.** AI infrastructure costs are dropping monthly. What cost $80K/year in GPU time two years ago costs $15K/year today.
4. **BC's AWS/K8s migration.** Infrastructure buildout is partially handled by the migration Sharon's team is already executing.

---

## 9. IP and Ownership

| Category | Owner |
|----------|-------|
| All BCAI-specific code, configurations, and customizations | **Micazen** |
| AI models trained on BodyShopConnect data | **Micazen** |
| Customer data, tenant data, operational data | **Micazen** |
| Underlying orchestration framework, AI integration patterns, and deployment tooling that existed before or independent of the BCAI engagement | **D. Caine Solutions LLC** |
| DCS retains the right to use anonymized architectural patterns and methodologies in future work | **D. Caine Solutions LLC** |

Sharon owns everything specific to BCAI. Kevin retains his tools and framework. Clean separation.

---

## 10. Risk and Mitigation

### Technical Risks

| Risk | Likelihood | Impact | What We Do About It |
|------|-----------|--------|-------------------|
| Existing BC code too tangled to reuse | Medium | High | Phase 0 includes code audit. Price adjusts at Phase 1 gate based on findings. |
| Nemotron performance insufficient for real-time | Low | High | Benchmark during Phase 0. Fallback models available (Llama 3, Mistral). |
| CIECA integration complexity exceeds estimate | Medium | High | BC already has working CIECA. We lift and modernize, not rebuild from scratch. |
| Cross-tenant data leakage | Low | Critical | Per-tenant database isolation, not schema-shared. Audit in Phase 0. |
| AWS/K8s migration creates moving target | Medium | Medium | Build alongside, not on top of. Clear interface boundaries. |

### Business Risks

| Risk | Likelihood | Impact | What We Do About It |
|------|-----------|--------|-------------------|
| Scope creep from enthusiasm | High | Medium | Milestone gates. Each phase scoped and priced at transition. |
| BC dev team resists external builder | High | Medium | Position as "alongside" not "replacing." Shared bug visibility. |
| AutoCanada declines pilot | Low | Medium | Any network can serve as pilot. AutoCanada is ideal, not required. |
| Competitor launches AI shop management first | Low | High | Speed to market with Core Lite. v4 features are 18+ month moat. |

---

## 11. Assumptions and Dependencies

1. Micazen provides staging environment access within 5 business days of deposit receipt.
2. Existing BC codebase access (read-only) provided to DCS for Phase 0 code audit.
3. Sharon or Jim available for 2-3 hours/week for product decisions during Phase 0-1.
4. BC's AWS/K8s migration does not block BCAI sandbox deployment.
5. GPU infrastructure costs (AWS Canada Central) are a Micazen-direct expense, not included in DCS phase pricing.
6. Live BC system remains live throughout -- no shop downtime at any point.
7. SOP content (where it exists) is provided by Micazen/shop operators. DCS builds the framework; shops provide the content.

---

## 12. Termination

- Either party may terminate with 15 days written notice.
- Upon termination, DCS delivers all completed work to date.
- If terminated by Micazen before a milestone: deposit for current phase is non-refundable; completed work beyond 50% of current phase is billed pro-rata.
- If terminated by DCS: full refund of any unearned fees.
- Phase 0 deposit ($15,000 CAD) is non-refundable in all cases.
- All completed deliverables transfer to Micazen per IP terms regardless of termination.

---

## 13. Next Steps

| Step | Action | Owner | Target |
|------|--------|-------|--------|
| 1 | Review and sign this SOW | Sharon / Kevin | Week of April 7, 2026 |
| 2 | Phase 0 deposit ($15,000 CAD) | Micazen | Upon signing |
| 3 | Staging environment and codebase access | Micazen | Within 5 business days of deposit |
| 4 | Phase 0 kickoff | DCS + Micazen | Within 3 business days of access |
| 5 | Phase 0 gate review | Sharon + Jim + Kevin | 6 weeks from kickoff |
| 6 | Phase 1 go/no-go decision | Sharon | At Phase 0 gate |

The first customer can be onboarded to BCAI Core within 6-8 weeks of Phase 0 kickoff. That is the timeline to revenue.

---

## 14. Signatures

**D. Caine Solutions LLC**

Name: Kevin Starr
Title: Principal
Date: _______________
Signature: _______________

**Micazen Consulting & Technologies**

Name: Sharon Ashley
Title: Owner
Date: _______________
Signature: _______________

---

*D. Caine Solutions LLC -- No fluff. Just truth, tools, and traction.*
*8104 E 35th St, Tulsa, OK 74145 | inquiry@starrpartners.ai*
