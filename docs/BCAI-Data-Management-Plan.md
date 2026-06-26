# BCAI Data Management Plan
## BodyShopConnect AI -- Sovereign Data Governance

---

**Prepared by:** D. Caine Solutions LLC
8104 E 35th St, Tulsa, OK 74145
inquiry@starrpartners.ai

**Prepared for:** Sharon Ashley & Jim Wraight
Micazen Consulting & Technologies
British Columbia, Canada

**Date:** April 5, 2026
**Version:** 1.0
**Project Code:** MIC-2026-DMP
**Classification:** Confidential

---

## Table of Contents

1. Purpose & Scope
2. Data Classification Framework
3. Data Inventory & Mapping
4. Data Collection Principles
5. Data Storage & Sovereignty
6. Data Retention & Deletion
7. Data Access Control
8. Data Quality
9. Data Portability
10. Backup & Recovery
11. Data Sharing & Third-Party
12. AI Data Governance
13. Monitoring & Compliance
14. Appendices

---

## 1. Purpose & Scope

This Data Management Plan (DMP) governs every byte of data collected, processed, stored, transmitted, retained, and deleted within the BCAI platform operated by Micazen Inc.

**Why this document exists:** BCAI is a multi-tenant collision repair management platform serving independent shops, multi-shop operators (MSOs), regional groups, and national networks. Some of these networks -- AutoCanada, CSN Collision, Consolidated Dealers Group -- are publicly traded or operate under enterprise-grade governance requirements. A single data incident -- one shop seeing another shop's data, one record crossing a border it should not cross, one AI model trained on a competitor's repair history -- ends the business.

Sharon Ashley said it plainly: **"If I have a breach and one shop sees another shop's data... we're done."**

This plan ensures that never happens.

**Scope:** This plan covers:
- All data processed by the BCAI platform (v3 sovereign AI and v4 Ted voice agent)
- All deployment regions (Canada, United States, European Union)
- All tenant tiers (Single Store, MSO, Regional, Network)
- All data processors and sub-processors
- All AI training, inference, and voice processing data
- All backup, archival, and disaster recovery data

**Regulatory framework:** This plan is designed to satisfy:
- **PIPEDA** (Personal Information Protection and Electronic Documents Act) -- Canada
- **BC PIPA** (Personal Information Protection Act) -- British Columbia
- **Alberta PIPA** -- Alberta
- **GDPR** (General Data Protection Regulation) -- European Union (future expansion)
- **CCPA/CPRA** (California Consumer Privacy Act / California Privacy Rights Act) -- United States
- **SOC 2 Type II** controls -- enterprise client requirement
- Network-specific data governance agreements (AutoCanada, CSN, CDG)

---

## 2. Data Classification Framework

### 2.1 Classification Tiers

Every data element in BCAI is assigned one of four classification tiers. The tier determines storage requirements, access controls, transmission rules, and disposal procedures.

| Tier | Label | Definition | Examples |
|------|-------|------------|----------|
| **T1** | **Public** | Data intentionally made available to the public. No business impact if disclosed. | Marketing materials, published pricing tiers, public API documentation |
| **T2** | **Internal** | Data intended for internal use within a tenant. Low business impact if disclosed to another tenant, but violation of trust. | Shop operating hours, general workflow configurations, non-sensitive SOP templates |
| **T3** | **Confidential** | Data that would cause material business harm if disclosed. Subject to contractual or regulatory protection. | Repair order history, customer contact info, vehicle data (VINs), employee records, financial summaries, cycle time analytics, AI-generated recommendations |
| **T4** | **Restricted** | Data subject to the highest regulatory, legal, or contractual protection. Breach triggers mandatory notification. | Insurance claim details, full financial records, PII with SIN/SSN, voice recordings, AI training datasets, network-wide aggregated analytics, DRP agreement terms, authentication credentials |

### 2.2 Data Type Classification Map

| Data Type | Classification | Rationale |
|-----------|---------------|-----------|
| Customer name, phone, email | T3 -- Confidential | PII under PIPEDA/GDPR. Required for service delivery. |
| Customer SIN/SSN (if collected) | T4 -- Restricted | Sensitive PII. Should not be collected unless legally required. |
| Vehicle Identification Numbers (VINs) | T3 -- Confidential | Linked to vehicle ownership. PII adjacent under PIPEDA. |
| Vehicle photos (damage, repair) | T3 -- Confidential | May contain license plates, personal items. Linked to RO. |
| Repair orders (RO data) | T3 -- Confidential | Core business record. Contains customer, vehicle, financial data. |
| CIECA/EMS estimate imports | T3 -- Confidential | Contains line-item repair data, insurer info, customer details. |
| Insurance claim numbers & details | T4 -- Restricted | Subject to insurer data agreements. Breach triggers contractual liability. |
| DRP agreement terms | T4 -- Restricted | Contractual. Disclosure would harm competitive position. |
| Financial records (invoices, payments) | T4 -- Restricted | Subject to tax law retention. Contains payment details. |
| Accounting exports | T3 -- Confidential | Derived from T4 data but formatted for external system. |
| Employee records (name, role, schedule) | T3 -- Confidential | Employment PII under provincial/state law. |
| Employee SIN/SSN, banking info | T4 -- Restricted | Sensitive employment data. Should not be stored in BCAI. |
| Voice recordings (Ted v4) | T4 -- Restricted | Biometric-adjacent data. Consent required. Subject to wiretapping laws. |
| Voice transcripts | T3 -- Confidential | Derived from T4 recordings. Contains operational commands. |
| AI training data (per-tenant) | T4 -- Restricted | Proprietary. Cross-tenant contamination is a termination event. |
| AI model weights (per-tenant fine-tuning) | T4 -- Restricted | Derived from tenant data. Must not be shared or aggregated. |
| AI inference logs | T3 -- Confidential | Contains prompts, responses, context. May include PII. |
| SOP documents | T2 -- Internal | Operational procedures. Competitive value within networks. |
| Shop configuration (bays, users, roles) | T2 -- Internal | Operational. Low sensitivity. |
| Audit logs | T3 -- Confidential | Contains user actions, timestamps, data access records. |
| Session tokens & credentials | T4 -- Restricted | Authentication material. Compromise = unauthorized access. |
| Platform metrics (uptime, performance) | T2 -- Internal | Operational. No PII. |
| Marketing / public content | T1 -- Public | Intentionally public. |

### 2.3 Handling Requirements by Tier

| Requirement | T1 -- Public | T2 -- Internal | T3 -- Confidential | T4 -- Restricted |
|-------------|-------------|----------------|--------------------|--------------------|
| **Storage encryption** | Optional | AES-256 at rest | AES-256 at rest | AES-256 at rest + column-level encryption |
| **Transit encryption** | TLS 1.2+ | TLS 1.2+ | TLS 1.3 required | TLS 1.3 + mutual TLS for service-to-service |
| **Access control** | None | Authenticated users within tenant | Role-based, least privilege | Role-based + MFA + approval workflow |
| **Audit logging** | None | Basic access logs | Full access audit trail | Full audit trail + real-time alerting |
| **Backup encryption** | N/A | Encrypted backups | Encrypted backups, region-locked | Encrypted backups, region-locked, separate key per tenant |
| **Transmission outside region** | Permitted | With approval | Prohibited without DPA | Prohibited. No exceptions. |
| **Disposal method** | Standard delete | Secure delete | Cryptographic erasure | Cryptographic erasure + certificate of destruction |
| **Retention after offboarding** | N/A | Deleted at offboarding | Exported + deleted within 90 days | Exported + cryptographically erased within 90 days + audit |

