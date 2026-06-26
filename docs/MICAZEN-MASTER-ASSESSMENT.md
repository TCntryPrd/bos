# Micazen / BodyShopConnect AI -- Master Assessment

**Classification:** Internal -- Kevin Starr / D. Caine Solutions Eyes Only
**Created:** 2026-04-05
**Last Updated:** 2026-04-05
**Purpose:** Single source of truth for the Micazen/BCAI deal. Every decision, commitment, risk, and number in one place.

---

## 1. Deal Overview

**Client:** Micazen Consulting & Technologies Inc. / BodyShopConnect (BC)
**Client Contact:** Sharon Ashley (sole owner/president) -- sashley@micazen.com, 236-702-4410
**Right Hand:** Jim Wraight -- jim@bodyshopconnect.com (Eastern time zone)
**DCS Contact:** Kevin Starr / D. Caine Solutions LLC -- d.caine@dcaine.com
**Engagement Start:** February 23, 2026 (first discovery call)
**NDA Status:** Requested Mar 18, signed status unclear -- VERIFY
**Assessment SOW:** $250 for deep dive app assessment (agreed Mar 18)

### What They Want Built

A full ground-up rebuild of their collision repair shop management system (BodyShopConnect) as an AI-native platform with sovereign AI, voice interaction capability, multi-tenant isolation, and modular tiered product structure. The existing system (PHP/Yii2, Vue 2, MySQL) cannot be extended -- rebuild is the only path.

### Total Deal Value Across All Phases

| Scope | Range (CAD) | Timeline |
|-------|-------------|----------|
| Phases 0-3 (to network pilot) | $135,000 - $240,000 | 8-12 months |
| V3 Sovereign AI Platform (full) | $230,000 - $355,000 (platform only) | 22 months |
| V4 Brad (full vision, voice in every bay) | ~$850,000 | 30 months |

### Current Status (as of April 6, 2026)

Sharon and Jim are frustrated. They have received presentations, roadmaps, and value propositions but not what they actually need: concrete spec sheets listing exactly what features ship in each phase. Kevin committed on the April 6 call to email spec sheets "within days." Those spec sheets (5 phases, 158KB) plus 4 governance documents (276KB) have been delivered. Awaiting Sharon's red-line response.

### Next Steps

1. Sharon and Jim review spec sheets and red-line them
2. Back-and-forth via email until specs are agreed
3. Sign off on Phase 0/1 scope and pricing
4. Begin build

---

## 2. Client Profile

### Sharon Ashley -- Founder/Owner/President

- **Background:** 40 years in collision repair industry, started 1984
- Computer programming education (early career)
- Fixed cars, estimated, owned her own shop, sold it
- Made significant money coding during Y2K (1999)
- Transitioned to software training, trained shops across North America
- Built BodyShopConnect after frustration with existing vendors ("took a couple million dollars out of the bank and went, I'm building my own")
- Trained in Lean/Six Sigma
- This is her **fourth management system build** -- she knows exactly what she is getting into
- Speaks at industry conferences regularly (WIN Conference, others)
- **Decision authority:** Total. No shareholders, no board. She writes the check.
- **Communication style:** Direct, impatient with fluff, wants specifics, finishes people's sentences, talks fast, thinks fast. Does not suffer fools. Will call bullshit immediately.
- Mitchell (billion-dollar competitor) has tried to buy her "a dozen times" -- she refused every time

**Key quote:** "We don't need the fluff and the pillows. We just need to know, here's the rock solid goods."

### Jim Wraight -- Right Hand

- Known Sharon 25-30 years
- Former software/IT guy for an estimating system
- Eastern time zone
- Started building AI voice agents (Maya and Molly -- named after his dogs)
- Technical enough to understand architecture, practical enough to think about market
- Good on stage with Sharon -- they finish each other's sentences
- Will be hands-on during build (industry knowledge validation)

### Dev Team

