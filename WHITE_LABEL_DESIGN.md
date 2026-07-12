# IR Custom AIOS - White Label Install System

**Goal**: Self-service installation via web page → tenant provisioning → guided onboarding

## Install Flow

```
┌─────────────────────┐
│  Install Web Page   │
│  (Public Access)    │
└──────────┬──────────┘
           │ submits
           ▼
┌─────────────────────┐
│ Tenant Provisioning │
│   API Endpoint      │
└──────────┬──────────┘
           │ creates
           ▼
┌─────────────────────┐
│  New Tenant Setup   │
│  - Database schema  │
│  - Workspace dirs   │
│  - Default agents   │
│  - Auth credentials │
└──────────┬──────────┘
           │ redirects to
           ▼
┌─────────────────────┐
│  Onboarding Wizard  │
│  - Email connector  │
│  - Calendar         │
│  - WhatsApp         │
│  - Slack, etc.      │
└─────────────────────┘
```

## 1. Install Web Page (Public)

**URL**: `https://boss.ai/install` (or your domain)

**Form Fields**:
```typescript
interface InstallForm {
  // Personal
  fullName: string;              // "Kevin D. Caine"
  businessName: string;          // "D. Caine Solutions"
  plannedUse?: string;           // Optional: "Real estate automation"
  
  // AIOS Identity
  userName: string;              // What AIOS calls them: "Kevin", "Boss", etc.
  email: string;                 // Login email + contact
  password: string;              // Account password
  
  // API Keys
  openrouterApiKey?: string;     // If they have one
  createOpenrouterForMe: boolean; // If checked and no key provided
  
  // Terms
  acceptTerms: boolean;
  subscriptionPlan?: string;     // If you're charging
}
```

**Validation**:
- Email must be unique (no duplicate tenants)
- userName: 2-24 chars, lowercase letters only
- Password: min 12 chars, complexity requirements
- If `createOpenrouterForMe` checked: create via OpenRouter API

## 2. Tenant Provisioning API

**POST /api/admin/install**

**Request**:
```json
{
  "fullName": "Jane Smith",
  "businessName": "Smith Consulting",
  "userName": "jane",
  "email": "jane@smithconsulting.com",
  "password": "SecurePass123!",
  "openrouterApiKey": "sk-or-...",
  "plannedUse": "Marketing automation"
}
```

**Process**:
1. **Validate** inputs (email unique, password strength)
2. **Generate tenant ID**: UUID or hash of email
3. **Create tenant record**:
   ```sql
   INSERT INTO boss_tenants (
     id, name, business_name, primary_email, 
     status, openrouter_api_key, created_at
   ) VALUES (...)
   ```
4. **Hash password** and store in `boss_users`:
   ```sql
   INSERT INTO boss_users (
     tenant_id, email, password_hash, 
     display_name, role, active
   ) VALUES (...)
   ```
5. **Create workspace directories**:
   ```bash
   mkdir -p /home/boss/tenants/{tenant_id}/workspaces
   mkdir -p /home/boss/tenants/{tenant_id}/memory
   mkdir -p /home/boss/tenants/{tenant_id}/uploads
   ```
6. **Provision default agents**:
   - Mercury (email manager) - disabled until configured
   - Buckley (WhatsApp operator) - disabled until configured
   - Darry (Kanban manager) - enabled
7. **Create auth JWT** with tenant context
8. **Send welcome email** with login link

**Response**:
```json
{
  "tenantId": "uuid",
  "authToken": "jwt-token",
  "onboardingUrl": "/onboarding",
  "dashboardUrl": "/dashboard"
}
```

## 3. Database Schema Updates

### New Tables

```sql
-- Tenants (root entity for multi-tenancy)
CREATE TABLE IF NOT EXISTS boss_tenants (
  id text PRIMARY KEY, -- UUID
  name text NOT NULL,
  business_name text,
  primary_email text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active', -- active, suspended, cancelled
  openrouter_api_key text, -- Encrypted at rest
  plan text DEFAULT 'free', -- free, pro, enterprise
  onboarding_completed boolean DEFAULT false,
  onboarding_step text DEFAULT 'welcome', -- welcome, connectors, agents, complete
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  CHECK (status IN ('active', 'trial', 'suspended', 'cancelled'))
);

CREATE INDEX idx_tenants_email ON boss_tenants(primary_email);
CREATE INDEX idx_tenants_status ON boss_tenants(status) WHERE status = 'active';

-- Users (per-tenant users, starting with primary admin)
CREATE TABLE IF NOT EXISTS boss_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES boss_tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'admin', -- admin, user, agent
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(tenant_id, email),
  CHECK (role IN ('admin', 'user', 'agent'))
);

CREATE INDEX idx_users_tenant ON boss_users(tenant_id, email);

-- Onboarding progress tracking
CREATE TABLE IF NOT EXISTS boss_onboarding (
  tenant_id text PRIMARY KEY REFERENCES boss_tenants(id) ON DELETE CASCADE,
  step text NOT NULL DEFAULT 'welcome',
  completed_steps jsonb DEFAULT '[]',
  skipped_steps jsonb DEFAULT '[]',
  data jsonb DEFAULT '{}', -- Store form data between steps
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  
  CHECK (step IN ('welcome', 'connectors', 'agents', 'preferences', 'complete'))
);
```

## 4. Onboarding Wizard

**Multi-step flow** after successful install:

### Step 1: Welcome
- Show personalized greeting: "Welcome, {userName}!"
- Overview of what IR Custom AIOS does
- Brief tour of dashboard
- **Action**: Continue to connectors

### Step 2: Connect Services
**Optional** - can skip and do later

