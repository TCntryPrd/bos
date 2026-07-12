# WhatsApp VPS Mirror Setup

## What This Covers

How to mirror the WhatsApp/OpenWA infrastructure from last-castle to a new VPS so the portal on the VPS works identically — live message flow, sync-names, and two-sided conversation display.

Reference deployment: last-castle (source) → boss-vps (mirror).

---

## Prerequisites

- OpenWA running on source box (last-castle) with an authenticated session
- VPS has IR Custom AIOS stack running (`docker compose up -d`)
- SSH access to VPS via Tailscale: `ssh -i ~/.ssh/id_ed25519_hostinger_new root@<VPS_TAILSCALE_IP>`

---

## Step 1 — Copy OpenWA to VPS

### 1a. Rsync source files

```bash
rsync -avz --progress \
  /home/tcntryprd/OpenWA/ \
  root@<VPS_TAILSCALE_IP>:/home/tcntryprd/OpenWA/
```

### 1b. Copy OpenWA session SQLite (preserves API keys + session auth)

```bash
# Find the running OpenWA volume on source
docker inspect openwa-api --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'

# Copy sqlite DBs to VPS volume
scp /var/lib/docker/volumes/openwa_openwa-data/_data/openwa.sqlite \
    root@<VPS_TAILSCALE_IP>:/tmp/openwa.sqlite

scp /var/lib/docker/volumes/openwa_openwa-data/_data/main.sqlite \
    root@<VPS_TAILSCALE_IP>:/tmp/main.sqlite
```

On VPS:
```bash
ssh root@<VPS_TAILSCALE_IP>
cd /home/tcntryprd/OpenWA
docker compose up -d
# Put sqlite files into running volume
docker cp /tmp/openwa.sqlite openwa-api:/app/data/openwa.sqlite
docker cp /tmp/main.sqlite openwa-api:/app/data/main.sqlite
docker compose restart openwa-api

# Verify session is ready
OPENWA_KEY=<API_KEY>
SESSION=<SESSION_UUID>
curl -s -H "X-API-Key: $OPENWA_KEY" http://localhost:2785/api/sessions/$SESSION \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])"
# Should print: ready
```

If status is `scan_qr`, follow the QR re-auth procedure in `whatsapp-openwa.md` §4.

---

## Step 2 — Mirror Env Vars

### 2a. Add OpenWA vars to VPS `.env`

```bash
# On VPS: /home/tcntryprd/boss-dev/.env
OPENWA_BASE_URL=http://<OPENWA_NETWORK_GATEWAY>:2785/api
OPENWA_SESSION_ID=<SESSION_UUID>
OPENWA_API_KEY=<API_KEY>
OPENWA_WEBHOOK_TOKEN=<WEBHOOK_TOKEN>
```

Find the correct gateway for the `openwa-network` on VPS:
```bash
docker network inspect openwa-network --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
# Use this IP for OPENWA_BASE_URL
```

### 2b. Fix trusted IPs and proxies

The default Docker subnet on VPS often differs from the source box. Identify the actual gateway:

```bash
docker network inspect boss-v2_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
# Example output: 172.16.2.1
```

Add overrides to VPS `.env`:
```bash
echo 'BOSS_INTERNAL_TRUSTED_IPS=127.0.0.1,::1,<BOSS_GATEWAY>,172.22.0.1' >> .env
echo 'BOSS_TRUSTED_PROXIES=172.16.0.0/12,172.22.0.0/16' >> .env
```

> **Why**: `BOSS_INTERNAL_TRUSTED_IPS` must include the network gateway IP so host-side scripts (rascals, cron) can call internal-only API routes. `BOSS_TRUSTED_PROXIES` must cover the actual Docker subnet so nginx→API proxy correctly resolves `request.ip` from `X-Forwarded-For`.

### 2c. Watch for merged lines in `.env`

If the previous last line had no trailing newline, the `echo >>` will stick to it. Fix with:

```bash
python3 -c "
with open('.env','r') as f: content = f.read()
# split stuck lines
content = content.replace('https://boss-vps.daggertooth-larch.ts.netBOSS_INTERNAL',
                          'https://boss-vps.daggertooth-larch.ts.net\nBOSS_INTERNAL')
with open('.env','w') as f: f.write(content)
"
```

---

## Step 3 — Rebuild API on VPS

After updating source and env:

```bash
cd /home/tcntryprd/boss-dev
docker compose build api
docker compose up -d --no-deps api
```

Verify internal bypass works:
```bash
curl -s -H 'X-BOSS-Internal: true' http://localhost:8001/api/whatsapp/threads \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["threads"]), "threads")'
```

---

## Step 4 — Fix the Webhook URL

The OpenWA webhook was registered on the source box pointing at the source gateway IP. On VPS, this IP is wrong.

Find the correct gateway for `openwa-network` on VPS:
```bash
docker network inspect openwa-network --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
# Example: 172.16.3.1
```

Verify it's reachable from the openwa container:
```bash
docker exec openwa-api node -e "
const http = require('http');
http.get({hostname:'172.16.3.1',port:8001,path:'/health',timeout:2000}, r => {
  console.log('reachable, status', r.statusCode);
}).on('error', e => console.log('err:', e.code));
"
```

