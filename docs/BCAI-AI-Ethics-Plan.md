# AI Ethics and Ethical Use Plan
# BodyShopConnect AI (BCAI)

---

**Prepared by:** Micazen Consulting & Technologies  
**In collaboration with:** D. Caine Solutions LLC  
**Date:** April 5, 2026  
**Version:** 1.0  
**Classification:** Confidential -- Board Distribution  
**Document Code:** MIC-ETHICS-2026-001  

---

## Executive Summary

This document establishes the AI Ethics and Ethical Use Plan for BodyShopConnect AI (BCAI), a sovereign AI platform deployed in collision repair facilities across Canada and North America. It governs every AI capability within the platform -- from workflow recommendations and technician assignment optimization to voice-activated bay agents and autonomous workflow execution.

BCAI is deployed in environments where real people do physically demanding, skilled work. The AI operates alongside tradespeople whose expertise, safety, and dignity are non-negotiable. It processes insurance claims that affect people's livelihoods. It handles sensitive business data under Canadian privacy law. It will be deployed at scale across publicly traded enterprises and major insurance carrier networks.

This is not a compliance exercise. This is a binding operational framework. Every engineer who writes AI features, every product manager who designs AI workflows, and every customer who deploys AI capabilities operates under these principles. Violations are treated as production incidents with defined severity, escalation, and remediation.

No other collision repair management platform has published an AI ethics framework. This document is intended to set the standard -- not just for this industry, but as a model for how sovereign AI platforms should operate in any skilled-trade environment.

---

## Table of Contents