- Led by "Yuri" (will be skeptical of external builder getting GitHub access)
- Global team: Poland, Georgia, Italy, Brazil, Mexico, Haiti, US, Canada
- All paid in US dollars
- All remote since COVID
- 4 QA testers
- Tech support team (using Zoho Desk)
- Currently completing AWS/K8s migration, building LMS (6 weeks)
- When asked about AI: "They said they need two to three weeks per developer, two to three developers, to assess and start learning the new technology" = 6-7 weeks just to START learning
- Sharon's response: "I might as well just pack my bags and go play marbles in the corner"
- **Sharon explicitly sidelined the existing dev team for BCAI:** "I would not have my programming team involved. It would be like Jim and I with our industry knowledge."

### Business Model

- SaaS model -- monthly licensing per shop
- Currently single-tier pricing, pivoting to tiered (BC Light, BC Medium, BC Full + BCAI add-on) effective May 1 (year end is April 30)
- Growing 5-10 shops per month organically through customer referrals alone -- zero advertising, zero outbound sales
- Revenue: not disclosed explicitly, but self-funded with "a couple million" invested, all programmers paid in USD
- Sharon and Jim handle all sales presentations personally

### Customer Base

| Customer | Type | Shops | Notes |
|----------|------|-------|-------|
| AutoCanada | Publicly traded, corporate-owned | ~80 collision | Best pilot candidate -- corporate trainers, SOPs, rigorous |
| CSN Collision | Franchise network | ~500 | Independently owned, inconsistent SOPs |
| Simplicity | Corporate-owned | Unknown | No formal SOPs ("the boys don't have anything") |
| Car Stars | Network | Unknown | Had "Car Stars Operating System" at one point |
| Independent shops | Direct | Growing 5-10/mo | Target for initial BCAI launch |

International presence: Canada, US, Europe.

---

## 3. What Exists Today

### The Current BodyShopConnect System

- **Age:** 10+ years (launched 2016)
- **Stack:** PHP/Yii2 framework, MySQL (one database per tenant), Elasticsearch 6.8 (EOL), Vue 2 (EOL)
- **Hosting:** AWS, Kubernetes migration 99% complete as of April 6
- **Scale:** 200+ business rules, 35-40 third-party integrations, 500+ items in backlog
- **Releases:** Minimum one per month with new features
- **Source Control:** GitHub
- **Features:** Full management system -- estimates, open ROs, assignments, parts management, job costing, accounting, scheduling, internal/external communications, display boards, reports, admin/customization, RBAC (4-tier: single store, MSO, regional, network)
- **Languages:** English, French, Spanish (plus Romanian, Italian, Hindi in background)
- **GUID-based tenant isolation** throughout databases

### Current AI Tools

| Tool | What It Does | Status |
|------|-------------|--------|
| ChatGPT Team | General use | Active |
| Betty | Chatbot -- article search from help pages ("a tadpole" per Jim) | Active, basic |
| Maya & Molly | AI phone answering agents (named after dogs) | Active |

### What Works Well

- CIECA/estimating imports (battle-tested, 10+ years)
- RBAC (5 permission levels, working)
- RO workflow engine (functional, monolithic)
- Estimating system connectors (CCC, Mitchell, Audatex -- working)
- Accounting exports (QuickBooks, Sage, Xero -- working)
- Organic growth engine (5-10 shops/month with zero marketing)
- Customer loyalty (shops that were guinea pigs in 2016 are still there)

### What Is Broken/Aging

- Vue 2: End of life, cannot support modern AI UI
- Elasticsearch 6.8: End of life
- PHP/Yii2: Monolithic, cannot be extended for AI integration
- Multi-tenant architecture: Bolted on, not designed in (dev team acknowledged this)
- No voice/AI interaction capability
- Help system is article-based only (Betty is search, not intelligence)
- No SOP framework (most shops have zero written SOPs)

---

## 4. What They Want Built

### Non-Negotiable Requirements (repeated across multiple calls)

**1. CIECA/Estimating System Imports**
> "If I don't have the CIECA, if I don't have the estimating systems importing... we got nothing." -- Sharon

