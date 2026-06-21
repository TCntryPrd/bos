# White-Label Install System - Implementation Status

**Created**: 2026-06-05  
**Goal**: Self-service installation for new IR Custom AIOS tenants

## ✅ COMPLETED (Foundation)

### Database Schema
- **Migration 029** deployed: `boss_tenants`, `boss_users`, `boss_onboarding`, `boss_subscriptions`, `boss_tenant_usage`
- Default tenant created: `id='default'`, email `d.caine@dcaine.com`
- Multi-tenancy foundation ready

### Documentation
- **WHITE_LABEL_DESIGN.md**: Complete system architecture
  - Install flow
  - Onboarding wizard design
  - Security considerations
  - Billing integration (optional)
  - Testing strategy
  
### UI Prototype
- **Install.tsx**: React component for public install page
  - Form with all required fields
  - Validation logic
  - Error handling
  - Submit to `/api/admin/install`

## 🚧 PENDING (Delegated to Gio - 8 tasks)

### Phase 1: Multi-Tenancy Core (Priority 10, Due June 10)

**Task 1: Create tenant/user database schema** ✅ DONE (migration deployed)

**Task 2: Add tenant_id scoping to all queries** (CRITICAL)
- Update every query in the codebase:
  - WhatsApp: threads, messages, monitors
  - Tasks: Kanban, work orders
  - Agents: decisions, notifications, state
  - Connectors: tokens, OAuth flows
  - Memory: episodes, insights
- Middleware to extract `tenant_id` from JWT
- No cross-tenant data access possible

**Task 3: Implement tenant file system isolation**
- Create directory structure:
  ```
  /home/boss/tenants/
    {tenant-id}/
      workspaces/
        {agent-handle}/
      memory/
      uploads/
  ```
- Update all file operations
- No cross-tenant file access

### Phase 2: Install Flow (Priority 10, Due June 11)

**Task 4: Build public install page UI** ✅ PROTOTYPE DONE
- Needs routing integration
- Connect to backend API
- Add to public paths (no auth required)

**Task 5: Build tenant provisioning API endpoint**
```typescript
POST /api/admin/install
{
  fullName, businessName, userName, email, 
  password, openrouterApiKey?, plannedUse?
}

Process:
1. Validate (email unique, password strength)
2. Generate tenant_id (UUID)
3. Create tenant record
4. Hash password (bcrypt 12 rounds)
5. Create user record
6. Create workspace directories
7. Provision default agents (Mercury, Buckley, Darry - all disabled)
8. Generate JWT with tenant context
9. Send welcome email (SendGrid)
10. Return auth token + redirect URL
```

**Task 6: Implement OpenRouter account creation**
- If `createOpenrouterForMe` checked:
  - Call OpenRouter API to create sub-account
  - Store API key encrypted in `boss_tenants.openrouter_api_key`
- Use BOSS_TOKEN_ENCRYPTION_KEY (AES-256-GCM)

### Phase 3: Onboarding Wizard (Priority 9, Due June 12)

**Task 7: Build onboarding wizard UI**
- Multi-step flow:
  1. **Welcome**: "Welcome {userName}!" + quick tour
  2. **Connectors**: Gmail, Calendar, WhatsApp, Slack (can skip)
  3. **Agents**: Enable/disable Mercury, Buckley, Darry
  4. **Preferences**: Timezone, working hours, notifications
  5. **Complete**: Dashboard redirect
- Track progress in `boss_onboarding` table
- Allow skipping steps (return later from settings)

**Task 8: Implement tenant-scoped connector OAuth**
- Update OAuth flows:
  - Gmail/Calendar: Store tokens per `tenant_id`
  - Slack: Per-tenant bot tokens
  - WhatsApp: Per-tenant OpenWA sessions
- Update `boss_connector_tokens`:
  - Add `tenant_id` column
  - Foreign key to `boss_tenants`
- Each tenant has isolated connections

## Architecture Overview

```
Public Install Page (/install)
          ↓
    POST /api/admin/install
          ↓
   Tenant Provisioning:
   - Create DB records
   - Setup directories
   - Provision agents
   - Generate JWT
          ↓
    Redirect to /onboarding
          ↓
   Onboarding Wizard:
   - Welcome
   - Connect services (OAuth)
   - Configure agents
   - Set preferences
          ↓
    Dashboard (/dashboard)
```

