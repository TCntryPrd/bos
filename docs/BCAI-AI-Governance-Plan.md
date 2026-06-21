# BCAI AI Governance Plan

## BodyShopConnect AI | Micazen Consulting & Technologies Inc.

| Field | Value |
|-------|-------|
| **Document Version** | 1.0 |
| **Classification** | Confidential -- Micazen Internal + Authorized Partners |
| **Date** | April 5, 2026 |
| **Author** | Starr & Partners LLC (D. Caine Solutions LLC) |
| **Approved By** | Sharon Ashley, Founder & CEO, Micazen Inc. |
| **Review Cycle** | Quarterly minimum; ad hoc upon regulatory change or material system change |
| **Jurisdictions** | Canada (Federal + Provincial), United States (Federal + State), European Union |
| **Applicable Entity** | Micazen Consulting & Technologies Inc. (Canada) |

---

## Executive Summary

This document establishes the comprehensive AI Governance Plan for BodyShopConnect AI (BCAI), the sovereign AI-powered collision repair management platform developed by Micazen Inc. It defines policies, procedures, controls, and accountability structures that ensure BCAI meets or exceeds the requirements of all applicable AI and privacy regulations across Canada, the United States, and the European Union.

BCAI processes sensitive business data, customer personally identifiable information (PII), insurance claims, financial records, and -- in later phases -- voice interaction data. It operates across three regulatory jurisdictions with distinct and sometimes overlapping requirements. This governance plan addresses every AI capability across all five development phases and establishes the controls necessary for a publicly traded customer (AutoCanada) to deploy BCAI with confidence.

**Core Governance Principle:** BCAI recommends. Humans decide. The system never makes autonomous changes to business data, financial records, or operational workflows without explicit human approval. This is not merely a design preference -- it is a contractual, legal, and ethical requirement embedded at the architecture level.

---

## Table of Contents