**2. Accounting Exports**
> "We need to have the accounting exports at minimum to be able to go to market." -- Sharon
- Sage 50, Sage Cloud, Xero, QuickBooks Desktop, QuickBooks Online

**3. Click-to-Talk AI (THE sales differentiator)**
> "If it doesn't have, if I can't like talk to it and say, hey, go do this and go do that, then I don't have that edge for sales. We just have a basic product." -- Sharon (Apr 6)
> "The excitement would not be able to be built without me being able to say, hey, BC, go do this." -- Sharon (Apr 6)
- Click-to-talk is acceptable for Phase 1 (no wake word needed yet)
> "I don't think it's life and death off of an early version release" -- Sharon, re: wake word vs button click

**4. Tenant Isolation / Data Privacy**
> "If I have a breach and one shop sees another shop's data... we're done." -- Sharon
> "By the agreements that we've signed with networks... the information has to be siloed." -- Sharon
- No cross-tenant learning. No cross-tenant data exposure. Period.
- PIPEDA compliance must be structural, not contractual.
- Data must stay in Canada (especially for AutoCanada -- publicly traded).

**5. RBAC (carry over from existing)**
> "It's all role based security, end user management." -- Sharon
- Four tiers: Single store, MSO, Regional, Network
- AI must respect role permissions: "If that employee asking the question doesn't have user access right to employees..." -- Sharon

**6. Multi-Language**
> "Our system is always in two languages by default." -- Sharon
- English + French by law in Canada
- Spanish for US expansion
- Romanian, Italian, Hindi in background

**7. Third-Party Integrations (35+)**
> "We have like 35 third party integrations." -- Sharon
- Google Drive, Dropbox, OneDrive (media storage)
- Paint scale vendors (third-party API, write-back)
- AutoHouse, ClaimsCorp, CSI platforms, Serbia DMS
- Trigger-based data pushes on delivery dates
> "Even on core, we would need those third party interfaces." -- Sharon

**8. Speed to Market**
> "It's not so much how much does it cost... how long to deploy?" -- Sharon (Feb 23)
> "We don't even have one customer until 15 to 22 months" -- Sharon (said with alarm)

### Explicitly Requested Features

- Find RO / Search ("BC, find Smith")
- Add notes to file ("BC, add notes to the file for Smith")
- Update department/status ("BC, change the department")
- Send email/text to customer
- Order parts (eventually)
- Receive parts/payments (eventually)
- Reporting via AI ("which technician was the most efficient last month?")
- Dynamic dashboard/widget creation
- Help system / guided walkthroughs ("walking you through step by step")
- Assignments, estimates, open/closed/void ROs
- Job costing, parts management, tech stations, payments, scheduling
- Display boards for TVs
- Print functionality (credit returns, invoices)
- Desktop app + mobile responsive web
- Offline capability with sync
- Self-healing (recommendation only, NOT autonomous)
- Playbook system for tech support

### Tiered Product Structure

| Tier | Features |
|------|----------|
| BC Light | Basic ROs, no job costing, no scheduling |
| BC Medium | Add job costing |
| BC Full | Everything including display boards |
| BCAI | Optional AI add-on for any tier |

### Go-to-Market Strategy (Sharon's explicit plan)

1. Launch BCAI Core with independent shops first
2. Generate revenue and learn from real usage
3. Pilot with AutoCanada (corporate trainers, SOPs, rigorous testing)
4. Migrate existing BC customers to new platform over time
5. Decommission legacy system

> "We have to go to market with non-BodyshopConnect customers first, to be able to prove the model." -- Sharon
> "If I piss off one little guy... [vs] if I take an existing customer who's been with me for 10 years and go, hey, I got this new platform, and they have issue after issue... they're gone." -- Sharon

### What They Explicitly Do NOT Want

