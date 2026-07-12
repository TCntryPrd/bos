# Message to Spanky - Hostinger Deployment for Kane

**From**: Kevin  
**Date**: 2026-06-05  
**Priority**: HIGH (P10)  
**Client**: Kane Minkus

---

Hey Spanky,

Got a big task for you with Kane. We're going white-label with IR Custom AIOS and Kane's going to be our first external deployment on his Hostinger account.

## The Mission

Deploy a **clean, empty IR Custom AIOS instance** to Kane's Hostinger hosting. Think of it like shipping an empty box with all the infrastructure ready - Kane will be the one to open it up, run the `/install` page, create his account, and complete onboarding himself.

**This is NOT**:
- Pre-configured for Kane
- A copy of my setup
- Pre-loaded with data

**This IS**:
- Empty shell with `/install` page
- Multi-tenant architecture (ready for more users later)
- Ready for Kane to be the FIRST user
- Clean slate - he sets it all up

## What You Need to Do

I've created comprehensive docs for you:

1. **KANE_HOSTINGER_DEPLOYMENT.md** (in your directory)
   - Quick overview of your tasks
   
2. **HOSTINGER_DEPLOYMENT_GUIDE.md** (main repo)
   - Complete step-by-step deployment instructions
   - Troubleshooting section
   - Success criteria checklist

3. **Task in Kanban**: "Deploy IR Custom AIOS white-label install for Kane - Hostinger"
   - Full context with all details

## High-Level Steps

1. Get access to Kane's Hostinger account
2. Setup Node.js app + PostgreSQL database
3. Deploy the IR Custom AIOS codebase (from `/home/tcntryprd/boss-dev`)
4. Run database migrations (IMPORTANT: skip default tenant creation)
5. Configure environment (TENANT_MODE=multi, INSTALL_ENABLED=true)
6. Setup domain/subdomain with SSL
7. Verify `/install` page works
8. Notify me and Kane when ready

## Timeline

**Your Work**: 2-3 days  
**Kane's Setup**: 15 minutes (once you're done)  
**Due Date**: June 9, 2026

## What Happens After You Deploy

Once you notify Kane, he'll:
1. Visit the `/install` page you deployed
2. Fill out form (name, email, password, OpenRouter key)
3. System auto-creates his tenant and logs him in
4. He completes onboarding wizard (connect Gmail, WhatsApp, Calendar)
5. Enables his agents (Mercury email manager, Buckley WhatsApp operator, Darry Kanban)
6. Starts using IR Custom AIOS for his business

I can help guide him through setup when he's ready.

## Important Notes

- **Generate NEW encryption keys** for Kane's instance (don't use mine)
- **Empty database** - verify zero tenants exist before notifying Kane
- **Security first** - SSL required, secure credentials
- **Test but don't create account** - let Kane be the first real user
- **Hostinger-specific** - their control panel is straightforward for Node.js apps

## Resources in Your Directory

- `AGENT.md` - Your role as Rascal for Kane (WhatsApp manager)
- `KANE_HOSTINGER_DEPLOYMENT.md` - This deployment task
- Main repo has full guides: `HOSTINGER_DEPLOYMENT_GUIDE.md`, `WHITE_LABEL_DESIGN.md`

## If You Need Help

Message me or check in. Gio is working on some of the install endpoint code in parallel, but the infrastructure deployment (your part) can proceed independently.

**Key Point**: Focus on getting the environment ready. Even if the install API isn't 100% complete when you deploy, we can update it later. The important thing is Kane has a working Hostinger instance with the database schema ready.

## Why This Matters

Kane is our first white-label deployment. This proves the multi-tenant architecture works and sets the template for future deployments. Plus, Kane's working with us on the course/product, so having him on his own IR Custom AIOS instance is part of the collaboration.

## Questions?

Hit me up. You've got the full Hostinger deployment guide with troubleshooting, but I'm here if you hit roadblocks.

**Let's get Kane set up!** 🚀

- Kevin
