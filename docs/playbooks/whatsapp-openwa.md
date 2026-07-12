# WhatsApp via OpenWA

## Overview

IR Custom AIOS connects to WhatsApp through the OpenWA API running as a Docker container (`openwa-api`) on last-castle. OpenWA manages the WhatsApp Web session and exposes a REST API that IR Custom AIOS's backend proxies through its own routes.

## Infrastructure

| Component | Details |
|---|---|
| Container | `openwa-api` on last-castle |
| OpenWA port | `2785` (host-bound) |
| Inside Docker network | `http://host.docker.internal:2785` from boss_api |
| Session name | `kevin-production` |
| Session ID | `932ccb22-8072-4bee-906c-0c1bae593a1f` |
| Phone | Kevin's WhatsApp number |

## Environment Variables (boss-agent.env)

```
OPENWA_BASE_URL=http://172.19.0.1:2785/api
OPENWA_SESSION_ID=932ccb22-8072-4bee-906c-0c1bae593a1f
OPENWA_API_KEY=owa_k1_28c9a7cf864c4608bfce9e70a6bf7d0aa5008bebfd4fadd688e678e36071a2a2
OPENWA_WEBHOOK_TOKEN=969a9feff19b5694e2748d75a1ddb54183b58185276449a9
```

## Re-authenticating on a Headless Box (QR Code)

When the OpenWA session drops and needs to be re-linked, the box has no display. The trick is to pull the QR code from the OpenWA API, embed it in an HTML file, and serve it through the nginx container that's already running.

### Step 1 — Confirm the session needs a QR

```bash
curl -s -H "X-API-Key: $OPENWA_API_KEY" \
  http://localhost:2785/api/sessions/$OPENWA_SESSION_ID | python3 -c "import json,sys; print(json.load(sys.stdin).get('status'))"
```

If status is `scan_qr` or `starting` (not `ready`), proceed.

### Step 2 — Write the QR HTML page

```bash
QR_B64=$(curl -s -H "X-API-Key: $OPENWA_API_KEY" \
  "http://localhost:2785/api/sessions/$OPENWA_SESSION_ID/qr" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('qr','').replace('data:image/png;base64,',''))")

cat > /home/tcntryprd/boss-dev/apps/web/public/qr.html << EOF
<!DOCTYPE html>
<html>
<head><title>WhatsApp QR</title>
<style>body{background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
</head>
<body>
<img src="data:image/png;base64,${QR_B64}" style="width:300px;height:300px;image-rendering:pixelated">
</body>
</html>
EOF
```

### Step 3 — Open in browser and scan

Navigate to:
```
https://last-castle.daggertooth-larch.ts.net/boss/ui/qr.html
```

Scan with your phone's WhatsApp > Linked Devices > Link a Device.

### Step 4 — Confirm and clean up

```bash
# Confirm session is ready
curl -s -H "X-API-Key: $OPENWA_API_KEY" \
  http://localhost:2785/api/sessions/$OPENWA_SESSION_ID | python3 -c "import json,sys; print(json.load(sys.stdin).get('status'))"

# Remove the QR page
rm /home/tcntryprd/boss-dev/apps/web/public/qr.html
```

### Notes

- The QR code expires in ~60s — if it expires, re-run Step 2
- The `public/` directory is served as static files by nginx via `boss_web` — no rebuild needed
- Do NOT leave `qr.html` in place after scanning; it's a live auth token

## Database Schema

All WhatsApp data lives in Postgres (`boss_db`) under `tenant_id = 'default'`.

### boss_whatsapp_threads
Tracks every chat thread (DM or group):

| Column | Type | Notes |
|---|---|---|
| `chat_id` | text PK | `<number>@c.us`, `<number>@lid`, or `<groupId>@g.us` |
| `tenant_id` | text | always `'default'` |
| `display_name` | text | human-readable name (contact or group) |
| `phone` | text | E.164-ish number for DMs; null for groups |
| `is_group` | bool | true if group chat |
| `last_message_at` | timestamptz | time of most recent message |
| `last_message_preview` | text | truncated last message body |
| `last_message_from_me` | bool | true if Kevin sent the last message |
| `unread_count` | int | messages not yet read |
| `archived` | bool | whether thread is archived |

### boss_whatsapp_messages
Individual messages within a thread:

| Column | Notes |
|---|---|
| `chat_id` | FK to threads |
| `message_id` | OpenWA message ID |
| `from_me` | bool |
| `body` | message text |
| `timestamp` | message time |
| `sender_name` | display name of sender (groups) |

## IR Custom AIOS API Routes

All routes are under `/api/whatsapp/` and require `X-BOSS-Internal: true` from localhost.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/whatsapp/threads` | List all threads, sorted by last_message_at desc |
| GET | `/api/whatsapp/threads/:chatId/messages` | Messages for a thread |
| POST | `/api/whatsapp/threads/:chatId/send` | Send a message |
| POST | `/api/whatsapp/threads/:chatId/mark-read` | Mark thread as read (resets unread_count) |
| POST | `/api/whatsapp/sync-names` | Backfill display_name/phone from OpenWA contacts+groups |
| POST | `/api/whatsapp/webhook` | Inbound webhook from OpenWA (internal) |

## Threads API Response Shape

```json
{
  "threads": [
    {
      "chat_id": "120363403447962158@g.us",
      "display_name": "Industry Rockstars CS",
      "phone": null,
      "is_group": true,
      "last_message_at": "2026-06-03T18:27:47.000Z",
      "last_message_preview": "He finally got the clue...",
      "last_message_from_me": false,
      "unread_count": 184,
      "archived": false
    }
  ]
}
```

## OpenWA Direct API (bypass IR Custom AIOS)

For debugging or agent use:

```bash
# Session status
curl -H "X-API-Key: $OPENWA_API_KEY" \
  http://localhost:2785/api/sessions/$OPENWA_SESSION_ID

# List contacts
curl -H "X-API-Key: $OPENWA_API_KEY" \
  http://localhost:2785/api/sessions/$OPENWA_SESSION_ID/contacts

# List groups
curl -H "X-API-Key: $OPENWA_API_KEY" \
  http://localhost:2785/api/sessions/$OPENWA_SESSION_ID/groups

# Send message
curl -X POST -H "X-API-Key: $OPENWA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"15551234567","message":"Hello"}' \
  http://localhost:2785/api/sessions/$OPENWA_SESSION_ID/messages/send-text
```

## Webhook Flow

OpenWA POSTs inbound messages to IR Custom AIOS at `/api/whatsapp/webhook`. The webhook handler:
1. Verifies the token (`OPENWA_WEBHOOK_TOKEN`)
2. Upserts the thread row (`boss_whatsapp_threads`)
3. Inserts the message row (`boss_whatsapp_messages`)
4. Increments `unread_count` on the thread

## Health Check

```bash
# Confirm OpenWA session is connected
curl -s -H "X-BOSS-Internal: true" http://localhost:8001/api/whatsapp/threads | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['threads']), 'threads')"
```

If `threads` returns 0 and OpenWA session was recently started, wait 30–60s for the session to authenticate.