1. No more slide decks or value pitches -- "We don't care about all that"
2. No bolt-on AI to existing system -- rebuild required
3. No cross-tenant learning or data leakage
4. No big-bang deployment -- live system stays live
5. No lump-sum payment upfront -- milestone-based
6. No waiting 15-22 months for first sellable product
7. No vague deliverables -- "We're on a here, write a check and a wing and a hope"
8. No involving existing dev team in rebuild
9. No new tools for support team (rejected Airtable -- "yet another program")
10. No autonomous system changes without human approval -- "That's dangerous" -- Sharon

---

## 5. Evolution of the Deal

### February 23, 2026 -- Discovery Call

**Scope:** Simple AI agent bolt-on to existing system
**Features:** 5 core functions (Find RO, Add Note, Update Status, Show Summary, Send Message)
**Budget discussed:** $10K-$15K low end for pilot
**Timeline:** 4 weeks to prototype, 2-3 months to full rollout
**AI approach:** Small LLM or SLM on their server alongside n8n
**Mood:** Enthusiastic. Sharon was excited, ready to move fast.
**Key moment:** Sharon showed the system live, walked through features. "Sold. Just tell us what you need."

### March 18, 2026 -- Second Call (Jim's first appearance)

**Major shift:** From bolt-on to full rebuild discussion
**Key quote:** "Do we take what we have today and layer agents, or do we take the bazillion lines of code... and have it build me a new system?"
**NDA requirement raised.** Assessment SOW introduced ($250).
**Timeline discussed:** "Three to four, maybe six weeks to truly build it out into alpha"
**Dev team sidelined:** "I would not have my programming team involved"
**35+ integrations identified as major scope item**
**Mood:** Excited but starting to calculate. Jim asking good technical questions.

### March 31, 2026 -- Roadmap Presentation

**Assessment completed.** Kevin reviewed the codebase.
**Four options presented:** V1 (bolt-on, rejected), V2 (cloud AI), V3 (sovereign AI), V4 (Brad -- voice in every bay)
**V4 timeline:** 30 months, $850K CAD -- Sharon's reaction: "Defibrillator"
**V3 positioned as practical:** 22 months, $230K-$355K platform
**Phase 1 pricing reduced:** Originally $85K-$165K, now $40K-$65K
**Go-to-market crystallized:** Independent shops first, then AutoCanada pilot
**SOP gap identified:** Most shops have zero written SOPs
**Mood:** Growing impatient. Wants concrete deliverables, not architecture slides.

### April 6, 2026 -- The Critical Call (Frustration Peak)

**Sharon and Jim frustrated.** Three meetings in and still no concrete feature list.

> "You're spending a lot of time about the $3 million Car Starr can make. We don't care about all that. None of that stuff, all of that stuff is irrelevant." -- Sharon

> "What I need is, what are we going to get? Exactly? What are we going to get? What does it look like? What does it feel like? What features is it going to have?" -- Sharon

> "We're on a here, write a check and a wing and a hope, right? And we can't move forward with that kind of hope and prayer." -- Sharon

> "If we keep going back and forth and we don't know what we have to sell, you know, it's going to be, we're going to be talking in three months, and we won't even have got started." -- Sharon

**Kevin committed:** Spec sheets emailed within days, spec sheet style not presentation slide deck, red-line process via email, no more meetings until specs are done.

**Key demand from Jim:** "Almost similar to how you had the core, that box up with the core, and then you had a list of the options there, similar to that, but with the functionality that we're actually looking for."

**Mood:** Last chance. If the spec sheets do not land, this deal is dead.

### Summary of Evolution

| Aspect | Feb 23 | Mar 18 | Mar 31 | Apr 6 |
|--------|--------|--------|--------|-------|
| Scope | AI bolt-on | Full rebuild considered | Full rebuild confirmed | Full rebuild, compressed |
| Budget | $10-15K pilot | "Bazillion dollars" | $40-65K Phase 1 | "Don't care about numbers, care about features" |
| Timeline | 4 weeks prototype | 3-6 weeks alpha | 6-8 weeks Phase 1 core | "How fast can we sell?" |
| AI approach | SLM on server | Open to options | Sovereign AI (Nemotron) | Sovereign preferred, privacy required |
| Mood | Enthusiastic | Excited | Growing impatient | "Stop the dog and pony show" |
| Key demand | "Can you build it?" | "What would rebuild look like?" | "Show us the plan" | "Give us spec sheets NOW" |

