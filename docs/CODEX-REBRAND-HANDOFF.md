# CodeX Goal Task: Rebrand `boss` → `boss` (IR Custom AIOS) — Code Layer

**Target box:** IR Custom AIOS VPS (`2.24.116.75`), repo at `/docker/boss-ir`
**Scope:** Tier 2 only (code identifiers). Tier 3 (database, containers, network, volumes) is **explicitly out of scope** and stays `boss`.
**Author:** Spanky (Kevin's Client Manager) · **Date:** 2026-06-07

---

## Goal

Make `boss` the internal/code-level brand constant and `IR Custom AIOS` the
default display name. After this task there should be **no `boss` token left in
application source** (`apps/` + `packages/`), except the deliberately-skipped
infrastructure references that live in `.env` and `docker-compose*.yml` (DB name,
container names, network, compose service names).

The frontend display name must remain **dynamic** (read from tenant/config, default
"IR Custom AIOS") so when a customer names their instance the UI updates without a
code change. Tier 1 (the visible display strings → dynamic config) is being handled
separately by Spanky; verify none remain hardcoded at the end.

---

## CRITICAL — pre-flight before you touch anything

1. **The working tree is dirty.** `git status` shows ~33 modified files on `main` —
   these are today's white-label onboarding/wizard fixes (auth.ts, brain.ts,
   IR Custom AIOSOrb.tsx, theme, etc.). **Commit them first** so the rename lands as a
   clean, isolated diff:
   ```bash
   cd /docker/boss-ir
   git add -A && git commit -m "white-label: onboarding wizard + brain noTools + bright theme"
   ```
2. **Branch.** Do the rename on a branch, never live on `main`:
   ```bash
   git checkout -b rebrand/boss
   ```
3. **Do NOT deploy to the live stack** until the build passes and Kevin approves
   cutover. Kane is about to walk through the running deployment; it must stay up.

---

## In scope (Tier 2)

### 1. npm package namespace `@boss/*` → `@boss/*`
15 packages: `agent, api, backup, brain, confidence, connectors, core, desktop,
gateway, healing, learning, mobile, voice, web, worker`.
- Rename the `name` field in every `packages/*/package.json` and `apps/*/package.json`.
- Update every import (`from '@boss/core'` → `from '@boss/core'`).
- Update workspace references and the tsconfig path alias at
  `apps/mobile/tsconfig.json:16` (`@boss/core` → `@boss/core`).