---

## 3. Data Inventory & Mapping

### 3.1 Complete Data Inventory

| Data Element | Source | Storage Location | Access Roles | Retention Period | Classification |
|-------------|--------|-----------------|--------------|-----------------|----------------|
| Customer name | Manual entry / CIECA import | Tenant DB (RDS) | Shop staff, managers, network admins | Business relationship + 2 years | T3 |
| Customer phone | Manual entry | Tenant DB (RDS) | Shop staff, managers | Business relationship + 2 years | T3 |
| Customer email | Manual entry | Tenant DB (RDS) | Shop staff, managers | Business relationship + 2 years | T3 |
| Customer address | Manual entry / CIECA | Tenant DB (RDS) | Shop staff, managers | Business relationship + 2 years | T3 |
| Vehicle VIN | CIECA import / manual | Tenant DB (RDS) | Shop staff, managers, AI engine | 7 years (linked to RO) | T3 |
| Vehicle make/model/year | Derived from VIN / manual | Tenant DB (RDS) | Shop staff, managers, AI engine | 7 years (linked to RO) | T3 |
| Vehicle photos | Camera upload / mobile app | Object storage (S3, regional) | Shop staff, managers, insurers (if shared) | 7 years (linked to RO) | T3 |
| Repair order (full record) | Created in-app | Tenant DB (RDS) | Shop staff, managers, network admins, AI engine | 7 years | T3 |
| RO line items | CIECA import / manual | Tenant DB (RDS) | Shop staff, managers, AI engine | 7 years | T3 |
| RO status history | System-generated | Tenant DB (RDS) | Managers, network admins | 7 years | T3 |
| CIECA/EMS raw import files | Estimating system export | Object storage (S3, regional) | System only (processed on import) | 1 year (raw file), data persists in RO | T3 |
| Insurance claim number | CIECA import / manual | Tenant DB (RDS) | Shop staff, managers | 7 years (linked to RO) | T4 |
| Insurance carrier details | CIECA import / DRP config | Tenant DB (RDS) | Managers, network admins | Duration of DRP + 2 years | T4 |
| DRP agreement metadata | Admin configuration | Tenant DB (RDS) | Network admins only | Duration of agreement + 2 years | T4 |
| Invoice records | Generated in-app | Tenant DB (RDS) | Managers, accounting role | 7 years | T4 |
| Payment records | Payment processor webhook | Tenant DB (RDS) | Managers, accounting role | 7 years | T4 |
| Accounting export files | Generated on demand | Temporary storage (S3) | Accounting role | 30 days after generation | T3 |
| Employee name, role, contact | Admin entry | Tenant DB (RDS) | Managers, HR role | Employment + 2 years | T3 |
| Employee credentials (hashed) | System-generated | Auth DB (separate) | System only | Duration of employment | T4 |
| Voice recordings (Ted v4) | Bay microphone capture | Object storage (S3, regional) | System only (auto-processed) | 90 days unless flagged | T4 |
| Voice transcripts | AI STT processing | Tenant DB (RDS) | Managers (on request), AI engine | 90 days unless linked to RO action | T3 |
| AI training dataset (tenant) | Derived from tenant RO history | AI storage (regional) | AI engine only | Indefinite within tenant scope | T4 |
| AI model weights (tenant-specific) | Training pipeline | AI storage (regional) | AI engine only | Current + 2 previous versions | T4 |
| AI inference logs | Runtime | Tenant DB (RDS) | System, managers (on request) | 90 days | T3 |
| AI recommendations | Runtime | Tenant DB (RDS) / in-memory | Shop staff, managers | Session duration (not persisted unless acted upon) | T3 |
| SOP documents | Admin upload / AI-generated | Tenant DB (RDS) + object storage | Shop staff, managers, AI engine | Indefinite (versioned) | T2 |
| Shop configuration | Admin entry | Tenant DB (RDS) | Managers, network admins | Duration of tenancy | T2 |
| User session tokens | System-generated | Redis (in-memory, regional) | System only | 30 days (sliding expiration) | T4 |
| Audit logs | System-generated | Append-only log store (regional) | Security role, network admins | 3 years | T3 |
| Platform metrics | System-generated | Metrics DB (regional) | Platform ops team | 1 year | T2 |

### 3.2 Data Flow Diagrams

#### 3.2.1 Customer & Repair Order Data Flow

```
Customer arrives at shop
        |
        v
[Front desk creates RO]
        |
        +---> Customer PII --> Tenant DB (RDS, ca-central-1)
        |                          |
        +---> Vehicle data --------+
        |                          |
        +---> CIECA import --------+---> Raw file --> S3 (ca-central-1)
        |                          |
        v                          v
[Shop floor processing]     [AI Engine (same region)]
        |                          |
        +---> Status updates       +---> Recommendations
        +---> Voice commands (v4)  +---> SOP lookups
        +---> Photo uploads        +---> Cycle time predictions
        |                          |
        v                          v
[RO completion]             [AI inference logs]
        |                          |
        +---> Invoice generated    +---> 90-day retention
        +---> Accounting export ---|---> External accounting system
        +---> Insurance submission-|---> Authorized carrier only
        |
        v
[Archival after 7 years] --> Cryptographic erasure
```

#### 3.2.2 Voice Data Flow (Ted v4)

```
Bay microphone (always-listening for wake word)
        |
        | (audio stream, encrypted in transit)
        v
[Edge processing - wake word detection]
        |
        | (only post-wake-word audio transmitted)
        v
[STT Engine (same region as tenant data)]
        |
        +---> Raw audio --> S3 (regional, encrypted)
        |                    |
        |                    +---> 90-day TTL auto-delete
        |
        +---> Transcript --> Tenant DB
        |                    |
        |                    +---> Linked to RO if action taken
        |                    +---> 90-day TTL if no action
        |
        v
[NLU / Intent Engine (Nemotron, same region)]
        |
        +---> RO update command --> Tenant DB
        +---> Notification trigger --> Internal messaging
        +---> SOP lookup --> Tenant knowledge base
        |
        v
[TTS Response --> Bay speaker]
```

#### 3.2.3 Financial Data Flow

```
[RO completion / parts received / sublet invoice]
        |
        v
[Invoice generation in BCAI]
        |
        +---> Invoice record --> Tenant DB (T4 encrypted)
        +---> Payment processing --> Payment gateway (Stripe/Moneris)
        |                              |
        |                              +---> Tokenized card data (never stored in BCAI)
        |                              +---> Transaction confirmation --> Tenant DB
        |
        +---> Accounting export (on demand)
        |         |
        |         +---> QuickBooks format
        |         +---> Sage format
        |         +---> CSV/standard format
        |         |
        |         +---> Delivered to configured destination ONLY
        |
        +---> Tax reporting data --> 7-year retention
```

#### 3.2.4 AI Data Flow

