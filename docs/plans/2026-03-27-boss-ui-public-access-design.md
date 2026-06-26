# IR Custom AIOS UI + Public Access — Design Document

**Date:** 2026-03-27
**Author:** Claude Code (Lead Engineer)
**Approved by:** Kevin Starr

## Goal
Add a React dashboard, guest token auth, and public internet access (Tailscale Funnel) to the IR Custom AIOS. This is the prototype for the BSC Brad system.

## Architecture
- Tailscale Funnel exposes /boss/* paths to public internet
- JWT guest tokens provide zero-setup demo access for prospects (Sharon, Jim)
- React dashboard on port 8005 served at /boss/ui/
- New API endpoints for jobs, bluetooth, and token management
- All existing services untouched

## Parts
1. Tailscale Funnel on /boss/ paths
2. Guest Token API (JWT, configurable TTL, revokable)
3. React Dashboard (5 pages: Status, Google Home, Bluetooth, Command Center, Guest Tokens)
4. Docker Compose + Funnel route for dashboard

## Security
- Master token remains primary auth
- Guest tokens are JWTs signed with HMAC-SHA256 (secret derived from master token)
- Guest tokens stored in Postgres for listing/revocation
- /health is the only unauthenticated endpoint
- Funnel only on /boss/* paths — OpenClaw routes stay tailnet-only
