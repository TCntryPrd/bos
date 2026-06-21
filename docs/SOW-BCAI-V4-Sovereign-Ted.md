# Statement of Work
# BCAI v4 -- Sovereign AI + Ted: The Bay Operating System

---

**Prepared by:** D. Caine Solutions LLC
8104 E 35th St, Tulsa, OK 74145
inquiry@starrpartners.ai

**Prepared for:** Sharon Ashley & Jim Wraight
Micazen Consulting & Technologies
British Columbia, Canada

**Date:** April 2, 2026
**Version:** 4.0
**Project Code:** MIC-2026-V4
**Classification:** Confidential

---

## Table of Contents

1. The Market Opportunity: What Wins
2. What Ted Is
3. How v4 Builds on v3 (Not a Separate Product)
4. The Revenue Math at Scale
5. What Ted Looks Like in a Shop
6. The SOP Advantage
7. What Ships and When
8. Competitive Moat: Why Nobody Catches Up
9. Investment by Phase
10. Hardware and Infrastructure
11. Risk and Mitigation
12. IP and Ownership
13. Next Steps
14. Signatures

---

## 1. The Market Opportunity: What Wins

v3 is the platform that launches. v4 is the platform that wins the market.

BCAI v3 gives BodyShopConnect a sovereign AI platform with CIECA imports, accounting exports, core workflow, and AI-assisted shop management. It is a strong product. It generates revenue. It satisfies every privacy and compliance requirement.

BCAI v4 takes that foundation and puts an intelligent voice agent in every bay. A technician with dirty hands, an air hose running, and a car on the lift can update a repair order, log parts received, move a job to paint, and get proactive SOP reminders -- without touching a keyboard. Without looking at a screen. Without breaking flow.

That is not a feature. That is a new category.

When AutoCanada sees $12M/year in recovered technician time, and CSN sees $47M/year, Sharon is no longer selling software. She is selling operational transformation. Nobody else in collision repair is within 18 months of this capability.

---

## 2. What Ted Is

Ted is not a chatbot. Ted is not a voice assistant bolted onto shop management software. Ted is the bay operating system -- the ambient intelligence layer that runs inside every bay, knows every car, knows every tech, knows every SOP, and works hands-free in the environment where the actual work happens.

Every other system in this industry -- Mitchell, CCC ONE, Audatex -- is a web application built for the office. Designed for someone at a desk with clean hands and a screen. They have never solved the fundamental problem: **the person who creates the most valuable data in the shop (the technician) is the person least able to enter it.**

Ted solves that. Ted goes to where the work is.

### How It Works

It is 9:47 AM on a Tuesday. Bay 3 smells like primer and metal. Marcus has been under a silver Honda Accord for twenty minutes -- hands dirty, air hose running, not a keyboard in sight.

He says: **"Hey Ted, RO 18422 -- parts arrived on the Accord. Move it to paint ready and notify Mike."**

Half a second of silence. Then a voice from the bay speaker, calm and clear:

*"Got it. Paint queue updated. Mike's been notified. Next step on this RO: pre-paint inspection is required before dispatch -- shop SOP 14B. Should I flag that for QC?"*

Marcus says "yeah" -- and keeps welding.

The repair order updated itself. The production board refreshed. Mike got the notification. The audit trail logged the timestamp, the user, the action. The cycle time clock kept moving. And Marcus never touched a keyboard. Never looked up. Never broke flow.

### The Technical Flow

```
Bay Microphone
     |
  [Wake Word Engine -- LOCAL on terminal hardware]
     |  "Hey Ted" detected --> audio capture begins
     |  No audio sent anywhere until wake word fires
     |  Privacy by architecture -- same model as Alexa's wake word chip
     |
  [BSC Local Server -- on-premises, LAN only]
     |  Audio received via local network (never internet)
     |
  [Nemotron LLM -- sovereign AI, no cloud]
     |  Intent classified, entities extracted
     |  Sub-second response time on local hardware
     |
  [Tool Execution -- agent handles all downstream effects]
     |  --> Update RO status
     |  --> Log parts received
     |  --> Send notification to Mike
     |  --> Update production board
     |  --> Write audit trail entry
     |
  [Voice Response -- synthesized locally]
     |
  [Bay Speaker -- response delivered to tech]
```

**Every step happens on local infrastructure.** No cloud. No internet dependency for voice processing. No per-call API cost. Sub-second round-trip from command to confirmation.

