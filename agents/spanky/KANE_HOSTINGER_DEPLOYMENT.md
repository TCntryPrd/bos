# Kane Minkus - IR Custom AIOS Hostinger Deployment

**Date**: 2026-06-05  
**Assigned To**: Spanky (Rascal for Kane Minkus)  
**Priority**: P10 (High)  
**Due**: June 9, 2026  
**Status**: Ready to start

---

## Mission

Deploy a **clean, empty IR Custom AIOS instance** to Kane's Hostinger account. This will be an empty shell ready for Kane to:
1. Visit `/install` page
2. Create his account (first user)
3. Complete onboarding (connect services, enable agents)
4. Start using his AI operating system

**NOT** pre-configured - Kane sets it up himself with Kevin's guidance.

---

## Your Task Breakdown

### 1. Access Kane's Hostinger Account
- Get credentials from Kane
- Access control panel
- Verify available services (Node.js, PostgreSQL, Redis)

### 2. Deploy Codebase
**Source**: `/home/tcntryprd/boss-dev` (Kevin's development repo)

**Key Files**:
- `apps/api/` - Backend
- `apps/web/` - Frontend with `/install` page
- `migrations/029_multi_tenancy.sql` - Database schema
- `.env` - Create NEW (don't copy Kevin's)

### 3. Database Setup
- Create PostgreSQL database on Hostinger
- Run ALL migrations (001 through 029)
- **SKIP** default tenant INSERT in migration 029 (we want empty)
- Verify: Zero tenants in database

### 4. Environment Config
```bash
TENANT_MODE=multi
INSTALL_ENABLED=true
# Generate NEW keys with: openssl rand -hex 32
```

### 5. Domain Setup
- Configure subdomain: `aios.kaneminkus.com` (or Kane's preference)
- Enable SSL (Let's Encrypt)
- Test `/health` endpoint

### 6. Verify & Notify
- [ ] `/install` page loads
- [ ] Database empty (no tenants)
- [ ] SSL working
- [ ] Notify Kane & Kevin

---

## Full Instructions

See: `/home/tcntryprd/boss-dev/HOSTINGER_DEPLOYMENT_GUIDE.md`

## Resources

- `WHITE_LABEL_DESIGN.md` - System architecture
- `WHITE_LABEL_STATUS.md` - Implementation status
- Task in Kanban: "Deploy IR Custom AIOS white-label install for Kane - Hostinger"

## Contact

- Kevin: Technical support
- Kane: Hostinger credentials, domain preferences

**Timeline**: 2-3 days for deployment, then Kane's 15-min setup