```
[Tenant RO history (owned by tenant)]
        |
        v
[Training pipeline (regional, isolated)]
        |
        +---> Data sanitization (remove cross-references)
        +---> Feature extraction
        +---> Model training (Nemotron fine-tuning)
        |
        v
[Tenant-specific model weights]
        |
        +---> Stored in regional AI storage
        +---> Versioned (current + 2 previous)
        +---> NEVER shared across tenants
        +---> NEVER aggregated with other tenant data
        |
        v
[Inference engine (same region)]
        |
        +---> RO recommendations
        +---> Cycle time predictions
        +---> SOP suggestions
        +---> Parts ordering suggestions
        |
        v
[Inference logs --> 90-day retention]
```

#### 3.2.5 Cross-Border Data Flow Map

```
CANADA (ca-central-1 / ca-west-1)
+-----------------------------------------------+
|  Canadian tenants:                              |
|  - All PII                                      |
|  - All RO data                                  |
|  - All financial records                        |
|  - All voice recordings                         |
|  - All AI training data + models                |
|  - All backups                                  |
|  - All AI inference                             |
|                                                 |
|  NOTHING LEAVES THIS BOUNDARY                   |
|  unless tenant provides written authorization   |
+-----------------------------------------------+

UNITED STATES (us-east-1 / us-west-2)
+-----------------------------------------------+
|  US tenants only:                               |
|  - Same data categories as above                |
|  - Stored and processed in US region            |
|  - No Canadian tenant data permitted            |
+-----------------------------------------------+

EUROPEAN UNION (eu-west-1 / eu-central-1) [future]
+-----------------------------------------------+
|  EU tenants only:                               |
|  - Same data categories as above                |
|  - Stored and processed in EU region            |
|  - GDPR Article 44-49 compliance               |
|  - No data transfer outside EU without          |
|    Standard Contractual Clauses (SCCs)          |
+-----------------------------------------------+

CROSS-BORDER TRANSFERS:
  Canada --> US:  PROHIBITED for Canadian tenants (default)
                  Permitted only with:
                  - Written tenant authorization
                  - Adequate protection finding (PIPEDA s.6.1)
                  - Contractual safeguards in place

  Canada --> EU:  PROHIBITED for Canadian tenants (default)
                  Permitted only with written tenant authorization + DPA

  US --> Canada:  Permitted for platform operations (no PII)
                  PII transfer requires contractual basis

  US --> EU:      Subject to GDPR adequacy / SCCs

  EU --> Canada:  Permitted (Canada has EU adequacy finding)
  EU --> US:      Subject to EU-US Data Privacy Framework
```

---

## 4. Data Collection Principles

### 4.1 Purpose Limitation

Every data element collected by BCAI must have a stated, documented purpose. Data collected for one purpose must not be repurposed without:
- New consent from the data subject (where consent is the lawful basis), OR
- A compatible purpose assessment documented in writing

| Data Element | Stated Purpose |
|-------------|----------------|
| Customer PII | Service delivery: creating and managing repair orders |
| Vehicle VIN | Vehicle identification for repair tracking and insurance claims |
| Vehicle photos | Damage documentation, repair verification, insurance submission |
| Voice recordings | Real-time workflow commands and audit trail (Ted v4) |
| Financial records | Invoicing, payment processing, tax compliance |
| Employee records | Workforce management, role-based access control |
| AI training data | Improving AI recommendations for the specific tenant |
| Audit logs | Security monitoring, compliance, dispute resolution |

### 4.2 Data Minimization

BCAI must not collect data beyond what is required for the stated purpose.

**Rules:**
- Customer SIN/SSN: MUST NOT be collected unless legally required for a specific transaction. BCAI provides no field for this by default.
- Customer banking information: MUST NOT be stored. Payment processing uses tokenization through the payment gateway.
- Employee banking information: MUST NOT be stored in BCAI. Payroll is out of scope.
- Biometric data: Voice recordings are processed for command extraction only. Voiceprint identification is NOT performed unless explicitly enabled by tenant with documented consent from each employee.
- Location data: GPS coordinates are not collected. Shop addresses are stored for business purposes only.

**CIECA import minimization:** When importing CIECA/EMS files, BCAI extracts only the fields required for RO management. Raw import files are retained for 1 year for dispute resolution, then permanently deleted.

### 4.3 Consent Management

| Data Type | Consent Basis | Mechanism |
|-----------|--------------|-----------|
| Customer PII for RO creation | **Implied consent** (PIPEDA s.7) -- necessary for the service the customer requested | Customer presents vehicle for repair; consent implied by the transaction |
| Customer PII for marketing | **Express consent** required | Opt-in checkbox. Not pre-checked. Separate from service consent. |
| Voice recordings (technician) | **Express consent** required | Employee acknowledgment form at onboarding. Tenant responsible for collection. |
| Voice recordings (customer, if applicable) | **Express consent** required | Verbal notification + signage in reception area. Two-party consent in applicable jurisdictions. |
| AI training on tenant data | **Contractual basis** | Included in BCAI service agreement. Tenant can opt out (see Section 12.5). |
| Insurance data sharing | **Contractual basis** | Per DRP agreement between tenant and carrier. BCAI acts as processor. |
| Accounting data export | **Contractual basis** | Configured by tenant admin. Export only to designated system. |
| Cross-border data transfer | **Express written consent** required | Separate addendum to service agreement. Not included by default. |

### 4.4 Lawful Basis for Processing

| Processing Activity | PIPEDA Basis | GDPR Basis (future) |
|---------------------|-------------|---------------------|
| RO creation and management | Implied consent (s.7) -- service delivery | Contractual necessity (Art. 6(1)(b)) |
| Invoicing and payment | Implied consent -- service delivery | Contractual necessity |
| Tax record retention | Legal obligation (Income Tax Act) | Legal obligation (Art. 6(1)(c)) |
| Insurance claim submission | Contractual (DRP agreement) | Legitimate interest (Art. 6(1)(f)) |
| AI-assisted recommendations | Contractual (service agreement) | Legitimate interest + DPIA |
| Voice recording and processing | Express consent | Consent (Art. 6(1)(a)) + DPIA |
| Employee access management | Employment relationship | Contractual necessity |
| Security monitoring / audit logs | Legitimate business interest | Legitimate interest (Art. 6(1)(f)) |
| Marketing communications | Express consent | Consent (Art. 6(1)(a)) |

---

## 5. Data Storage & Sovereignty

### 5.1 Primary Storage Architecture

BCAI uses a region-locked storage architecture. The region is determined at tenant provisioning and cannot be changed without a formal migration process.

| Tenant Region | Primary Infrastructure | AI Processing | Backup Region |
|--------------|----------------------|---------------|---------------|
| **Canada** | AWS `ca-central-1` (Montreal) | Same region (Nemotron on regional GPU) | AWS `ca-west-1` (Calgary) |
| **United States** | AWS `us-east-1` (Virginia) or `us-west-2` (Oregon) | Same region | Different US region |
| **European Union** (future) | AWS `eu-west-1` (Ireland) or `eu-central-1` (Frankfurt) | Same region | Different EU region |

### 5.2 Storage Components