---

## 3. How v4 Builds on v3 (Not a Separate Product)

This document is not a competing proposal to v3. It is the growth path FROM v3. Sharon described this on March 31: "baby Brad, toddler Brad, 10-year-old Brad, 20-year-old Brad."

v3 is what launches. v4 is what Sharon sells to AutoCanada's executives when she walks in with the $12M/year ROI presentation.

```
v3 Foundation (Phases 0-3)            v4 Ted Layer (Phase 4+)
--------------------------            ----------------------
Sovereign AI on Canadian infra   -->  Same infrastructure, extended
CIECA imports + accounting       -->  Same integrations, voice-accessible
Core RO workflow                 -->  Same workflow, hands-free
AI-assisted suggestions          -->  Autonomous execution with confirmation
Per-tenant isolation             -->  Per-bay context awareness
Web/mobile UI                    -->  Voice + touch + keyboard (multi-modal)
```

Everything built in v3 carries forward. v4 adds three new capabilities on top:

| New Capability | What It Does |
|---------------|-------------|
| **Bay Context Agent** | Knows which tech is in which bay, which RO is on which lift, at all times. No self-identification needed -- Ted knows who is talking and what they are working on. |
| **SOP Prompter Agent** | After every action, Ted proactively tells the tech what is next. Not because the tech asked -- because the SOP requires it and Ted knows the current state of the RO. |
| **Voice I/O Manager** | Wake word detection, speech-to-text, text-to-speech -- all local. Coordinates audio routing between bay terminals and the AI layer. |

---

## 4. The Revenue Math at Scale

### AutoCanada: $12,000,000/Year in Recovered Labor Value

AutoCanada operates approximately 80 collision repair locations. Average 8 technicians per shop.

| Metric | Per Tech | Per Shop (8 techs) | AutoCanada (80 shops) |
|--------|----------|--------------------|-----------------------|
| Time saved daily | 60+ min | 8 hrs | 640 hrs |
| At $75/hr labor rate | $75/day | $600/day | $48,000/day |
| **Annual recovery** | **$18,750/yr** | **$150,000/yr** | **$12,000,000/yr** |

That is not new revenue from new customers. That is $12 million already in the building, currently spent on admin work instead of billable repair hours.

### CSN Collision: $47,000,000/Year

CSN operates approximately 500 locations across Canada. Conservative estimate at 5 techs/shop average:

| Metric | Value |
|--------|-------|
| Total techs across network | 2,500 |
| Daily recovery per tech | $75 |
| Network daily recovery | $187,500 |
| **Annual network recovery** | **$47,000,000** |

### Single Independent Shop (8 techs)

| Metric | Value |
|--------|-------|
| Daily recovery | $600 |
| Monthly recovery | $13,000 |
| Annual recovery | $150,000 |
| **Ted pays for itself in weeks, not years.** | |

### The Hidden ROI: Data Quality

Beyond direct labor recovery, Ted creates secondary value that compounds:

- **Cycle time reduction.** Every RO event logged instantly -- not batched at end of shift, not forgotten. Accurate production boards mean better scheduling. Better scheduling means faster cycle times.
- **Insurance scorecard improvement.** DRP programs score shops on cycle time, touch time, parts accuracy, communication. Ted improves all of these simultaneously. Better scores = more DRP assignments = more work into the shop.
- **Audit trail quality.** Every voice command logged with timestamp, user, bay, RO number, and action. Disputes with insurers, warranty claims, parts returns -- all backed by immutable audit trail.

---

## 5. What Ted Looks Like in a Shop

### Bay Hardware

Every bay gets a dedicated terminal -- purpose-built for the shop environment:

| Component | Specification | Estimated Cost |
|-----------|--------------|---------------|
| Bay speaker unit | Industrial-grade, shop-environment rated | **$55-60 per bay** |
| Microphone | Built into speaker unit, noise-cancelling for shop environment | Included |
| Bay terminal (optional) | 10-12" IP65-rated touchscreen, dust and water resistant | $300-500 per bay |

The speaker is the minimum requirement. The touchscreen terminal is recommended but optional -- Ted works voice-only. For shops that want a visual display (current RO, production board at a glance), the terminal adds that capability.

### Multi-Modal Input

Ted never forces a single way of working. Techs work differently. Moments are different.