1. [Definitions and Glossary](#1-definitions-and-glossary)
2. [Regulatory Landscape and Compliance Map](#2-regulatory-landscape-and-compliance-map)
3. [AI Risk Classification](#3-ai-risk-classification)
4. [Data Governance](#4-data-governance)
5. [Algorithmic Transparency and Explainability](#5-algorithmic-transparency-and-explainability)
6. [Human Oversight Framework](#6-human-oversight-framework)
7. [Bias and Fairness](#7-bias-and-fairness)
8. [Privacy Impact Assessment Framework](#8-privacy-impact-assessment-framework)
9. [Voice Data Governance](#9-voice-data-governance)
10. [Incident Response](#10-incident-response)
11. [Audit and Compliance](#11-audit-and-compliance)
12. [Tenant Rights](#12-tenant-rights)
13. [Training Data Governance](#13-training-data-governance)
14. [Third-Party AI Components](#14-third-party-ai-components)
15. [Continuous Monitoring](#15-continuous-monitoring)
16. [Employee and Contractor Training](#16-employee-and-contractor-training)
17. [Version Control and Change Management](#17-version-control-and-change-management)
18. [Appendix A: DPIA Template](#appendix-a-dpia-template)
19. [Appendix B: AI Incident Report Template](#appendix-b-ai-incident-report-template)
20. [Appendix C: Audit Checklist](#appendix-c-audit-checklist)
21. [Appendix D: Compliance Mapping Matrix](#appendix-d-compliance-mapping-matrix)
22. [Appendix E: AI Feature Risk Register](#appendix-e-ai-feature-risk-register)

---

## 1. Definitions and Glossary

| Term | Definition |
|------|-----------|
| **BCAI** | BodyShopConnect AI -- the collision repair management platform |
| **Sovereign LLM** | Self-hosted large language model running on Canadian infrastructure; no data leaves Canadian jurisdiction |
| **Tenant** | An individual collision repair shop or network operating on the BCAI platform |
| **Network Tenant** | A franchise or corporate group (e.g., AutoCanada, CSN Collision) with multiple shops |
| **PII** | Personally Identifiable Information as defined by PIPEDA, GDPR, and applicable state laws |
| **DPIA** | Data Protection Impact Assessment |
| **AI System** | Any component of BCAI that uses machine learning, natural language processing, or statistical modeling to generate outputs, recommendations, or predictions |
| **Human-in-the-Loop (HITL)** | Requirement that a human reviews and approves AI-generated recommendations before they take effect |
| **Approval Gate** | A system-enforced checkpoint where AI execution pauses until human authorization is received |
| **Brad** | The per-bay voice agent identity deployed in Phase 4 |
| **BC Voice** | The click-to-talk AI assistant deployed in Phase 1 |
| **Kill Switch** | Mechanism to immediately disable any AI capability at tenant, feature, or system level |
| **Data Residency** | The physical geographic location where data is stored and processed |
| **Cross-Tenant Isolation** | Architectural guarantee that no tenant can access, infer, or be affected by another tenant's data |
| **SOP** | Standard Operating Procedure -- codified business process rules |
| **RO** | Repair Order -- the primary business document in collision repair |
| **CIECA** | Collision Industry Electronic Commerce Association -- data standard |
| **Drift** | Gradual degradation or change in AI model behavior over time |

---

## 2. Regulatory Landscape and Compliance Map

### 2.1 Canadian Regulations

| Regulation | Status | Applicability to BCAI | Key Requirements |
|-----------|--------|----------------------|-----------------|
| **PIPEDA** (Personal Information Protection and Electronic Documents Act) | In force | All commercial activity involving personal information | Consent, purpose limitation, accuracy, safeguards, openness, individual access, challenging compliance |
| **AIDA** (Artificial Intelligence and Data Act) | Passed as part of Bill C-27; implementation pending | All AI systems used in commercial activity in Canada | Risk classification, transparency, bias mitigation, human oversight, record-keeping |
| **CPPA** (Consumer Privacy Protection Act) | Part of Bill C-27; pending implementation | Replaces Part 1 of PIPEDA when enacted | Enhanced consent, algorithmic transparency, data portability, de-identification, private right of action |
| **Quebec Law 25** (Act to Modernize Legislative Provisions Respecting the Protection of Personal Information) | In force (phased: 2022-2024) | Any processing of Quebec residents' data | DPIA mandatory, privacy by design, consent specificity, breach notification 72h, cross-border restrictions |
| **Alberta PIPA** | In force | Alberta shop operations | Substantially similar to PIPEDA with provincial enforcement |
| **BC PIPA** | In force | British Columbia shop operations | Substantially similar to PIPEDA with provincial enforcement |

### 2.2 European Union Regulations

| Regulation | Status | Applicability to BCAI | Key Requirements |
|-----------|--------|----------------------|-----------------|
| **EU AI Act** (Regulation 2024/1689) | In force (phased: 2025-2027) | AI systems offered or used in the EU market | Risk-based classification, conformity assessment, transparency, human oversight, technical documentation, post-market monitoring |
| **GDPR** (General Data Protection Regulation) | In force | Processing of EU residents' personal data | Lawful basis, data minimization, purpose limitation, right to explanation (Art. 22), right to erasure, DPIAs, 72h breach notification, adequacy decisions for transfers |
| **AI Liability Directive** (proposed) | In development | AI systems deployed in EU | Reversal of burden of proof for AI-caused damage, presumption of causality, disclosure obligations |

### 2.3 United States Regulations

| Regulation | Status | Applicability to BCAI | Key Requirements |
|-----------|--------|----------------------|-----------------|
| **NIST AI Risk Management Framework** | Published (voluntary) | Best practice for US operations | Govern, Map, Measure, Manage lifecycle; risk identification and mitigation |
| **Colorado AI Act** (SB 24-205) | Signed; effective Feb 1, 2026 | Deployers of high-risk AI in Colorado | Risk management, impact assessments, consumer notification, disclosure of AI interaction, annual review |
| **California CCPA/CPRA** | In force | Processing California residents' data | Opt-out rights, data deletion, automated decision-making disclosure, data minimization |
| **NYC Local Law 144** | In force | Automated employment decision tools used in NYC | Bias audit by independent auditor, public posting of audit results, candidate notification |
| **Illinois BIPA** (Biometric Information Privacy Act) | In force | Collection or use of biometric identifiers in Illinois | Written consent before collection, retention/destruction schedule, prohibition on sale, private right of action |
| **Texas CUBI** (Capture or Use of Biometric Identifiers Act) | In force | Biometric data of Texas residents | Consent, no sale without consent, destruction schedule |
| **Washington My Health My Data Act** | In force | Health-related data of Washington residents | Consent for health data, geofencing restrictions |

### 2.4 International Standards

| Standard | Status | Applicability to BCAI | Key Requirements |
|---------|--------|----------------------|-----------------|
| **ISO/IEC 42001:2023** | Published | AI management system certification | AI policy, risk assessment, AI system lifecycle management, third-party management, data governance |
| **ISO/IEC 27001:2022** | Published | Information security management | ISMS, risk treatment, access control, incident management, business continuity |
| **SOC 2 Type II** | Audit standard | Trust service criteria | Security, availability, processing integrity, confidentiality, privacy |
| **ISO/IEC 27701:2019** | Published | Privacy information management | Extension of 27001 for privacy; maps to GDPR and PIPEDA |

---

## 3. AI Risk Classification

### 3.1 EU AI Act Risk Framework Applied to BCAI

The EU AI Act establishes four risk tiers. Every AI capability in BCAI is classified below. BCAI contains **no unacceptable-risk AI systems**. The majority of BCAI's AI capabilities fall into the **limited-risk** and **minimal-risk** categories. Select capabilities in workforce management and financial recommendation are classified as **high-risk** and subject to enhanced controls.

### 3.2 Phase-by-Phase AI Feature Classification

#### Phase 1: Core Platform + Click-to-Talk AI

| AI Feature | Description | EU AI Act Risk Level | Rationale | Controls Required |
|-----------|-------------|---------------------|-----------|-------------------|
| BC Voice (Click-to-Talk) | Natural language interface for querying system data and issuing commands | **Limited** | AI system interacting with humans; no autonomous decisions | Transparency: users informed they interact with AI; all commands require confirmation |
| CIECA Import Field Mapping | AI-suggested mapping of estimate fields to BC data model | **Minimal** | Assistive tool; human reviews all mappings before import | Logging of suggestions vs. accepted mappings |
| Basic Report Generation | AI-assisted report formatting and summary generation | **Minimal** | Content generation; no decision-making | AI-generated content labeled as such |

#### Phase 2: Full AI Assistance + Sovereign LLM

| AI Feature | Description | EU AI Act Risk Level | Rationale | Controls Required |
|-----------|-------------|---------------------|-----------|-------------------|
| Sovereign LLM | Self-hosted language model for all AI processing | **Limited** | Foundation model used in commercial application | Technical documentation, transparency, data governance per AI Act Art. 53 |
| AI Workflow Suggestions | Recommendations for next steps in RO workflow | **Limited** | Advisory only; human confirms every action | Explainability: each suggestion traces to triggering data; approval gate enforced |
| Scheduling Optimization | AI-suggested technician scheduling and bay allocation | **High** | Affects worker task assignment and working conditions | Bias testing, human oversight, impact assessment, documentation per AI Act Art. 6/Annex III |
| Parts Prediction | Suggested parts orders based on estimate analysis | **Limited** | Financial recommendation; human approves all orders | Traceability to estimate data; cost impact disclosed |
| Recommendation Engine (Self-Healing) | Detects workflow inefficiencies and suggests corrections | **Limited** | Advisory; no autonomous action | All recommendations logged with reasoning; human approval required |
| Job Costing AI Assistance | AI-calculated labor and material cost suggestions | **Limited** | Financial advisory; human reviews all figures | Source data attribution; variance flagging |

#### Phase 3: Network-Ready + AutoCanada Pilot

| AI Feature | Description | EU AI Act Risk Level | Rationale | Controls Required |
|-----------|-------------|---------------------|-----------|-------------------|
| SOP Enforcement Engine | Monitors compliance with standard operating procedures | **High** | Evaluates worker compliance; affects employment conditions | Bias audit, transparency to affected workers, appeal process, documentation |
| Cross-Shop Benchmarking AI | Compares performance metrics across network shops | **Limited** | Analytical tool; privacy-controlled aggregation | Tenant isolation in comparisons; no individual worker identification in cross-shop data |
| AI-Powered Analytics | Trend detection, anomaly identification in business data | **Minimal** | Statistical analysis; no autonomous action | Methodology documentation; confidence intervals displayed |
| Customer Portal AI | AI-assisted customer communication and status updates | **Limited** | Customer-facing AI interaction | Transparency: customers informed of AI involvement; human review of customer-facing content |

#### Phase 4: Voice in Every Bay (Brad)

| AI Feature | Description | EU AI Act Risk Level | Rationale | Controls Required |
|-----------|-------------|---------------------|-----------|-------------------|
| Wake Word Detection | On-device "Hey BC" detection | **Limited** | Biometric-adjacent (voice); local processing only | No recording before wake word; on-device processing; BIPA/biometric compliance |
| Per-Bay Voice Agents (Brad) | Persistent voice AI assistants per repair bay | **High** | Continuous workplace AI; affects worker conditions; processes voice biometric data | Full HITL; voice data governance; worker consent; union consultation where applicable; bias testing |
| Autonomous Workflow with Approval Gates | AI executes workflow steps after explicit human approval | **High** | AI system with execution capability; financial and operational impact | Multi-level approval gates; kill switch; full audit trail; rollback capability |
| Voice Analytics | Analysis of voice interaction patterns for quality improvement | **High** | Worker surveillance adjacent; voice biometric processing | Consent, purpose limitation, aggregation requirements, opt-out capability |
| Multi-Bay Orchestration | AI coordination across multiple bays simultaneously | **Limited** | Scheduling/logistics optimization | Transparency to workers; override capability per bay |

#### Phase 5: Migration + Scale + Predictive AI

| AI Feature | Description | EU AI Act Risk Level | Rationale | Controls Required |
|-----------|-------------|---------------------|-----------|-------------------|
| Predictive Demand Forecasting | Predicts future repair volume and resource needs | **Limited** | Business intelligence; advisory only | Methodology disclosure; confidence intervals; human validation |
| Parts Demand Prediction | Anticipates parts requirements based on historical patterns | **Limited** | Inventory optimization; human approves all orders | Traceability; financial impact disclosure |
| Revenue Modeling | AI-generated financial projections | **Limited** | Financial advisory; no autonomous financial actions | Assumptions disclosed; scenario analysis; not a guarantee |
| Migration Data Mapping | AI-assisted data mapping from legacy systems | **Minimal** | Assistive tool; human validates all mappings | Validation reports; rollback capability |
| White-Label Customization AI | AI-assisted platform customization for white-label partners | **Minimal** | Content/configuration assistance | Human review of all customizations before deployment |

### 3.3 Risk Classification Summary

| Risk Level | Count of AI Features | Governance Tier |
|-----------|---------------------|----------------|
| **Unacceptable** | 0 | N/A -- BCAI does not deploy prohibited AI |
| **High** | 5 | Enhanced: conformity assessment, bias audit, DPIA, human oversight, incident reporting, post-market monitoring |
| **Limited** | 13 | Standard: transparency, logging, explainability, human confirmation |
| **Minimal** | 4 | Baseline: documentation, voluntary codes of practice |

### 3.4 Policy Statement: Risk Classification Review

**POLICY GOV-RISK-001:** Every new AI feature added to BCAI must be classified under this risk framework before development begins. Classification must be approved by the AI Governance Officer and documented in the AI Feature Risk Register (Appendix E). Reclassification review occurs quarterly or upon material change to feature scope.

---

## 4. Data Governance

### 4.1 Data Classification

| Data Category | Classification | Examples | Handling Requirements |
|--------------|---------------|----------|----------------------|
| **Customer PII** | Confidential | Names, addresses, phone numbers, email, vehicle VIN, insurance policy numbers | Encrypted at rest and in transit; access by role only; retention limits; right to erasure |
| **Business Financial Data** | Confidential | Revenue, costs, profit margins, labor rates, parts pricing | Tenant-isolated; encrypted; access restricted to authorized roles |
| **Insurance Claims Data** | Confidential | Claim numbers, adjuster info, coverage details, liability determinations | Purpose-limited to claim processing; no cross-tenant sharing; retention per insurance regulations |
| **Employee/Technician Data** | Confidential | Names, certifications, performance metrics, scheduling data, voice data | Employment law protections; consent for AI processing; bias protections |
| **AI Interaction Data** | Internal | Queries to BC Voice/Brad, AI responses, approval/rejection decisions | Logged for audit; anonymized for system improvement; tenant-isolated |
| **Aggregated Analytics** | Internal | Cross-shop benchmarks (anonymized), industry trends | De-identified per PIPEDA/GDPR standards; statistical disclosure controls |
| **System Telemetry** | Internal | Error logs, performance metrics, model inference times | No PII; retained for operational purposes |
| **Voice Recordings** | Restricted | Post-wake-word audio (Phase 4) | Highest protection; explicit consent; shortest retention; BIPA compliance |

### 4.2 Data Collection Principles

**POLICY GOV-DATA-001:** BCAI collects only the minimum data necessary for the stated purpose. No speculative data collection.

**POLICY GOV-DATA-002:** Every data field collected must map to a documented business purpose. Data fields without a documented purpose must be removed within 30 days of identification.

**POLICY GOV-DATA-003:** Consent is obtained before or at the time of collection. Consent is specific (per purpose), informed (plain language), and revocable. For Quebec operations, consent meets Law 25 enhanced specificity requirements.

### 4.3 Data Processing

**POLICY GOV-DATA-004:** All AI processing of tenant data occurs within the sovereign LLM infrastructure on Canadian soil (AWS ca-central-1, Montreal). No tenant data is transmitted to third-party AI providers.

**POLICY GOV-DATA-005:** The sovereign LLM maintains zero persistent memory between requests. No tenant context persists in the model after a request completes. Cross-request context is maintained only in the application layer, within tenant isolation boundaries.

**POLICY GOV-DATA-006:** AI processing is purpose-limited. Data collected for repair order management is not used for marketing, profiling, or any secondary purpose without separate explicit consent.

### 4.4 Per-Tenant Data Isolation

| Control | Implementation | Verification |
|---------|---------------|-------------|
| Database isolation | Per-tenant PostgreSQL schema; no shared data tables for tenant business data | Automated schema isolation tests in CI/CD |
| Application isolation | Tenant context enforced at middleware layer; every database query scoped to authenticated tenant | Penetration testing quarterly |
| AI isolation | LLM requests include only the requesting tenant's data; no cross-tenant context injection | Request/response logging with tenant ID verification |
| Network isolation | Tenant data never traverses another tenant's network segment | Network architecture audit annually |
| Backup isolation | Per-tenant backup encryption keys; cross-tenant backup access architecturally impossible | Backup restoration test quarterly |

**POLICY GOV-DATA-007:** Cross-tenant data isolation is absolute. No data from Tenant A is ever visible to, inferred by, or used in processing for Tenant B. This applies to:
- Direct database queries
- AI model context
- Analytics and benchmarking (anonymized aggregation only, with minimum group sizes)
- Log files and telemetry
- Backup and disaster recovery

**POLICY GOV-DATA-008:** Network data sharing agreements (e.g., AutoCanada viewing aggregate data across its shops) require explicit contractual authorization. Even within a network, individual shop data is accessible only to roles with documented authorization in the RBAC hierarchy.

### 4.5 Cross-Border Data Flow

| Data Flow | Permitted? | Conditions |
|-----------|-----------|-----------|
| Canadian tenant data stored in Canada | Yes | Default and mandatory for Canadian tenants |
| Canadian tenant data processed in Canada | Yes | Sovereign LLM in ca-central-1 |
| Canadian tenant data transferred to US | No | Prohibited without explicit tenant consent and adequacy assessment |
| Canadian tenant data transferred to EU | No | Prohibited without explicit tenant consent and adequacy assessment |
| US tenant data stored in US | Yes | US infrastructure for US tenants (when deployed) |
| US tenant data processed in Canada | Conditional | Permitted if US tenant consents; Canada has adequate protections |
| EU tenant data stored in EU | Yes | Required under GDPR; EU infrastructure for EU tenants (when deployed) |
| EU tenant data transferred to Canada | Conditional | Canada has EU adequacy decision; standard contractual clauses as backup |
| EU tenant data transferred to US | No | Not permitted without EU-US Data Privacy Framework certification or SCCs |

**POLICY GOV-DATA-009:** Canadian client data must remain on Canadian infrastructure at all times. This is non-negotiable and architecturally enforced through data residency controls in the infrastructure layer.

**POLICY GOV-DATA-010:** Cross-border data transfers require: (a) documented legal basis, (b) adequacy assessment or appropriate safeguards, (c) explicit tenant notification, (d) Data Transfer Impact Assessment, and (e) approval by the Data Protection Officer.

### 4.6 Data Retention and Deletion

| Data Category | Retention Period | Deletion Method | Legal Basis |
|--------------|-----------------|----------------|------------|
| Active repair orders | Duration of active use + 7 years | Secure erasure (cryptographic) | Tax/insurance record requirements |
| Completed repair orders | 7 years from completion | Secure erasure | CRA requirements; provincial limitation periods |
| Customer PII (active) | Duration of business relationship | N/A | Ongoing consent |
| Customer PII (inactive) | 2 years from last interaction | Secure erasure + verification | Purpose limitation; right to erasure |
| AI interaction logs | 3 years | Secure erasure | Audit trail; regulatory compliance |
| Voice recordings | 90 days maximum | Secure erasure with certificate | BIPA; data minimization |
| Voice transcriptions (anonymized) | 1 year | Secure erasure | System improvement; consent-based |
| System telemetry | 1 year | Standard deletion | Operational necessity |
| AI model training artifacts | Life of model version + 2 years | Secure erasure | Reproducibility; audit requirements |
| Audit logs | 7 years | Archive then secure erasure | Regulatory compliance |

**POLICY GOV-DATA-011:** Tenants may request deletion of their data at any time. Deletion is completed within 30 days of verified request. A deletion certificate is provided. Data required for legal retention (e.g., tax records) is retained in locked archive with access only for legal/compliance purposes and is deleted when the retention period expires.

**POLICY GOV-DATA-012:** Upon tenant offboarding, all tenant data is exported in portable format (JSON/CSV) and delivered to the tenant, then securely erased from BCAI systems within 60 days. Confirmation of deletion is provided in writing.

---

## 5. Algorithmic Transparency and Explainability

### 5.1 Transparency Principles

**POLICY GOV-TRANS-001:** Every user interacting with an AI component of BCAI is informed that they are interacting with an AI system. This disclosure is:
- Persistent (not dismissable or hidden)
- Clear (plain language, not legal jargon)
- Contextual (explains what the AI does in this specific interaction)

**POLICY GOV-TRANS-002:** Every AI-generated recommendation, suggestion, or output is visually distinguished from system-generated or human-generated content. AI outputs are labeled with:
- "AI Recommendation" or equivalent label
- Confidence indicator where applicable
- Source data attribution
- Timestamp of generation

### 5.2 Explainability Requirements by Risk Level

| Risk Level | Explainability Requirement | Implementation |
|-----------|---------------------------|---------------|
| **High-risk** | Full explanation: what data was used, what model produced the output, what alternatives were considered, what the confidence level is, and how to challenge the recommendation | Dedicated explanation panel; exportable explanation report |
| **Limited-risk** | Standard explanation: source data referenced, reasoning summary, confidence indicator | Inline explanation tooltip or expandable detail |
| **Minimal-risk** | Basic attribution: AI-generated label, source data reference | Label and link to source data |

### 5.3 Traceability

**POLICY GOV-TRANS-003:** Every AI-generated recommendation is traceable to its source data. The traceability chain includes:

1. **Input data**: Specific data records that were provided to the AI model (with record IDs)
2. **Model version**: Exact model version and configuration that produced the output
3. **Prompt/context**: The system prompt and user query that triggered the output (tenant-isolated)
4. **Output**: The full AI response before any post-processing
5. **Post-processing**: Any transformations applied to the AI output
6. **Presentation**: How the output was displayed to the user
7. **User action**: Whether the user accepted, rejected, or modified the recommendation
8. **Timestamp**: UTC timestamp at each stage

**POLICY GOV-TRANS-004:** Traceability records are retained for the duration specified in the data retention schedule (Section 4.6) and are available for audit, tenant request, and regulatory inquiry.

### 5.4 Right to Explanation

**POLICY GOV-TRANS-005:** In compliance with GDPR Article 22 and AIDA transparency requirements, any individual affected by an AI-generated recommendation has the right to:
- Receive a meaningful explanation of the logic involved
- Understand the significance and envisaged consequences
- Contest the recommendation through defined channels
- Request human review of the recommendation

This right applies regardless of whether the recommendation was accepted by the human operator. The explanation must be provided in plain language within 30 days of request (GDPR) or as specified by applicable regulation.

### 5.5 Model Documentation

**POLICY GOV-TRANS-006:** The sovereign LLM and all AI models used in BCAI are documented according to EU AI Act Article 11 technical documentation requirements:

| Documentation Element | Content |
|----------------------|---------|
| General description | Purpose, intended use, foreseeable misuse |
| Technical specifications | Architecture, training methodology, hardware requirements |
| Training data | Sources, preprocessing, representativeness, known limitations (see Section 13) |
| Performance metrics | Accuracy, precision, recall, F1 for each task type; benchmarked against industry standards |
| Risk analysis | Identified risks and mitigation measures |
| Human oversight measures | Approval gates, kill switches, escalation paths |
| Testing and validation | Test methodology, results, known failure modes |
| Post-deployment monitoring | Monitoring plan, drift detection, incident triggers |

---

## 6. Human Oversight Framework

### 6.1 Core Principle

**BCAI recommends. Humans decide.**

This principle is not a guideline -- it is an architectural constraint enforced at the system level. The AI cannot bypass approval gates. There is no configuration that allows fully autonomous AI action on business-critical data without human confirmation.

### 6.2 Approval Gate Taxonomy

| Gate Level | Description | Applies To | Override Allowed? |
|-----------|-------------|-----------|-------------------|
| **Level 1: Informational** | AI provides information; no action proposed | Report generation, data queries, status lookups | N/A -- no action to approve |
| **Level 2: Suggestion** | AI recommends action; user must click to accept | Workflow next steps, scheduling suggestions, parts recommendations | User may dismiss or modify |
| **Level 3: Confirmation** | AI prepares an action; user must explicitly confirm before execution | Financial transactions, customer communications, RO status changes | User must confirm; cannot auto-approve |
| **Level 4: Multi-Party** | AI prepares an action; requires approval from multiple authorized users | SOP overrides, cross-tenant data sharing, system configuration changes | Requires defined quorum |
| **Level 5: Administrative** | AI proposes system-level changes; requires admin + governance approval | Model updates, RBAC changes, data retention policy changes | Governance committee approval |

### 6.3 Phase-Specific Oversight Requirements

#### Phase 1-2: All AI Outputs Require Human Confirmation
- BC Voice commands that modify data: Level 3
- AI workflow suggestions: Level 2
- Scheduling recommendations: Level 3
- Parts ordering suggestions: Level 3
- Financial calculations: Level 2 (display only) or Level 3 (if actioning)

#### Phase 3: Network Operations Add Multi-Party Gates
- SOP enforcement actions: Level 3 (shop level) or Level 4 (network level)
- Cross-shop data sharing: Level 4
- Network-wide policy changes: Level 5

#### Phase 4: Voice and Autonomous Workflows
- Voice commands that modify data: Level 3 (verbal confirmation + optional visual confirmation)
- Autonomous workflow steps: Level 3 minimum; configurable to Level 4
- Brad executing multi-step workflows: Each step individually gated at Level 3
- Voice analytics configuration: Level 5

#### Phase 5: Predictive AI
- Predictive recommendations: Level 2
- Actions based on predictions: Level 3
- Migration execution: Level 4

### 6.4 Kill Switches

**POLICY GOV-HITL-001:** Kill switches exist at four levels and are immediately effective:

| Kill Switch Level | Scope | Who Can Activate | Effect | Recovery |
|------------------|-------|-----------------|--------|---------|
| **Feature** | Single AI feature (e.g., scheduling AI) | Shop Admin, Manager | Feature disabled; manual operation required | Admin re-enables after investigation |
| **Tenant** | All AI features for one tenant | Shop Admin, Micazen Support | AI disabled for tenant; platform operates in manual mode | Admin re-enables; incident report required |
| **System** | All AI features for all tenants | Micazen Operations | AI disabled platform-wide; all tenants operate in manual mode | Governance committee approval to re-enable |
| **Emergency** | Complete system halt | Micazen CTO, CEO | Platform enters maintenance mode | Full incident review before restart |

**POLICY GOV-HITL-002:** Kill switch activation is logged immutably. Every activation generates an incident report (see Section 10). Kill switch activation does not require justification at the time of activation -- investigation follows.

### 6.5 Escalation Paths

```
Technician/User → Shop Manager → Shop Admin → Regional Admin → Network Admin → Micazen Support → AI Governance Officer → Executive Team
```

| Escalation Trigger | First Responder | Escalation Threshold |
|-------------------|----------------|---------------------|
| AI recommendation seems wrong | Shop Manager | If pattern repeats 3+ times: escalate to Micazen Support |
| AI produces harmful/offensive output | Shop Admin (kill switch) | Immediate escalation to Micazen AI Governance Officer |
| AI accesses wrong tenant data | Micazen Support (system kill switch) | Immediate escalation to CTO + legal |
| AI makes unauthorized changes | Shop Admin (tenant kill switch) | Immediate escalation to Micazen Operations |
| Worker reports AI bias | Shop Admin | Escalate to AI Governance Officer within 24 hours |

### 6.6 Human Oversight Governance

**POLICY GOV-HITL-003:** The AI Governance Officer role is established within Micazen with the following responsibilities:
- Quarterly review of approval gate effectiveness
- Annual review of risk classifications
- Investigation of all Level 3+ kill switch activations
- Approval of AI model updates (see Section 17)
- Reporting to Micazen executive team and board

---

## 7. Bias and Fairness

### 7.1 Bias Risk Areas in BCAI

| AI Feature | Bias Risk | Impact | Mitigation |
|-----------|-----------|--------|-----------|
| Scheduling/technician assignment | Unequal distribution of desirable jobs by gender, age, seniority, or ethnicity | Employment discrimination | Fairness metrics in scheduling algorithm; demographic parity testing; human override |
| SOP compliance scoring | Disproportionate flagging of certain workers | Hostile work environment; constructive dismissal claims | Statistical parity analysis; manager review of all flags; appeal process |
| Performance benchmarking | Comparison that disadvantages shops with different demographics | Unfair business pressure | Normalization for shop size, geography, specialty; contextual comparisons only |
| Voice recognition | Lower accuracy for accented speech, non-native speakers | Exclusion from voice features; unequal access | Multi-accent training data; accuracy testing across demographic groups; text input fallback |
| Customer communication AI | Tone or language bias in generated customer messages | Customer discrimination; brand damage | Template-based guardrails; human review of all customer-facing AI content |
| Parts/vendor recommendations | Preference for certain vendors based on training data bias | Unfair commercial advantage; kickback appearance | Vendor recommendation transparency; disclosed criteria; human final selection |

### 7.2 Bias Testing Protocol

**POLICY GOV-BIAS-001:** High-risk AI features undergo bias testing before deployment and quarterly thereafter.

**Testing methodology:**

1. **Demographic parity testing**: For features that affect workers (scheduling, SOP compliance), test that outcomes are distributed equitably across protected categories (gender, age, ethnicity, language, disability status) using industry-standard fairness metrics (demographic parity ratio, equalized odds, calibration)

2. **Disparate impact analysis**: For any AI feature that produces differential outcomes, calculate the four-fifths rule ratio. If any protected group receives favorable outcomes at less than 80% the rate of the most-favored group, the feature is flagged for remediation

3. **Accent and dialect testing**: Voice features are tested against a representative sample of accents found in collision repair workplaces (Canadian English, Canadian French, Spanish, Punjabi, Mandarin, Arabic, Caribbean English, and others based on regional demographics)

4. **Language equity testing**: AI features are tested for equivalent quality in all supported languages (English, French, Spanish). If quality degrades below defined thresholds in non-English languages, the feature is not deployed in that language until remediated

5. **Adversarial testing**: Red-team testing to identify ways the AI could be manipulated to produce biased outputs

### 7.3 Bias Audit Schedule

| Audit Type | Frequency | Auditor | Report Recipient |
|-----------|-----------|---------|-----------------|
| Pre-deployment bias test | Before every high-risk feature launch | Internal AI team + external reviewer | AI Governance Officer |
| Quarterly statistical audit | Every 3 months | Internal AI team | AI Governance Officer; available to tenants on request |
| Annual comprehensive bias audit | Annually | Independent third-party auditor | Board; available to regulators; published summary for NYC LL144 compliance |
| Ad hoc audit | Triggered by complaint or incident | Independent third-party auditor | AI Governance Officer; legal team |

### 7.4 NYC Local Law 144 Compliance

**POLICY GOV-BIAS-002:** If BCAI is used in any capacity that constitutes an Automated Employment Decision Tool (AEDT) under NYC Local Law 144 -- including technician scheduling, performance evaluation, or any function that substantially assists employment decisions -- the following controls apply:

- Annual independent bias audit by a qualified auditor
- Public posting of audit summary on Micazen website
- Notice to candidates/employees at least 10 business days before use
- Posting of AEDT use and data retention information
- Right to request alternative process or accommodation

### 7.5 Remediation Process

When bias is detected:
1. Feature is flagged and AI Governance Officer notified within 24 hours
2. Root cause analysis within 7 days
3. Remediation plan documented and approved within 14 days
4. Fix deployed within 30 days (or feature disabled if fix requires longer)
5. Post-fix bias audit to verify remediation
6. Affected tenants notified of issue and resolution

---

## 8. Privacy Impact Assessment Framework

### 8.1 When a DPIA Is Required

**POLICY GOV-PIA-001:** A Data Protection Impact Assessment (DPIA) is required before:
- Deploying any new AI feature classified as high-risk
- Deploying any AI feature that processes new categories of personal data
- Materially changing the data processing of an existing AI feature
- Introducing voice data processing (Phase 4)
- Entering a new jurisdiction
- Onboarding a network tenant (e.g., AutoCanada) where the tenant's regulatory requirements exceed baseline
- Any processing likely to result in a high risk to individuals' rights and freedoms

### 8.2 DPIA Process

1. **Initiation**: Product/engineering team submits DPIA request to AI Governance Officer
2. **Scoping**: Data Protection Officer defines scope, stakeholders, and timeline
3. **Assessment**: Complete DPIA template (Appendix A)
4. **Review**: AI Governance Officer + legal review
5. **Consultation**: Consult with affected tenants or tenant representatives where appropriate
6. **Approval/Conditions**: DPO approves, conditionally approves (with required mitigations), or rejects
7. **Publication**: DPIA summary made available to affected tenants
8. **Monitoring**: DPIA reviewed annually or upon material change

### 8.3 Completed DPIAs Required Before Phase Launch

| Phase | DPIAs Required |
|-------|---------------|
| Phase 1 | DPIA-001: Click-to-Talk AI (BC Voice); DPIA-002: CIECA Data Import Processing |
| Phase 2 | DPIA-003: Sovereign LLM Deployment; DPIA-004: AI Workflow Suggestions; DPIA-005: Scheduling AI; DPIA-006: Customer Notification AI |
| Phase 3 | DPIA-007: SOP Enforcement Engine; DPIA-008: Cross-Shop Benchmarking; DPIA-009: Customer Portal AI; DPIA-010: AutoCanada Network Processing |
| Phase 4 | DPIA-011: Voice Data Collection and Processing; DPIA-012: Per-Bay Voice Agents; DPIA-013: Autonomous Workflow Execution; DPIA-014: Voice Analytics |
| Phase 5 | DPIA-015: Predictive AI (Demand, Parts, Revenue); DPIA-016: Data Migration Processing; DPIA-017: White-Label Third-Party Processing |

The full DPIA template is provided in Appendix A.

---

## 9. Voice Data Governance

### 9.1 Applicability

This section applies to Phase 4 (Voice in Every Bay) and any Phase 1 click-to-talk features that process audio. Voice data is classified as **Restricted** -- the highest sensitivity classification in BCAI.

### 9.2 Voice Data Lifecycle

```
[Bay Microphone] → [On-Device Wake Word Detection] → [Audio Streamed to Sovereign LLM] → [Transcription] → [NLP Processing] → [Response Generation] → [Audio Playback]
                                                              ↓
                                                    [Transcription Stored]
                                                              ↓
                                                    [Audio Deleted After Processing]
```

### 9.3 Recording and Consent

**POLICY GOV-VOICE-001:** No audio is recorded, streamed, or processed until the wake word is detected. Wake word detection occurs entirely on-device with no network communication. Pre-wake-word audio is never captured, stored, or transmitted.

**POLICY GOV-VOICE-002:** Before voice features are enabled in any shop, the following consent requirements must be met:

| Jurisdiction | Consent Requirement | Method |
|-------------|--------------------|---------| 
| **Canada (PIPEDA)** | Informed, meaningful consent from all individuals whose voice may be captured | Written consent form; conspicuous signage in shop; opt-out alternative (text input) |
| **Canada (Quebec Law 25)** | Express consent; specific to voice processing purpose | Separate consent form for voice; cannot be bundled with general platform consent |
| **EU (GDPR)** | Explicit consent (Art. 9 -- voice as biometric data); or substantial public interest | Explicit opt-in; granular consent management; right to withdraw at any time |
| **US (Illinois BIPA)** | Written informed consent BEFORE collection; disclosure of purpose and retention schedule | BIPA-specific consent form; signed by each individual; retained for 3 years beyond relationship |
| **US (Texas CUBI)** | Informed consent before capture | Written consent; disclosure of commercial purpose |
| **US (California CCPA/CPRA)** | Notice at collection; opt-out right; data deletion right | Privacy notice; Do Not Sell/Share option; deletion request process |
| **US (General)** | Two-party consent states require all-party consent for recording | State-by-state compliance matrix; conspicuous notice in all states |

**POLICY GOV-VOICE-003:** Voice features include a persistent, always-visible indicator (light, icon, or display element) showing:
- When wake word detection is active (listening for wake word only)
- When audio is being streamed/processed (post-wake-word)
- When the system is idle (not listening)

### 9.4 Voice Data Retention

| Data Type | Retention | Storage | Access |
|-----------|----------|---------|--------|
| Raw audio (post-wake-word) | Deleted immediately after transcription | Transient memory only; never written to persistent storage | System process only |
| Transcription | 90 days | Encrypted, tenant-isolated database | Admin, Manager (with audit log) |
| Anonymized transcription (for model improvement) | 1 year | Separate analytics database; no PII | AI engineering team only |
| Voice interaction metadata (timestamp, bay, duration) | 1 year | Tenant database | Admin, Manager |
| Wake word detection events (no audio) | 90 days | Tenant database | Admin |

**POLICY GOV-VOICE-004:** Raw audio is never written to disk, never stored in a database, and never retained after the transcription is complete. This is enforced at the infrastructure level through memory-only audio processing pipelines.

### 9.5 Voice Biometric Protections

**POLICY GOV-VOICE-005:** BCAI does not create, store, or maintain voiceprints, speaker identification profiles, or any biometric template derived from voice data. If speaker identification is implemented in a future phase, it will require:
- Separate DPIA
- Explicit written consent per individual
- Compliance with BIPA, GDPR Art. 9, and all applicable biometric regulations
- Ability to delete all biometric data on request

### 9.6 Visitor and Third-Party Voice Data

**POLICY GOV-VOICE-006:** Shops using voice features must post conspicuous signage informing all individuals (including customers, delivery drivers, and visitors) that voice-activated AI is in use. Signage must include:
- What is captured (audio after wake word only)
- How it is used (shop operations)
- How to opt out (request text-based interaction)
- Contact information for privacy inquiries

---

## 10. Incident Response

### 10.1 AI-Specific Incident Categories

| Category | Severity | Examples | Response Time |
|----------|---------|---------|--------------|
| **AI-01: Incorrect Recommendation** | Low-Medium | AI suggests wrong part; AI miscalculates cost; AI provides inaccurate status | Investigation within 72 hours; remediation within 30 days |
| **AI-02: Harmful or Offensive Output** | High | AI generates discriminatory, offensive, or dangerous content | Immediate kill switch; investigation within 24 hours; root cause within 7 days |
| **AI-03: Data Leak Between Tenants** | Critical | Tenant A sees Tenant B's data in any AI output | Immediate system kill switch; investigation within 4 hours; notification within 24 hours; regulatory notification per schedule below |
| **AI-04: Unauthorized Autonomous Action** | Critical | AI modifies data without human approval; AI bypasses approval gate | Immediate feature/tenant kill switch; investigation within 4 hours; rollback of all unauthorized changes |
| **AI-05: Voice Data Breach** | Critical | Voice recordings exposed; voice data accessed by unauthorized party | Immediate voice feature kill switch; investigation within 4 hours; BIPA notification within statutory period |
| **AI-06: Model Compromise** | Critical | Evidence of model poisoning, adversarial attack, or unauthorized model modification | Immediate system kill switch; investigation within 4 hours; model rollback to last known-good version |
| **AI-07: Bias Incident** | High | Evidence of systematic bias in AI outputs affecting protected groups | Feature suspension within 24 hours; investigation within 7 days; remediation within 30 days |
| **AI-08: Regulatory Non-Compliance** | High | Discovery that AI feature does not meet regulatory requirement | Assessment within 48 hours; remediation plan within 14 days; implementation per severity |

### 10.2 Notification Timelines by Jurisdiction

| Jurisdiction | Notification Deadline | Notify Whom | Threshold |
|-------------|----------------------|------------|-----------|
| **Canada (PIPEDA)** | As soon as feasible | Privacy Commissioner of Canada; affected individuals | Real risk of significant harm |
| **Canada (Quebec Law 25)** | 72 hours | Commission d'acces a l'information du Quebec; affected individuals | Risk of serious injury |
| **Canada (Alberta PIPA)** | Without unreasonable delay | Alberta OIPC; affected individuals | Real risk of significant harm |
| **EU (GDPR)** | 72 hours to authority; without undue delay to individuals | Supervisory authority; affected individuals | Risk to rights and freedoms |
| **EU (AI Act)** | Without undue delay | Market surveillance authority | Serious incident (Art. 62) |
| **US (California CCPA/CPRA)** | Most expedient time; no later than 72 hours | California AG; affected individuals | Breach of unencrypted personal information |
| **US (Illinois BIPA)** | No statutory timeline; sue within 5 years | Affected individuals (private right of action) | Any violation of BIPA |
| **US (Colorado)** | 30 days to AG; as expedient as possible to individuals | Colorado AG; affected individuals | Breach affecting 500+ Coloradans |
| **US (NYC LL144)** | N/A (audit-based) | Published audit; candidate notification | N/A |

### 10.3 Incident Response Procedure

1. **Detection**: Incident identified through monitoring (Section 15), user report, or audit
2. **Triage**: On-call engineer classifies severity using Section 10.1 categories
3. **Containment**: Appropriate kill switch activated; scope of impact assessed
4. **Investigation**: Root cause analysis using traceability records (Section 5.3)
5. **Notification**: Regulatory and individual notifications per Section 10.2 timelines
6. **Remediation**: Fix developed, tested in staging, deployed with approval gate
7. **Recovery**: Affected features restored; affected data corrected; affected tenants notified
8. **Post-Incident Review**: Full post-mortem within 14 days; learnings documented; governance plan updated if needed
9. **Regulatory Reporting**: Final report to regulators as required; annual summary in compliance report

The AI Incident Report Template is provided in Appendix B.

---

## 11. Audit and Compliance

### 11.1 Audit Schedule

| Audit Type | Frequency | Auditor | Scope |
|-----------|-----------|---------|-------|
| **Internal AI governance audit** | Quarterly | AI Governance Officer + internal team | All policies in this document; approval gate effectiveness; kill switch testing; bias metrics |
| **External AI audit** | Annually | Independent third-party auditor | Full AI governance compliance; bias audit; technical controls; regulatory compliance |
| **Penetration test (AI-focused)** | Semi-annually | Independent security firm | Tenant isolation; prompt injection; model manipulation; data exfiltration |
| **SOC 2 Type II audit** | Annually | Certified CPA firm | Security, availability, processing integrity, confidentiality, privacy |
| **ISO 27001 surveillance audit** | Annually (after certification) | Accredited certification body | ISMS controls |
| **ISO 42001 certification audit** | Annually (after certification) | Accredited certification body | AI management system controls |
| **Bias audit (NYC LL144)** | Annually | Independent auditor meeting LL144 qualifications | Disparate impact analysis for AEDT features |
| **DPIA review** | Annually per DPIA; or upon material change | Data Protection Officer | Continued accuracy of each DPIA |
| **Data retention compliance audit** | Semi-annually | Internal compliance team | Verification that data is deleted per retention schedule |
| **Voice data audit** | Quarterly (when Phase 4 active) | Internal AI team + external auditor | Voice data lifecycle compliance; BIPA compliance; consent records |

### 11.2 Audit Record Retention

**POLICY GOV-AUDIT-001:** All audit records, including findings, remediation plans, evidence, and auditor reports, are retained for 7 years. Audit records are stored separately from operational data and are accessible only to the AI Governance Officer, legal team, and authorized auditors.

### 11.3 What Gets Audited

| Audit Area | Specific Items |
|-----------|---------------|
| **Approval gates** | Every approval gate activation in the audit period; acceptance/rejection rates; bypass attempts (should be zero) |
| **Kill switches** | All activations; response times; recovery procedures |
| **AI outputs** | Random sample of AI recommendations; accuracy assessment; explainability verification |
| **Tenant isolation** | Cross-tenant data access attempts (should be zero); isolation test results |
| **Bias metrics** | Fairness metrics for high-risk features; trends over time |
| **Data retention** | Sample verification that deleted data is actually deleted; retention schedule compliance |
| **Consent records** | Completeness and validity of consent records; withdrawal processing |
| **Training data** | Provenance verification; cross-tenant contamination check |
| **Model versions** | Deployment history; rollback capability verification; change authorization records |
| **Incident response** | All incidents; response time compliance; remediation completion |
| **Voice data** | Audio deletion verification; consent record completeness; BIPA compliance |

### 11.4 Audit Checklist

A detailed audit checklist is provided in Appendix C.

---

## 12. Tenant Rights

### 12.1 Rights Framework

**POLICY GOV-TENANT-001:** Every tenant has the following rights, exercisable at any time through the BCAI administration interface or by written request to Micazen:

| Right | Description | Response Timeline | Regulatory Basis |
|-------|-----------|------------------|-----------------|
| **Data export** | Export all tenant data in machine-readable format (JSON, CSV) | 30 days | GDPR Art. 20; CPPA data portability; CCPA |
| **AI decision explanation** | Request explanation of any AI recommendation that affected their business | 30 days | GDPR Art. 22; AIDA; Colorado AI Act |
| **AI feature opt-out** | Disable any or all AI features for their tenant; platform operates in manual mode | Immediate (self-service) | Consent withdrawal; GDPR Art. 7(3) |
| **Data deletion** | Request deletion of all tenant data (subject to legal retention requirements) | 30 days | GDPR Art. 17; PIPEDA Principle 9; CCPA |
| **Consent withdrawal** | Withdraw consent for specific data processing activities | 15 days for effect | GDPR Art. 7(3); PIPEDA |
| **Processing restriction** | Request that specific data not be processed by AI | 15 days for effect | GDPR Art. 18; PIPEDA |
| **Data correction** | Request correction of inaccurate personal data | 30 days | GDPR Art. 16; PIPEDA Principle 6 |
| **Audit access** | Request access to audit reports relevant to their tenant | 30 days | Contractual; SOC 2 |
| **Incident notification** | Be notified of any incident affecting their data | Per Section 10.2 timelines | GDPR; PIPEDA; state breach laws |
| **AI interaction history** | Request complete history of AI interactions for their tenant | 30 days | Transparency; GDPR Art. 15 |
| **Voice data deletion** | Request immediate deletion of all voice data for their tenant | 72 hours | BIPA; GDPR Art. 17 |
| **Objection to profiling** | Object to any automated profiling of their workers or customers | 15 days for effect | GDPR Art. 21 |

### 12.2 Network Tenant Rights (AutoCanada and Similar)

Network tenants have additional rights:
- View aggregate (anonymized) data across their network shops
- Enforce network-wide SOP policies (subject to individual shop employee consent for AI features)
- Request network-level audit reports
- Mandate AI feature configuration across their shops (within the bounds of this governance plan)
- Data portability for the entire network dataset

**POLICY GOV-TENANT-002:** Network tenant rights do not override individual shop employee rights. If a network mandates an AI feature and an individual employee objects (e.g., to voice processing), the employee's objection takes precedence for their own data.

### 12.3 AutoCanada-Specific Provisions

As a publicly traded company, AutoCanada requires enhanced governance:
- All AI-related changes to AutoCanada's BCAI instance require 30-day advance notice
- Quarterly governance report provided to AutoCanada's compliance team
- Annual independent audit results shared with AutoCanada
- Material AI incidents affecting AutoCanada reported within 4 hours (supporting their continuous disclosure obligations)
- AI governance documentation available for AutoCanada's auditors upon request

---

## 13. Training Data Governance

### 13.1 Training Data Sources

| Source | Content | Use | Consent |
|--------|---------|-----|---------|
| **Industry SOPs** | Collision repair standard operating procedures (OEM, I-CAR, CCAR) | Fine-tuning sovereign LLM for industry terminology and workflows | Publicly available; licensed where applicable |
| **CIECA standards** | Data format specifications, field definitions | Parsing and mapping accuracy | Industry standard; licensed |
| **De-identified historical data** | Anonymized, aggregated repair patterns (no PII, no tenant identification) | Model performance improvement | Consent obtained; de-identification verified by DPO |
| **Tenant-provided SOPs** | Custom SOPs uploaded by tenants for their own use | Tenant-specific AI behavior | Tenant consent for their own use only; never shared cross-tenant |
| **Synthetic data** | AI-generated test data simulating repair scenarios | Testing and validation | No real data; generated to specification |
| **Public collision repair documentation** | Published guides, manuals, regulatory documents | General knowledge | Publicly available |

### 13.2 Cross-Tenant Training Data Prohibition

**POLICY GOV-TRAIN-001:** No tenant's operational data is ever used to train, fine-tune, or improve the AI model for the benefit of other tenants. This is absolute. Specifically:

- Tenant A's repair orders, customer data, financial data, SOPs, and AI interactions are never used to improve AI behavior for Tenant B
- AI model fine-tuning uses only the sources listed in Section 13.1
- If Micazen wishes to use de-identified, aggregated data from multiple tenants for model improvement, each contributing tenant must provide separate, explicit, revocable consent
- Consent is opt-in, not opt-out
- Tenants who do not consent receive identical AI functionality

### 13.3 Tenant SOP as Training Data

**POLICY GOV-TRAIN-002:** When a tenant uploads custom SOPs, these SOPs are used exclusively for that tenant's AI behavior. The SOPs are:
- Stored in the tenant's isolated data environment
- Loaded into AI context only for that tenant's requests
- Never accessed by the sovereign LLM for other tenants' requests
- Deleted when the tenant requests deletion or offboards
- Not included in any aggregate training dataset without explicit consent

### 13.4 Training Data Documentation

**POLICY GOV-TRAIN-003:** All training data used for the sovereign LLM is documented in a Training Data Register that includes:
- Source identification and provenance
- Date acquired
- License/consent basis
- Data preprocessing steps applied
- Known biases or limitations
- Representativeness assessment
- Retention period
- Responsible party

### 13.5 Prohibited Training Data

The following data is prohibited from use in AI training:
- Any PII without explicit, documented consent
- Any data that could identify a specific tenant without consent
- Data acquired through unauthorized means
- Data that violates any license or copyright
- Data that contains known biases without documented mitigation
- Voice recordings (raw audio is never used for training)

---

## 14. Third-Party AI Components

### 14.1 Current Third-Party AI Components

| Component | Provider | Purpose | Data Exposure | Risk |
|----------|---------|---------|---------------|------|
| **Cloud LLM API (Phase 1 only)** | To be determined (temporary until sovereign LLM) | AI processing before sovereign LLM deployment | Queries and responses transit provider infrastructure | Medium -- mitigated by Phase 2 sovereign deployment |
| **Wake word engine (Picovoice Porcupine)** | Picovoice | On-device wake word detection | None -- fully on-device processing | Low |
| **Speech-to-text engine** | To be determined | Transcription of post-wake-word audio | Audio streamed within Canadian infrastructure | Medium -- data residency and retention controls apply |
| **Text-to-speech engine** | To be determined | Voice response generation | Text input within Canadian infrastructure | Low |
| **CIECA parsing libraries** | Industry standard | Estimate data parsing | No external communication | Minimal |

### 14.2 Due Diligence Requirements

**POLICY GOV-3P-001:** Before any third-party AI component is integrated into BCAI, the following due diligence must be completed:

| Assessment Area | Requirement | Documentation |
|----------------|------------|---------------|
| **Data processing** | Where does the component process data? Does data leave Canadian infrastructure? | Written confirmation from vendor |
| **Data retention** | Does the component retain, cache, or log input/output data? | Vendor data processing agreement |
| **Model training** | Does the vendor use BCAI inputs to train its models? | Written opt-out confirmation; contractual prohibition |
| **Security** | SOC 2, ISO 27001, or equivalent certification | Current audit report |
| **Privacy** | GDPR-compliant DPA; PIPEDA-compliant privacy assessment | Executed DPA |
| **Availability** | SLA commitments; failover capability | SLA agreement |
| **Exit strategy** | Can the component be replaced without data loss or service interruption? | Migration plan documented |
| **Regulatory compliance** | Component meets all applicable AI regulations for BCAI's jurisdictions | Vendor compliance attestation |

### 14.3 Third-Party Monitoring

**POLICY GOV-3P-002:** All third-party AI components are monitored for:
- Performance degradation
- Unexpected data flows
- Terms of service changes that affect compliance
- Security vulnerabilities
- Regulatory status changes in the vendor's jurisdiction

Review frequency: quarterly, or immediately upon vendor notification of changes.

### 14.4 Phase 2 Sovereign Transition

**POLICY GOV-3P-003:** The transition from cloud LLM to sovereign LLM in Phase 2 eliminates the highest-risk third-party AI dependency. Post-Phase 2, no tenant operational data is processed by any third-party AI provider. This is the single most important governance improvement in the BCAI lifecycle.

---

## 15. Continuous Monitoring

### 15.1 Monitoring Framework

| Monitoring Area | Metrics | Threshold | Alert | Response |
|----------------|---------|-----------|-------|---------|
| **Model accuracy** | AI recommendation acceptance rate by feature | Below 70% acceptance (rolling 7 days) | Warning to AI Governance Officer | Investigation within 72 hours |
| **Model drift** | Statistical distribution of AI outputs compared to baseline | Divergence exceeding 2 standard deviations | Alert to AI engineering team | Investigation within 48 hours; potential model refresh |
| **Bias metrics** | Fairness metrics per Section 7.2 | Four-fifths rule violation | Alert to AI Governance Officer | Feature suspension review within 24 hours |
| **Tenant isolation** | Cross-tenant data access attempts | Any attempt (should be zero) | Critical alert to CTO | Immediate investigation; potential system kill switch |
| **Approval gate compliance** | Percentage of AI actions with valid human approval | Below 100% | Critical alert | Immediate investigation; feature disabled |
| **Kill switch functionality** | Response time of kill switches | Above 5 seconds | Alert to engineering | Fix within 24 hours |
| **Voice data lifecycle** | Audio deletion within specified timeframe | Any audio persisted beyond processing | Critical alert | Immediate investigation; voice feature suspension |
| **Model inference latency** | P95 response time | Above 5 seconds (text); above 2 seconds (voice) | Warning to engineering | Performance optimization within 7 days |
| **Resource utilization** | GPU/CPU/memory utilization of sovereign LLM | Above 85% sustained | Warning to operations | Capacity planning; scaling within 30 days |
| **Adversarial input detection** | Prompt injection attempts, unusual input patterns | Any detected adversarial pattern | Alert to security team | Immediate investigation; input sanitization review |

### 15.2 Monitoring Infrastructure

**POLICY GOV-MON-001:** AI monitoring runs independently from the AI system being monitored. Monitoring infrastructure:
- Separate logging pipeline from application logs
- Immutable audit log (append-only; no deletion capability)
- Real-time alerting (under 5 minutes from event to alert)
- Dashboard accessible to AI Governance Officer and operations team
- Monitoring data retained for 3 years

### 15.3 Self-Assessment

**POLICY GOV-MON-002:** The sovereign LLM's outputs are continuously evaluated against a set of known-correct test cases (golden set). The golden set:
- Contains at least 500 representative queries across all AI features
- Is updated quarterly to reflect new features and edge cases
- Is tenant-neutral (no real tenant data)
- Includes adversarial test cases
- Is run automatically after every model update and weekly during normal operation

### 15.4 Anomaly Detection

**POLICY GOV-MON-003:** Automated anomaly detection monitors for:
- Sudden changes in AI output distribution
- Unusual patterns in approval gate rejections
- Spikes in AI error rates
- Unexpected data access patterns
- Model behavioral changes not attributable to known updates

---

## 16. Employee and Contractor Training

### 16.1 Training Requirements

| Role | Training Required | Frequency | Content |
|------|------------------|-----------|---------|
| **All Micazen employees** | AI Governance Fundamentals | Annual + onboarding | This governance plan overview; data handling; incident reporting; tenant isolation |
| **AI engineering team** | AI Ethics and Technical Governance | Semi-annual | Bias testing; model documentation; fairness metrics; adversarial testing; responsible AI development |
| **Customer support** | AI Support and Escalation | Semi-annual | How AI features work; common issues; escalation paths; tenant rights; kill switch procedures |
| **Sales and account management** | AI Governance for Customers | Annual | How to explain governance to prospects; tenant rights; compliance positioning; what can and cannot be promised |
| **Executive team** | AI Governance Executive Briefing | Quarterly | Compliance status; risk register; regulatory updates; incident summary |
| **Contractors (engineering)** | AI Governance for Contractors | Before project start + annual | Data handling; tenant isolation; code review requirements; prohibited practices |
| **Contractors (non-engineering)** | Data Handling and Privacy | Before project start | Confidentiality; data classification; prohibited disclosures |
| **Tenant administrators** | BCAI AI Features and Controls | At onboarding + major releases | How AI features work; how to configure AI settings; how to use kill switches; how to exercise tenant rights |
| **Tenant end users (technicians)** | BCAI AI User Guide | At onboarding | What the AI does and does not do; how to confirm/reject recommendations; how to report issues; voice features (when applicable) |

### 16.2 Training Records

**POLICY GOV-TRAIN-EMP-001:** Training completion is recorded and auditable. Records include:
- Employee/contractor name and role
- Training module completed
- Date of completion
- Assessment score (where applicable)
- Acknowledgment of governance policies

Training records are retained for the duration of employment/engagement plus 3 years.

### 16.3 Regulatory Update Training

**POLICY GOV-TRAIN-EMP-002:** When a material regulatory change occurs (e.g., AIDA implementation, new state AI law), affected personnel receive supplemental training within 60 days of the change taking effect.

---

## 17. Version Control and Change Management

### 17.1 AI Model Change Categories

| Category | Description | Approval Required | Testing Required | Rollback Required |
|----------|-----------|------------------|-----------------|-------------------|
| **Critical patch** | Security fix or critical bug in AI model | CTO + AI Governance Officer | Targeted regression; golden set validation | Yes -- immediate rollback capability |
| **Minor update** | Performance improvement; no behavioral change | AI engineering lead | Full regression; golden set validation; bias re-test for high-risk features | Yes -- 48-hour rollback window |
| **Major update** | Behavioral change; new capabilities; model swap | AI Governance Officer + CTO + DPO | Full regression; golden set validation; bias audit; staging deployment for minimum 7 days; DPIA review | Yes -- 30-day rollback window |
| **New feature** | New AI feature deployment | AI Governance Officer + CTO + DPO + risk classification | All above + new DPIA; pre-deployment bias test; tenant notification | Yes -- indefinite rollback capability |

### 17.2 Change Management Process

1. **Proposal**: Engineering submits change request with:
   - Description of change
   - Risk classification impact assessment
   - Test plan
   - Rollback plan
   - DPIA impact (new DPIA needed? existing DPIA update?)

2. **Review**: Appropriate approvers review per Section 17.1

3. **Staging deployment**: Change deployed to staging environment
   - Staging must replicate production configuration
   - Staging period: minimum 48 hours (minor), 7 days (major), 14 days (new feature)
   - Golden set validation must pass
   - Bias testing must pass for high-risk features

4. **Tenant notification**: For major updates and new features:
   - 14 days advance notice to all tenants
   - 30 days advance notice to AutoCanada and other publicly traded tenants
   - Release notes explaining what changed and why

5. **Production deployment**: Gradual rollout
   - Canary deployment to internal test tenants first
   - Phased rollout: 10% of tenants, then 50%, then 100%
   - Each phase: minimum 24 hours with monitoring before expanding

6. **Post-deployment monitoring**: Enhanced monitoring for 7 days after full deployment
   - All Section 15 metrics monitored at elevated sensitivity
   - Rollback triggered automatically if critical thresholds breached

7. **Documentation**: Change record updated with:
   - Actual deployment dates
   - Any issues encountered
   - Monitoring results
   - Sign-off from AI Governance Officer

### 17.3 Rollback Procedure

**POLICY GOV-CHANGE-001:** Every AI model deployment maintains the ability to rollback to the previous version. Rollback:
- Can be initiated by any person authorized to activate a kill switch
- Takes effect within 15 minutes
- Is logged as an incident (Section 10)
- Triggers post-incident review
- Previous model version is retained for minimum 90 days after replacement

### 17.4 Model Version Registry

**POLICY GOV-CHANGE-002:** A model version registry is maintained with:
- Unique version identifier
- Deployment date and time
- Change description
- Training data version reference
- Performance benchmark results
- Bias test results
- Approver signatures
- Rollback status (active, available for rollback, archived)

---

## Appendix A: DPIA Template

### Data Protection Impact Assessment

---

**DPIA Reference Number:** DPIA-[XXX]

**Feature/System Name:** [Name]

**Assessment Date:** [Date]

**Assessor:** [Name and Role]

**Approver:** [DPO Name]

---

#### Section 1: Description of Processing

| Item | Response |
|------|---------|
| What personal data is processed? | [List all PII categories] |
| What is the purpose of processing? | [Specific business purpose] |
| What is the legal basis for processing? | [Consent / Legitimate interest / Contract / Legal obligation] |
| Who are the data subjects? | [Customers / Employees / Technicians / Visitors] |
| How is data collected? | [User input / Automated / Voice / Imported] |
| Where is data stored? | [Canadian infrastructure / specific region] |
| How long is data retained? | [Per retention schedule] |
| Who has access to the data? | [Roles and access controls] |
| Is data shared with third parties? | [Yes/No; if yes, list parties and legal basis] |
| Does data cross borders? | [Yes/No; if yes, list countries and safeguards] |

#### Section 2: AI-Specific Assessment

| Item | Response |
|------|---------|
| What AI model processes this data? | [Sovereign LLM / specific model] |
| What decisions or recommendations does the AI make? | [List all AI outputs] |
| Is human oversight required for AI outputs? | [Yes -- describe approval gate level] |
| Can the AI output be explained? | [Describe explainability mechanism] |
| Has bias testing been conducted? | [Yes/No; if yes, attach results] |
| What is the EU AI Act risk classification? | [Unacceptable / High / Limited / Minimal] |
| What happens if the AI fails? | [Describe fallback/degradation behavior] |

#### Section 3: Risk Assessment

| Risk | Likelihood (1-5) | Impact (1-5) | Risk Score | Mitigation |
|------|-----------------|-------------|-----------|-----------|
| Data breach | [Score] | [Score] | [L x I] | [Describe mitigation] |
| Cross-tenant data exposure | [Score] | [Score] | [L x I] | [Describe mitigation] |
| Biased AI output | [Score] | [Score] | [L x I] | [Describe mitigation] |
| Unauthorized autonomous action | [Score] | [Score] | [L x I] | [Describe mitigation] |
| Consent failure | [Score] | [Score] | [L x I] | [Describe mitigation] |
| Cross-border data transfer | [Score] | [Score] | [L x I] | [Describe mitigation] |
| Model failure/degradation | [Score] | [Score] | [L x I] | [Describe mitigation] |
| [Additional risks as applicable] | | | | |

#### Section 4: Consultation

| Stakeholder | Date Consulted | Outcome |
|------------|---------------|---------|
| Data Protection Officer | [Date] | [Approved / Conditions / Rejected] |
| AI Governance Officer | [Date] | [Approved / Conditions / Rejected] |
| Affected tenant representatives | [Date] | [Feedback summary] |
| Legal counsel | [Date] | [Advice summary] |
| [Others as applicable] | | |

#### Section 5: Decision

| Item | Response |
|------|---------|
| Overall risk level | [Low / Medium / High / Very High] |
| Decision | [Approved / Approved with conditions / Rejected] |
| Conditions (if applicable) | [List conditions] |
| Review date | [Date for next review] |
| DPO signature | [Signature and date] |

---

## Appendix B: AI Incident Report Template

### AI Incident Report

---

**Incident Reference:** AI-INC-[YYYY]-[NNN]

**Date/Time Detected:** [UTC timestamp]

**Date/Time Reported:** [UTC timestamp]

**Reported By:** [Name and Role]

**Severity:** [Low / Medium / High / Critical]

**Category:** [AI-01 through AI-08 per Section 10.1]

---

#### Section 1: Incident Description

| Item | Response |
|------|---------|
| What happened? | [Factual description] |
| Which AI feature was involved? | [Feature name and phase] |
| Which tenants were affected? | [Tenant IDs; or "all tenants" if system-wide] |
| What data was involved? | [Data categories; PII flag] |
| How was the incident detected? | [Monitoring alert / User report / Audit finding] |
| What was the immediate impact? | [Business impact; data impact; individual impact] |

#### Section 2: Containment

| Item | Response |
|------|---------|
| Kill switch activated? | [Yes/No; which level] |
| Time from detection to containment | [Duration] |
| Containment actions taken | [List actions] |
| Is the incident contained? | [Yes / Ongoing] |

#### Section 3: Investigation

| Item | Response |
|------|---------|
| Root cause | [Description] |
| Contributing factors | [List factors] |
| AI traceability chain reviewed? | [Yes/No; findings] |
| Similar past incidents? | [Reference numbers] |
| Model version involved | [Version ID] |

#### Section 4: Notification

| Recipient | Date Notified | Method | Content |
|-----------|-------------|--------|---------|
| Affected tenants | [Date] | [Email/Phone/Portal] | [Summary] |
| Regulatory authority | [Date] | [Official channel] | [Per jurisdiction requirements] |
| Affected individuals | [Date] | [Method] | [Summary] |
| AI Governance Officer | [Date] | [Internal] | [Full report] |
| Executive team | [Date] | [Internal] | [Summary] |

#### Section 5: Remediation

| Item | Response |
|------|---------|
| Remediation plan | [Description] |
| Implementation date | [Date] |
| Testing conducted | [Description and results] |
| Rollback performed? | [Yes/No; details] |
| Data correction required? | [Yes/No; details] |
| Governance plan update required? | [Yes/No; details] |

#### Section 6: Post-Incident Review

| Item | Response |
|------|---------|
| Post-mortem date | [Date] |
| Attendees | [Names and roles] |
| Lessons learned | [List] |
| Process improvements | [List] |
| Follow-up actions | [List with owners and deadlines] |
| Signed off by | [AI Governance Officer signature and date] |

---

## Appendix C: Audit Checklist

### Quarterly Internal AI Governance Audit

**Audit Period:** [Start Date] to [End Date]

**Auditor:** [Name and Role]

**Date Completed:** [Date]

---

#### 1. AI Risk Classification

- [ ] All AI features have current risk classification documented
- [ ] No new AI features deployed without prior risk classification
- [ ] Risk classifications reviewed for accuracy since last audit
- [ ] AI Feature Risk Register (Appendix E) is current

#### 2. Data Governance

- [ ] Tenant data isolation verified through automated tests
- [ ] Cross-border data flow controls verified
- [ ] Data retention schedule compliance verified (sample check)
- [ ] Data deletion requests processed within SLA
- [ ] Consent records complete and current

#### 3. Algorithmic Transparency

- [ ] AI outputs are labeled and distinguishable from non-AI content
- [ ] Explainability mechanisms functional for high-risk features
- [ ] Traceability records complete and retrievable
- [ ] Right to explanation requests processed within SLA

#### 4. Human Oversight

- [ ] All approval gates functional (test each level)
- [ ] Kill switches tested at each level (feature, tenant, system, emergency)
- [ ] Kill switch response time within 5-second requirement
- [ ] No instances of AI bypassing approval gates
- [ ] Escalation paths documented and current

#### 5. Bias and Fairness

- [ ] Bias metrics within acceptable thresholds for all high-risk features
- [ ] No unresolved bias incidents from prior period
- [ ] Bias testing conducted per schedule
- [ ] NYC LL144 audit current (if applicable)

#### 6. Voice Data (Phase 4+)

- [ ] Raw audio deletion verified (never persisted to disk)
- [ ] Voice data retention within 90-day limit
- [ ] Consent records complete for all shops with voice features
- [ ] BIPA compliance verified for Illinois operations
- [ ] Signage requirements verified for shops with voice features

#### 7. Incident Response

- [ ] All incidents from audit period logged and categorized
- [ ] Notification timelines met for all incidents
- [ ] Post-incident reviews completed for all High/Critical incidents
- [ ] Remediation actions completed or on track

#### 8. Third-Party Components

- [ ] Third-party AI component inventory current
- [ ] Vendor compliance attestations current
- [ ] Data processing agreements current
- [ ] No unauthorized third-party AI components in use

#### 9. Training

- [ ] All required personnel have current training records
- [ ] New hires/contractors received required training before access
- [ ] Regulatory update training delivered as needed

#### 10. Change Management

- [ ] All AI model changes followed change management process
- [ ] Rollback capability verified for current model version
- [ ] Model version registry current
- [ ] Tenant notifications sent per requirements

#### Overall Assessment

| Area | Status | Findings | Remediation Required |
|------|--------|----------|---------------------|
| [Each area above] | [Pass / Partial / Fail] | [Description] | [Yes/No; details] |

**Auditor Signature:** _____________________________ **Date:** __________

**AI Governance Officer Review:** _____________________________ **Date:** __________

---

## Appendix D: Compliance Mapping Matrix

This matrix maps each governance policy to the regulations it satisfies.

| Policy | PIPEDA | AIDA | Quebec Law 25 | GDPR | EU AI Act | CCPA/CPRA | Colorado AI Act | NIST AI RMF | NYC LL144 | BIPA | ISO 42001 | ISO 27001 | SOC 2 |
|--------|--------|------|--------------|------|-----------|-----------|----------------|-------------|-----------|------|-----------|-----------|-------|
| **GOV-RISK-001** (Risk classification) | | X | | | X | | X | X | | | X | | |
| **GOV-DATA-001** (Data minimization) | X | | X | X | | X | | X | | | X | | X |
| **GOV-DATA-002** (Purpose mapping) | X | | X | X | | X | | | | | X | | X |
| **GOV-DATA-003** (Consent) | X | | X | X | | X | | | | | | | X |
| **GOV-DATA-004** (Sovereign processing) | X | X | X | X | X | | | | | | X | X | X |
| **GOV-DATA-005** (Zero persistent memory) | X | | X | X | | | | | | | X | | X |
| **GOV-DATA-006** (Purpose limitation) | X | | X | X | | X | | | | | X | | X |
| **GOV-DATA-007** (Tenant isolation) | X | | X | X | | X | | X | | | X | X | X |
| **GOV-DATA-008** (Network data agreements) | X | | X | X | | | | | | | | X | X |
| **GOV-DATA-009** (Canadian data residency) | X | | X | X | | | | | | | | X | X |
| **GOV-DATA-010** (Cross-border transfers) | X | | X | X | | | | | | | X | X | X |
| **GOV-DATA-011** (Tenant deletion rights) | X | | X | X | | X | | | | | | | X |
| **GOV-DATA-012** (Offboarding data export) | X | | X | X | | X | | | | | | | X |
| **GOV-TRANS-001** (AI disclosure) | | X | | X | X | | X | X | | | X | | |
| **GOV-TRANS-002** (AI output labeling) | | X | | X | X | | X | X | | | X | | |
| **GOV-TRANS-003** (Traceability) | | X | | X | X | | X | X | | | X | | X |
| **GOV-TRANS-004** (Traceability retention) | X | X | X | X | X | | X | X | | | X | X | X |
| **GOV-TRANS-005** (Right to explanation) | X | X | | X | X | | X | X | | | X | | |
| **GOV-TRANS-006** (Model documentation) | | X | | | X | | | X | | | X | | |
| **GOV-HITL-001** (Kill switches) | | X | | | X | | X | X | | | X | | X |
| **GOV-HITL-002** (Kill switch logging) | | X | | | X | | | X | | | X | X | X |
| **GOV-HITL-003** (Governance officer) | | X | | X | X | | X | X | | | X | X | X |
| **GOV-BIAS-001** (Bias testing) | | X | | | X | | X | X | X | | X | | |
| **GOV-BIAS-002** (NYC LL144 compliance) | | | | | | | | | X | | | | |
| **GOV-PIA-001** (DPIA requirements) | | | X | X | X | | X | X | | | X | | |
| **GOV-VOICE-001** (No pre-wake recording) | X | | X | X | | X | | | | X | | X | X |
| **GOV-VOICE-002** (Voice consent) | X | | X | X | | X | | | | X | | | X |
| **GOV-VOICE-003** (Voice indicators) | | X | X | X | X | | | | | X | | | |
| **GOV-VOICE-004** (No audio persistence) | X | | X | X | | X | | | | X | | X | X |
| **GOV-VOICE-005** (No voiceprints) | X | | X | X | | X | | | | X | | | |
| **GOV-VOICE-006** (Visitor signage) | X | | X | X | | X | | | | X | | | |
| **GOV-AUDIT-001** (Audit retention) | X | X | X | X | X | X | X | X | | | X | X | X |
| **GOV-TENANT-001** (Tenant rights) | X | X | X | X | | X | X | | | | | | X |
| **GOV-TENANT-002** (Employee vs network rights) | X | | X | X | | X | | | | | | | |
| **GOV-TRAIN-001** (No cross-tenant training) | X | X | X | X | X | X | | X | | | X | | X |
| **GOV-TRAIN-002** (SOP isolation) | X | | X | X | | X | | | | | X | | X |
| **GOV-TRAIN-003** (Training data documentation) | | X | | | X | | | X | | | X | | |
| **GOV-3P-001** (Third-party due diligence) | X | X | X | X | X | X | | X | | | X | X | X |
| **GOV-3P-002** (Third-party monitoring) | | X | | X | X | | | X | | | X | X | X |
| **GOV-3P-003** (Sovereign transition) | X | X | X | X | X | | | X | | | X | X | X |
| **GOV-MON-001** (Independent monitoring) | | X | | | X | | X | X | | | X | X | X |
| **GOV-MON-002** (Golden set testing) | | X | | | X | | | X | | | X | | |
| **GOV-MON-003** (Anomaly detection) | | X | | | X | | | X | | | X | X | X |
| **GOV-CHANGE-001** (Rollback capability) | | X | | | X | | | X | | | X | X | X |
| **GOV-CHANGE-002** (Model version registry) | | X | | | X | | | X | | | X | X | X |
| **GOV-TRAIN-EMP-001** (Training records) | | X | | X | X | | X | X | | | X | X | X |
| **GOV-TRAIN-EMP-002** (Regulatory update training) | | X | | X | X | | X | X | | | X | | |

---

## Appendix E: AI Feature Risk Register

This register is a living document updated as features are developed and deployed.

| Feature ID | Feature Name | Phase | Risk Level | DPIA Ref | Last Bias Test | Last Review | Status | Owner |
|-----------|-------------|-------|-----------|---------|---------------|------------|--------|-------|
| AI-F-001 | BC Voice (Click-to-Talk) | 1 | Limited | DPIA-001 | [Date] | [Date] | [Active/Development/Planned] | [Name] |
| AI-F-002 | CIECA Import Field Mapping | 1 | Minimal | DPIA-002 | N/A | [Date] | [Status] | [Name] |
| AI-F-003 | Basic Report Generation | 1 | Minimal | N/A | N/A | [Date] | [Status] | [Name] |
| AI-F-004 | Sovereign LLM | 2 | Limited | DPIA-003 | [Date] | [Date] | [Status] | [Name] |
| AI-F-005 | AI Workflow Suggestions | 2 | Limited | DPIA-004 | [Date] | [Date] | [Status] | [Name] |
| AI-F-006 | Scheduling Optimization | 2 | High | DPIA-005 | [Date] | [Date] | [Status] | [Name] |
| AI-F-007 | Parts Prediction | 2 | Limited | DPIA-004 | [Date] | [Date] | [Status] | [Name] |
| AI-F-008 | Recommendation Engine | 2 | Limited | DPIA-004 | [Date] | [Date] | [Status] | [Name] |
| AI-F-009 | Job Costing AI | 2 | Limited | DPIA-004 | [Date] | [Date] | [Status] | [Name] |
| AI-F-010 | SOP Enforcement Engine | 3 | High | DPIA-007 | [Date] | [Date] | [Status] | [Name] |
| AI-F-011 | Cross-Shop Benchmarking AI | 3 | Limited | DPIA-008 | [Date] | [Date] | [Status] | [Name] |
| AI-F-012 | AI-Powered Analytics | 3 | Minimal | N/A | N/A | [Date] | [Status] | [Name] |
| AI-F-013 | Customer Portal AI | 3 | Limited | DPIA-009 | [Date] | [Date] | [Status] | [Name] |
| AI-F-014 | Wake Word Detection | 4 | Limited | DPIA-011 | N/A | [Date] | [Status] | [Name] |
| AI-F-015 | Per-Bay Voice Agents (Brad) | 4 | High | DPIA-012 | [Date] | [Date] | [Status] | [Name] |
| AI-F-016 | Autonomous Workflow (Approval Gates) | 4 | High | DPIA-013 | [Date] | [Date] | [Status] | [Name] |
| AI-F-017 | Voice Analytics | 4 | High | DPIA-014 | [Date] | [Date] | [Status] | [Name] |
| AI-F-018 | Multi-Bay Orchestration | 4 | Limited | DPIA-012 | [Date] | [Date] | [Status] | [Name] |
| AI-F-019 | Predictive Demand Forecasting | 5 | Limited | DPIA-015 | [Date] | [Date] | [Status] | [Name] |
| AI-F-020 | Parts Demand Prediction | 5 | Limited | DPIA-015 | [Date] | [Date] | [Status] | [Name] |
| AI-F-021 | Revenue Modeling | 5 | Limited | DPIA-015 | [Date] | [Date] | [Status] | [Name] |
| AI-F-022 | Migration Data Mapping | 5 | Minimal | DPIA-016 | N/A | [Date] | [Status] | [Name] |

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | April 5, 2026 | Starr & Partners LLC | Initial release -- comprehensive AI governance plan covering Phases 1-5, all jurisdictions |

---

## Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Founder & CEO, Micazen Inc. | Sharon Ashley | _______________ | _______________ |
| AI Governance Officer | [TBD] | _______________ | _______________ |
| Data Protection Officer | [TBD] | _______________ | _______________ |
| Chief Technology Officer | [TBD] | _______________ | _______________ |
| Legal Counsel | [TBD] | _______________ | _______________ |

---

*This document is confidential to Micazen Consulting & Technologies Inc. and its authorized partners. Distribution without written authorization is prohibited.*

*Prepared by Starr & Partners LLC (D. Caine Solutions LLC) -- Executive Engineering Division*
