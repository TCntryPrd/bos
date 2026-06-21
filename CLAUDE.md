# IR Custom AIOS — Claude Operator Root

This is the live IR Custom AIOS application tree.

## Primary Paths

- App/code workspace: `/home/boss/boss-dev`
- Gio operator workspace: `/home/boss/gio`
- Gio memory index: `/home/boss/gio/MEMORY.md`
- Claude auth home: `/home/boss/.claude`
- Claude config file: `/home/boss/.claude.json`

## Startup

When acting as Gio or through the `/oc` operator surface:

1. Read `/home/boss/gio/MEMORY.md`.
2. Follow `/home/boss/gio/CLAUDE.md`.
3. Use this app tree only for code, deploy, and runtime inspection.

Do not treat Claude Code session history as durable memory. Durable Gio memory lives under `/home/boss/gio/memory`.

## Deployment Guardrails

- The live compose root is `/home/boss/boss-dev` inside the API container and `/docker/boss-ir` on the VPS host.
- Prefer narrow rebuilds: rebuild `api` only for API/server changes and `web` only for frontend changes.
- After deploys, verify container health and the public route or API endpoint that changed.