- Update `package-lock.json` (re-run `npm install` to regenerate, don't hand-edit).

### 2. Code symbols
`IR Custom AIOSOrb`, `IR Custom AIOSLogo`, `IR Custom AIOSLogoProps`, `IR Custom AIOSMark`, `IR Custom AIOSWebSocket`
→ `BossOrb`, `BossLogo`, `BossLogoProps`, `BossMark`, `BossWebSocket`.
Rename the files too (`IR Custom AIOSOrb.tsx` → `BossOrb.tsx`) and all imports/usages.
- **Note:** there are `.backup` / `-original.tsx.backup` copies of the orb — delete
  these stale backups rather than renaming them.
- **Alternative worth raising with Kevin:** if more white-labels are coming, neutral
  names (`AssistantOrb`, `BrandLogo`, `BrandMark`) age better than `Boss*`. Default
  to `Boss*` per Kevin's stated preference unless he says otherwise.

### 3. Internal auth header `X-BOSS-Internal` → `X-BOSS-Internal`
Used in ~16 files. **Producers and consumers must change together** or internal API
auth breaks. Known producers: `apps/api/src/agents/telegram-bot.ts`,
`apps/api/src/agents/persistent-scheduler.ts`. Consumer: the API's internal-auth
middleware. Also update the doc comment in `apps/api/src/routes/slack.ts` and the
two test fixtures in `apps/api/src/routes/pipeline.test.ts`.

### 4. Environment variable names `BOSS_*` → `BOSS_*`
25+ vars read in code (`process.env.BOSS_*`). Rename in code **and** in the
server `.env` atomically, in the same deploy.
- **VALUE-SENSITIVE — do not regenerate, carry the existing value across:**
  - `BOSS_JWT_SECRET` → `BOSS_JWT_SECRET` (changing the value invalidates every
    active session/login token)
  - `BOSS_TOKEN_ENCRYPTION_KEY` → `BOSS_TOKEN_ENCRYPTION_KEY` (changing the value
    makes every stored encrypted credential unreadable — brain keys, connector creds)
- Other vars: `BOSS_MULTI_TENANT, BOSS_TENANT_ID, BOSS_API_KEY,
  BOSS_GATEWAY_TOKEN/PORT, BOSS_AGENT_PORT, BOSS_BACKGROUND_AGENTS,
  BOSS_INTERNAL_TRUSTED_IPS, BOSS_TRUSTED_PROXIES, BOSS_UI_URL,
  BOSS_CONFIG_ROOT, BOSS_RUNTIME, BOSS_HOME_OVERRIDE, BOSS_BACKUP_*,
  BOSS_HOST_BRIDGE_*, BOSS_GIO_*`.
  - The `BOSS_HOST_BRIDGE_*` and `BOSS_GIO_*` vars belong to the COO/Gio host
    bridge, which is disabled in white-label. Rename for consistency but expect them
    unused.
- **Lower risk option** if you want zero coordinated-deploy danger: read the new name
  with a fallback to the old (`process.env.BOSS_X ?? process.env.BOSS_X`) for one
  release, then drop the fallback. Your call; atomic rename is fine if `.env` is
  updated in the same step.

### 5. Comments / doc strings / JSDoc
Any "IR Custom AIOS" / "IR Custom AIOS" in comments, headers, READMEs inside `apps/` and
`packages/` → "IR Custom AIOS" / `boss` as appropriate.

---

## Explicitly OUT of scope (Tier 3 — leave as `boss`)

Do **not** touch these. They are invisible plumbing and renaming them risks the data
for zero user benefit:
- Database name `boss_ir`, DB user `boss`, `POSTGRES_URL/DB/USER`
- Docker `container_name` values (`boss_ir_api`, `boss_ir_weaviate`, etc.)
- Docker network `boss-ir_default`
- Docker volume names
- compose **service** names (`api`, `web`, `postgres`, `redis`, `weaviate`) — these
  are already generic; the internal DNS (`http://weaviate:8080`, `postgres:5432`)
  depends on them, leave them.
- The repo directory path `/docker/boss-ir`

If you hit a hardcoded DB name or container name in source (there shouldn't be — they
come from env/compose), flag it, don't change it.

---

## Workflow

1. Commit dirty tree → branch `rebrand/boss` (see pre-flight).
2. Do the rename in the categories above.
3. Regenerate lockfile: `npm install`.
4. **Build must pass, all workspaces:**
   ```bash
   npm run build --workspace=packages/core
   npm run build --workspace=packages/brain
   npm run build --workspace=packages/connectors
   npm run build --workspace=apps/api
   npm run build --workspace=apps/web
   ```
5. Run tests if present (`npm test` / per-workspace).
6. Update server `.env`: rename the `BOSS_*` keys to `BOSS_*`, **same values**.
7. Write a short **cutover checklist** (the exact commands to rebuild + recreate the
   stack) but do not run it — hand back to Kevin/Spanky for the live deploy.
8. Report: files changed, anything you left as `boss` and why, build/test output.

---

## Acceptance criteria

- `grep -rIi 'boss' apps/ packages/ --include='*.ts' --include='*.tsx' --include='*.json' | grep -v node_modules | grep -v dist` returns **nothing** (or only items you explicitly justify).
- `git grep -i 'X-BOSS-Internal'` returns nothing.
- All five workspace builds pass (`tsc` + `vite` clean).
- `.env` carries `BOSS_JWT_SECRET` and `BOSS_TOKEN_ENCRYPTION_KEY` with the
  **same values** the `BOSS_*` versions had.
- No `*.backup` orb files remain.
- Branch `rebrand/boss` builds; `main` untouched until cutover.

---

## Post-cutover smoke test (Kevin/Spanky run after deploy)

1. Login works (JWT secret carried over → existing tokens still valid).
2. Brain chat responds (token encryption key carried over → Gemini key still decrypts).
3. Internal API call with `X-BOSS-Internal: true` succeeds; old header now rejected.
4. Onboarding wizard still fires on first login.
5. No "IR Custom AIOS" visible anywhere in the UI.