Update the webhook:
```bash
OPENWA_KEY=<API_KEY>
SESSION=<SESSION_UUID>
TOKEN=<WEBHOOK_TOKEN>

# Get webhook ID
WEBHOOK_ID=$(curl -s -H "X-API-Key: $OPENWA_KEY" \
  http://localhost:2785/api/sessions/$SESSION/webhooks \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")

# Update URL to correct gateway
curl -s -X PUT \
  -H "X-API-Key: $OPENWA_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"http://172.16.3.1:8001/api/webhooks/whatsapp?token=$TOKEN\"}" \
  http://localhost:2785/api/sessions/$SESSION/webhooks/$WEBHOOK_ID
```

---

## Step 5 — Sync Historical Data from Source

The VPS DB starts empty or stale. Dump from source and restore:

```bash
# On source (last-castle)
docker exec boss_postgres pg_dump -U boss -d boss_db \
  --data-only \
  -t boss_whatsapp_threads \
  -t boss_whatsapp_messages \
  > /tmp/wa_sync.sql

# Transfer to VPS
scp /tmp/wa_sync.sql root@<VPS_TAILSCALE_IP>:/tmp/wa_sync.sql
```

On VPS:
```bash
# Strip pg_dump restriction header (causes psql parse error)
grep -v '\\restrict' /tmp/wa_sync.sql > /tmp/wa_sync_clean.sql

# Truncate then restore
docker exec boss_postgres psql -U boss -d boss_db \
  -c 'TRUNCATE boss_whatsapp_messages, boss_whatsapp_threads CASCADE'

docker exec -i boss_postgres psql -U boss -d boss_db < /tmp/wa_sync_clean.sql

# Verify
docker exec boss_postgres psql -U boss -d boss_db -t \
  -c 'SELECT COUNT(*), MAX(last_message_at)::date FROM boss_whatsapp_threads'
```

---

## Step 6 — Verify Two-Sided Message Display

All messages default to `from_me = false` if OpenWA's webhook events don't include outgoing messages. The fix has two parts:

### 6a. Expand webhook event subscription

```bash
OPENWA_KEY=<API_KEY>
SESSION=<SESSION_UUID>
WEBHOOK_ID=<WEBHOOK_ID>

curl -s -X PUT \
  -H "X-API-Key: $OPENWA_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"events":["message.received","message.sent","message.ack","message.revoked","message","message_create"]}' \
  http://localhost:2785/api/sessions/$SESSION/webhooks/$WEBHOOK_ID
```

`message` and `message_create` are the `whatsapp-web.js` events that fire for phone-sent messages. Without them, only inbound messages are captured.

### 6b. Webhook handler must check ID string prefix

In `apps/api/src/routes/webhooks/whatsapp.ts`, the `fromMe` detection must check the message ID string:

```typescript
// whatsapp-web.js encodes fromMe as the prefix: "true_<chatId>_<msgId>"
const idStr = typeof data.id === 'string' ? data.id : '';
const fromMe = event === 'message.sent'
  || data.fromMe === true
  || idStr.startsWith('true_');
```

Without the `idStr.startsWith('true_')` check, outgoing messages are stored as `from_me = false` even when delivered correctly.

---

## Verification Checklist

```bash
# 1. OpenWA session ready
curl -s -H "X-API-Key: $OPENWA_KEY" http://localhost:2785/api/sessions/$SESSION \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])"
# → ready

# 2. IR Custom AIOS API responds to internal bypass
curl -s -H 'X-BOSS-Internal: true' http://localhost:8001/api/whatsapp/threads \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["threads"]), "threads")'
# → N threads

# 3. sync-names works
curl -s -X POST -H 'X-BOSS-Internal: true' http://localhost:8001/api/whatsapp/sync-names
# → {"ok":true,"updated":N,"total":N}

# 4. Webhook is pointing at correct VPS URL
curl -s -H "X-API-Key: $OPENWA_KEY" http://localhost:2785/api/sessions/$SESSION/webhooks \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['url'])"
# → http://172.16.3.1:8001/api/webhooks/whatsapp?token=...

# 5. Test webhook delivery
TOKEN=<WEBHOOK_TOKEN>
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"event":"message.received","sessionId":"<SESSION_UUID>","payload":{"id":"test-001","from":"15551234567@c.us","body":"test","type":"chat","fromMe":false,"timestamp":1748988000,"isGroupMsg":false}}' \
  "http://localhost:8001/api/webhooks/whatsapp?token=$TOKEN"
# → {"ok":true,"persisted":true,"event":"message.received"}

# Cleanup test
docker exec boss_postgres psql -U boss -d boss_db \
  -c "DELETE FROM boss_whatsapp_threads WHERE chat_id='15551234567@c.us'"
```

---

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `Unauthorized` from API | Trusted IPs not updated | Add gateway to `BOSS_INTERNAL_TRUSTED_IPS` in `.env`, rebuild API |
| 0 threads via nginx (port 8005) | `BOSS_TRUSTED_PROXIES` doesn't cover Docker subnet | Add `172.16.0.0/12` to `BOSS_TRUSTED_PROXIES` |
| Messages stuck at May 29 | Webhook pointing at wrong host gateway | Update webhook URL to VPS `openwa-network` gateway |
| Only one side of conversation | Missing `message`/`message_create` events + ID prefix check | Steps 6a and 6b above |
| `.env` lines merged | Missing trailing newline before append | Use python3 string replace to split stuck lines |
| `docker compose` not found | Wrong directory | Must run from `/home/tcntryprd/boss-dev/` |

## Related Playbooks

- `whatsapp-openwa.md` — full OpenWA infrastructure, QR re-auth procedure
- `whatsapp-sync-names.md` — sync contact/group names from OpenWA to DB
- `dashboard-tiles.md` — WhatsApp Dashboard tile
