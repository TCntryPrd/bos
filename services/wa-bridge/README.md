# wa-bridge — BOS WhatsApp bridge (Baileys)

Protocol-level WhatsApp bridge for BOS. Speaks the WhatsApp multi-device
protocol over a websocket with [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys).
**No browser, no Chromium, no puppeteer.**

Replaces the retired `services/openwa` (`@open-wa/wa-automate` + headless
Chromium), which is dead: wa-automate's initializer waits forever for
`window.Debug`, which current WhatsApp Web no longer exposes.

The REST surface and outbound webhook payloads are **identical** to the old
service, so the BOS api needs no behavioral change — only env/name renames.

---

## Environment

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `WA_BRIDGE_API_KEY` | **yes** | — | `X-API-Key` for every `/api/*` route. Unset ⇒ process exits 1 (fail-closed). |
| `WA_BRIDGE_SESSION_ID` | **yes** | — | The only valid `:id` in the paths. Unset ⇒ exits 1. |
| `WA_BRIDGE_WEBHOOK_URL` | no | — | Where events are POSTed. Unset ⇒ warns, forwards nothing. |
| `WA_BRIDGE_WEBHOOK_TOKEN` | no | — | Sent as `X-Webhook-Token`. Must match the api's expected token. |
| `PORT` | no | `2785` | Same port as the old service. |
| `WA_BRIDGE_DATA_DIR` | no | `/data/session` | Volume. Holds `auth/` (Baileys `useMultiFileAuthState`), `messages.json`, `contacts.json`. |
| `WA_BRIDGE_LOG_LEVEL` | no | `silent` | Baileys' internal pino level. `debug` for protocol tracing. |

## REST surface