---

## 6. Pricing History and Current Position

### Every Price Point Discussed

| Date | Context | Amount | Currency |
|------|---------|--------|----------|
| Feb 23 | Pilot/prototype (low end) | $10,000 - $15,000 | USD |
| Mar 18 | Assessment SOW | $250 | USD |
| Mar 18 | Sharon's half-joke | "Can you do it for $100K?" | CAD |
| Mar 31 | Phase 1 (original) | $85,000 - $165,000 | CAD |
| Mar 31 | Phase 1 (revised down) | $40,000 - $65,000 | CAD |
| Mar 31 | V3 total platform (22 mo) | $230,000 - $355,000 | CAD |
| Mar 31 | V3 + infrastructure (2yr) | $350,000 - $565,000 | CAD |
| Mar 31 | V4 Brad (30 mo) | ~$850,000 | CAD |
| Strategic Brief | Phases 0-3 (best case) | $135,000 | CAD |
| Strategic Brief | Phases 0-3 (expected) | $195,000 | CAD |
| Strategic Brief | Phases 0-3 (conservative) | $240,000 | CAD |

### Canadian Dollar Impact

> "We got to add like 45% because we're Canadian. So instead of 100 grand, it's 150 grand." -- Sharon

All of Kevin's pricing is in USD. Sharon is budgeting in CAD. This creates persistent sticker shock. The spec sheets must be crystal clear about which currency is being used.

### Billing Structure Agreed

- Milestone-based, not calendar-based
- No lump-sum upfront
- Phase 0 deposit: $15,000 CAD (agreed as non-refundable)
- Each phase is a go/no-go gate
- Sharon floated continuous monthly billing for ongoing development (Apr 6) -- needs to be addressed

### Current Phase Pricing (from Strategic Brief)

| Phase | Duration | Investment (CAD) |
|-------|----------|-----------------|
| Phase 0: Foundation + Code Audit | Weeks 1-6 | $15,000 |
| Phase 1: BCAI Core | Weeks 7-16 | $45,000 - $85,000 |
| Phase 2: Market Launch + AI | Weeks 14-24 | $35,000 - $65,000 |
| Phase 3: Network Pilot (AutoCanada) | Months 6-10 | $40,000 - $75,000 |
| Phase 4: Migration + Ted/Voice | Months 10-18+ | TBD at Phase 3 gate |

---

## 7. What We Have Delivered So Far

| Deliverable | Size/Detail | Status |
|-------------|-------------|--------|
| Discovery call (Feb 23) | 1 hour | COMPLETE |
| Second call with Jim (Mar 18) | 1 hour | COMPLETE |
| NDA | Requested by Sharon | STATUS UNCLEAR -- VERIFY |
| Assessment SOW ($250) | Deep dive app assessment | COMPLETE |
| V3 Sovereign AI Assessment | Full key findings report | DELIVERED |
| V4 Brad Assessment | Full vision document | DELIVERED |
| Roadmap presentation (Mar 31) | 4 options presented | DELIVERED |
| Strategic Brief | Internal pre-SOW analysis | INTERNAL ONLY |
| Follow-up email (Mar 31) | Recap + Monday plan | SENT |
| April 6 call | Feature spec discussion | COMPLETE |
| Post-call email (Apr 6) | "BCAI Core Phase 1-2 Plan and Spec Sheet Deliverables" | SENT |
| 5 Phase Spec Sheets | 158KB, detailed feature-level | DELIVERED (emailed) |
| 4 Governance Documents | AI Governance, Security/Pen Test, Data Management, AI Ethics -- 276KB | DELIVERED |
| SOW V3 | Statement of work for sovereign path | DELIVERED |
| SOW V4 | Statement of work for Brad path | DELIVERED |