- **Voice** -- the primary mode. Hands-free. Fastest. Marcus keeps welding.
- **Touch** -- for confirmations, quick status taps, when the shop is quiet.
- **Keyboard** -- for complex inputs. When a tech types something manually and tabs out, Ted offers: *"Want me to handle the rest?"* One tap. Ted executes all downstream steps.

### Voice Activity States

The bay speaker/terminal always shows Ted's current state -- visible from across the bay:

| State | Meaning |
|-------|---------|
| Green | Ted is listening -- wake word active, ready |
| Yellow | Ted is thinking -- processing your request |
| Blue | Ted is speaking -- response playing |
| White | Ted is offline -- server unreachable (rare; local fallback available) |

### Mobile App with Voice

For techs who move between bays, the parking lot, or the parts counter:

- Mobile app with "Hey Ted" wake word support
- Same voice capabilities as bay speaker
- Push notifications for RO updates, parts arrivals, SOP reminders
- Works on iOS and Android
- Connects to same local server as bay terminals

---

## 6. The SOP Advantage

Zero shops have written SOPs. Maybe one group has rough ones. Jim confirmed this on March 31. This is a problem -- and an opportunity.

### Why SOPs Matter for v4

Ted can only prompt the next step if he knows what the steps are. The SOP framework is what makes Ted intelligent, not just responsive. Without SOPs, Ted is a voice command interface. With SOPs, Ted is a co-pilot who keeps every tech in compliance, every RO on track, and every manager informed.

### How SOPs Get Built

| Phase | What Happens |
|-------|-------------|
| **Phase 0-1** | DCS builds the SOP framework -- the system that stores, retrieves, and sequences SOP steps. |
| **Phase 2** | Baseline SOPs codified using industry best practices and demo recordings Sharon mentioned. |
| **Phase 3 (AutoCanada)** | AutoCanada provides corporate SOPs via their trainers. These are codified into BCAI per-tenant config. |
| **Ongoing** | Each shop can configure its own SOP library. A DRP shop for State Farm has different requirements than an independent. Ted handles both. |

### Self-Healing Error Playbooks

When Ted encounters a situation that deviates from SOP -- a skipped step, an out-of-sequence status change, a missing inspection -- Ted does not just log it. Ted intervenes:

*"Heads up -- RO 18422 was moved to paint ready, but pre-paint inspection hasn't been logged yet. SOP 14B requires it before dispatch. Should I flag this for QC, or did you already complete it?"*

This is not punitive. This is a safety net. It catches the mistakes that cost shops insurance chargebacks, customer complaints, and rework.

Over time, these interventions become training data. Ted learns which deviations are real problems and which are workflow variations. The error playbooks get smarter. The false positive rate drops. The real catches increase.

---

## 7. What Ships and When

v4 builds on v3. The first three phases are identical to the v3 SOW. Ted's voice capabilities begin in Phase 4.

| Phase | Timeline | What Ships | Investment (CAD) |
|-------|----------|-----------|-----------------|
| **Phase 0** | Weeks 1-6 | Sandbox, code audit, CIECA prototype, tenant isolation design | $15,000 |
| **Phase 1** | Weeks 7-16 | BCAI Core: RO workflow, CIECA imports, accounting, RBAC, multi-tenant | $45,000 - $85,000 |
| **Phase 2** | Weeks 14-24 | Market launch with independents, AI assistance layer (Nemotron) | $35,000 - $65,000 |
| **Phase 3** | Months 6-10 | AutoCanada pilot, network reporting, SOP enforcement | $40,000 - $75,000 |
| **Phase 4** | Months 10-18+ | Ted voice system, bay hardware deployment, mobile app, self-healing playbooks | Scoped at Phase 3 gate |

### Why Phase 4 Is Scoped at Phase 3 Gate

By the time Sharon and Jim reach the Phase 3 gate, they will have:
- Real customer revenue from independent shops
- AutoCanada pilot data and feedback
- Proven AI assistance running on sovereign infrastructure
- Clear understanding of which shops want voice first

Phase 4 pricing will reflect actual technology costs at that time (GPU costs are dropping monthly), actual customer demand, and learnings from Phases 0-3. Pricing it today would be guessing. Sharon does not pay for guesses.