| Component | Technology | Region-Locked | Encryption |
|-----------|-----------|---------------|------------|
| Relational data (ROs, customers, config) | Amazon RDS (PostgreSQL) | Yes | AES-256 at rest, TLS 1.3 in transit |
| File storage (photos, CIECA files, exports) | Amazon S3 | Yes, with bucket policy | AES-256 (SSE-KMS), per-tenant key |
| Voice recordings | Amazon S3 (separate bucket) | Yes, with bucket policy | AES-256 (SSE-KMS), per-tenant key |
| AI training data | Amazon S3 + EBS (GPU instances) | Yes | AES-256, per-tenant key |
| AI model weights | Amazon S3 | Yes | AES-256, per-tenant key |
| Session store | Amazon ElastiCache (Redis) | Yes | In-transit encryption, at-rest encryption |
| Audit logs | Amazon CloudWatch Logs + S3 archival | Yes | AES-256, immutable retention policy |
| Search index | Amazon OpenSearch (if applicable) | Yes | AES-256, node-to-node encryption |

### 5.3 Sovereignty Rules

1. **Canadian tenants:** ALL data -- primary, backup, AI training, AI inference, voice recordings, audit logs -- MUST reside on Canadian infrastructure. No exceptions. No "just for processing" carve-outs. The data does not leave Canada.

2. **US tenants:** All data stored and processed in US regions. Canadian data does not enter US storage.

3. **EU tenants:** All data stored and processed in EU regions. Subject to GDPR data localization requirements.

4. **Sovereign AI guarantee:** AI models serving Canadian tenants are trained and run on Canadian infrastructure. The model weights, training data, and inference requests never leave the Canadian region. This is not a preference -- it is a contractual and legal requirement.

5. **No region migration without process:** Moving a tenant's data from one region to another requires:
   - Written request from tenant (authorized signatory)
   - Data protection impact assessment
   - Migration plan with zero-downtime requirement
   - Verification of data completeness post-migration
   - Certified deletion from source region

### 5.4 Tenant Isolation

Tenant isolation is enforced at multiple layers:

| Layer | Isolation Mechanism |
|-------|-------------------|
| **Database** | Schema-per-tenant or database-per-tenant (network clients). Row-level security as defense-in-depth. |
| **Object storage** | Per-tenant S3 prefix with IAM policies. No cross-tenant access possible at the AWS IAM level. |
| **AI models** | Per-tenant model storage. Training pipeline runs in isolated compute with tenant-specific credentials. |
| **Application** | Tenant ID injected at authentication. Every query scoped to tenant. No global queries without platform admin role. |
| **Network** | VPC isolation for network-tier clients (AutoCanada, CSN). Security groups restrict inter-tenant traffic. |
| **Encryption** | Per-tenant KMS keys for T4 data. Tenant cannot decrypt another tenant's data even with direct storage access. |

**Network client isolation (AutoCanada, CSN, CDG):** For publicly traded or enterprise network clients, BCAI provides dedicated database instances and separate S3 buckets. This is not just logical isolation -- it is physical isolation. A breach of one network's infrastructure cannot expose another network's data because the data is on different database instances with different credentials and different encryption keys.

---

## 6. Data Retention & Deletion

### 6.1 Retention Schedule

| Data Type | Retention Period | Legal/Business Basis | Auto-Enforced |
|-----------|-----------------|---------------------|---------------|
| Repair orders (full record) | **7 years** from RO close date | CRA record retention (Income Tax Act s.230), provincial consumer protection | Yes -- flagged for review at 7 years |
| Customer PII | **Duration of business relationship + 2 years** | PIPEDA reasonable retention principle | Yes -- auto-flagged when no RO activity for 2 years |
| Vehicle data (VINs, photos) | **7 years** (linked to RO lifecycle) | Same as RO | Yes -- linked to RO retention |
| Financial records (invoices, payments) | **7 years** from fiscal year end | CRA record retention, provincial tax law | Yes -- auto-enforced |
| Insurance claim data | **7 years** | Statute of limitations for insurance disputes | Yes -- linked to RO retention |
| Employee records | **Duration of employment + 2 years** | Provincial employment standards | Yes -- triggered on employee deactivation |
| Voice recordings (Ted v4) | **90 days** unless flagged for dispute/investigation | Data minimization principle. No legal requirement to retain longer. | Yes -- S3 lifecycle policy, automatic deletion |
| Voice transcripts | **90 days** unless linked to RO action | Same as recordings | Yes -- database TTL |
| AI training data (per-tenant) | **Indefinite within tenant scope** | Continuous improvement of tenant-specific AI | No auto-delete -- deleted on tenant offboarding |
| AI model weights | **Current version + 2 previous versions** | Rollback capability | Yes -- auto-pruned on new training run |
| AI inference logs | **90 days** | Debugging, quality assurance | Yes -- database TTL |
| SOP documents | **Indefinite** (versioned) | Operational. Tenant controls lifecycle. | No auto-delete -- tenant manages |
| Audit logs | **3 years** | SOC 2 requirement, security investigation window | Yes -- archived to cold storage at 1 year, deleted at 3 years |
| Session data | **30 days** | Security. No need for longer retention. | Yes -- Redis TTL |
| CIECA raw import files | **1 year** | Dispute resolution for import discrepancies | Yes -- S3 lifecycle policy |
| Accounting export files | **30 days after generation** | Temporary. Tenant should download promptly. | Yes -- S3 lifecycle policy |
| Platform metrics | **1 year** | Operational monitoring | Yes -- metrics DB rotation |

### 6.2 Deletion Procedures

**Standard deletion (T1-T2 data):**
- Database records: `DELETE` with confirmation. Vacuumed in next maintenance window.
- Object storage: S3 object deletion with versioning disabled on non-critical buckets.

**Secure deletion (T3 data):**
- Database records: Soft delete (mark as deleted) + hard delete after 30-day grace period.
- Object storage: S3 object deletion + bucket lifecycle policy to permanently remove after 30 days.
- Search indexes: Reindexed to exclude deleted records within 24 hours.

**Cryptographic erasure (T4 data):**
- Database records: Encrypted with per-tenant key. Deletion = destroy the encryption key + hard delete the ciphertext.
- Object storage: Per-tenant KMS key destroyed. Even if ciphertext persists in backups, it is computationally unrecoverable.
- AI model weights: Model files deleted from all storage locations. Training data encryption key destroyed.
- Voice recordings: S3 objects deleted + KMS key rotation ensures backup copies are unreadable.

**Deletion verification:**
- Every deletion operation generates an audit log entry (which itself follows the 3-year audit log retention).
- Quarterly deletion verification: random sample of deleted records checked to confirm they are not recoverable from any storage layer.

### 6.3 Right to Erasure

BCAI supports data subject erasure requests (PIPEDA withdrawal of consent, GDPR Article 17).

**Process:**
1. Request received from data subject (customer) or tenant admin on their behalf.
2. Identify all records linked to the data subject across all storage systems.
3. Assess legal holds: if data is subject to legal retention (tax records, active insurance claim), the retention obligation overrides the erasure request. Data subject is notified of the exception and the specific legal basis.
4. For data not subject to legal hold: execute secure deletion (T3) or cryptographic erasure (T4) within 30 days.
5. Confirmation sent to requestor with summary of actions taken and any exceptions.
6. Audit log entry created (does not contain the deleted PII -- only the fact of deletion and the data categories affected).

**Exceptions to erasure:**
- Financial records within CRA 7-year retention window
- Records subject to active litigation hold
- Records required for an active insurance claim
- Audit log entries (anonymized, not deleted)

### 6.4 Tenant Offboarding

When a tenant terminates their BCAI agreement:

