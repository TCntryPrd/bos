# Statement of Work
## BodyShopConnect AI Platform (BCAI)
### D. Caine Solutions LLC → Micazen Inc.

**Prepared by:** Kevin Starr, D. Caine Solutions LLC
**Prepared for:** Sharon Ashley (sashley@micazen.com), Jim Wraight (jim@bodyshopconnect.com)
**Date:** April 2026
**Version:** 2.0 (Revised per March 31, 2026 meeting)

---

## 1. Executive Summary

D. Caine Solutions LLC ("DCS") will design, develop, and deploy a next-generation AI-powered collision repair management platform — **BCAI** — to replace and modernize the existing BodyShopConnect platform. The system incorporates sovereign AI with strict tenant isolation, voice-enabled workflow assistance, and intelligent agents that learn shop operations while maintaining complete data privacy between tenants.

This revised SOW reflects the compressed timeline and phased go-to-market strategy agreed upon during the March 31 meeting: launch BCAI Core to independent shops first, pilot with a network partner (AutoCanada recommended), then migrate existing BC customers.

---

## 2. Go-To-Market Strategy

### Phase Path
1. **BCAI Core** → Independent shops (new customers, revenue generation + learning)
2. **Network Pilot** → AutoCanada (rigorous testing, SOP-driven, corporate trainer support)
3. **Customer Migration** → Existing BC customers (proven platform, data migration)

### Why This Order
- Independent shops provide low-risk learning environment
- Early revenue offsets development investment
- Network pilot (AutoCanada) provides structured SOP feedback, corporate trainers, and comprehensive testing
- Existing customers migrate to a battle-tested platform, not a beta
- Positions BC as "early adopter pricing" to independents, creating urgency

---

## 3. Scope of Work

### 3.1 BCAI Core (MVP) — Go-To-Market Release

**Must-have for market launch:**

| Feature | Description | Priority |
|---------|-------------|----------|
| CIECA/Estimating Imports | Import data from CCC, Mitchell, Audatex estimating systems | P0 — Required |
| Accounting Exports | Push data to QuickBooks, Sage, AutoHouse, third-party accounting | P0 — Required |
| Core Workflow Engine | RO creation, status tracking, card movement between stages | P0 — Required |
| Role-Based Access | Admin, Manager, Technician, Receptionist roles with scoped permissions | P0 — Required |
| Multi-Tenant Architecture | Per-tenant data isolation, no cross-tenant learning or data exposure | P0 — Required |
| Basic Reporting | Per-shop and multi-shop (if MSO) reporting on RO status, cycle time | P1 — Launch week |
| Mobile-Responsive UI | Access from desktop, tablet, and mobile browsers | P1 — Launch week |

**Deferred to post-launch:**
- Voice-enabled bay interaction (Brad/Jim)
- AI agent SOP enforcement
- Advanced analytics and benchmarking
- Third-party integrations beyond CIECA and accounting

### 3.2 Sovereign AI Architecture

All AI processing occurs within BC's infrastructure. No customer data leaves the platform.

| Component | Specification |
|-----------|--------------|
| LLM Engine | NVIDIA Nemotron (locally hosted) or equivalent sovereign model |
| Data Isolation | Per-tenant Postgres schema or dedicated database |
| API Boundary | Tenant-scoped API keys; AI brain scoped to active tenant only |
| Cross-Tenant Policy | Zero cross-tenant learning. Skills, SOPs, and training data are tenant-specific |
| Encryption | AES-256 at rest, TLS 1.3 in transit |

### 3.3 Multi-Level Tenant Architecture

```
Network (e.g., AutoCanada, CSN, Simplicity, Car Star)
  └── MSO / Franchise Group
       └── Individual Shop
            └── Employees (role-based)
```

| Level | Visibility | Examples |
|-------|-----------|----------|
| Network Admin | All shops in network, aggregate reporting | AutoCanada corporate |
| MSO Admin | All shops in their MSO group | Regional manager |
| Shop Admin | Their shop only | Shop owner/manager |
| Technician | Their bay, their assigned ROs | Bay technician |
| Receptionist | Front-end workflow, customer intake | Front desk |

Networks cannot see other networks. Franchisees within a network can be sub-tenanted for additional isolation if required.

### 3.4 SOP Framework & Training

**Input Sources:**
- Existing BC completed RO data (10+ years, verified successful outcomes)
- Industry expert content (Mike Anderson, Kristen Felder, Dave Luehr, etc.)
- Network-specific SOPs (AutoCanada corporate training materials)
- Demo recordings and best-practice videos
- WIP ratio benchmarks and industry KPIs

**Training Process:**
1. Codify baseline SOPs from industry best practices + existing data
2. Create system skills/prompts from SOPs
3. Run 30+ historical ROs through the system under observation
4. Correct deviations, reinforce correct behavior
5. Scale to 1,000+ RO simulations
6. Deploy with human-in-the-loop verification for first 90 days per tenant

### 3.5 Bug/Error Handling

| Event | Action |
|-------|--------|
| User encounters error | "Report Error" button sends telemetry to system |
| System auto-diagnosis | AI agent logs, identifies root cause, attempts self-heal |
| Unresolved | Escalation to DCS + BC dev team simultaneously |
| Fix deployed | Playbook created for AI so identical issue auto-heals in future |
| Transparency | Both DCS and BC teams have full visibility on all incidents |