**Estimated Phase 4 range (for planning purposes only):** $60,000 - $120,000 CAD, depending on number of pilot bays, mobile app scope, and hardware deployment model. This estimate is NOT a commitment -- it will be firmed up at the Phase 3 gate with real data.

---

## 8. Competitive Moat: Why Nobody Catches Up

### The Gap Today

| Capability | Ted (BCAI v4) | Mitchell | CCC ONE | Audatex | Shop-Ware | Generic AI |
|-----------|---------------|----------|---------|---------|-----------|-----------|
| Voice in the bay | Yes | No | No | No | No | No |
| Local wake word (privacy) | Yes | No | No | No | No | No |
| Sovereign AI (no cloud) | Yes | No | No | No | No | No |
| Fine-tuned on collision data | Yes | No | No | No | No | No |
| Predictive SOP prompting | Yes | No | No | No | No | No |
| Works offline | Yes | No | No | No | No | No |
| Per-interaction AI cost | $0 | N/A | N/A | N/A | N/A | High |

### Why the Gap Grows

Mitchell, CCC ONE, and Audatex are legacy platforms. Their codebases are measured in decades. Adding voice-first AI to a legacy web application is not a feature -- it requires a fundamental rebuild that these companies are not positioned to execute quickly.

More critically: **they do not have the data.** The fine-tuning flywheel is the moat. Every month BCAI runs in production is another month of collision-specific training data that no competitor can replicate. The model gets smarter in ways specific to collision repair, specific to how techs talk, specific to the SOPs shops actually use.

**First mover advantage: 5-7 years.** By the time a competitor understands what Ted is, ships a prototype, runs a pilot, and fine-tunes a model -- BCAI will have trained Ted on years of real data from hundreds of shops. The gap does not close. It widens.

### The Four Moats (Same as v3, Deepened by Voice)

1. **Regulatory moat.** Sovereign AI + local voice processing. Audio never leaves the building. No competitor can match this without building from scratch.
2. **Data moat.** 10+ years of operational data PLUS voice interaction data from every bay. Training corpus that cannot be purchased or replicated.
3. **Distribution moat.** AutoCanada, CSN, Simplicity, Car Star. These are existing BC relationships. Ted is the upgrade path, not a competitive switch.
4. **Switching cost moat.** Once shops depend on voice workflow -- once Marcus expects to say "Hey Ted" and keep welding -- the switching cost is not a database migration. It is the loss of an operational capability their techs rely on every hour of every shift.

---

## 9. Investment by Phase

### Phases 0-3: Identical to v3 SOW

| Phase | Investment (CAD) | Timeline |
|-------|-----------------|----------|
| Phase 0: Foundation + Code Audit | $15,000 | Weeks 1-6 |
| Phase 1: BCAI Core | $45,000 - $85,000 | Weeks 7-16 |
| Phase 2: Market Launch + AI | $35,000 - $65,000 | Weeks 14-24 |
| Phase 3: AutoCanada Pilot | $40,000 - $75,000 | Months 6-10 |
| **Subtotal (Phases 0-3)** | **$135,000 - $240,000** | **8-12 months** |

### Phase 4: Ted Voice System (Scoped at Phase 3 Gate)

| Component | Estimated Range | Notes |
|-----------|----------------|-------|
| Ted voice engine (STT, TTS, wake word) | $25,000 - $45,000 | Local processing, no per-call cost |
| Bay Context Agent + SOP Prompter | $15,000 - $30,000 | Builds on Phase 2-3 AI and SOP work |
| Mobile app with voice | $15,000 - $35,000 | iOS + Android, or progressive web app |
| Self-healing error playbooks | $5,000 - $10,000 | Initial playbook set, expands over time |
| **Phase 4 estimated total** | **$60,000 - $120,000** | Firmed at Phase 3 gate |

### Total v4 Investment Range (Phases 0-4)

| Scenario | Total CAD | Timeline |
|----------|-----------|----------|
| Best case | $195,000 | ~14 months |
| Expected case | $300,000 | ~16 months |
| Conservative case | $360,000 | ~18 months |

### What Sharon Is Actually Buying

At the expected case ($300,000 CAD total through Phase 4):

- For **AutoCanada (80 shops):** $300K investment against $12M/year in recovered value. **40x return in year one.**
- For **CSN (500 locations):** Same $300K platform against $47M/year. **157x return in year one.**
- For **a single 8-tech shop:** Ted recovers $150K/year. The platform cost per shop at 100 shops is $3,000. **50x return.**