**Awaiting:** Sharon and Jim's red-line response on spec sheets.

---

## 8. Competitive Landscape

### Direct Competitors (Estimating Systems -- also potential integration partners)

| Competitor | Revenue | AI Status | Threat to BC |
|-----------|---------|-----------|--------------|
| CCC Intelligent Solutions | Billion+ | Photo-based damage assessment AI | Low -- different layer (estimating, not shop management) |
| Mitchell (Enlyte) | Billion+ | Claims automation AI | Low -- insurance side, not shop side. Tried to buy BC "a dozen times" |
| Audatex (Solera) | Billion+ | Estimating AI | Low -- same as CCC |
| Tractable | Funded startup | Photo-to-estimate AI | Low -- completely different product (Sharon considered reaching out) |

### Modern Platforms (no AI yet)

| Competitor | Threat | Notes |
|-----------|--------|-------|
| Shop-Ware | Medium | Modern stack, could add AI faster than legacy players |
| Tekmetric | Medium | Modern stack, same risk as Shop-Ware |

### BC's Competitive Moats

1. **Regulatory moat:** Sovereign AI -- data never leaves Canadian infrastructure. Competitors using cloud APIs fail Canadian privacy requirements and network data agreements.
2. **Data moat:** 10+ years of repair order data across hundreds of shops. No competitor can replicate this training corpus.
3. **Distribution moat:** Existing relationships with AutoCanada, CSN, Simplicity, Car Stars. These take years to build.
4. **Time moat:** First mover in AI shop management. Nobody else is even planning this yet.

### The Real Competitive Risk

Shop-Ware or Tekmetric bolting on ChatGPT or similar would be cloud-based (fails Canadian privacy) and non-sovereign (fails network data agreements). But they could capture US independent shops that do not have the same privacy constraints. BC's moat is strongest in Canada; weaker in the US market.

---

## 9. Risk Assessment

### CRITICAL -- Deal at Risk

**1. Sharon's patience is exhausted.**
After four calls and multiple presentations, Sharon still did not have what she needed: concrete feature lists per phase. The April 6 call was the frustration peak. The spec sheets that were delivered are the make-or-break deliverable. If Sharon red-lines them and finds them vague, generic, or not reflecting her system's actual complexity, this deal is over.

> "If we keep going back and forth and we don't know what we have to sell... we're going to be talking in three months, and we won't even have got started." -- Sharon

**Risk level: CRITICAL.** Everything hinges on the spec sheet response.

### HIGH

**2. Scope mismatch -- 200+ business rules vs 6-8 week Phase 1.**
Sharon has built four management systems. She knows what "the weeds" look like. She explicitly warned:
> "You show up in six weeks, and we go, this only has a tenth of what we need."
> "I truly believe we're going to be in the weeds off the gate, and I'm going to drop a bunch of money, and in six weeks, I'm going to go, oh shit, here's the 100 things that we missed."

Phase 1 as described (CIECA, accounting, core RO workflow) is infrastructure. It is not a sellable product. Sharon knows this. If Phase 1 does not include enough AI interaction to demo to potential customers, she will consider it a failed investment.

**3. Kevin's bandwidth -- IR Custom AIOS + BCAI + other clients.**
Kevin is simultaneously building IR Custom AIOS. They share architectural DNA but are separate products for separate markets. Sharon directly asked about this:
> "If you're the only person that we can reach out to..."
> "You have other things on the go as well, and God forbid you wanted a day off."

Kevin claimed "6 humans + 5 AI agents" as extended team. This is vague. Sharon will test this claim if things break.

**4. SOP gap -- chicken-and-egg problem.**
> Jim: "Zero. Maybe one group might have a few rough [SOPs]."

The AI needs SOPs to be effective. Most shops do not have written SOPs. This creates a bootstrapping problem for AI-assisted workflows. AutoCanada is the exception (corporate trainers, SOPs) -- which is why they are actually the best pilot candidate despite being positioned as Phase 3.