---

## 4. Phased Delivery & Timeline

### Phase 0: Foundation (Weeks 1–6)
- Infrastructure setup (AWS/Kubernetes alongside existing migration)
- Database architecture with tenant isolation
- Authentication and role-based access framework
- CIECA import pipeline (initial integration)
- **Milestone:** Sandbox environment live, first data import demonstrated
- **Investment:** $15,000 – $35,000 CAD

### Phase 1: BCAI Core Build (Months 2–5)
- Core workflow engine (RO lifecycle)
- CIECA/estimating system imports (CCC, Mitchell, Audatex)
- Accounting exports (QuickBooks, Sage, AutoHouse)
- Role-based access and multi-tenant architecture
- Basic reporting dashboard
- Mobile-responsive UI
- **Milestone:** BCAI Core functional, ready for internal testing
- **Investment:** $70,000 – $165,000 CAD
- *Reduced by existing BC code that can be migrated directly*

### Phase 2: Market Launch (Months 4–7)
- QA and security audit
- Independent shop onboarding (first 5–10 customers)
- Feedback loop and rapid iteration
- Additional third-party integrations as needed
- **Milestone:** BCAI Core live with paying independent shop customers
- **Investment:** $40,000 – $110,000 CAD

### Phase 3: Network Pilot (Months 6–10)
- AutoCanada pilot deployment (3 shops recommended)
- Network-level SOP integration
- Corporate trainer feedback loop
- Multi-level reporting (shop → MSO → network)
- AI agent SOP enforcement (initial)
- **Milestone:** AutoCanada pilot live, SOP-driven agent assistance operational
- **Investment:** $50,000 – $100,000 CAD

### Phase 4: Customer Migration & Brad (Months 8–18+)
- Existing BC customer migration tooling
- Data migration with zero shop downtime
- Voice-enabled bay interaction (Brad/Jim)
- Full sovereign AI with NVIDIA Nemotron
- Advanced analytics and benchmarking
- **Milestone:** First existing BC customer fully migrated; voice available
- **Investment:** Scoped per phase based on current technology costs

### Timeline Summary

| Phase | Duration | Cumulative | Key Output |
|-------|----------|-----------|------------|
| Phase 0 | 6 weeks | 6 weeks | Sandbox live |
| Phase 1 | 3–4 months | ~5 months | BCAI Core functional |
| Phase 2 | 2–3 months | ~7 months | First paying customers |
| Phase 3 | 3–4 months | ~10 months | AutoCanada pilot |
| Phase 4 | 6–12 months | ~18 months | Full platform + voice |

**Note:** Timelines compress as existing BC code is evaluated and reused. The AWS/Kubernetes migration currently underway by BC's dev team runs in parallel and reduces Phase 0/1 effort.

---

## 5. Pricing Model

### Milestone-Based
- Payment due at milestone completion, not calendar dates
- Each phase begins only after Kevin and Sharon/Jim review and approve the prior phase
- No payment for work not delivered
- Prices reduce as existing BC code is reused (not rebuilt)
- Technology cost reductions are passed through (AI infrastructure costs are dropping monthly)

### Phase 0 Deposit
- **$15,000 CAD** to initiate Phase 0
- Covers infrastructure setup, CIECA pipeline prototype, sandbox deployment

### Ongoing
- Each subsequent phase is scoped and priced at the transition call
- No surprises — actual cost determined by what needs to be built vs. what already exists

---

## 6. What's NOT In Scope (Yet)

- Full Brad/Jim voice-in-every-bay system (Phase 4+)
- Mobile native app (Phase 3+ — mobile web covers launch)
- Integration with every existing BC third-party partner (phased by customer demand)
- Marketing materials or sales collateral for BCAI
- BC's existing platform maintenance or bug fixes

---

## 7. Assumptions & Dependencies

1. BC's AWS/Kubernetes migration continues in parallel
2. BC provides access to existing codebase for assessment and migration
3. BC provides (or facilitates) SOP content from networks/industry experts
4. AutoCanada agrees to pilot participation (Sharon to coordinate)
5. DCS prototype (IR Custom AIOS) serves as architectural proof of concept
6. Weekly or bi-weekly check-ins during active development phases

---

## 8. Intellectual Property

- BCAI platform and all customizations are owned by Micazen Inc.
- DCS retains rights to underlying framework/tooling used across other clients
- Sovereign AI models trained on BC data are BC's property
- No BC customer data is used outside of BC's platform, ever

---

## 9. Next Steps

1. ☐ Review this SOW
2. ☐ Approve Phase 0 scope and investment
3. ☐ DCS begins Phase 0 (6-week sprint)
4. ☐ Phase 0 milestone call — review sandbox, plan Phase 1
5. ☐ Sharon/Jim provide initial SOP content (demo recordings, workflow docs, industry expert videos)

---

**D. Caine Solutions LLC**
Kevin Starr, Founder
d.caine@dcaine.com

**Micazen Inc.**
Sharon Ashley, _______________
Jim Wraight, _______________
