# BOSS fresh-install cutover checklist

Branch: `rebrand/boss`
Current repo path: `/docker/boss-ir`
Live deploy: not run by Gio during branch work.

## Verification completed

- `npm install`
- `npm run build --workspace=packages/core`
- `npm run build --workspace=packages/brain`
- `npm run build --workspace=packages/connectors`
- `npm run build --workspace=apps/api`
- `npm run build --workspace=apps/web`
- `npm test` passed: 416 passed, 38 skipped.
- Tracked text/filename scan for the previous brand returned zero matches.

## Fresh-install identity

The branch now creates and reads the new identity from the start:

- Postgres user: `boss`
- Postgres database: `boss_ir`
- Postgres URL user/database: `boss` / `boss_ir`
- Application table/function/tool prefixes: `boss_`
- Docker container labels: `boss_*`
- Runtime env prefix: `BOSS_*`
- Local workspace marker: `.boss`

## Important cutover note

Because the existing compose volume was created under the old database identity, a fresh install should reset volumes before first boot from this branch. Do this only while there is no required data in the stack.

## Cutover commands

```bash
cd /docker/boss-ir
git checkout rebrand/boss
git status --short --branch

# Confirm new env identity.
grep -nE "^(POSTGRES_USER|POSTGRES_DB|POSTGRES_URL|BOSS_)=" .env
! grep -RIl "previous-brand-token-placeholder" . >/dev/null

# Fresh install only: remove old containers/volumes, then rebuild/recreate.
docker compose down -v
docker compose build
docker compose up -d

# Smoke checks.
docker compose ps
curl -fsS http://127.0.0.1:8001/health
curl -fsS https://ircustomdashboards.tech/ >/dev/null
```

## Post-cutover smoke

- Install/onboarding opens on first login.
- Brain chat responds.
- Internal calls use `X-BOSS-Internal: true`.
- Public UI shows only IR Custom AIOS/customer-controlled branding.
- No previous-brand identity appears in rendered source, logs, or initialized database object names.