| Step | Action | Timeline |
|------|--------|----------|
| 1 | Tenant admin requests offboarding | Day 0 |
| 2 | Full data export generated (see Section 9) | Within 15 business days |
| 3 | Export delivered to tenant via secure transfer | Within 20 business days |
| 4 | Tenant confirms receipt of export | Tenant acknowledges |
| 5 | All tenant data marked for deletion | Day after confirmation |
| 6 | Cryptographic erasure of all T4 data (KMS key destruction) | Within 30 days of confirmation |
| 7 | Secure deletion of all T3 data | Within 30 days of confirmation |
| 8 | Deletion of all T2/T1 data | Within 30 days of confirmation |
| 9 | AI model weights and training data destroyed | Within 30 days of confirmation |
| 10 | Certificate of destruction issued to tenant | Within 90 days of offboarding request |
| 11 | Backup rotation completes (deleted data falls off all backups) | Within 30 days of deletion |

**Maximum timeline from request to certified destruction: 90 days.**

If the tenant does not confirm receipt of export within 30 days, BCAI will make two additional attempts, then proceed with deletion. Data is not held hostage.

---

## 7. Data Access Control

### 7.1 RBAC Model

BCAI implements a four-tier Role-Based Access Control model aligned with the collision repair industry hierarchy.

| Tier | Role | Scope | Data Access |
|------|------|-------|-------------|
| **Tier 1: Single Store** | Shop Staff (estimator, tech, parts, office) | Own shop only | ROs assigned to them, customer records for their ROs, own schedule |
| **Tier 1: Single Store** | Shop Manager | Own shop only | All shop data, employee records, financial summaries, AI recommendations |
| **Tier 2: MSO** | MSO Admin | Multiple owned shops | All data across owned shops, cross-shop analytics, employee management |
| **Tier 3: Regional** | Regional Manager | Geographic region within network | Aggregated analytics, compliance data, SOP management for region |
| **Tier 4: Network** | Network Admin | All shops in network | Network-wide analytics, DRP management, SOP deployment, compliance oversight |

**Additional platform roles:**

| Role | Scope | Purpose |
|------|-------|---------|
| Platform Admin (Micazen) | Platform-wide | Technical operations, tenant provisioning, platform health |
| Security Auditor | Platform-wide (read-only audit data) | Compliance review, security investigation |
| Accounting Role | Per-shop | Financial record access, export generation |
| AI Admin (per-tenant) | Tenant-wide | AI training configuration, model management, opt-out settings |

### 7.2 Principle of Least Privilege

- Every user starts with zero access and is granted permissions by their role assignment.
- No user has access to data outside their tenant boundary. Period.
- Network admins can see aggregated analytics for their network but cannot access individual customer PII without a documented business need.
- Platform admins (Micazen staff) can access tenant data ONLY for technical support, ONLY with tenant authorization, ONLY with full audit logging, and ONLY for the duration of the support incident.

### 7.3 Access Request & Approval Workflow

| Request Type | Approval Required From | SLA |
|-------------|----------------------|-----|
| New user account (shop staff) | Shop Manager | 1 business day |
| Role change (e.g., staff to manager) | Shop Manager + MSO Admin (if applicable) | 2 business days |
| Network admin access | Network executive (named signatory) | 5 business days |
| Platform admin access to tenant data | Tenant admin + Micazen Security lead | Same day (for active incidents) |
| Bulk data export | Tenant admin + Micazen confirmation | 5 business days |
| Cross-tenant analytics (network level) | Network admin + each affected tenant | 10 business days |

### 7.4 Access Review Schedule

| Review Type | Frequency | Responsible Party | Output |
|-------------|-----------|-------------------|--------|
| User access recertification | **Quarterly** | Shop Manager / MSO Admin | Deactivation of stale accounts |
| Privileged access review | **Monthly** | Micazen Security team | Audit report, anomaly investigation |
| Platform admin access audit | **Monthly** | Micazen CTO + Security | Full log review of all tenant data access |
| Network admin scope review | **Quarterly** | Network executive | Confirmation that access scope matches current shops |
| Service account review | **Quarterly** | Micazen Engineering | Rotation of service credentials, removal of unused accounts |

### 7.5 Privileged Access Monitoring

All privileged access (Platform Admin, Network Admin, Security Auditor) is:
- Logged in real-time to an immutable audit store.
- Subject to anomaly detection (see Section 13).
- Reviewed monthly by a person who does not hold the privileged role being reviewed.
- Time-limited: platform admin access to tenant data expires automatically after 4 hours and must be re-authorized.

### 7.6 Break-Glass Emergency Access

For critical production incidents where normal approval workflows would cause unacceptable delay:

1. **Who can invoke:** Micazen CTO, VP Engineering, or designated on-call lead.
2. **Scope:** Access to the specific tenant and data required to resolve the incident. Not blanket access.
3. **Duration:** Maximum 4 hours. Auto-expires.
4. **Logging:** All actions during break-glass access are logged to a separate, tamper-evident audit stream.
5. **Post-incident:** Mandatory review within 48 hours. Break-glass report sent to affected tenant. Full access log included.
6. **Frequency cap:** If break-glass is used more than twice per quarter for the same root cause, a systemic fix is required and tracked to completion.

---

## 8. Data Quality

### 8.1 Validation Rules at Point of Entry

| Field | Validation Rule | Error Handling |
|-------|----------------|----------------|
| VIN | 17 characters, ISO 3779 check digit validation | Reject with specific error. Suggest correction if off by one character. |
| Phone number | E.164 format. North American numbers validated against numbering plan. | Accept with warning if format is non-standard. |
| Email | RFC 5322 format validation. Domain MX record check on save. | Reject if format invalid. Warn if domain has no MX record. |
| RO number | Tenant-specific format rules (configurable). Uniqueness enforced. | Reject duplicate. Auto-generate if configured. |
| Invoice amount | Numeric, 2 decimal places, currency code. Must match line item sum. | Reject if sum mismatch. Highlight discrepancy. |
| CIECA import | Schema validation against CIECA/EMS standard. Required fields enforced. | Partial import with detailed error report for failed fields. |
| Date fields | ISO 8601 format. Future date validation where applicable (RO open date cannot be in the future). | Reject with specific error. |
| Insurance claim number | Format validation per carrier (configurable). | Accept with warning if format unrecognized. |

### 8.2 Deduplication

**Customer deduplication:**
- Match on phone number (primary), email (secondary), name + address (fuzzy match).
- On CIECA import: check for existing customer before creating new record.
- Duplicate candidates presented to user for merge decision. No automatic merge.
- Merge preserves the older record and links the newer record's history.

**Vehicle deduplication:**
- Match on VIN (exact). VIN is globally unique.
- A vehicle can appear across tenants (customer goes to different shop). Each tenant has their own record. No cross-tenant dedup.

**CIECA import deduplication:**
- Import hash (SHA-256 of raw file) prevents the same file from being imported twice.
- Line-item matching against existing RO to prevent duplicate entries on re-import.

### 8.3 Data Integrity Checks

| Check | Mechanism | Frequency |
|-------|-----------|-----------|
| File import integrity | SHA-256 checksum calculated on upload, verified on processing | Every import |
| Database referential integrity | Foreign key constraints, triggers for cascade operations | Continuous (enforced by DB engine) |
| Backup integrity | Checksum verification on every backup file | Every backup cycle |
| Cross-system consistency | Reconciliation between RO status in DB and search index | Daily automated job |
| Financial data integrity | Double-entry verification: invoice amounts match payment records match line items | On every financial transaction |
| AI training data integrity | Hash of training dataset compared before and after training run | Every training run |