These are not projections. These are labor hours already being spent on admin work that Ted eliminates.

---

## 10. Hardware and Infrastructure

### Bay Hardware (Micazen-Direct Cost)

| Item | Cost per Bay | Notes |
|------|-------------|-------|
| Speaker unit (mic + speaker) | $55-60 | Minimum requirement for Ted |
| IP65 touchscreen terminal (optional) | $300-500 | For shops wanting visual display |
| Cabling/mounting | $25-50 | Per bay installation |

At AutoCanada scale (80 shops x ~8 bays = 640 bays):
- Speakers only: ~$38,000
- Speakers + terminals: ~$250,000 - $360,000

Hardware is a Micazen/shop-operator cost, not included in DCS phase pricing. Sharon decides the hardware rollout model -- full deployment, bay-by-bay, or pilot-first.

### GPU Infrastructure (Same as v3)

| Option | Cost |
|--------|------|
| AWS Canada Central GPU (monthly, reserved) | $8,000-$15,000/month |
| On-premise GPU hardware (one-time) | $60,000-$120,000 |
| Hybrid (recommended): AWS during build, evaluate on-prem at scale | Start at ~$8K/month, transition when economics favor it |

GPU infrastructure is a Micazen-direct expense. At 200+ shops, the zero-per-query economics of sovereign AI versus cloud API ($1.8M-$4.8M/year in avoided cost) make the infrastructure investment a rounding error.

---

## 11. Risk and Mitigation

### All v3 Risks Apply (See v3 SOW Section 10)

Plus these v4-specific risks:

| Risk | Likelihood | Impact | What We Do About It |
|------|-----------|--------|-------------------|
| Shop noise degrades voice recognition | Medium | Medium | Noise-cancelling industrial mics. Wake word engine filters ambient. Benchmark in real shop during Phase 3. |
| Techs resist voice interaction | Medium | Medium | Multi-modal -- voice is primary but never forced. Keyboard and touch always available. Adoption measured in pilot. |
| "Rogue agent" behavior (Sharon's concern from March 31) | Low | High | Confirmation gates for sensitive actions. Self-healing playbooks log and flag anomalies. Human-in-the-loop by default until trust is earned. |
| SOP content does not exist yet | High | Medium | Framework ships first. SOPs are codified during Phase 2-3. AutoCanada brings corporate SOPs. Industry best practices fill gaps. |
| Speaker hardware supply chain | Low | Low | Commodity components. Multiple suppliers. No custom hardware. |
| Mobile app adds scope | Medium | Medium | Progressive web app as MVP reduces scope. Native apps if customer demand justifies it. |

---

## 12. IP and Ownership

Same terms as v3 SOW:

| Category | Owner |
|----------|-------|
| All BCAI-specific code, configurations, and customizations (including Ted) | **Micazen** |
| AI models trained on BodyShopConnect data (including voice interaction data) | **Micazen** |
| Customer data, tenant data, operational data, voice recordings | **Micazen** |
| Underlying orchestration framework, AI integration patterns, and deployment tooling | **D. Caine Solutions LLC** |

Voice interaction data (anonymized) from Ted becomes training data that makes the model smarter. That data and those models belong to Micazen. This is part of the moat -- it compounds over time and it belongs to Sharon.

---

## 13. Next Steps

v4 does not require a separate decision today. The path to Ted runs through v3.

| Step | Action | Owner | Target |
|------|--------|-------|--------|
| 1 | Sign v3 SOW and begin Phase 0 | Sharon / Kevin | Week of April 7, 2026 |
| 2 | Phase 0 code audit includes voice feasibility assessment | DCS | Weeks 1-6 |
| 3 | Phase 1-2 builds the foundation Ted runs on | DCS | Weeks 7-24 |
| 4 | Phase 3 AutoCanada pilot validates the platform | DCS + AutoCanada | Months 6-10 |
| 5 | Phase 3 gate: Sharon decides whether to activate Phase 4 (Ted) | Sharon | Month 10 |
| 6 | If yes: Phase 4 scoped with firm pricing based on real data | DCS + Sharon | Month 10-11 |

**Sharon signs v3 today. Ted is the decision she makes in 10 months, backed by real revenue, real customer data, and a proven platform.**

v3 is what launches. v4 is what wins the market. They are the same product at different stages of growth.

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
