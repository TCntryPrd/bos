# IR Custom AIOS - Hostinger Deployment Guide for Kane Minkus

**Deployment Target**: Kane's Hostinger Account  
**Goal**: Empty shell ready for Kane to run `/install` and complete onboarding  
**Assigned To**: Spanky (Rascal for Kane Minkus)  
**Status**: Pending deployment

---

## Overview

This deployment creates a **clean, empty IR Custom AIOS instance** on Hostinger. Kane will be the first user, creating his account via the `/install` page, then completing onboarding to connect his services and configure his agents.

**What Kane Gets**:
- Self-service installation page (`/install`)
- Multi-tenant architecture (he can add users later)
- Full AIOS capabilities (email manager, WhatsApp operator, Kanban, agents)
- Guided onboarding for connectors (Gmail, Calendar, WhatsApp)
- Complete isolation (his own database tenant)

---

## Deployment Steps

### 1. Hostinger Environment Setup

**Required Services**:
- Node.js 20+ (check Hostinger Node.js hosting)
- PostgreSQL database (Hostinger provides this)
- Redis (optional but recommended for caching)
- Docker (if available, for OpenWA WhatsApp container)

**Check Hostinger Plan**:
- Does it support Node.js applications?
- PostgreSQL database access?
- Custom domain/subdomain setup?
- SSH access for deployment?

### 2. Clone IR Custom AIOS Codebase

**Option A: Direct Git Clone** (if SSH access available):
```bash
git clone <boss-repo-url> /path/to/boss
cd /path/to/boss
npm install
```

**Option B: FTP Upload** (if no SSH):
- Build locally: `npm run build`
- Upload `dist/` directory to Hostinger
- Upload `package.json` and `node_modules/`

### 3. Database Setup

**Create PostgreSQL Database** (via Hostinger control panel):
- Database name: `boss_aios`
- User: Create dedicated user with full privileges
- Note connection string

**Run Migrations**:
```bash
# Connect to database and run:
psql -U <user> -d boss_aios < migrations/001_initial.sql
psql -U <user> -d boss_aios < migrations/002_*.sql
# ... run all migrations in order
psql -U <user> -d boss_aios < migrations/029_multi_tenancy.sql
```

**Critical**: Do NOT run the default tenant INSERT in migration 029. We want a clean slate:
```sql
-- SKIP THESE LINES from migration 029:
-- INSERT INTO boss_tenants (id, name...) VALUES ('default'...);
-- INSERT INTO boss_users (tenant_id...) VALUES ('default'...);
```

### 4. Environment Configuration

Create `.env` file:
```bash
# Node Environment
NODE_ENV=production
PORT=8001

# Multi-Tenancy (WHITE-LABEL MODE)
TENANT_MODE=multi
DEFAULT_TENANT_ID=none  # No default tenant - force install flow
INSTALL_ENABLED=true
INSTALL_REQUIRE_INVITE=false

# Database
POSTGRES_URL=postgresql://user:pass@host:5432/boss_aios

# Redis (if available)
REDIS_HOST=localhost
REDIS_PORT=6379

# Security
BOSS_TOKEN_ENCRYPTION_KEY=<generate-with-openssl-rand-hex-32>
JWT_SECRET=<generate-with-openssl-rand-hex-32>

# Email (for welcome emails - optional for initial deployment)
SENDGRID_API_KEY=<if-kane-has-one>
WELCOME_EMAIL_FROM=noreply@<kane-domain>

# OpenRouter (Kane will add his own during onboarding)
# Leave empty - Kane provides during install

# Public URL
API_BASE_URL=https://<kane-domain-or-subdomain>
```

### 5. Build & Deploy Application

```bash
# Build frontend
cd apps/web
npm run build

# Build API
cd ../api
npm run build

# Start services
npm run start:prod
# or use Hostinger's Node.js app manager
```

**Hostinger-Specific**:
- Use their Node.js application manager
- Set entry point: `apps/api/dist/index.js`
- Configure environment variables in control panel
- Setup process manager (PM2 if available)

### 6. Domain/Subdomain Setup