Auth: `X-API-Key: $WA_BRIDGE_API_KEY` on every `/api/*` route (constant-time
compare, sha256 + `timingSafeEqual`). `/healthz` is unauthenticated and returns
**200 even when the WhatsApp session is down** — it's a liveness probe, not a
readiness probe, so a dead session shows as `unreachable`/`scan_qr` in BOS
rather than as a dead port.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/healthz` | `{ ok: true, status }` |
| GET | `/api/sessions/{id}` | `{ id, status: 'ready'\|'scan_qr'\|'starting'\|'error', phone?, pushname? }` |
| GET | `/api/sessions/{id}/qr` | `200 { qr: 'data:image/png;base64,…' }` · `202 { status, message }` (not issued yet) · `409 { error: 'already_paired' }` |
| POST | `/api/sessions/{id}/messages/send-text` | body `{ chatId, text }` → `{ ok: true, id, messageId }`. `409 session_not_ready`, `502 send_failed`. |
| GET | `/api/sessions/{id}/contacts` | `Contact[]` |
| GET | `/api/sessions/{id}/contacts/{contactId}` | `Contact` · `404` |
| GET | `/api/sessions/{id}/groups` | `[{ id, name, isGroup: true, participantsCount? }]` |
| GET | `/api/sessions/{id}/channels/{chatId}/messages?limit=N` | `Message[]` — **see History below** |
| GET | `/api/sessions/{id}/messages/{messageId}/media` | `{ url: 'data:<mime>;base64,…', mimetype }` |
| POST | `/api/sessions/{id}/logout` | `{ ok: true, status: 'scan_qr' }` — unpairs, wipes auth, re-issues a QR |

Any `:id` other than `WA_BRIDGE_SESSION_ID` → `404 session_not_found`.

`Contact` = `{ id, name, pushname, pushName, formattedName, verifiedName, number, isMyContact, isBlocked, isBusiness, isGroup }`.

`Message` = `{ id, chatId, from, to, fromMe, author, sender, senderName, pushName, notifyName, verifiedName, formattedName, body, type, hasMedia, quotedMsgId, timestamp, isGroupMsg, ack }` — `timestamp` in **seconds**.

## Webhooks out

`POST $WA_BRIDGE_WEBHOOK_URL` with `X-Webhook-Token: $WA_BRIDGE_WEBHOOK_TOKEN`:

```json
{ "event": "...", "sessionId": "...", "timestamp": 1752460000, "data": { } }
```

| Event | `data` |
| --- | --- |
| `message.received` | full `Message` (`fromMe: false`) |
| `message.sent` | full `Message` (`fromMe: true`) |
| `message.ack` | `{ id, chatId, ack, fromMe, timestamp }` |
| `message.revoked` | `{ id, chatId, timestamp }` |
| `session.status` | `{ sessionId, status, reason, phone?, pushname? }` |

Delivery: 4 attempts (1s/3s/9s backoff), fire-and-forget. A webhook failure never
kills the socket.

**Ack scale.** Baileys' `WAMessageStatus` is remapped to the -1..4 scale the BOS
receiver's `ACK_LABEL` expects: `ERROR 0 → -1 (failed)`, `PENDING 1 → 0`,
`SERVER_ACK 2 → 1 (sent)`, `DELIVERY_ACK 3 → 2 (delivered)`, `READ 4 → 3`,
`PLAYED 5 → 4`.

## JID dialect

Baileys speaks `<digits>@s.whatsapp.net`; BOS + its Postgres rows speak OpenWA's
`<digits>@c.us` (`phoneToChatId()`, and the webhook receiver's `phoneFromChatId()`
only matches `@c.us` / `@lid`). The bridge translates on both edges:

- **in** — bare digits, `@c.us`, or `@s.whatsapp.net` all accepted; normalized to a Baileys jid.
- **out** — every id in a REST response or webhook body is rendered `@c.us`.
- `@g.us` (groups) and `@lid` are identical in both dialects and pass through.

Baileys' device suffix (`15551234567:12@s.whatsapp.net`) is stripped.

## ⚠ History — a real behavior change

**Baileys cannot fetch old chat history on demand.** It's a socket client, not
a browser session: there is no "give me the last 50 messages of chat X" call,
which is exactly what the browser API gave the old service.

So `GET /channels/{chatId}/messages` is served from a **rolling on-disk store of
messages this bridge has SEEN**:

- live traffic (`messages.upsert`), and
- whatever the on-connect history sync (`messaging-history.set`) hands us —
  which WhatsApp scopes to recent activity, not the full archive.

Capped at 500 messages/chat, 1000 chats. Unknown chat → `[]` (200), never a 500.
History sync is stored but **not** webhooked (replaying months of old messages
into the BOS inbox as "new" would be wrong and a retry storm).

**Consequence for BOS: the inbox is fed by webhook → Postgres, so it builds
forward from pairing. A full backfill of pre-pairing threads is NOT possible.**
Whatever is already in `boss_whatsapp_messages` stays; nothing new arrives for
old threads until someone messages in them again.

**Media caveat:** `/messages/{id}/media` decrypts from an in-memory cache of the
last 3000 raw message protos (the binary media keys don't survive a JSON round
trip, so they're not persisted). BOS fetches media inline while handling the
webhook, so in practice it's always warm — but after a restart, media for older
messages returns `404`.

## Robustness

- Auto-reconnect on `connection.close` for every `DisconnectReason` **except**
  `loggedOut` — that one wipes the auth state and comes back as a fresh QR
  (reconnecting with dead creds is pointless).
- `session.status` webhook on every transition.
- `unhandledRejection` / `uncaughtException` are logged, not fatal.
- The HTTP surface keeps serving while the socket is down.

## Build / run

```bash
npm ci
npm run build        # tsc → dist/
npm start            # node dist/server.js
npm run typecheck    # tsc --noEmit
```

Docker: `node:20-bookworm-slim`, non-root `USER node`, `dumb-init` as PID 1,
`HEALTHCHECK` on `/healthz:2785`, `VOLUME /data/session`.