### 8.4 Error Handling and Correction

- All validation errors are logged with the original input, the validation rule that failed, and the user/system that submitted the data.
- Users can correct rejected data and resubmit.
- Bulk corrections (e.g., fixing a phone number format across all records) require manager approval and generate an audit trail.
- CIECA import errors generate a detailed report that the user can review and resolve field-by-field.
- Data corrections to financial records after invoicing require a credit note / adjustment workflow -- original records are never silently modified.

---

## 9. Data Portability

### 9.1 Export Formats

| Data Type | Export Formats Available |
|-----------|------------------------|
| Customer records | CSV, JSON |
| Repair orders (full) | CSV, JSON, PDF (individual RO) |
| Vehicle records | CSV, JSON |
| Financial records | CSV, JSON, QuickBooks IIF, Sage CSV |
| CIECA/EMS data | CIECA XML (native format), CSV |
| Voice transcripts | JSON (timestamped), plain text |
| AI recommendations log | JSON |
| SOP documents | Original format (PDF, DOCX), plus JSON metadata |
| Audit logs | JSON, CSV |
| Photos | Original format (JPEG, PNG) in ZIP archive |
| Complete tenant export | ZIP archive containing all of the above |

### 9.2 Full Tenant Data Export

Any tenant can request a complete export of all their data at any time. This is a contractual right, not a favor.

**Export includes:**
- All customer records
- All vehicle records
- All repair orders with full history
- All financial records
- All employee records (within BCAI scope)
- All photos and documents
- All voice transcripts (within retention window)
- All SOP documents
- All AI inference logs (within retention window)
- All audit logs
- All shop configuration
- Data dictionary describing every field