**Option A: Subdomain** (recommended for testing):
- Create: `aios.kaneminkus.com` (or similar)
- Point to Hostinger Node.js app
- Setup SSL certificate (Let's Encrypt via Hostinger)

**Option B: Main Domain**:
- Use Kane's existing domain
- Configure DNS to point to Hostinger
- SSL certificate via Hostinger

**Test Access**:
```bash
curl https://aios.kaneminkus.com/health
# Should return: {"status":"ok"}
```

### 7. Verify Install Page

**Navigate to**: `https://aios.kaneminkus.com/install`

**Should See**:
- "Welcome to IR Custom AIOS" heading
- Form with fields:
  - Full Name
  - Business Name
  - User Name (what AIOS calls you)
  - Email
  - Password
  - OpenRouter API Key (optional)
- "Create My AIOS →" button

**Test Form Validation**:
- Try submitting empty form → should show errors
- Try weak password → should reject
- Try invalid email → should reject

### 8. Test API Endpoint

```bash
# Test tenant creation endpoint exists
curl -X POST https://aios.kaneminkus.com/api/admin/install \
  -H "Content-Type: application/json" \
  -d '{"test":"ping"}'

# Should return 400 or validation error (not 404)
# 404 means endpoint not registered - fix routing
```

### 9. Verify Database Schema

```sql
-- Connect to PostgreSQL and verify tables exist:
\dt boss*

-- Should see:
-- boss_tenants
-- boss_users
-- boss_onboarding
-- boss_tasks
-- boss_whatsapp_threads
-- ... and all other tables

-- Verify NO tenants exist:
SELECT COUNT(*) FROM boss_tenants;
-- Should return: 0

-- Verify multi-tenancy columns exist:
\d boss_tasks
-- Should show 'tenant_id' column
```

---

## Post-Deployment: Kane's Setup Flow

Once deployment is verified, Kane will:

### Step 1: Create Account (`/install`)
1. Visit `https://aios.kaneminkus.com/install`
2. Fill out form:
   - Full Name: "Kane Minkus"
   - Business Name: "Kane Minkus Consulting" (or his business)
   - User Name: "kane" (what AIOS calls him)
   - Email: kane@<his-email>
   - Password: (secure password)
   - OpenRouter API Key: (if he has one, or check "create for me")
3. Click "Create My AIOS →"
4. System creates first tenant, auto-login

### Step 2: Onboarding Wizard (`/onboarding`)
After install, redirected to onboarding:

**Welcome**:
- Overview of IR Custom AIOS capabilities
- Quick tour
- Continue →

**Connect Services**:
- **Gmail** (optional): OAuth flow → enables Mercury email manager
- **Google Calendar** (optional): OAuth flow → enables scheduling
- **WhatsApp** (optional): QR code scan → enables Buckley operator
- **Slack** (optional): OAuth flow → enables notifications
- Can skip and add later from settings

**Configure Agents**:
- **Mercury** (Email Manager): Enable? Auto-draft replies?
- **Buckley** (WhatsApp Operator): Enable? Which contacts to monitor?
- **Darry** (Kanban Manager): Enable? (recommended: yes)

**Preferences**:
- Time zone
- Working hours
- Notification preferences
- Token budget limits

**Complete**:
- "You're all set!" → Redirect to Dashboard

### Step 3: Using IR Custom AIOS (`/dashboard`)
Kane now has:
- Dashboard with tiles (tasks, email, WhatsApp, calendar)
- Kanban board for task management
- Agent controls (enable/disable, configure)
- Settings for connectors and preferences

---

## Troubleshooting

### Install Page Returns 404
**Issue**: Route not registered  
**Fix**: Verify `/install` route in `apps/web/src/App.tsx` or routing config

### POST /api/admin/install Returns 404
**Issue**: API endpoint not registered  
**Fix**: Check `apps/api/src/server.ts` imports and registers install routes

### Database Connection Error
**Issue**: `.env` POSTGRES_URL incorrect  
**Fix**: Verify connection string, test with `psql` command

### "Tenant Already Exists" Error
**Issue**: Migration created default tenant  
**Fix**: Delete default tenant:
```sql
DELETE FROM boss_users WHERE tenant_id = 'default';
DELETE FROM boss_tenants WHERE id = 'default';
```

### OpenRouter Account Creation Fails
**Issue**: Missing `OPENROUTER_ADMIN_KEY`  
**Fix**: Either:
- Add admin key to `.env` (if you have one)
- Or disable auto-creation, Kane provides his own key

### SSL Certificate Issues
**Issue**: HTTPS not working  
**Fix**: Use Hostinger's SSL manager (Let's Encrypt)

---

## Success Criteria Checklist

Before notifying Kane:

- [ ] `/install` page loads and displays correctly
- [ ] Form validation works (try invalid inputs)
- [ ] Database schema deployed (all `boss_*` tables exist)
- [ ] NO tenants exist in database (clean slate)
- [ ] Environment variables configured correctly
- [ ] Domain/subdomain resolves with SSL
- [ ] `/health` endpoint returns `{"status":"ok"}`
- [ ] API logs show no startup errors
- [ ] Hostinger service is running (Node.js app active)

---

## Notification to Kane & Kevin

Once deployment complete, send message:

**Subject**: IR Custom AIOS Ready for Setup

**Message**:
> Hey Kane & Kevin,
> 
> Your IR Custom AIOS instance is deployed and ready! 🎉
> 
> **Installation URL**: https://aios.kaneminkus.com/install
> 
> **Next Steps**:
> 1. Visit the install page above
> 2. Create your account (takes 2 minutes)
> 3. Complete onboarding wizard (~10 minutes)
> 4. Start using your AI operating system!
> 
> The system is a clean slate - you'll be the first user. After setup, you can add team members, connect your services (Gmail, WhatsApp, Calendar), and enable your AI agents.
> 
> Kevin will be available to help guide you through if needed.
> 
> Let me know if you hit any issues!
> 
> - Spanky

---

## Resources

**Documentation**:
- Architecture: `WHITE_LABEL_DESIGN.md`
- Status: `WHITE_LABEL_STATUS.md`
- Database: `migrations/029_multi_tenancy.sql`
- Install UI: `apps/web/src/pages/Install.tsx`

**Support**:
- Kevin: Available for guidance during Kane's setup
- Spanky: Monitoring deployment, available for troubleshooting

**Hostinger Resources**:
- Control Panel: Node.js app management
- Database Manager: phpMyAdmin or similar
- File Manager: Upload/edit files
- SSL Manager: Certificate setup

---

## Timeline

**Phase 1: Deployment** (Spanky - 2-3 days)
- Environment setup
- Code deployment
- Database migration
- Testing

**Phase 2: Kane Setup** (Kane - 15 minutes)
- Visit `/install`
- Create account
- Complete onboarding

**Phase 3: Usage** (Kane - ongoing)
- Connect services
- Enable agents
- Start managing business with AIOS

---

## Notes for Spanky

- This is Kane's dedicated instance - not shared with other clients
- Keep credentials secure (send via encrypted channel)
- Document any Hostinger-specific quirks for future reference
- After Kane's setup, can white-label this process for other clients
- Kevin can help troubleshoot if deployment issues arise

**Priority**: High (P10) - Kane is waiting for this
**Due Date**: June 9, 2026
**Client**: Kane Minkus (course/product collaboration project)