- **Email** (Gmail/Microsoft)
  - OAuth flow
  - Scope: read, send, drafts
  - Enables: Mercury email manager
  
- **Calendar** (Google/Microsoft)
  - OAuth flow
  - Scope: read, write events
  - Enables: Meeting scheduling, availability
  
- **WhatsApp** (OpenWA)
  - QR code scan
  - Container setup
  - Enables: Buckley WhatsApp operator
  
- **Slack** (optional)
  - OAuth flow
  - Bot token
  - Enables: Slack notifications

**UI**: Cards for each service with "Connect" button or "Skip for now"

### Step 3: Configure Agents
- Review default agents (Mercury, Buckley, Darry)
- Enable/disable each
- Set agent preferences:
  - Mercury: Auto-draft replies? Newsletter extraction?
  - Buckley: Which contacts to monitor?
  - Darry: Enable task auto-creation?

### Step 4: Preferences
- Time zone
- Working hours
- Notification preferences (email, push, Slack)
- OpenRouter model defaults (cheap vs. powerful)
- Token budget limits

### Step 5: Complete
- "You're all set!"
- Quick links to:
  - Dashboard
  - Create first task
  - View agents
  - Documentation
- Optional: Schedule onboarding call

## 5. Environment Configuration

**Update docker-compose.yml**:

```yaml
environment:
  # Multi-tenancy
  TENANT_MODE: multi  # Changed from 'single'
  DEFAULT_TENANT_ID: ${DEFAULT_TENANT_ID:-default}
  
  # Install endpoint
  INSTALL_ENABLED: ${INSTALL_ENABLED:-true}
  INSTALL_REQUIRE_INVITE: ${INSTALL_REQUIRE_INVITE:-false}
  
  # OpenRouter management
  OPENROUTER_ADMIN_KEY: ${OPENROUTER_ADMIN_KEY}  # For creating sub-accounts
  
  # Email for welcome messages
  SENDGRID_API_KEY: ${SENDGRID_API_KEY}
  WELCOME_EMAIL_FROM: noreply@boss.ai
```

## 6. Security Considerations

### Encryption at Rest
- OpenRouter API keys: AES-256-GCM
- User passwords: bcrypt with salt rounds 12+
- Connection tokens: Encrypted in `boss_connector_tokens`

### Isolation
- Database: All queries scoped by `tenant_id`
- File system: Separate `/tenants/{id}` directories
- Memory: No cross-tenant data access
- Agents: Each tenant has isolated Rascals/Outsiders

### Rate Limiting
- Install endpoint: 10 per IP per hour
- Prevent abuse during trial period
- Token budget enforcement per tenant

## 7. Billing Integration (Optional)

If charging for service:

```sql
-- Subscriptions
CREATE TABLE IF NOT EXISTS boss_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL UNIQUE REFERENCES boss_tenants(id),
  plan text NOT NULL, -- free, pro, enterprise
  stripe_customer_id text,
  stripe_subscription_id text,
  status text NOT NULL, -- trialing, active, past_due, cancelled
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Plans**:
- **Free**: 1 user, basic agents, 10k tokens/month
- **Pro**: Unlimited users, all agents, 500k tokens/month, $49/mo
- **Enterprise**: Custom limits, dedicated support, $299/mo

## 8. Implementation Tasks

### Phase 1: Core Multi-Tenancy (Priority 10)
1. Create tenant/user tables
2. Update all existing queries to scope by tenant_id
3. Middleware: Extract tenant from JWT
4. File system isolation

### Phase 2: Install Flow (Priority 10)
5. Public install page UI
6. POST /api/admin/install endpoint
7. Tenant provisioning logic
8. Password hashing + JWT generation
9. Welcome email

### Phase 3: Onboarding Wizard (Priority 9)
10. Onboarding multi-step UI
11. Connector OAuth flows (tenant-scoped)
12. Agent configuration UI
13. Progress tracking

### Phase 4: Polish (Priority 8)
14. Email verification
15. Password reset flow
16. Tenant admin panel
17. Usage analytics per tenant
18. Billing integration (if needed)

## 9. Testing Strategy

**Test Tenants**:
- Create 3 test tenants with install flow
- Verify isolation (can't see each other's data)
- Test all connectors per tenant
- Verify agents work independently

**Load Testing**:
- 100 concurrent tenants
- Agent operations don't cross-contaminate
- Database queries remain fast with tenant_id indexing

## 10. Migration Path

**Existing Data** (your tenant):
```sql
-- Mark existing data as 'default' tenant
UPDATE boss_whatsapp_threads SET tenant_id = 'default' WHERE tenant_id IS NULL;
UPDATE boss_tasks SET tenant_id = 'default' WHERE tenant_id IS NULL;
-- ... repeat for all tables

-- Create legacy tenant record
INSERT INTO boss_tenants (id, name, business_name, primary_email, status, onboarding_completed)
VALUES ('default', 'D. Caine Solutions', 'D. Caine Solutions', 'd.caine@dcaine.com', 'active', true);
```

## Success Metrics

- Install completion rate: >80% (start to dashboard)
- Time to first value: <10 minutes
- Tenant isolation: 100% (zero cross-tenant data leaks)
- Onboarding completion: >60% finish all steps
- Churn rate: <5% in first 30 days

## Documentation

- **/docs/install-guide.md** - Step-by-step for new users
- **/docs/white-label.md** - For resellers/white-label partners
- **/docs/multi-tenant-arch.md** - Technical architecture
- **/docs/admin-guide.md** - Managing tenants, billing, support

---

**Next Steps**: Create tasks for Gio to implement Phase 1 (multi-tenancy core) and Phase 2 (install flow).