**5. Existing dev team friction.**
Yuri (dev team lead) will be suspicious of GitHub access being granted to an external party. Sharon sidelined the existing team, but they are still maintaining the live system. Passive resistance, information withholding, or territorial behavior is likely.

### MEDIUM

**6. Canadian dollar exchange rate.**
All pricing presented has been ambiguous about USD vs CAD. Sharon's team budgets in CAD. A $65K USD Phase 1 is $94K+ CAD. This must be explicitly addressed in every pricing document.

**7. Support model -- single point of failure.**
Sharon raised this directly. The playbook system, Zoho Desk integration, and escalation path are defined in specs but not yet proven. Sharon rejected Airtable ("yet another program") -- support must flow through Zoho Desk with automation to Kevin's systems.

**8. Ongoing billing model undefined.**
> "This isn't a one and done... how does that all work? Do we just keep adding in and you just charge so much per month?" -- Sharon

Phase-based pricing covers initial build. The ongoing development/maintenance model (monthly retainer? per-feature pricing? T&M?) is not defined and must be before Phase 1 ends.

**9. Conference demo pressure.**
Sharon speaks at WIN Conference (Women's Industry Network, ~500 attendees) and other summer conferences about AI. She wants to demo something. If no working demo exists by conference season, it is a reputational risk for her -- and she will blame the vendor.

**10. Phase 1 is not sellable.**
Kevin explicitly stated Phase 1 (6-8 weeks) is "truly getting the system rebuilt and ready for the deeper AI connections." Jim confirmed: "the base product would more or less kind of be for more internal testing." Sharon's response: "So you've got like six months, five to six months before I have a saleable product." This is a problem. She is paying $40-65K for something she cannot sell.

### LOW BUT CONSEQUENTIAL

**11. Self-healing scope creep.**
Kevin proposed self-learning/self-healing. Sharon said "That's dangerous." Acceptable: recommend changes, surface patterns. Not acceptable: autonomous changes. Any spec that implies autonomous behavior will trigger pushback.

---

## 10. Kevin's Commitments (Tracking)

| Commitment | Source | Status | Notes |
|-----------|--------|--------|-------|
| Spec sheets emailed within days | Apr 6 call | DELIVERED | 5 phases, 158KB. Awaiting red-line. |
| Red-line process via email | Apr 6 call | PENDING | Waiting for Sharon's response |
| Phase-based milestone pricing | Multiple calls | IN SPECS | Must be crystal clear on currency |
| Zoho Desk integration for ticketing | Apr 6 call | IN SPECS (Phase 1 add-on) | Sharon rejected Airtable |
| 12-hour response time on issues | Apr 6 call | IN SPECS | "Within 12 hours I can be right there in the system" |
| Playbook for every issue as they arise | Apr 6 call | COMMITTED | Must be operationalized |
| Extended team (6 humans + 5 AI agents) | Apr 6 call | CLAIMED | Vague -- need to substantiate if challenged |
| Proof of concept via IR Custom AIOS | Apr 6 call | DEMONSTRATED | Showed IR Custom AIOS dashboard live |
| NDA signing | Mar 18 call | UNCLEAR | Sharon sent NDA? Kevin signed? VERIFY. |
| Assessment ($250) | Mar 18 call | COMPLETE | |
| No more presentation meetings until specs done | Apr 6 call | ACTIVE | "We don't need to do meeting, meeting, meeting" |
| Multi-language UI (EN/FR minimum) | Multiple calls | IN SPECS | Legal requirement for Canadian market |
| Existing code reuse to reduce cost | Apr 6 call | COMMITTED | "I'll reuse proven, working code snippets and refit them" |
| Desktop app | Mar 18 call | IN SPECS (later phase) | Phase 1 is URL-only |
| Offline capability | Mar 18 call | IN SPECS (later phase) | |

---

## 11. Strategic Recommendation

### Is This Deal Worth Pursuing?

**Yes.** But only if you can execute. The reasons:

1. **No competition.** Nobody in collision repair is building sovereign AI shop management. The moat is real.
2. **Recurring revenue.** This is not a one-time build. It is a long-term platform relationship with monthly revenue potential.
3. **Portfolio value.** BCAI validates the sovereign AI architecture that IR Custom AIOS is also built on. Success here is proof of concept for future clients.
4. **Client quality.** Sharon is self-funded, decisive, domain-expert, and has distribution (AutoCanada, CSN). She is the ideal client if she trusts the builder.
5. **Market timing.** The collision repair industry is ripe for AI disruption. First mover captures the market for years.

### What Is the Realistic Timeline?

| Milestone | Realistic Date | Confidence |
|-----------|---------------|------------|
| Spec sheets agreed (red-lined) | April 15-20, 2026 | Medium |
| Phase 0 kickoff | Late April 2026 | Medium (depends on spec agreement) |
| Phase 1 complete (internal testing) | June-July 2026 | Medium-Low (scope risk) |
| First sellable product (Phase 2) | September-October 2026 | Low (depends on Phase 1) |
| Conference demo capability | Summer 2026 | Medium (click-to-talk MVP possible) |
| AutoCanada pilot | Q1 2027 | Low (many dependencies) |

### What Is the Realistic Total Revenue?

| Timeframe | Revenue (USD) | Confidence |
|-----------|---------------|------------|
| Phase 0-1 (next 4 months) | $40,000 - $55,000 | High if specs close |
| Phase 0-3 (next 12 months) | $90,000 - $165,000 | Medium |
| Full V3 platform (22 months) | $155,000 - $240,000 | Low |
| Ongoing monthly retainer | $5,000 - $15,000/mo | TBD -- not yet negotiated |

### What Are the Dealbreakers?

1. **Spec sheets rejected.** If Sharon red-lines the specs back with "this is still vague" or "you don't understand our system," the engagement is over.
2. **Phase 1 delivers no AI.** If the 6-8 week Phase 1 is pure infrastructure with zero AI interaction, Sharon will not pay for Phase 2.
3. **Response time failure.** If something breaks in production and Kevin cannot respond within 12 hours, trust collapses immediately.
4. **Currency confusion.** If pricing documents are ambiguous about USD vs CAD and Sharon discovers a 45% markup she did not expect, trust collapses.
5. **Bandwidth failure.** If IR Custom AIOS work causes BCAI delays, Sharon will know and will not accept it.

### What Must Happen in the Next 7 Days

1. **Wait for Sharon's red-line response.** Do not send follow-up emails pushing. She will respond when she is ready. Pushing will annoy her.
2. **Prepare for red-line revisions.** When the response comes, turn around revisions within 24-48 hours. Fast turnaround on this builds trust.
3. **Clarify currency in all documents.** Every price must say USD or CAD explicitly. Recommendation: present everything in CAD since that is how Sharon budgets.
4. **Define the ongoing billing model.** Sharon asked directly. The spec sheets should include or be supplemented with a clear answer: monthly retainer for ongoing development + per-feature pricing for major additions.
5. **Ensure Phase 1 includes click-to-talk AI.** Even basic. Even if it only does 3-5 things. Sharon was explicit: without "hey BC, go do this" capability, there is no sales edge and no excitement to build.
6. **Verify NDA status.** Was it signed? If not, get it done before any code work begins.
7. **Do not schedule another meeting.** Sharon said no more meetings until specs are done. Respect that.

### Bottom Line

This is a real deal with a real client who has real distribution and real money. The total addressable opportunity is $150K-$250K over 12-18 months with ongoing monthly revenue after that. But Sharon is a veteran builder who has done this four times before. She will not tolerate vagueness, missed deadlines, or presentations that should have been spreadsheets. The spec sheets are the test. If they pass, this becomes the anchor client for DCS's AI platform practice. If they fail, Sharon moves on and finds someone else -- or tells Yuri's team to figure it out, which they will, eventually.

The deal is alive but the margin for error is zero.

---

*Document maintained by Kevin Starr / D. Caine Solutions LLC. Not for distribution.*