**Export does NOT include:**
- AI model weights (these are derived artifacts, not source data; tenant's training data IS included)
- Platform infrastructure logs
- Other tenants' data (obviously)

**Timeline:** Complete export delivered within **30 calendar days** of request. For tenants with more than 10 years of historical data, an additional 15 days may be required with notification.

### 9.3 CIECA-Format Export

For tenants migrating to another shop management system, BCAI provides CIECA/EMS-compatible export of all estimating and repair data, ensuring portability to any CIECA-compliant platform.

### 9.4 Accounting Export

BCAI supports ongoing accounting exports in:
- QuickBooks Desktop (IIF format)
- QuickBooks Online (API push or CSV)
- Sage 50 (CSV import format)
- Xero (API push or CSV)
- Generic CSV with configurable field mapping

Exports are triggered by the tenant's accounting role and delivered only to the configured destination.

### 9.5 Regulatory Portability (PIPEDA / GDPR)

Upon request from a data subject (customer), BCAI will provide the data subject's personal information in a structured, commonly used, machine-readable format (JSON or CSV) within **30 calendar days**. This includes:
- All PII held about the individual
- All repair orders linked to the individual
- All vehicle records linked to the individual

This does not include internal business records about the individual (e.g., internal notes, AI training contributions) unless required by applicable law.

---

## 10. Backup & Recovery

### 10.1 Backup Architecture

| Component | Backup Method | Frequency | Retention |
|-----------|--------------|-----------|-----------|
| PostgreSQL (tenant data) | WAL streaming (continuous) + daily base backup | Continuous + daily snapshot | 30 days |
| S3 objects (photos, files) | S3 versioning + cross-region replication (within country) | Continuous | 30 days of versions |
| Redis (sessions) | Not backed up (ephemeral by design) | N/A | N/A |
| AI model weights | Snapshot on training completion | Per training run | Current + 2 previous versions |
| Audit logs | S3 archival with WORM (write-once-read-many) | Daily archival from CloudWatch | 3 years |
| Configuration (IaC) | Git-versioned (Terraform/CDK) | Every change | Indefinite |

### 10.2 Recovery Objectives

| Metric | Target | Validation |
|--------|--------|------------|
| **Recovery Time Objective (RTO)** | **4 hours** | Time from disaster declaration to service restoration |
| **Recovery Point Objective (RPO)** | **1 hour** | Maximum data loss window (WAL streaming provides near-zero RPO in practice) |
| **Backup Test Frequency** | **Monthly** | Full restore test to isolated environment |
| **Per-Tenant Restore** | Supported | Restore a single tenant's data without affecting other tenants |

### 10.3 Backup Encryption & Sovereignty

- All backups are encrypted with AES-256 using AWS KMS.
- Canadian tenant backups are stored ONLY in Canadian regions (`ca-central-1` primary, `ca-west-1` secondary).
- US tenant backups are stored ONLY in US regions.
- Backup encryption keys are per-tenant for T4 data.
- Backup access requires the same authentication and authorization as production data access.

### 10.4 Backup Testing

**Monthly restore test process:**
1. Select a random tenant (rotated so every tenant is tested at least once per year).
2. Restore tenant data to an isolated environment.
3. Verify data completeness: record counts, checksum validation, referential integrity.
4. Verify application functionality: can the restored data serve the application correctly.
5. Document results. Failures trigger an immediate investigation and corrective action.
6. Destroy the test environment and all restored data after verification.

### 10.5 Per-Tenant Restore

BCAI's schema-per-tenant (or database-per-tenant for network clients) architecture enables restoring a single tenant's data from backup without affecting any other tenant. This is critical for:
- Recovering from tenant-specific data corruption
- Responding to tenant-specific incidents
- Supporting legal/regulatory requests for point-in-time data

**Process:**
1. Identify the target tenant and the desired point-in-time.
2. Restore the tenant's database schema from WAL archives to the target timestamp.
3. Restore the tenant's S3 objects from versioned backups.
4. Verify data consistency between database and object storage.
5. Swap the restored data into production (or provide as a separate export if requested).

---

## 11. Data Sharing & Third-Party

### 11.1 Data Sharing Principles

1. **No data is sold to third parties. Ever.** This is not negotiable. BCAI does not monetize tenant data through sale, licensing, or "anonymized" aggregation for external parties.

2. **Data sharing is tenant-directed.** BCAI shares data only when the tenant has configured a specific integration or explicitly authorized a specific sharing arrangement.

3. **Minimum necessary.** When data is shared with a third party (e.g., insurance carrier), only the data elements required for the specific purpose are transmitted.

### 11.2 Third-Party Data Flows

| Third Party | Data Shared | Direction | Tenant Control | Legal Basis |
|-------------|-------------|-----------|---------------|-------------|
| Estimating systems (Mitchell, CCC, Audatex) | CIECA/EMS estimate data | Inbound to BCAI | Tenant initiates import | Contractual (service delivery) |
| Insurance carriers | RO status, estimate, photos, supplements | Outbound from BCAI | Per DRP agreement, tenant configures which carriers | Contractual (DRP agreement) |
| Accounting systems (QB, Sage, Xero) | Financial records (invoices, payments) | Outbound from BCAI | Tenant configures integration | Contractual (tenant directs) |
| Payment processors (Stripe, Moneris) | Transaction amounts, tokenized card data | Bidirectional | Standard payment flow | Contractual (payment processing) |
| Parts suppliers | Part numbers, quantities, VIN | Outbound from BCAI | Tenant configures supplier integration | Contractual (ordering) |
| Cloud infrastructure (AWS) | All data (encrypted) | Stored on infrastructure | N/A (infrastructure, not sharing) | DPA with AWS |

### 11.3 Sub-Processor Management

BCAI maintains a list of all sub-processors (third parties that process data on BCAI's behalf).

**Current sub-processor list:**
| Sub-Processor | Purpose | Data Accessed | Region |
|---------------|---------|---------------|--------|
| Amazon Web Services (AWS) | Infrastructure (compute, storage, database) | All data (encrypted at rest) | Regional (per tenant) |
| Payment processor (TBD) | Payment processing | Transaction data (tokenized) | Regional |
| Monitoring provider (TBD) | Infrastructure monitoring | Platform metrics only (no PII) | N/A |

**Sub-processor obligations:**
- Each sub-processor has a signed Data Processing Agreement (DPA).
- Sub-processors are audited annually for compliance with their DPA.
- Tenants are notified 30 days before a new sub-processor is added.
- Enterprise tenants (AutoCanada, CSN) have contractual right to object to new sub-processors.

### 11.4 Data Processing Agreement (DPA) Template

BCAI provides a DPA template for enterprise clients that includes:
- Scope of processing (what data, what purposes)
- Sub-processor list and notification obligations
- Data breach notification procedures
- Data location requirements
- Audit rights
- Data return and deletion on termination
- Liability and indemnification

The DPA template is available as a separate document: `BCAI-DPA-Template.md`

### 11.5 Network Data Agreements

For network clients (AutoCanada, CSN, CDG), BCAI respects network-specific data governance requirements:

- **AutoCanada:** Publicly traded (ACQ on TSX). Data governance must meet TSX continuous disclosure requirements. Dedicated infrastructure. Annual audit right. 72-hour breach notification.
- **CSN Collision:** Network data stays within CSN tenant boundary. Individual franchisee data visible to CSN corporate per franchise agreement.
- **CDG / Other networks:** Per-network data governance addendum to master agreement.

**Cross-network data sharing:** NEVER. AutoCanada data is never visible to CSN. CSN data is never visible to AutoCanada. Not in analytics, not in AI training, not in aggregate reports, not anywhere. This is enforced at the database level, the application level, and the encryption level.

---

## 12. AI Data Governance

### 12.1 AI Training Data Sources

BCAI's sovereign AI is trained exclusively on:

| Source | Description | Consent Basis |
|--------|-------------|--------------|
| Tenant's own RO history | Historical repair orders, cycle times, parts usage, labor hours | Contractual (service agreement) |
| Industry SOPs (with consent) | Published standard operating procedures provided by tenant or network | Explicit consent from content owner |
| Manually coded business rules | Rules codified by Micazen from tenant-approved sources | Contractual (service agreement) |
| CIECA standards (public) | Public CIECA data format specifications | Public information |

**What is NOT used for AI training:**
- Data from other tenants. NEVER.
- Scraped internet data.
- Third-party datasets purchased or licensed.
- Data from estimating systems beyond what the tenant imported.
- Voice recordings (used for command extraction only, not model training).

### 12.2 Cross-Tenant Training Isolation

**This is the single most important AI governance rule in the entire system.**

No tenant's data is ever mixed with another tenant's data for AI training, fine-tuning, evaluation, or any other purpose. This is enforced by:

1. **Pipeline isolation:** Each tenant's training pipeline runs in a separate compute instance with tenant-specific credentials. There is no shared training environment.
2. **Data access controls:** Training compute instances can only access their assigned tenant's S3 bucket. Cross-tenant access is impossible at the IAM level.
3. **Model storage isolation:** Trained model weights are stored in tenant-specific S3 paths with per-tenant encryption keys.
4. **Audit trail:** Every training run is logged with the tenant ID, data sources used, data volume, and resulting model hash.
5. **Verification:** Quarterly audit confirms no cross-tenant data leakage by reviewing training job logs and data access patterns.

**Why this matters:** If AutoCanada's repair data influenced a model serving CSN, or vice versa, it would be a breach of the network data agreements and potentially a securities violation for the publicly traded entity. This is a business-ending scenario.

### 12.3 AI Model Versioning & Lineage

| Attribute | Tracked |
|-----------|---------|
| Model version ID | UUID, auto-generated |
| Training timestamp | ISO 8601 |
| Training data hash | SHA-256 of the training dataset |
| Training data volume | Record count and byte size |
| Training parameters | Learning rate, epochs, batch size, etc. |
| Base model version | Which Nemotron checkpoint was used |
| Performance metrics | Accuracy, latency, resource usage on validation set |
| Deployment timestamp | When this version was promoted to production |
| Previous version | Link to the version this replaced |

Model lineage is queryable. For any AI recommendation, the system can identify which model version generated it, what data that model was trained on, and when.

### 12.4 Right to Explanation

When BCAI's AI makes a recommendation (cycle time estimate, SOP suggestion, parts recommendation, scheduling optimization), the tenant has the right to understand why.

**Implementation:**
- Every AI recommendation includes a "reasoning" field that explains the key factors.
- Example: "Estimated 3.2 additional days because: similar VINs in your shop averaged 4.1 days for this repair type, current paint queue has 6 jobs ahead, your Thursday throughput is historically 15% lower than Monday-Wednesday."
- The explanation references only the tenant's own data. Never "shops like yours" or cross-tenant benchmarks.
- Explanations are stored with the recommendation for the 90-day inference log retention period.

### 12.5 AI Opt-Out

Tenants can opt out of AI features at the tenant level:

| Opt-Out Level | Effect |
|---------------|--------|
| Full AI opt-out | No AI features enabled. BCAI operates as a traditional shop management system. No training on tenant data. |
| AI training opt-out | AI features still available (using base model only). Tenant data is NOT used for fine-tuning. |
| Specific feature opt-out | Individual AI features (cycle time prediction, SOP suggestions, etc.) can be disabled independently. |
| Voice AI opt-out (v4) | Ted voice features disabled. Shop operates without voice interface. |

Opt-out is immediate. No "wind-down period." If a tenant opts out of AI training, any previously trained tenant-specific model weights are deleted within 30 days.

---

## 13. Monitoring & Compliance

### 13.1 Data Access Audit Logging

Every access to T3 (Confidential) and T4 (Restricted) data is logged:

| Log Field | Description |
|-----------|-------------|
| Timestamp | ISO 8601, UTC |
| User ID | Authenticated user or service account |
| Tenant ID | Tenant context of the access |
| Action | Read, Write, Update, Delete, Export |
| Resource type | Customer, RO, Invoice, VoiceRecording, etc. |
| Resource ID | Specific record identifier |
| Source IP | IP address of the request |
| User agent | Client application identifier |
| Result | Success, Denied, Error |

Audit logs are:
- Written to an append-only store (no modification or deletion possible).
- Encrypted at rest.
- Retained for 3 years.
- Stored in the same region as the tenant's data.

### 13.2 Anomaly Detection

BCAI monitors for unusual data access patterns that may indicate a breach, insider threat, or misconfiguration.

| Anomaly Type | Detection Method | Response |
|-------------|-----------------|----------|
| Bulk data export outside normal patterns | Volume threshold: >1000 records accessed in 1 hour by a single user | Alert to tenant admin + Micazen security |
| Access from unusual IP/location | Geolocation comparison against user's historical pattern | MFA challenge + alert |
| Access outside business hours | Time-based rules per tenant configuration | Alert to tenant admin |
| Cross-tenant data access attempt | Application-layer validation + database-layer row security | Block + immediate alert + incident created |
| Privileged access without approval | Comparison against access request/approval system | Block + immediate alert |
| Bulk deletion | Deletion volume threshold | Require secondary approval before execution |
| Failed authentication spike | >5 failed attempts in 10 minutes | Account lockout + alert |

### 13.3 Compliance Review Schedule

| Review | Frequency | Owner | Output |
|--------|-----------|-------|--------|
| Data classification review | **Annually** | Micazen DPO / Security lead | Updated classification map |
| Retention compliance audit | **Quarterly** | Micazen Security | Report: data past retention, deletion backlog |
| Access control review | **Quarterly** | Tenant admins + Micazen Security | Stale accounts deactivated, role assignments verified |
| Sub-processor audit | **Annually** | Micazen Legal + Security | Sub-processor compliance report |
| AI governance audit | **Quarterly** | Micazen AI lead + Security | Cross-tenant isolation verification, training data audit |
| Backup restore test | **Monthly** | Micazen Engineering | Restore test report |
| DPA compliance review | **Annually** | Micazen Legal | DPA obligations met across all enterprise clients |
| Penetration test | **Annually** (minimum) | Third-party security firm | Pen test report + remediation plan |
| SOC 2 Type II audit | **Annually** | Independent auditor | SOC 2 report |

### 13.4 Data Protection Impact Assessment (DPIA)

A DPIA is required before:
- Introducing a new data processing activity
- Adding a new data type to the platform
- Changing how AI models are trained or deployed
- Adding a new sub-processor
- Expanding into a new geographic region
- Implementing new surveillance or monitoring capabilities (e.g., new anomaly detection rules)

**DPIA process:**
1. Description of the proposed processing
2. Assessment of necessity and proportionality
3. Risk assessment (likelihood and severity of harm to data subjects)
4. Mitigation measures
5. Sign-off by Micazen DPO (or designated privacy lead)
6. Sign-off by affected tenant (for tenant-specific changes)

DPIAs are retained indefinitely as compliance documentation.

### 13.5 Breach Detection & Notification

**Detection:**
- Automated monitoring (Section 13.2) provides first-line detection.
- All employees and contractors trained to recognize and report potential breaches.
- Third-party security monitoring (SIEM) for infrastructure-level threats.

**Classification:**
| Severity | Definition | Example |
|----------|------------|---------|
| **Critical** | Confirmed unauthorized access to T4 data affecting multiple tenants or a network client | Cross-tenant data exposure, database breach |
| **High** | Confirmed unauthorized access to T3/T4 data within a single tenant | Single-tenant data exposure, unauthorized export |
| **Medium** | Suspected unauthorized access, no confirmed data exposure | Anomalous access pattern, failed exploitation attempt |
| **Low** | Policy violation with no data exposure | Employee accessing data outside their role (blocked by access controls) |

**Notification timeline:**

| Stakeholder | Critical | High | Medium | Low |
|-------------|----------|------|--------|-----|
| Micazen Security team | Immediate | Immediate | 4 hours | 24 hours |
| Micazen executive team | 1 hour | 4 hours | Next business day | Weekly report |
| Affected tenant(s) | 24 hours | 48 hours | As appropriate | N/A |
| Privacy Commissioner of Canada | **72 hours** (per PIPEDA) | 72 hours (if RROSH threshold met) | Not required | Not required |
| GDPR supervisory authority (future) | **72 hours** (per GDPR Art. 33) | 72 hours (if risk to rights/freedoms) | Not required | Not required |
| Affected data subjects | **As soon as feasible** (per PIPEDA) | As soon as feasible (if risk of harm) | Not required | Not required |

**RROSH = Real Risk of Significant Harm** (PIPEDA breach notification threshold).

**Post-breach:**
1. Contain the breach (isolate affected systems).
2. Assess scope (what data, which tenants, how many data subjects).
3. Preserve evidence (forensic imaging before remediation).
4. Notify per the timeline above.
5. Remediate root cause.
6. Post-incident review within 14 days.
7. Update this DMP if the breach revealed a gap.

---

## Appendices

### Appendix A: Glossary

| Term | Definition |
|------|------------|
| **BCAI** | BodyShopConnect AI -- the multi-tenant collision repair platform |
| **Tenant** | A customer organization using BCAI (single shop, MSO, regional group, or network) |
| **RO** | Repair Order -- the core business record in collision repair |
| **CIECA** | Collision Industry Electronic Commerce Association -- standards body for electronic data exchange in collision repair |
| **EMS** | Estimate Management Standard -- CIECA's data exchange format |
| **DRP** | Direct Repair Program -- agreement between a body shop and an insurance carrier |
| **MSO** | Multi-Shop Operator -- a company operating multiple collision repair locations |
| **PII** | Personally Identifiable Information |
| **PIPEDA** | Personal Information Protection and Electronic Documents Act (Canada) |
| **PIPA** | Personal Information Protection Act (British Columbia / Alberta) |
| **GDPR** | General Data Protection Regulation (European Union) |
| **CCPA/CPRA** | California Consumer Privacy Act / California Privacy Rights Act |
| **DPA** | Data Processing Agreement |
| **DPIA** | Data Protection Impact Assessment |
| **SOC 2** | Service Organization Control 2 -- security compliance framework |
| **WAL** | Write-Ahead Log -- PostgreSQL continuous backup mechanism |
| **KMS** | Key Management Service -- AWS encryption key management |
| **RTO** | Recovery Time Objective |
| **RPO** | Recovery Point Objective |
| **WORM** | Write Once Read Many -- immutable storage |
| **Ted** | The voice AI agent in BCAI v4 |
| **Nemotron** | NVIDIA's locally-hosted AI model used for sovereign AI processing |

### Appendix B: Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | April 5, 2026 | D. Caine Solutions LLC | Initial release |

### Appendix C: Review & Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Founder, D. Caine Solutions LLC | Kevin Starr | _____________ | _____________ |
| CEO, Micazen Inc. | Sharon Ashley | _____________ | _____________ |
| CTO / Technical Lead, Micazen Inc. | Jim Wraight | _____________ | _____________ |
| Legal Counsel, Micazen Inc. | _____________ | _____________ | _____________ |

### Appendix D: Related Documents

| Document | Purpose |
|----------|---------|
| BCAI-DPA-Template.md | Data Processing Agreement template for enterprise clients |
| BCAI-Phase-1-Spec.md through Phase-5-Spec.md | Technical specifications for BCAI platform |
| SOW-BCAI-V3-Sovereign-AI.md | Statement of Work for BCAI v3 |
| SOW-BCAI-V4-Sovereign-Ted.md | Statement of Work for BCAI v4 |
| BCAI Incident Response Plan | (To be developed) Detailed incident response procedures |
| BCAI Business Continuity Plan | (To be developed) Full BCP including disaster recovery |
| BCAI Acceptable Use Policy | (To be developed) User-facing policy for data handling |

---

**END OF DOCUMENT**

*This document governs every byte of data in the BCAI platform. If a data handling question is not answered here, the answer is "don't do it until this document is updated to address it."*
