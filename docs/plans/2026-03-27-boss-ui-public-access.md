# IR Custom AIOS UI + Public Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add React dashboard, guest token auth, bluetooth API, and Tailscale Funnel public access to the IR Custom AIOS.

**Architecture:** Guest JWT tokens extend the existing bearer auth middleware. React dashboard is a new Docker service (nginx serving static Vite build) at port 8005. Tailscale Funnel exposes /boss/* paths to public internet. New API endpoints added to existing services/api/app/main.py.

**Tech Stack:** Python 3.11, FastAPI, python-jose[cryptography], React 18, TypeScript, Vite, Tailwind CSS, nginx, Docker

---

### Task 1: Guest Token API + New Endpoints

**Files:**
- Modify: `services/api/app/main.py`
- Modify: `services/api/requirements.txt`

**Step 1: Add python-jose to requirements**

Add `python-jose[cryptography]` to `services/api/requirements.txt`.

**Step 2: Add guest token endpoints and extend auth middleware**

In `services/api/app/main.py`, add:

1. Import `jose.jwt`, `datetime`, `uuid`
2. `JWT_SECRET` derived from `BOSS_API_TOKEN`
3. Table creation for `boss_guest_tokens` (id, token_id, label, expires_at, created_at, revoked)
4. `POST /admin/guest-token` — body: `{ttl_hours: int, label: str}`, requires master token, creates JWT + stores in DB, returns token string + shareable URL
5. `GET /admin/tokens` — requires master token, returns all non-revoked tokens with expiry
6. `DELETE /admin/tokens/{token_id}` — requires master token, revokes token
7. `GET /jobs` — reads boss_build_queue, returns last 50 jobs with status
8. `GET /bluetooth/scan` — placeholder (returns mock data, bluetoothctl requires host access)
9. `POST /bluetooth/connect` — placeholder (returns mock response)
10. Update `bearer_auth` middleware: try master token match first, then try JWT decode with signature verification + expiry check + revocation check

**Step 3: Rebuild API service**

```bash
cd ~/boss-dev/infra && docker compose up -d --build api
```

**Step 4: Test guest token flow**

```bash
# Create token
curl -s -X POST http://localhost:8001/boss/admin/guest-token \
  -H "Authorization: Bearer <REDACTED: BOSS_API_TOKEN — see .env.boss-token>" \
  -H "Content-Type: application/json" \
  -d '{"ttl_hours": 2, "label": "test"}'

# List tokens
curl -s http://localhost:8001/boss/admin/tokens \
  -H "Authorization: Bearer <REDACTED: BOSS_API_TOKEN — see .env.boss-token>"

# Use guest token (use the JWT from create response)
curl -s http://localhost:8001/boss/health
curl -s http://localhost:8001/boss/events -H "Authorization: Bearer <guest-jwt>"

# Test jobs endpoint
curl -s http://localhost:8001/boss/jobs \
  -H "Authorization: Bearer <REDACTED: BOSS_API_TOKEN — see .env.boss-token>"
```

---

### Task 2: React Dashboard — Scaffold + Auth

**Files:**
- Create: `services/dashboard/package.json`
- Create: `services/dashboard/tsconfig.json`
- Create: `services/dashboard/vite.config.ts`
- Create: `services/dashboard/tailwind.config.js`
- Create: `services/dashboard/postcss.config.js`
- Create: `services/dashboard/index.html`
- Create: `services/dashboard/src/main.tsx`
- Create: `services/dashboard/src/App.tsx`
- Create: `services/dashboard/src/index.css`
- Create: `services/dashboard/src/lib/api.ts` — API client with token management
- Create: `services/dashboard/src/lib/auth.ts` — token check from URL param / localStorage
- Create: `services/dashboard/src/components/Layout.tsx` — nav sidebar + header
- Create: `services/dashboard/src/components/LoginScreen.tsx` — token input
- Create: `services/dashboard/Dockerfile` — multi-stage: node build → nginx serve
- Create: `services/dashboard/nginx.conf` — SPA routing, base path /boss/ui/

**Step 1: Scaffold project**

Create all config files (package.json with react, react-dom, react-router-dom, tailwindcss, vite, typescript deps).

**Step 2: Build auth layer**

- `auth.ts`: on load, check `?token=` URL param → validate via API call → store in localStorage. Check localStorage on subsequent loads.
- `api.ts`: fetch wrapper that adds `Authorization: Bearer <token>` to all requests. Base URL: `/boss/`.
- `LoginScreen.tsx`: paste-token input, validates against API before storing.

**Step 3: Build Layout + routing**

5 routes: `/`, `/devices/google-home`, `/devices/bluetooth`, `/commands`, `/access`

---

### Task 3: Dashboard Pages

**Files:**
- Create: `services/dashboard/src/pages/StatusPage.tsx`
- Create: `services/dashboard/src/pages/GoogleHomePage.tsx`
- Create: `services/dashboard/src/pages/BluetoothPage.tsx`
- Create: `services/dashboard/src/pages/CommandPage.tsx`
- Create: `services/dashboard/src/pages/AccessPage.tsx`

**StatusPage:** Health indicators (green/red badges) for each service. Polls `/health`, `/boss/tts/health`, etc. Live event feed polling `/events` every 5s.

**GoogleHomePage:** Device list from Google Home API. Per-device controls. OAuth connect button linking to `/boss/google-home/oauth/start`. Status badges.

**BluetoothPage:** Scan button hitting `/bluetooth/scan`. Device list. Connect button hitting `/bluetooth/connect`. Connected devices list.

**CommandPage:** Text input + submit. Audio record button (MediaRecorder API) posting to `/voice-command`. Live response display. Job queue table polling `/jobs` every 5s.

**AccessPage:** TTL selector (1/2/4/24hr). Generate token button hitting `/admin/guest-token`. Active tokens table from `/admin/tokens`. Revoke button. Shareable URL display with copy-to-clipboard.

---

### Task 4: Docker + Funnel

**Files:**
- Modify: `infra/docker-compose.yml`
- Create: `services/dashboard/Dockerfile`
- Create: `services/dashboard/nginx.conf`

**Step 1: Add dashboard service to docker-compose.yml**

```yaml
  dashboard:
    build: ../services/dashboard
    container_name: boss_dashboard
    restart: unless-stopped
    ports:
      - "8005:80"
```

**Step 2: Build and start dashboard**

```bash
cd ~/boss-dev/infra && docker compose up -d --build dashboard
```

**Step 3: Enable Tailscale Funnel**

```bash
sudo tailscale funnel --bg --set-path=/boss/ http://127.0.0.1:8001
sudo tailscale funnel --bg --set-path=/boss/tts/ http://127.0.0.1:8003
sudo tailscale funnel --bg --set-path=/boss/google-home/ http://127.0.0.1:8004
sudo tailscale funnel --bg --set-path=/boss/ui/ http://127.0.0.1:8005
```

**Step 4: Verify Funnel**

```bash
tailscale funnel status
```

Expected: Shows "Funnel on" with all /boss/* paths.

**Step 5: End-to-end test**

From external network (phone, different machine):
- `https://last-castle.daggertooth-larch.ts.net/boss/ui/` loads dashboard
- Generate guest token, open shareable URL in incognito — should load dashboard with auth
- Send command from Command Center page — should get response from OpenClaw

---

### Task 5: Announce

```bash
openclaw system event --text "IR Custom AIOS UI live at https://last-castle.daggertooth-larch.ts.net/boss/ui/ — guest token API ready, Funnel enabled" --mode now
```