1. [Foundational Principles](#1-foundational-principles)
2. [The Human Override Doctrine](#2-the-human-override-doctrine)
3. [Worker Dignity and Augmentation](#3-worker-dignity-and-augmentation)
4. [Fairness and Non-Discrimination](#4-fairness-and-non-discrimination)
5. [Transparency and Explainability](#5-transparency-and-explainability)
6. [Consent and Control](#6-consent-and-control)
7. [Safety and Reliability](#7-safety-and-reliability)
8. [Accountability Framework](#8-accountability-framework)
9. [Voice AI Ethics (Phase 4)](#9-voice-ai-ethics-phase-4)
10. [Privacy and Data Governance](#10-privacy-and-data-governance)
11. [Environmental Responsibility](#11-environmental-responsibility)
12. [Ethical AI Development Practices](#12-ethical-ai-development-practices)
13. [Compliance and Certification Roadmap](#13-compliance-and-certification-roadmap)
14. [Stakeholder Communication](#14-stakeholder-communication)
15. [Governance and Review](#15-governance-and-review)
16. [Definitions](#16-definitions)
17. [Document Control](#17-document-control)

---

## 1. Foundational Principles

BCAI is built on seven foundational principles. These are not aspirational statements. They are engineering constraints. Every AI feature must satisfy all seven before it ships.

### 1.1 Human Agency and Oversight

AI assists. AI recommends. AI never decides.

Every AI output in BCAI is a recommendation presented to a qualified human who accepts, modifies, or rejects it. No AI capability in the platform makes final decisions about repair orders, technician assignments, scheduling, parts ordering, insurance claims, customer communications, or any action that affects a person's work, income, or vehicle.

The human is always in the loop. The human always has the final word. The AI is a tool in the hands of a skilled professional -- never the reverse.

### 1.2 Technical Robustness and Safety

BCAI fails safe, not fail-silent.

When the AI cannot produce a reliable recommendation, it says so explicitly. It does not guess. It does not extrapolate beyond its confidence threshold. It does not present uncertain outputs as if they were certain. When the AI subsystem fails entirely, the platform continues to operate as a fully functional non-AI shop management system. No shop is ever unable to operate because the AI is unavailable.

### 1.3 Privacy and Data Governance

BCAI is sovereign by architecture, not by policy.

All AI processing occurs on infrastructure controlled by the tenant or by Micazen on behalf of the tenant. Shop data does not leave the sovereign environment for AI processing. There is no cloud AI service receiving repair orders, technician identities, insurance claim details, or customer information. This is not a configuration option -- it is a structural constraint enforced by the system architecture.

Data minimization is a design requirement: the AI receives only the data it needs for a specific recommendation, not broad access to the tenant's entire dataset.

### 1.4 Transparency

Every AI recommendation is explainable, auditable, and documented.

There are no black-box AI features in BCAI. Every recommendation can be traced to specific input data, specific rules or model logic, and specific confidence calculations. Users see why the AI made a recommendation. Administrators see the full decision chain. Auditors can reconstruct any AI decision from retained logs.

### 1.5 Diversity, Non-Discrimination, and Fairness

AI must not introduce, amplify, or perpetuate bias.

Collision repair shops employ diverse workforces across gender, age, ethnicity, language, immigration status, disability, and skill level. The AI must serve all of these workers with equal quality and fairness. No AI recommendation may discriminate on any protected characteristic. This is tested, measured, audited, and enforced -- not assumed.

### 1.6 Societal and Environmental Wellbeing

AI exists to make skilled workers more effective, not to replace them.

BCAI is deployed in shops where tradespeople have spent years developing expertise. The AI augments that expertise by reducing administrative burden, surfacing relevant information, and suggesting workflow improvements. It does not exist to reduce headcount, justify layoffs, or deskill work. The platform succeeds when technicians are more productive and more satisfied -- not when they are eliminated.

### 1.7 Accountability

Every AI decision has a clear owner.

There is no ambiguity about who is responsible when AI produces incorrect, biased, or harmful outputs. The accountability chain runs from the feature owner through the governance board to the executive sponsor. Incidents have defined classification, escalation paths, and remediation timelines.

---

## 2. The Human Override Doctrine

The Human Override Doctrine is the single most important operational principle in BCAI. It is non-negotiable, non-configurable, and applies to every AI feature in every phase of the product.

### 2.1 Core Rules

| Rule | Description |
|------|-------------|
| **Override** | Every AI recommendation can be overridden by an authorized human at any time. |
| **Reversibility** | Every autonomous AI action can be reversed by an authorized human. |
| **Non-supremacy** | The AI NEVER overrides a human decision. If a technician, manager, or administrator makes a choice, the AI respects it. The AI may present alternative information, but it does not countermand, block, or circumvent human decisions. |
| **No irreversible actions** | The AI NEVER executes irreversible actions. It does not delete data. It does not send payments. It does not cancel insurance claims. It does not submit regulatory filings. It does not take any action that cannot be undone by a human within a reasonable timeframe. |
| **Kill switch** | Any shop manager or administrator can disable all AI features for their shop instantly, with a single action, without contacting Micazen support. The platform continues to function as a non-AI management system. |
| **Grace period** | In Phase 4 (autonomous workflow execution), AI recommendations are displayed for a configurable grace period (default: 30 seconds) before any auto-execution begins. During this period, any authorized user can cancel, modify, or approve the action. The grace period is never zero -- there is always a window for human intervention. |

### 2.2 Override Logging

Every human override of an AI recommendation is logged with:

- Timestamp
- User identity
- Original AI recommendation (full detail)
- Human decision (what they chose instead)
- Reason (optional free text, encouraged but not required)

Override patterns are analyzed quarterly to improve AI accuracy. High override rates on a specific feature trigger automatic review. Overrides are never used to penalize users -- they are a signal that the AI needs to improve, not that the human was wrong.

### 2.3 Escalation Hierarchy

When the AI and a human disagree, the human wins. Always. The escalation hierarchy for AI feature control is:

```
Technician → can mute, dismiss, or ignore any AI recommendation in their bay
Shop Manager → can disable any AI feature for their shop
Network Administrator → can disable any AI feature across all shops in their network
Micazen Support → can disable any AI feature platform-wide
Sharon Ashley (CEO) → final authority on AI capability governance
```

Each level can act independently. A technician does not need permission to dismiss a recommendation. A shop manager does not need to call Micazen to disable a feature. Control is distributed to the point of impact.

---

## 3. Worker Dignity and Augmentation

### 3.1 The Augmentation Commitment

BCAI exists to make collision repair technicians, estimators, managers, and administrative staff more effective at the work they already do. The AI serves the worker. The worker does not serve the AI.

This commitment is not a marketing message. It is an engineering constraint that governs feature design, data collection, reporting, and every interaction between the AI and the people who use it.

### 3.2 What AI Will Never Be Used For

The following uses of AI are prohibited in BCAI. They are not merely discouraged or flagged for review. They are architecturally blocked and contractually forbidden.

| Prohibited Use | Rationale |
|----------------|-----------|
| **Individual productivity surveillance** | AI will not track, score, rank, or report individual worker productivity for punitive purposes. Aggregate shop metrics are permitted. Individual worker scorecards that can be used for discipline are not. |
| **Public performance rankings** | AI will not create leaderboards, rankings, or comparative displays that publicly compare individual workers against each other. |
| **Firing or disciplinary recommendations** | AI will not recommend termination, suspension, demotion, write-ups, or any form of disciplinary action against any worker. Employment decisions are human decisions. |
| **Headcount reduction justification** | AI will not produce reports, analyses, or recommendations designed to justify reducing the number of workers in a shop. If a shop becomes more efficient, that efficiency belongs to the existing team -- not to a spreadsheet argument for fewer people. |
| **Pace-of-work enforcement** | AI will not set, enforce, or monitor compliance with individual task completion targets. Technicians work at the pace their skill and the job require. |
| **Behavioral monitoring** | AI will not analyze worker behavior patterns (break frequency, movement, social interactions) for management reporting. |
| **Automated disciplinary escalation** | AI will not automatically trigger HR processes, warnings, or escalations based on any metric or pattern. |

### 3.3 What AI Will Be Used For

| Permitted Use | Example |
|---------------|---------|
| **Reducing administrative burden** | Auto-populating repair order fields from CIECA imports so technicians spend less time on data entry. |
| **Surfacing relevant information** | Notifying a technician that all parts for their current RO have arrived, so they can plan their work. |
| **Suggesting workflow improvements** | Recommending a production sequence that reduces bay idle time based on shop-wide data -- presented to the manager for approval, not imposed. |
| **Helping document work faster** | Voice-activated status updates (Phase 4) so technicians can log progress without stopping work. |
| **Quality assistance** | Flagging that a pre-paint inspection is required per shop SOP before a job moves to paint. |
| **Training support** | Providing SOP reminders to newer technicians who opt in to guidance -- never imposed, never tracked for discipline. |
| **Scheduling optimization** | Suggesting schedule adjustments that respect labor laws, break requirements, and skill-appropriate assignments -- presented to the manager, not executed automatically. |

### 3.4 Voice Agent Interaction Standards (Phase 4)

Voice agents in BCAI bays (internally named "BC") are designed as helpful colleagues, not supervisors. The interaction model is governed by these rules:

**The AI asks. It does not command.**

| Correct | Incorrect |
|---------|-----------|
| "Would you like me to update the status to paint-ready?" | "Status updated to paint-ready." |
| "I noticed all parts are in for RO 18422. Want me to move it to the next stage?" | "RO 18422 moved to next stage." |
| "Just a heads up -- SOP 14B requires a pre-paint inspection on this one. Should I flag it for QC?" | "Pre-paint inspection is overdue. Flagging QC." |
| "Hey, want me to log that as body work complete?" | "Body work logged as complete." |

The AI uses natural, respectful language. It addresses technicians as peers. It never uses language that implies authority, urgency pressure, disappointment, or judgment. Phrasing like "you should have," "you need to," "this is overdue," or "why hasn't this been done" is prohibited in AI-generated speech.

### 3.5 Multilingual Dignity

Collision repair shops employ workers who speak English, French, Spanish, Punjabi, Cantonese, Mandarin, Tagalog, and other languages. The AI must provide equal quality of interaction regardless of the language used.

- AI recommendations are delivered in the user's configured language.
- Voice agents (Phase 4) respond in the language they are addressed in.
- No AI feature degrades in quality, accuracy, or capability based on the language of interaction.
- Language proficiency is never used as a data point in any AI recommendation (assignment, scheduling, performance).
- Error messages and system notifications are localized, not English-only with translation as an afterthought.

---

## 4. Fairness and Non-Discrimination

### 4.1 Protected Characteristics

AI recommendations in BCAI must not discriminate based on:

- Gender or gender identity
- Age
- Race or ethnicity
- National origin or immigration status
- Language or accent
- Disability (visible or invisible)
- Religion
- Sexual orientation
- Seniority (unless directly relevant to a specific skill certification required for the task)
- Employment status (full-time, part-time, contract)
- Union membership

### 4.2 Technician Assignment AI

The technician assignment recommendation engine is the highest-risk AI feature for bias. It recommends which technician should work on which repair order based on skills, certifications, current workload, and bay availability.

**Bias Controls:**

| Control | Implementation |
|---------|----------------|
| **Input restriction** | The assignment model receives: skill certifications, current workload, bay assignment, job requirements, availability. It does NOT receive: name, gender, age, photo, language preference, hire date (except for certification validity), or any demographic data. |
| **Proxy detection** | Quarterly analysis to detect proxy discrimination -- patterns where a technically neutral variable (e.g., shift preference, bay assignment history) correlates with a protected characteristic. |
| **Distribution monitoring** | Monthly automated check: are high-value ROs (insurance-paid, large scope) distributed equitably across technicians with equivalent certifications? Statistically significant skew triggers investigation. |
| **Override analysis** | Are manager overrides of AI assignments correlated with any demographic pattern? Quarterly review. |

### 4.3 Scheduling AI

The scheduling recommendation engine must respect:

- All applicable labor laws (federal, provincial/state, municipal)
- Mandatory break requirements
- Maximum consecutive work hours
- Skill-appropriate assignments (no recommending paint work to a body technician without paint certification)
- Accommodation requirements for workers with documented needs
- Religious observance schedules when provided by the worker
- Parental and caregiving responsibilities when disclosed

The scheduling AI treats these as hard constraints, not soft preferences. They cannot be overridden by the AI for "optimization."

### 4.4 Bias Auditing Program

| Audit Type | Frequency | Scope | Output |
|------------|-----------|-------|--------|
| **Automated distribution analysis** | Monthly | Assignment, scheduling, workflow routing recommendations | Statistical report flagging any skew above threshold |
| **Proxy variable analysis** | Quarterly | All AI input features | Correlation analysis between input variables and protected characteristics |
| **Adversarial testing** | Before each major AI feature launch | New AI capability | Red team report documenting bias scenarios tested and results |
| **Third-party audit** | Annually | Full AI system | Independent audit report with findings and remediation plan |
| **Override pattern analysis** | Quarterly | All AI recommendations that were overridden | Pattern analysis for demographic correlation in override decisions |

### 4.5 Bias Incident Response

When a bias pattern is detected:

1. **Immediate (within 4 hours):** Feature owner notified. Preliminary data reviewed.
2. **Within 24 hours:** Root cause investigation initiated. If pattern is confirmed, the affected AI feature is paused for the affected scope (specific shop, network, or platform-wide depending on severity).
3. **Within 72 hours:** Remediation plan documented and approved by AI Governance Board.
4. **Within 14 days:** Remediation deployed and validated.
5. **Within 30 days:** Post-incident report published to affected tenants.

Bias incidents are classified as Severity 1 (Critical) in the incident management system. They receive the same response urgency as a data breach.

---

## 5. Transparency and Explainability

### 5.1 The "Why" Requirement

Every AI recommendation displayed to a user must include a human-readable explanation of why the recommendation was made. This is not optional. It is a rendering requirement -- a recommendation without an explanation is a bug.

**Examples:**

| Recommendation | Explanation |
|----------------|-------------|
| "Move RO #1234 to Paint" | "All parts received (3/3 on April 4). Body work logged complete by Tech A on April 4 at 2:15 PM. Paint booth available in Bay 4 starting at 8:00 AM tomorrow." |
| "Assign RO #5678 to Marcus" | "Marcus has I-CAR Platinum certification (required for this structural repair). Current workload: 2 active ROs (below shop average of 3.1). Bay 3 available." |
| "Supplement likely needed" | "85% confidence. Reason: initial estimate scope is $2,400 for rear quarter panel. Historical data for similar damage profiles at this shop shows actual repair cost averaging $3,100 (n=47 comparable ROs over 12 months)." |
| "Schedule pickup call for Friday" | "Repair completion estimated Friday 3:00 PM based on current stage (paint cure) and remaining operations (reassembly: estimated 4 hours, detail: estimated 1.5 hours). Customer preference: afternoon calls (from profile)." |

### 5.2 Confidence Scores

Where applicable, AI recommendations include a confidence score:

- Displayed as a percentage (e.g., "85% confidence")
- Accompanied by an explanation of what drives the confidence level
- Subject to a minimum threshold before display (configurable per tenant, default: 70%)
- Recommendations below the minimum threshold are suppressed -- the AI says nothing rather than presenting a low-confidence guess

### 5.3 Decision Audit Trail

Every AI recommendation is logged with the following data, retained for a minimum of three (3) years:

| Field | Description |
|-------|-------------|
| Timestamp | When the recommendation was generated |
| Tenant ID | Which shop/network |
| Feature ID | Which AI capability generated it |
| Input data snapshot | The exact data the AI used (anonymized for long-term storage where required) |
| Model version | Which version of the AI model or rule set produced the recommendation |
| Output | The full recommendation including explanation |
| Confidence score | If applicable |
| User action | Accepted, modified, rejected, or ignored |
| Override detail | If overridden, what the human chose instead |

### 5.4 Tenant Access to Explanations

- Any tenant administrator can request a full explanation of any AI decision made within their shop, within 30 days of the decision.
- Micazen will provide the explanation within 5 business days of the request.
- Explanations include: input data, model logic, confidence calculation, and any relevant context.
- After 30 days, explanations are available from the audit log but may require additional processing time.

### 5.5 No Black-Box AI

BCAI does not use AI models or techniques that cannot be explained. Specifically:

- All recommendations are traceable to specific input data and specific rules or model weights.
- No AI feature operates on "emergent" logic that cannot be audited.
- If a model architecture is inherently difficult to explain (e.g., deep neural network for damage assessment), the feature includes a secondary explanation layer that translates model outputs into auditable reasoning.
- Any AI feature that cannot meet this standard does not ship.

---

## 6. Consent and Control

### 6.1 Opt-In Architecture

AI features in BCAI are opt-in at the tenant level. No AI capability is forced on any shop. The default state for every AI feature is **off**. Tenants enable the features they want and leave the rest disabled.

This is not a "free trial that auto-converts." AI features are disabled until a tenant administrator explicitly enables them. There is no countdown, no nagging, no "you're missing out" messaging.

### 6.2 Opt-Out Without Penalty

Any tenant can disable any AI feature at any time. When they do:

- The AI feature stops immediately (within one platform refresh cycle, maximum 60 seconds).
- All non-AI functionality continues to work exactly as before.
- No data is lost.
- No workflows are broken.
- No punitive pricing change occurs (tenants do not pay more for "non-AI mode").
- The tenant can re-enable the feature at any time.

### 6.3 Granular Feature Control

Tenants control AI at the feature level, not all-or-nothing:

| AI Feature | Independent Toggle |
|------------|-------------------|
| Workflow routing recommendations | On/Off |
| Technician assignment suggestions | On/Off |
| Scheduling optimization | On/Off |
| Parts ordering suggestions | On/Off |
| Quality prediction alerts | On/Off |
| Customer communication drafts | On/Off |
| Voice agents (Phase 4) | On/Off per bay |
| Autonomous workflow execution (Phase 4) | On/Off with configurable scope |
| Supplement prediction | On/Off |
| SOP compliance reminders | On/Off |

Each toggle is independent. Enabling scheduling AI does not require enabling assignment AI. Enabling voice agents in Bay 1 does not require enabling them in Bay 2.

### 6.4 Employee Consent

**Voice Recording (Phase 4):**

- Voice agents require employee acknowledgment before activation in their bay.
- Acknowledgment is documented per employee, not per shop. A shop cannot consent on behalf of its workers.
- Employees who do not consent can still use the platform through non-voice interfaces (tablet, desktop) with full functionality.
- No adverse employment action may be taken against an employee for declining voice agent consent. This is stated in the tenant agreement.

**Data Processing:**

- Employees are informed, in their preferred language, about what data the AI processes, how it is used, and what it does not do.
- A plain-language "AI in Your Shop" document is provided to every tenant for employee distribution, available in all supported languages.

### 6.5 Customer Consent

- AI-generated communications to end customers (vehicle owners, insurance adjusters) are clearly labeled as AI-assisted.
- Labeling format: "This message was drafted with AI assistance and reviewed by [shop name]."
- Customers are never led to believe they are communicating with a human when they are interacting with an AI system.

### 6.6 No Dark Patterns

BCAI does not use manipulative design to influence AI feature adoption:

- No "recommended" badges that pressure tenants into enabling features.
- No warnings about "missing out on efficiency gains" when features are disabled.
- No defaults that auto-enable new AI features when they launch.
- No A/B testing of consent flows designed to increase opt-in rates.
- No social proof ("87% of shops have enabled this feature") used to influence adoption.
- Feature descriptions are accurate and honest. Marketing claims do not exceed technical reality.

---

## 7. Safety and Reliability

### 7.1 Fail-Safe, Not Fail-Silent

When the AI cannot produce a reliable recommendation, the correct behavior is:

| Scenario | AI Response |
|----------|-------------|
| Insufficient data to make a recommendation | "I don't have enough data to suggest an assignment for this RO. [Specific missing data listed]." |
| Confidence below threshold | No recommendation displayed. Log entry recorded for diagnostics. |
| Model error or timeout | "AI recommendation unavailable. The system is operating normally -- recommendations will resume when the AI service recovers." |
| Conflicting data | "I found conflicting information on this RO: [specifics]. Please verify before proceeding." |
| Novel situation (no comparable historical data) | "This repair profile doesn't match historical patterns closely enough for me to make a confident suggestion." |

The AI never guesses. Silence or explicit uncertainty is always preferable to a confident-sounding wrong answer.

### 7.2 Confidence Thresholds

| Feature | Default Minimum Confidence | Configurable |
|---------|---------------------------|--------------|
| Workflow routing | 75% | Yes (range: 60-95%) |
| Technician assignment | 80% | Yes (range: 70-95%) |
| Supplement prediction | 70% | Yes (range: 60-90%) |
| Parts ordering suggestion | 85% | Yes (range: 75-95%) |
| Customer communication draft | 80% | Yes (range: 70-95%) |
| Autonomous action (Phase 4) | 90% | Yes (range: 85-99%) |

Recommendations below the configured threshold are not displayed. They are logged for model improvement purposes only.

### 7.3 Anomaly Detection

BCAI monitors its own AI behavior for anomalies:

- **Recommendation volume anomaly:** If the AI generates significantly more or fewer recommendations than expected for a given time period, an alert is triggered.
- **Confidence distribution shift:** If average confidence scores change by more than 10% over a 7-day rolling window, an alert is triggered.
- **Override rate spike:** If the override rate for any feature exceeds 40% over a 7-day rolling window, the feature is flagged for review.
- **Data drift detection:** If input data patterns change significantly from the training/calibration baseline, an alert is triggered.

When anomaly detection triggers, the response is:

1. Tenant administrator alerted via in-platform notification.
2. Micazen AI operations team alerted.
3. If severity warrants, the affected feature is automatically paused until reviewed.

### 7.4 No Hallucination Tolerance

BCAI AI does not generate fabricated data. Every AI output must reference specific, verifiable source data:

- RO numbers, dates, measurements, and part numbers cited in recommendations must exist in the tenant's data.
- Statistical claims ("47 comparable ROs") must be verifiable from the audit log.
- SOP references must correspond to actual configured SOPs.
- If the AI cannot cite specific data to support a recommendation, the recommendation is not made.

Hallucination is treated as a Severity 1 bug. Any confirmed instance of the AI presenting fabricated data as fact triggers immediate investigation and remediation.

### 7.5 Degraded Mode Operation

BCAI is designed so that AI failure never prevents shop operation:

| Component | If AI Fails |
|-----------|-------------|
| Core platform (RO management, scheduling, parts, accounting) | Fully operational. No AI dependency. |
| Production board | Fully operational. Manual updates work normally. AI suggestions disappear. |
| Customer communication | Manual composition available. AI draft assistance unavailable. |
| Voice agents (Phase 4) | Voice agent goes silent. Bay display and tablet interfaces remain fully functional. |
| Reporting | Historical reports available. AI-generated insights unavailable until recovery. |

### 7.6 No Single Point of Failure

- AI subsystem unavailability does not cascade to other platform components.
- AI infrastructure is monitored independently from core platform infrastructure.
- Recovery from AI failure does not require shop-side action -- the AI resumes automatically when the subsystem recovers.
- Tenants are notified of AI unavailability exceeding 15 minutes.

---

## 8. Accountability Framework

### 8.1 AI Feature Ownership

Every AI capability in BCAI has a named feature owner: an individual (not a team, not a role) responsible for the capability's behavior, accuracy, fairness, and safety. The feature owner is documented in the AI Feature Registry and updated whenever ownership changes.

The feature owner is responsible for:

- Monitoring the feature's performance and accuracy
- Responding to incidents involving the feature
- Ensuring the feature complies with this ethics plan
- Presenting feature performance at quarterly AI Governance Board reviews

### 8.2 Incident Classification

| Classification | Definition | Example |
|----------------|------------|---------|
| **AI Wrong** | AI made an incorrect recommendation that did not cause harm but was factually wrong. | Suggested moving an RO to paint when parts were not yet received. |
| **AI Bias** | AI exhibited a discriminatory pattern in recommendations. | Assignment AI consistently recommending high-value ROs to one demographic group. |
| **AI Safety** | AI took or recommended an action that could cause harm to people, property, or business operations. | Autonomous action (Phase 4) executed without proper grace period. |
| **AI Privacy** | AI exposed, processed, or retained data in violation of privacy policies or regulations. | AI recommendation included data from a different tenant's shop. |
| **AI Dignity** | AI interaction violated worker dignity principles (Section 3). | Voice agent used commanding language or implied criticism of a technician's work pace. |

### 8.3 Escalation Path

```
Level 1: Shop Administrator
    → Reviews incident, logs details, contacts Micazen if unresolved

Level 2: Micazen Support
    → Triages incident, engages feature owner, applies immediate mitigation

Level 3: AI Feature Owner
    → Investigates root cause, develops remediation, reports to governance board

Level 4: AI Governance Board
    → Reviews investigation, approves remediation, determines if feature should be paused or modified

Level 5: Sharon Ashley (CEO)
    → Final authority on AI capability decisions, regulatory response, public communication
```

### 8.4 Remediation SLAs

| Incident Type | Investigation Start | Resolution Target | Feature Impact |
|---------------|--------------------|--------------------|----------------|
| **AI Wrong** | Within 48 hours | 14 days | Feature continues operating; fix deployed in next release |
| **AI Bias** | Within 24 hours | 7 days | Feature paused for affected scope until remediation validated |
| **AI Safety** | Immediate | 72 hours | Feature disabled platform-wide until remediation validated |
| **AI Privacy** | Immediate | 48 hours | Feature disabled; regulatory notification within 72 hours if required |
| **AI Dignity** | Within 24 hours | 7 days | Voice/interaction feature paused; rewritten interaction patterns before re-enable |

### 8.5 AI Governance Board

**Composition:**
- CEO (Chair)
- CTO or Head of Engineering
- Head of Customer Success
- External AI Ethics Advisor (independent, no financial interest in Micazen)
- Customer representative (rotating, from active tenants)

**Meeting Cadence:**
- Quarterly: standing review of AI feature performance, bias audit results, incident reports, and ethics compliance
- Ad hoc: convened within 48 hours for any Severity 1 incident (AI Safety or AI Privacy)

**Authority:**
- Can mandate changes to any AI feature
- Can pause or disable any AI feature pending investigation
- Can require additional testing, auditing, or review before a feature launches
- Can recommend policy changes to this ethics plan (approved by CEO)

### 8.6 Annual Third-Party Audit

Micazen commissions an annual independent AI ethics audit conducted by a qualified third party with no financial interest in the company. The audit covers:

- Compliance with this ethics plan
- Bias audit methodology and results
- Incident response effectiveness
- Worker dignity standard compliance
- Privacy and data governance compliance
- Voice AI ethics compliance (Phase 4+)

The audit summary (excluding proprietary technical detail) is made available to tenant administrators and, upon request, to insurance carriers and regulatory bodies.

---

## 9. Voice AI Ethics (Phase 4)

Phase 4 introduces voice agents ("BC") in every bay. This is the highest-sensitivity AI deployment in BCAI. A machine speaks to a human in their workplace, in real time, about their work. The ethical requirements for this capability are correspondingly higher than for any other feature.

### 9.1 Identity and Honesty

- Voice agents identify themselves on first interaction in every session: "This is BC, your bay assistant."
- Voice agents never impersonate humans. They do not use human names, adopt human personas, or create the impression that a human is speaking.
- If asked "Are you a real person?" the voice agent responds honestly and immediately: "No, I'm BC -- the AI assistant for this bay."
- Voice agents do not simulate emotions, frustration, excitement, or other human emotional states.

### 9.2 Respect for Attention and Autonomy

- Voice agents respect "not now," "stop," "cancel," "shut up," "quiet," and any reasonable expression of disinterest -- immediately and without follow-up.
- After a dismissal, the voice agent does not re-initiate conversation until the next explicit activation (wake word or button press).
- Voice agents do not interrupt technicians who are actively speaking.
- Voice agents do not initiate conversation during high-noise operations (grinding, painting, compressed air) unless explicitly activated by the technician.
- Proactive notifications (unsolicited AI-initiated speech) are limited to configurable maximum frequency (default: no more than 2 per hour per bay) and can be disabled entirely.

### 9.3 Muting and Silence

- Technicians can mute the voice agent at any time: voice command ("mute"), physical button on bay hardware, or tablet toggle.
- Muting is immediate and complete. The voice agent produces no sound until unmuted.
- Muting does not disable non-voice AI features. The tablet/display interface remains fully functional.
- Muting is never logged for performance evaluation. Mute frequency is never reported to management. The mute action is private.

### 9.4 Voice Data Handling

| Data Type | Retention | Access |
|-----------|-----------|--------|
| Transcribed commands (text) | Retained in audit log per standard retention (3 years) | Audit trail access |
| Raw audio (voice recording) | Maximum 90 days, then automatically and irreversibly deleted | Restricted: AI operations team only, for quality improvement |
| Wake word detection events | 90 days | Admin, Manager |
| Voice agent responses (text) | Retained in audit log per standard retention | Audit trail access |
| Voice agent responses (audio) | Not retained. Generated in real time, not stored. | N/A |

### 9.5 Prohibited Voice AI Capabilities

The following capabilities are explicitly prohibited in BCAI voice agents, in all phases, with no exceptions:

| Prohibited Capability | Rationale |
|-----------------------|-----------|
| **Emotion detection / sentiment analysis** | Analyzing worker emotional state from voice is invasive, unreliable, and has no legitimate business purpose in collision repair. |
| **Voice-based performance evaluation** | Tone, pace, vocabulary, accent, or any voice characteristic is never used to evaluate worker performance. |
| **Stress detection** | Monitoring worker stress levels via voice analysis is prohibited. |
| **Speaker identification for surveillance** | Voice biometrics may be used for authentication (opt-in) but never for tracking who is in which bay or monitoring presence. |
| **Conversation recording between workers** | The voice agent only processes speech directed to it (post-wake-word). Ambient conversation between workers is never recorded, transcribed, or analyzed. |
| **Continuous listening** | Audio is not streamed to any server until the wake word is detected. Wake word detection occurs on-device. No cloud service receives ambient audio. |

### 9.6 Voice Agent Tone and Language Standards

The voice agent speaks as a helpful colleague. Specific tone guidelines:

- **Calm and even.** No urgency in tone unless there is a genuine safety concern.
- **Respectful.** Uses "please," "thanks," and natural courteous language.
- **Brief.** Technicians are working. Responses are concise. No unnecessary preamble.
- **Non-judgmental.** Never comments on speed, quality, or frequency of requests.
- **Acknowledges expertise.** "You probably already know this, but SOP 14B requires..." not "You need to do a pre-paint inspection."
- **Handles misunderstanding gracefully.** "I didn't catch that -- could you say it again?" not "Invalid command" or "I don't understand."

---

## 10. Privacy and Data Governance

### 10.1 Sovereign Architecture

BCAI's AI processing infrastructure is sovereign by design:

- All AI inference occurs on hardware controlled by the tenant or by Micazen on behalf of the tenant within the agreed jurisdiction.
- No shop data (repair orders, customer information, employee information, insurance claim details, voice recordings) is transmitted to third-party cloud AI services for processing.
- No AI model training is performed on tenant data without explicit written consent.
- Tenant data is isolated: Shop A's data is never used in AI recommendations for Shop B, even within the same network, unless explicitly configured by the network administrator.

### 10.2 Data Minimization

The AI receives only the data necessary for the specific recommendation it is making:

- Technician assignment AI receives skill data and workload data -- not personal information.
- Scheduling AI receives availability and constraints -- not worker home addresses or personal commitments.
- Voice agents receive the transcribed command and relevant RO context -- not the technician's full employment record.

Data minimization is enforced architecturally through API contracts that define exactly which data fields each AI feature can access.

### 10.3 Data Retention

| Data Category | Retention Period | Deletion Method |
|---------------|-----------------|-----------------|
| AI recommendation logs | 3 years | Automated purge, cryptographic verification |
| AI input data snapshots | 3 years (anonymized after 1 year) | Automated purge |
| Voice recordings (raw audio) | 90 days maximum | Automated irreversible deletion |
| Voice transcriptions | 3 years | Automated purge with recommendation logs |
| Bias audit data | 5 years | Manual review before deletion |
| Incident reports | 7 years | Manual review before deletion |
| Override logs | 3 years | Automated purge |

### 10.4 Cross-Tenant Data Isolation

- Each tenant's AI operates exclusively on that tenant's data.
- Network-level AI features (available to network administrators) operate on aggregated, anonymized data across their network's shops only.
- No AI feature can access data across network boundaries.
- Tenant data isolation is tested as part of every release cycle.

### 10.5 Regulatory Compliance

BCAI's privacy framework is designed to comply with:

- **PIPEDA** (Personal Information Protection and Electronic Documents Act) -- federal Canadian privacy law
- **PIPA** (British Columbia Personal Information Protection Act) -- provincial privacy law
- **GDPR** -- for any future European deployment
- **CCPA/CPRA** -- for any future California deployment
- **Industry-specific requirements** -- insurance carrier data handling agreements, network data sharing agreements

Compliance is validated annually as part of the third-party audit.

---

## 11. Environmental Responsibility

### 11.1 Sovereign AI and Carbon Footprint

BCAI's sovereign architecture (local compute, no cloud AI round-trips) inherently reduces the carbon footprint of AI operations:

- No data transfer to remote cloud data centers for AI inference.
- No dependency on hyperscale GPU clusters for routine recommendations.
- AI processing occurs on right-sized infrastructure colocated with the tenant's existing systems.

### 11.2 Compute Efficiency

- Model selection prioritizes compute efficiency: smaller, specialized models are used where they meet accuracy requirements, rather than defaulting to the largest available model.
- Batch processing is preferred over real-time inference where latency is not critical (e.g., daily scheduling optimization runs once rather than continuously).
- AI inference infrastructure is right-sized to actual workload. No standing over-provisioned GPU clusters.
- Model efficiency is reviewed as part of each major release. If a smaller model achieves equivalent accuracy, it replaces the larger one.

### 11.3 Hardware Lifecycle

- Bay hardware (Phase 4: speakers, microphones) is specified for minimum 5-year operational life.
- Hardware is repairable and replaceable at the component level where possible.
- End-of-life hardware disposal follows applicable e-waste regulations.

---

## 12. Ethical AI Development Practices

### 12.1 Training Data Review

- All training data used for BCAI AI models is reviewed by a human before use.
- Training data sources are documented: where it came from, when it was collected, what consent was obtained.
- Synthetic data generation is documented and reviewed for bias introduction.
- Training data never includes personally identifiable information unless specifically required and consented.
- Training data is version-controlled. Every model can be traced to the exact training data that produced it.

### 12.2 Red Teaming

Before every major AI feature launch, a red team exercise is conducted:

- **Scope:** Adversarial testing specifically designed to find bias, safety, privacy, and dignity violations.
- **Team:** Includes at least one person who is not part of the development team for the feature.
- **Scenarios:** Includes edge cases specific to collision repair: multilingual interactions, high-stress situations, complex insurance scenarios, shops with minimal data history, shops with unusual workflow patterns.
- **Documentation:** Red team findings are documented, remediated, and the remediation is verified before launch.
- **No launch without sign-off:** The feature owner must sign off that all red team findings are addressed. This sign-off is recorded in the AI Feature Registry.

### 12.3 Diverse Testing

BCAI AI features are tested across a representative range of deployment environments:

- Small independent shops (1-3 bays)
- Mid-size shops (4-10 bays)
- Large multi-location networks (20+ shops)
- Shops with primarily English-speaking workforces
- Shops with multilingual workforces
- Shops with high technician turnover
- Shops with stable, long-tenured teams
- Shops with complete historical data
- Shops with minimal historical data (new BCAI deployments)

Testing is not limited to the "ideal" shop. AI features must perform acceptably in challenging, data-sparse, and atypical environments.

### 12.4 Open Documentation

AI capabilities and limitations are documented honestly:

- Marketing materials do not claim capabilities that exceed technical reality.
- Known limitations are documented in user-facing help content, not buried in technical appendices.
- Accuracy metrics are reported as ranges, not best-case numbers.
- "AI-powered" is never used as a vague marketing term -- every AI feature has a specific, documented explanation of what the AI does and how.

### 12.5 Continuous Monitoring

Post-deployment monitoring is ongoing, not a launch-and-forget process:

- AI recommendation accuracy is tracked continuously.
- User satisfaction with AI features is measured through in-platform feedback (optional, anonymous, and never tied to individual performance metrics).
- Unintended consequences are actively monitored: if enabling AI feature X consistently leads to negative outcome Y (even if Y is outside the AI feature's direct scope), it is investigated.
- Model performance degradation over time (data drift, accuracy decay) is monitored and triggers retraining or recalibration when thresholds are exceeded.

---

## 13. Compliance and Certification Roadmap

### 13.1 Current Standards Alignment

| Standard | Status | Target |
|----------|--------|--------|
| **ISO/IEC 42001** (AI Management Systems) | Framework mapped; implementation in progress | Certification within 18 months of Phase 3 launch |
| **NIST AI Risk Management Framework (AI RMF 1.0)** | Mapped to BCAI AI features | Full alignment documented by Phase 3 launch |
| **EU AI Act** | Risk classification completed; BCAI features assessed as limited/minimal risk (no high-risk classification under current feature set) | Compliance documentation maintained; reassessed with each phase |
| **Canadian Artificial Intelligence and Data Act (AIDA)** | Monitoring legislative progress; current framework exceeds expected requirements | Full compliance within 6 months of royal assent |
| **CAN/CIOSC 101:2019** (Ethical Design and Use of Automated Decision Systems) | Mapped | Alignment documented |

### 13.2 Industry-First Certification

Micazen intends to propose a **Collision Repair AI Ethics Certification** to relevant industry bodies, including:

- Canadian Collision Industry Forum (CCIF)
- Collision Industry Conference (CIC)
- Inter-Industry Conference on Auto Collision Repair (I-CAR)
- Insurance Bureau of Canada (IBC)

This certification would establish industry-wide standards for AI use in collision repair, covering:

- Worker dignity and non-surveillance requirements
- Human override requirements
- Bias auditing standards
- Data sovereignty requirements
- Voice AI ethical standards

Micazen's position as the first mover in publishing a comprehensive AI ethics framework positions the company to lead this standardization effort.

### 13.3 Insurance Carrier Compliance

BCAI's ethics framework is designed to satisfy insurance carrier requirements for:

- Auditability of AI-influenced claim decisions
- Transparency of AI recommendations that affect repair scope or cost
- Data handling compliance for policyholder information
- Non-discrimination in AI-influenced processes that affect claim outcomes
- Documentation retention sufficient for regulatory examination

Insurance carriers can request AI decision audit reports for any claim processed through BCAI, subject to tenant authorization.

---

## 14. Stakeholder Communication

### 14.1 Shop Owners and Managers

| Communication | Frequency | Content |
|---------------|-----------|---------|
| AI Performance Report | Quarterly | Recommendation accuracy, override rates, feature usage, confidence score distributions, any incidents and resolutions |
| Ethics Audit Summary | Annually | Third-party audit findings summary, remediation actions, compliance status |
| Feature Change Notification | Per release | What changed in AI features, why, and what it means for shop operations |
| Incident Notification | As needed | What happened, what was affected, what was done, how it was prevented from recurring |

### 14.2 Network Administrators

| Communication | Frequency | Content |
|---------------|-----------|---------|
| AI Governance Compliance Dashboard | Real-time (in-platform) | Feature status, bias audit results, incident history, override analytics across network |
| Quarterly Governance Report | Quarterly | Comprehensive AI governance report covering all shops in the network |
| Annual Ethics Audit | Annually | Full third-party audit report (excluding proprietary technical detail) |

### 14.3 Insurance Carriers

| Communication | Available On | Content |
|---------------|-------------|---------|
| AI Decision Audit Report | Request (tenant-authorized) | Full audit trail for AI recommendations on specific claims |
| AI Ethics Framework Summary | Request | This document (redacted for proprietary technical detail where necessary) |
| Compliance Certification | Request | Current compliance status for applicable standards |

### 14.4 Employees (Technicians, Estimators, Administrative Staff)

| Communication | When | Content |
|---------------|------|---------|
| "AI in Your Shop" Guide | At AI feature enablement | Plain-language explanation of what AI does, what it does not do, how to override it, how to mute it, employee rights. Available in all supported languages. |
| Voice Agent Introduction | At Phase 4 deployment | Specific guide for voice agent: what it hears, what it stores, how to mute it, what it will never do. In employee's preferred language. |
| Feature Updates | Per release (posted in-shop) | What changed, in plain language. |
| Feedback Channel | Ongoing | Anonymous, accessible way for employees to report AI concerns without going through their manager. |

### 14.5 Regulators

- Full cooperation and documentation within 48 hours of any regulatory request.
- Proactive notification to relevant privacy commissioners if an AI Privacy incident occurs that meets reportable breach thresholds.
- Standing invitation for regulatory observers to attend annual AI Governance Board reviews.

---

## 15. Governance and Review

### 15.1 Document Review Cycle

This document is reviewed and updated:

- **Annually:** Comprehensive review by the AI Governance Board.
- **Per phase launch:** Updated to address new AI capabilities introduced in each phase.
- **After any Severity 1 incident:** Reviewed for adequacy; updated if the incident revealed a gap.
- **Upon regulatory change:** Updated to reflect new legal requirements.

### 15.2 Version Control

All versions of this document are retained. Changes are tracked with:

- Version number
- Date of change
- Summary of changes
- Approval authority

### 15.3 Enforcement

Compliance with this ethics plan is:

- A condition of employment for all Micazen engineering and product staff.
- A condition of the tenant agreement for all BCAI customers.
- Audited by the independent third-party auditor annually.
- Reviewed by the AI Governance Board quarterly.

Violations by Micazen staff are treated as performance issues with consequences up to and including termination. Violations by tenants (e.g., using platform data exports to circumvent worker dignity protections) may result in service modification or termination as specified in the tenant agreement.

---

## 16. Definitions

| Term | Definition |
|------|------------|
| **AI** | Artificial intelligence capabilities within BCAI, including machine learning models, rule-based recommendation engines, natural language processing, and voice recognition/synthesis. |
| **Autonomous action** | An action the AI executes without explicit human approval for each instance (subject to pre-configured approval gates and grace periods). Introduced in Phase 4. |
| **Bay** | A physical workspace in a collision repair shop where a vehicle is repaired. |
| **BC** | The name of the BCAI voice agent (Phase 4). |
| **Bias** | Systematic and unfair discrimination in AI recommendations based on protected characteristics or proxy variables. |
| **Confidence score** | A numerical measure (0-100%) of the AI's certainty in a specific recommendation, based on data quality, historical accuracy, and model reliability for the given context. |
| **Feature owner** | The named individual responsible for a specific AI capability's behavior, accuracy, fairness, and safety. |
| **Grace period** | The configurable time window between when an autonomous AI action is announced and when it executes, during which any authorized user can cancel or modify it. |
| **Human override** | The act of a human rejecting, modifying, or canceling an AI recommendation or autonomous action. |
| **Kill switch** | A single-action control that immediately disables all AI features for a shop. |
| **RO** | Repair Order -- the primary work record for a vehicle repair job. |
| **Sovereign AI** | AI that processes data exclusively on infrastructure controlled by the tenant or by Micazen within the agreed jurisdiction, with no data transmission to third-party cloud AI services. |
| **Tenant** | A shop or network of shops that uses the BCAI platform. |
| **Voice agent** | The AI-powered voice interface deployed in bays (Phase 4), capable of receiving voice commands and delivering spoken responses. |

---

## 17. Document Control

| Field | Value |
|-------|-------|
| **Document Title** | AI Ethics and Ethical Use Plan |
| **Document Code** | MIC-ETHICS-2026-001 |
| **Version** | 1.0 |
| **Status** | Final Draft -- Board Review |
| **Author** | D. Caine Solutions LLC |
| **Reviewed by** | Micazen AI Governance Board |
| **Approved by** | Sharon Ashley, CEO, Micazen Consulting & Technologies |
| **Effective Date** | Upon approval |
| **Next Review** | 12 months from effective date or at Phase 3 launch, whichever is earlier |

---

*This document is the property of Micazen Consulting & Technologies. Distribution is authorized to board members, investors, insurance carrier partners, regulatory bodies, and tenant administrators. Unauthorized distribution is prohibited.*

---

**End of Document**