## Security Checklist

- [x] Tenant database schema created
- [ ] All queries scoped by `tenant_id`
- [ ] Middleware extracts tenant from JWT
- [ ] File system isolated per tenant
- [ ] API keys encrypted at rest (AES-256-GCM)
- [ ] Passwords hashed (bcrypt 12 rounds)
- [ ] OAuth tokens stored per tenant
- [ ] Rate limiting on install endpoint (10/hour per IP)
- [ ] Email verification (optional)
- [ ] CORS configured for install page

## Environment Variables Needed

```bash
# Multi-tenancy
TENANT_MODE=multi  # Changed from 'single'
INSTALL_ENABLED=true
INSTALL_REQUIRE_INVITE=false

# OpenRouter admin (for creating sub-accounts)
OPENROUTER_ADMIN_KEY=sk-or-...

# Email (welcome messages)
SENDGRID_API_KEY=SG....
WELCOME_EMAIL_FROM=noreply@boss.ai

# Encryption (already exists)
BOSS_TOKEN_ENCRYPTION_KEY=<hex-32-bytes>
```

## Testing Plan

1. **Install Flow**:
   - Fill out form → creates tenant
   - Duplicate email → rejects
   - Weak password → rejects
   - OpenRouter creation → stores encrypted key

2. **Tenant Isolation**:
   - Create 2 test tenants
   - Login as Tenant A
   - Query WhatsApp threads → only sees own data
   - Query tasks → only sees own data
   - Try to access Tenant B files → denied

3. **Onboarding**:
   - Complete all steps → dashboard access
   - Skip connectors → can add later
   - Enable agents → start working immediately

4. **Load Test**:
   - 100 concurrent installs
   - All succeed without conflicts
   - Database performance remains good

## Migration Path for Existing Data

Your tenant (`default`) is already created with all existing data:

```sql
-- Already run in migration 029:
INSERT INTO boss_tenants (id, name, primary_email, status, onboarding_completed)
VALUES ('default', 'D. Caine Solutions', 'd.caine@dcaine.com', 'active', true);

INSERT INTO boss_users (tenant_id, email, display_name, role)
VALUES ('default', 'd.caine@dcaine.com', 'Kevin', 'admin');
```

All existing tables already have `tenant_id='default'`:
- `boss_whatsapp_threads`
- `boss_whatsapp_messages`
- `boss_tasks`
- `boss_rascals`
- `boss_outsiders`
- etc.

New installs get unique tenant IDs (UUIDs).

## Billing Integration (Future)

If monetizing:

**Plans**:
- **Free**: 1 user, 10k tokens/month, basic agents
- **Pro**: $49/mo, unlimited users, 500k tokens/month, all agents
- **Enterprise**: $299/mo, custom limits, priority support

**Implementation**:
- Stripe integration
- `boss_subscriptions` table tracks status
- `boss_tenant_usage` tracks consumption
- Rate limiting enforces plan limits

## Success Metrics

- **Install Completion**: >80% (start to dashboard)
- **Time to First Value**: <10 minutes
- **Onboarding Completion**: >60% finish all steps
- **Tenant Isolation**: 100% (zero data leaks)
- **Churn Rate**: <5% in first 30 days

## Next Steps

**Priority Order** (for Gio):

1. **Tenant scoping** (Task 2) - Most critical, touches entire codebase
2. **File isolation** (Task 3) - Security requirement
3. **Install API** (Task 5) - Enables new tenant creation
4. **Install UI** (Task 4) - Connect existing prototype
5. **OpenRouter creation** (Task 6) - Nice-to-have
6. **Onboarding wizard** (Task 7) - User experience
7. **Tenant OAuth** (Task 8) - Per-tenant connectors

**Estimated Timeline**: 2-3 weeks for full implementation

## Documentation Links

- Design: `/WHITE_LABEL_DESIGN.md`
- Migration: `/migrations/029_multi_tenancy.sql`
- Install UI: `/apps/web/src/pages/Install.tsx`
- Tasks: 8 tasks assigned to Gio in Kanban
