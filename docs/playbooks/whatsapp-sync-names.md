# WhatsApp Sync Names

## What It Does

The sync-names endpoint fetches the current contact list and group list from OpenWA and backfills `display_name` and `phone` on any `boss_whatsapp_threads` rows where the name is missing or stale.

This is needed because threads can be created by inbound webhooks before IR Custom AIOS has resolved the human-readable name. The webhook knows the `chat_id` but not necessarily the contact's saved name.

## Endpoint

```
POST /api/whatsapp/sync-names
Header: X-BOSS-Internal: true
```

**Response:**
```json
{ "ok": true, "updated": 3, "total": 12 }
```

- `total` — number of threads in the DB
- `updated` — threads where name or phone actually changed

## When It Runs

1. **On mount of the WhatsApp page** — fires automatically when a user opens `/whatsapp` in the dashboard (fire-and-forget; page reloads thread list when it completes)
2. **Manually** — via curl or any agent that wants fresh names

## Logic

```
1. Fetch all groups from OpenWA  →  groupId → groupName map
2. Fetch all contacts from OpenWA  →  phoneNumber → { name, phone } map
   (prefers saved contact name over pushName)
3. Load all threads from DB for tenant 'default'
4. For each thread:
   - If is_group: look up chat_id in groupMap
   - If DM: strip @suffix from chat_id, look up in contactMap
5. UPDATE any thread where name or phone changed
```

## Source

`apps/api/src/routes/whatsapp.ts` — `server.post('/sync-names', ...)`

## Manual Trigger

```bash
# From last-castle host
curl -s -X POST -H "X-BOSS-Internal: true" http://localhost:8001/api/whatsapp/sync-names

# From inside Docker network
wget --method=POST \
  --header="X-BOSS-Internal: true" \
  --header="X-Tenant-ID: default" \
  -O- \
  http://host.docker.internal:8001/api/whatsapp/sync-names
```

## Troubleshooting

**`updated: 0` every run** — all threads already have correct names, or OpenWA returned empty contact/group lists. Check that the OpenWA session is connected and authenticated:
```bash
curl -H "X-API-Key: $OPENWA_API_KEY" \
  http://localhost:2785/api/sessions/$OPENWA_SESSION_ID
```

**`openwa_not_configured` error (503)** — `OPENWA_API_KEY` env var is missing from the API container. Check `apps/agent/boss-agent.env` and rebuild.

**Group names not syncing** — OpenWA groups endpoint returns `[]` until the session has fully loaded. Wait 60s after session connect and retry.

## Related Playbooks

- `whatsapp-openwa.md` — full OpenWA infrastructure overview
- `dashboard-tiles.md` — how the WhatsApp Dashboard tile polls and displays this data
