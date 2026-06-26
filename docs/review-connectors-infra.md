# Code Review: IR Custom AIOS v2 — Connectors & Infrastructure
**Reviewer:** Claude Code (Senior Code Review)
**Date:** 2026-03-29
**Scope:** packages/connectors/, packages/backup/, packages/healing/, packages/learning/, packages/voice/, services/ (Docker Compose, Postgres migrations, Redis config), apps/worker/, services/worker/

---

## Executive Summary

The codebase has a significant bifurcation that must be understood before reading any finding:

- **`packages/connectors/`** — A complete, well-structured TypeScript connector layer. All 13+ connectors are real implementations, not stubs. OAuth2 is functional. The unified interface works correctly.
- **`packages/backup/`, `packages/healing/`, `packages/learning/`, `packages/voice/`** — All four are empty stubs. Each exports nothing and contains a single comment indicating a future phase.
- **`apps/worker/`** — Empty stub (one-line placeholder).
- **`services/worker/`** — A working Python worker, but it is a v1 holdover, not the v2 TypeScript worker described in the compose files. It has several critical issues.
- **`services/postgres/`** — Real, complete migrations with proper schema.
- **`docker-compose.yml`** — Structurally correct but has a broken service reference (`services/web/Dockerfile` does not exist).

---

## 1. packages/connectors/

### Overall Assessment: Real, Functional Implementation

Every file in this package is real code. There are no TODOs in the implementation paths and no stub functions.

### 1.1 OAuth2 Flow

**File:** `packages/connectors/src/auth/oauth2.ts`

The flow is fully functional:
- `buildAuthUrl()` generates correct authorization URLs for both Google and Microsoft using the right endpoints (`accounts.google.com/o/oauth2/v2/auth`, `login.microsoftonline.com/common/oauth2/v2.0/authorize`).
- PKCE is not implemented. Both providers now recommend PKCE for web applications even when a client secret is used. This is acceptable for a server-side flow but worth noting.
- `prompt: 'consent'` is correctly set for Google to force refresh token issuance on every re-auth.
- `offline_access` scope is correctly added for Microsoft.
- `exchangeCode()` and `refreshAccessToken()` make correct POST requests with `application/x-www-form-urlencoded`.

**File:** `packages/connectors/src/auth/token-store.ts`

Token storage is solid:
- AES-256-GCM with random IV and auth tag. Correct implementation.
- The format `iv:authTag:ciphertext` all as hex is unambiguous.
- `consumeAuthState()` deletes state on consumption (correct) and enforces a 10-minute expiry on OAuth state tokens (correct).
- Parameterized queries throughout — no SQL injection risk.

**File:** `packages/connectors/src/auth/refresh.ts`

Auto-refresh logic is correct:
- 5-minute buffer before expiry triggers refresh.
- Deduplication lock (`refreshLocks` Map) prevents concurrent refresh storms for the same account.
- `getAllValidTokens()` skips failed accounts gracefully instead of throwing.

**Critical Issue — Token Encryption Key Not Wired in docker-compose.yml:**
`token-store.ts` reads `process.env.BOSS_TOKEN_ENCRYPTION_KEY` and throws a hard error if it is not set. The `.env.example` does not include this variable, and `docker-compose.yml` does not pass it to the `api` or `worker` containers. The connector layer will fail to initialize in production without this env var.

### 1.2 Google Workspace Connectors

All six connectors hit the correct API endpoints with the correct HTTP methods.

**GmailConnector** (`google/gmail.ts`)
- Correct base path: `/gmail/v1/users/me`
- `listMessages()` fetches message IDs then fetches full messages individually. This is correct but results in N+1 HTTP calls. The Gmail batch API or `messages.batchGet` would be more efficient for large inboxes.
- MIME message construction in `buildMimeMessage()` uses `base64url` encoding, which is correct for Gmail's raw send API.
- `reply()` sets `In-Reply-To` and `References` headers using the `threadId`, which is incorrect. Gmail's threading uses the `Message-ID` header of the original message, not the `threadId`. The `threadId` is a Gmail-specific field, not an RFC 2822 message ID. This will result in replies that may not thread correctly in non-Gmail clients, and the raw `threadId` value is not a valid `Message-ID` value.

**GoogleCalendarConnector** (`google/calendar.ts`)
- Correct endpoint: `/calendar/v3/calendars/primary/events`
- `listEventsAllAccounts()` aggregates across all connected Google accounts with deduplication by `title|startTime`. This is smart but fragile — two different events at the same time with the same title will be silently dropped.
- `getFreeBusy()` correctly uses the `/freeBusy` endpoint with a POST.

**GoogleTasksConnector** (`google/tasks.ts`)
- Correct base: `/tasks/v1`. All CRUD operations look correct.
- `listTasks()` uses `showCompleted: 'false'` — correct default behavior.

**GoogleDriveConnector** (`google/drive.ts`)
- Uses Drive v3 API correctly.
- `upload()` constructs a multipart upload body manually. The boundary generation is fine, but the implementation will fail silently if the `Content-Transfer-Encoding: base64` section contains line breaks in the base64 output. `Buffer.toString('base64')` produces standard base64 with no line breaks, so this is safe in Node.js.
- `download()` bypasses the `GoogleClient` abstraction and calls `fetch()` directly. This means the token lookup path is duplicated (`getAllTokens()` is called, then filtered by `accountId`). If a token rotates between the `getAllTokens()` call and the `fetch()`, the download will fail with a 401. Minor, but inconsistent.

**GoogleContactsConnector** (`google/contacts.ts`)
- Uses the People API v1 correctly.
- `search()` uses `people:searchContacts` — correct endpoint for user contacts. Note: this endpoint only searches the user's own contacts, not the directory. For GSuite/Workspace directory search, `/people:searchDirectoryPeople` is needed.

**GoogleChatConnector** (`google/chat.ts`)
- Calls `chat.googleapis.com/v1/spaces` — correct.
- The `chat.messages` scope in `oauth2.ts` (`https://www.googleapis.com/auth/chat.messages`) is insufficient to list spaces; `chat.spaces.readonly` or `chat.spaces` is also required. The legacy Python `oauth.py` in `services/api/app/google/oauth.py` correctly includes both scopes. The v2 TypeScript version is missing the spaces scope.

### 1.3 Microsoft 365 Connectors

All seven connectors use the correct Graph API base (`graph.microsoft.com/v1.0`) and correct endpoint paths.

**GraphClient** (`microsoft/graph-client.ts`)
- Mirrors `GoogleClient` design. Clean abstraction.
- `put()` method is added for OneDrive, which has no equivalent in `GoogleClient`. This asymmetry is expected and acceptable.

**OutlookMailConnector** (`microsoft/mail.ts`)
- `listMessages()` correctly uses `/me/messages` with `$filter` and `$search`.
- Note: Graph API does not allow mixing `$filter` and `$search` in the same request. If `params.query` is set alongside `params.from` or `params.isRead`, the API will return a 400. The current code will attempt both simultaneously with no guard.
- `send()` and `reply()` both fetch the sent message by querying `sentitems` for the most recent message after sending. This is a race condition — if another email is sent concurrently, the wrong message could be returned.
- `reply()` uses the `/reply` action with only a `comment` body. This discards `params.to`, `params.cc`, `params.bcc`, and `params.subject`. The reply will always go to the original sender with the original subject, which may not be what callers expect if they pass different values.

**OutlookCalendarConnector** (`microsoft/calendar.ts`)
- `listEvents()` uses `/me/calendarView` — this is the correct endpoint for querying events in a date range (as opposed to `/me/events` which does not filter by range automatically).
- `getFreeBusy()` uses `/me/calendar/getSchedule` — correct endpoint.
- `parseEvent()` maps `showAs === 'free'` to `'tentative'` status. This is semantically wrong. `showAs: 'free'` means the organizer marked themselves as available (tentative or free); `showAs: 'busy'` or `showAs: 'tentativelyAccepted'` would be tentative. The mapping should be reviewed.

**MicrosoftTasksConnector** (`microsoft/tasks.ts`)
- `updateTask()` and `deleteTask()` require `listId` as a mandatory parameter but the `UpdateTaskParams` type marks `listId` as optional. This means callers who omit `listId` will get a runtime throw rather than a compile-time error.
- `createTask()` falls back to the first task list if no `listId` is provided — this is a reasonable default but not documented.

**OneDriveConnector** (`microsoft/drive.ts`)
- `upload()` uses simple PUT (`/content`), which is correct for files under 4MB. For larger files, the resumable upload session API is required. There is no size check or error path for oversized uploads.
- `search()` embeds the query directly in the URL path: `root/search(q='${encodeURIComponent(...)}')`. Single quotes inside `encodeURIComponent` are not encoded (they are unreserved characters). A query containing a single quote will break the OData expression. The query should be escaped before insertion.

**TeamsConnector** (`microsoft/teams.ts`)
- `listChatMessages()` and `sendChatMessage()` look correct.
- `listTeamChannels()` and `sendChannelMessage()` look correct.
- No scope validation — callers need `Chat.ReadWrite` and `ChannelMessage.Send` respectively, but there is no runtime check.

**MicrosoftContactsConnector** (`microsoft/contacts.ts`)
- `search()` uses `/me/people` — this is the People relevance endpoint, appropriate for search.
- `listContacts()` uses `/me/contacts` — correct for the full contacts list.
- Note: `/me/people` and `/me/contacts` return different data shapes. The `GraphContact` interface is defined to match `/me/contacts`, so `search()` results from `/me/people` may not have all fields populated (e.g., `phones`). The People API returns `scoredEmailAddresses` not `emailAddresses`. The mapping will produce contacts with empty email arrays from search results.

### 1.4 Unified Interface Layer

All five unified services (`UnifiedMailService`, `UnifiedCalendarService`, `UnifiedTaskService`, `UnifiedFileService`, `UnifiedContactService`) follow the same correct pattern:

- Connectors are instantiated per `ConnectedAccount` at construction time.
- When no `accountId` is specified, operations fan out to all connected accounts and results are merged.
- Deduplication is applied for calendar events (by title + start time) and contacts (by primary email).
- Errors from individual accounts are logged as warnings and skipped, not surfaced as failures. This is appropriate for a multi-account aggregation scenario.

**Issue — `tryAll()` error swallowing:** The `tryAll()` helper in every unified service silently continues on any error. If a message/event/file exists in account A but the connector throws for an unrelated reason, the method tries account B and so on until all fail. The final error message (`'Operation failed across all X accounts'`) discards all intermediate error details. For debugging, at minimum the intermediate errors should be collected and included in the final error.

**Issue — Iterator compatibility:** The `allConnectors()` method uses `yield*` on Map instances. This works in modern Node.js but TypeScript's strict type checking may flag it depending on `lib` target settings. Worth verifying the `tsconfig.json` targets.

---

## 2. packages/backup/ — STUB

**File:** `packages/backup/src/index.ts`

Content is `export {};` with a comment. No implementation exists.

The Postgres schema in `001_core_schema.sql` defines a `backup_log` table, and `.env.example` defines backup configuration variables, indicating the backup system was planned and partially designed, but the TypeScript implementation was never written.

**Impact:** The Docker Compose `api` service references backup functionality indirectly (via the schema), but no actual backup runs will occur.

---

## 3. packages/healing/ — STUB

**File:** `packages/healing/src/index.ts`

Content is `export {};`. The Postgres schema includes `playbooks` and `health_incidents` tables, and `services/api/app/monitor.py` (Python v1) runs a background monitor, but the v2 TypeScript healing engine does not exist.

---

## 4. packages/learning/ — STUB

**File:** `packages/learning/src/index.ts`

Content is `export {};`. The schema includes `preferences`, `behavioral_patterns`, and `onboarding_progress` tables. No learning or onboarding logic exists in the v2 TypeScript layer.

---

## 5. packages/voice/ — STUB

**File:** `packages/voice/src/index.ts`

Content is `export {};`. The Python services in `services/stt/` and `services/tts/` are real and runnable, and the schema has `voice_devices`, but the TypeScript voice pipeline package is not implemented.

---

## 6. services/ — Docker Compose & Postgres

### 6.1 docker-compose.yml

The compose file lists 7 services: `postgres`, `redis`, `weaviate`, `api`, `worker`, `web`, `stt`.

**Critical Issue — `services/web/Dockerfile` does not exist:**
The `web` service references `services/web/Dockerfile` as its build target. There is no `services/web/` directory. The `docker compose up` command will fail for any deployment that includes the `web` service. The `services/dashboard/` directory contains a Vite/React app that appears to be the intended web frontend, but its `Dockerfile` path does not match what the compose file references.

**Issue — REDIS_PASSWORD not applied:**
`.env.example` defines `REDIS_PASSWORD` and `redis.conf` documents that password auth should be injected via entrypoint. However, the compose file does not pass `REDIS_PASSWORD` to the redis container and does not define a custom entrypoint to inject `requirepass`. Redis will start without authentication. All other services connect to Redis without a password, which would be consistent but insecure in a production deployment.

**Issue — BOSS_TOKEN_ENCRYPTION_KEY not in compose env:**
The `api` service's `env_file: .env` will pick up the variable if it is added to `.env`, but it is absent from `.env.example`. A new deployer will not know this is required, and the connector token store will throw on first use.

**Issue — `worker` service build context:**
The `worker` container builds from `services/worker/Dockerfile` which runs the Python worker (`app/worker.py`). The `apps/worker/src/index.ts` exists as a TypeScript stub. There are two workers: a functional Python v1 worker and a stub TypeScript v2 worker. The compose file deploys the Python one. This is currently the correct choice (the TS worker is not implemented), but it creates confusion about which worker is "real" for v2.

**Observation — No healthcheck on `worker` or `web`:**
`worker` and `web` have no healthchecks. `api` and `stt` do. This is inconsistent but not a functional blocker.

**Multi-tenant overlay (`docker-compose.multi.yml`):**
This file is correct and complete. Traefik is properly configured with wildcard subdomain routing and Let's Encrypt. The `api.insecure=true` flag exposes the Traefik dashboard without authentication — this should be removed or protected before any public deployment.

### 6.2 Postgres Migrations

**File:** `services/postgres/migrations/001_core_schema.sql`

This is a complete, production-quality schema. Highlights:

- 14 tables covering all planned features: tenants, users, brain_configs, oauth_connections, conversations, messages, preferences, behavioral_patterns, playbooks, health_incidents, onboarding_progress, backup_log, voice_devices, tasks.
- Proper FK constraints with `ON DELETE CASCADE`.
- Appropriate indexes including partial indexes (e.g., `WHERE status = 'active'`, `WHERE status != 'resolved'`).
- GIN index on `playbooks.failure_signature` for full-text search.
- Automatic `updated_at` trigger applied dynamically via `information_schema` introspection.

**Issue — Dual OAuth token schema:**
The v2 connector layer (`packages/connectors/src/auth/token-store.ts`) defines its own `boss_oauth_tokens` table via `TOKEN_STORE_MIGRATION`. The v2 Postgres migration (`001_core_schema.sql`) defines an `oauth_connections` table. These are separate tables with different schemas, serving the same purpose. The v1 Python code (`services/api/app/google/oauth.py`) uses yet another table: `boss_google_oauth`. Three OAuth token tables exist across v1 Python, v2 TypeScript connectors, and the v2 schema migration. None of them are consolidated. This will cause confusion and data duplication.

**File:** `services/postgres/migrations/002_multi_tenant_functions.sql`

Correct. `create_tenant_schema()` dynamically creates per-tenant schemas. The use of `format()` with `%I` (identifier quoting) is correct and prevents SQL injection in dynamic DDL. `drop_tenant_schema()` is dangerous by design and appropriately noted in comments.

**Issue — Missing indexes on tenant schema tables:**
The per-tenant schema tables created by `create_tenant_schema()` omit some indexes that exist in the public schema. Specifically, `preferences` is missing the `(user_id, category, key)` UNIQUE constraint, and `messages` is missing the `tenant_id` index. These are probably not critical but create inconsistency.

### 6.3 Redis Configuration

`services/redis/redis.conf` is well-configured:

- AOF persistence enabled with `everysec` sync — appropriate for durability of Redis Streams (the event bus).
- RDB snapshots as backup.
- `maxmemory 256mb` with `allkeys-lru` policy. For a Streams-heavy workload, `allkeys-lru` will evict stream entries when memory is full. Consider `noeviction` with monitoring, or `volatile-lru` if some keys have TTLs, to avoid silently losing stream messages under memory pressure.
- Stream naming conventions are documented in comments — useful.

---

## 7. apps/worker/ — STUB

**File:** `apps/worker/src/index.ts`

```
// @boss/worker — Background job processor (Redis consumer)
// Phase 1 placeholder
console.log('IR Custom AIOS v2 Worker — not yet implemented');
```

This is not deployed; the compose file deploys `services/worker/` (Python). However, the stub creates a false impression that a TypeScript worker exists.

---

## 8. services/worker/ — Python v1 Worker

**File:** `services/worker/app/worker.py`

This is a real, running worker but it is a v1 holdover with several problems.

**Critical Issue — Hardcoded API key in source:**
```python
OPENCLAW_API_KEY = os.getenv("OPENCLAW_API_KEY", "<REDACTED: OPENCLAW_API_KEY — see .env>")
```
A real API key is hardcoded as the default fallback. Even if this key is no longer active, hardcoding credentials in source is a security violation. This file is in a git repository. The default must be changed to an empty string or the fallback must be removed entirely.

**Critical Issue — Missing `httpx` in requirements.txt:**
`worker.py` imports `httpx` and uses it in `send_to_openclaw()`. `requirements.txt` lists only `psycopg[binary]`, `redis`, and `python-dotenv`. The `httpx` package is not listed. The Docker build will succeed (because `httpx` is not installed at build time), but the worker will crash with an `ImportError` at the first `send_to_openclaw()` call.

**Issue — No retry logic:**
The worker crashes and exits on any unhandled exception (`sys.exit(1)`). Redis connection drops, Postgres connection drops, and transient errors in `send_to_openclaw()` will kill the process permanently. The Dockerfile has no restart policy; the compose file has `restart: unless-stopped`, so the container will restart, but all in-flight message processing will be lost.

**Issue — Redis Pub/Sub instead of Streams:**
The worker uses `r.pubsub().subscribe("boss_events")` — fire-and-forget Pub/Sub. The Redis config and schema comments describe Redis Streams (`XADD`, consumer groups) as the intended event bus. Pub/Sub does not persist messages; if the worker is down when a message is published, it is lost. Streams with consumer groups provide at-least-once delivery. This is a design regression from the documented intent.

**Issue — Hardcoded personal context:**
```python
"Check Kevin's email inbox..."
"Check Kevin's CRM pipeline..."
```
The worker's intent routing contains hardcoded personal references to the developer. These should not be in a product codebase.

**Issue — Keyword-based intent detection:**
The `detect_intent()` function uses simple substring matching against a hardcoded keyword list. This is appropriate for a prototype but will misclassify ambiguous input (e.g., "find emails from today" matches `web_search` before `email_read`).

---

## Priority Summary

### Critical (Must Fix Before Production)

1. **Hardcoded API key in `services/worker/app/worker.py`** — A real key is committed to source. Remove immediately. The default should be an empty string with a startup check.

2. **`services/web/Dockerfile` does not exist** — `docker compose up` will fail for the `web` service. Either create the Dockerfile pointing to `services/dashboard/`, or update the compose reference.

3. **`BOSS_TOKEN_ENCRYPTION_KEY` missing from `.env.example` and compose env** — The TypeScript connector layer will throw on startup if this is not set. Add to `.env.example` with generation instructions, and verify it is passed via `env_file` or explicit `environment` in compose.

4. **`httpx` missing from `services/worker/requirements.txt`** — Worker crashes on first AI routing call. Add `httpx` to requirements.

5. **Google Chat missing `chat.spaces.readonly` scope** — `GoogleChatConnector.listSpaces()` will get a 403. Add `https://www.googleapis.com/auth/chat.spaces.readonly` to `GOOGLE_SCOPES.chat` in `packages/connectors/src/auth/oauth2.ts`.

### Warnings (Should Fix)

6. **Three OAuth token tables, no consolidation** — `boss_google_oauth` (Python v1), `oauth_connections` (migration 001), `boss_oauth_tokens` (TS connector). Decide which is authoritative for v2. The migration table (`oauth_connections`) should be the canonical one, and the TS connector's `TOKEN_STORE_MIGRATION` should be reconciled with it.

7. **Graph API `$filter` + `$search` conflict in `OutlookMailConnector.listMessages()`** — Mixing these in a single request returns HTTP 400. Add a guard that either uses `$search` alone or `$filter` alone depending on which params are present.

8. **Gmail `reply()` uses threadId as Message-ID** — `In-Reply-To: {threadId}` is not a valid RFC 2822 header value. Fetch the original message's `Message-ID` header and use that instead.

9. **`MicrosoftContactsConnector.search()` uses People API field mismatch** — `/me/people` returns `scoredEmailAddresses`, not `emailAddresses`. The parse function will produce contacts with empty email arrays. Map `scoredEmailAddresses[].address` correctly.

10. **Redis `allkeys-lru` eviction policy** — Under memory pressure this will evict Stream entries silently. Change to `noeviction` and alert on memory, or ensure stream max-length is enforced at write time.

11. **`Traefik api.insecure=true` in docker-compose.multi.yml** — Dashboard is exposed without auth on port 8090. Remove or protect with basic auth middleware before any public deployment.

12. **Worker uses Redis Pub/Sub instead of Streams** — Messages published while the worker is down are lost. Migrate to `XADD`/`XREADGROUP` for at-least-once delivery, consistent with the documented intent in `redis.conf`.

### Suggestions (Consider Improving)

13. **Gmail N+1 fetches in `listMessages()`** — Each message requires a separate GET. Consider using Gmail batch requests (`POST /batch`) for inbox loads with more than ~10 messages.

14. **Drive upload file size limit** — `OneDriveConnector.upload()` and `GoogleDriveConnector.upload()` use simple PUT/multipart. Files over 4MB (OneDrive) or 5MB (Drive) require resumable upload sessions. Add a size check with an informative error.

15. **`tryAll()` loses intermediate error context** — The unified layer's fan-out fallback silently discards all intermediate errors. Collect them and include in the thrown error for diagnostics.

16. **Calendar deduplication by `title|start`** — Two legitimately different events with the same title at the same time (e.g., a recurring standup across two connected accounts) will be silently dropped. Consider deduplication by provider-specific iCal UID if available, or remove deduplication and let callers decide.

17. **`hardcoded personal names in worker`** — `Micazen`, `Magnussen`, `Pessy`, and "Kevin" should be removed from the intent detection and routing logic. Tenant/user context should come from the request, not hardcoded strings.

18. **`MicrosoftTasksConnector.updateTask()` runtime vs compile-time error** — `listId` is required at runtime but optional in the TypeScript type. Make it required in `UpdateTaskParams` for Microsoft, or use a discriminated union per provider.

19. **`OutlookMailConnector.send()` / `reply()` race condition** — Fetching the most recent sent item immediately after send can return a previously sent message if requests overlap. Graph's `sendMail` action should be extended to use a `POST /me/messages` + `POST /me/messages/{id}/send` pattern that returns the message ID.

20. **No test coverage** — There are zero test files across the entire `packages/` directory. The connector logic (especially the MIME builder, token encryption/decryption, and unified fan-out) is complex enough to warrant unit tests. Integration tests against Graph/Gmail sandbox environments would catch the API mismatch issues found in this review.

---

## File References

Primary source files reviewed:

- `/home/tcntryprd/boss-dev/packages/connectors/src/auth/oauth2.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/auth/token-store.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/auth/refresh.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/google/api-client.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/google/gmail.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/google/calendar.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/google/tasks.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/google/drive.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/google/contacts.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/google/chat.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/microsoft/graph-client.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/microsoft/mail.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/microsoft/calendar.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/microsoft/tasks.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/microsoft/drive.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/microsoft/teams.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/microsoft/contacts.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/unified/mail.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/unified/calendar.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/unified/tasks.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/unified/files.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/unified/contacts.ts`
- `/home/tcntryprd/boss-dev/packages/connectors/src/types.ts`
- `/home/tcntryprd/boss-dev/packages/backup/src/index.ts`
- `/home/tcntryprd/boss-dev/packages/healing/src/index.ts`
- `/home/tcntryprd/boss-dev/packages/learning/src/index.ts`
- `/home/tcntryprd/boss-dev/packages/voice/src/index.ts`
- `/home/tcntryprd/boss-dev/apps/worker/src/index.ts`
- `/home/tcntryprd/boss-dev/services/worker/app/worker.py`
- `/home/tcntryprd/boss-dev/services/worker/requirements.txt`
- `/home/tcntryprd/boss-dev/docker-compose.yml`
- `/home/tcntryprd/boss-dev/docker-compose.multi.yml`
- `/home/tcntryprd/boss-dev/services/postgres/migrations/001_core_schema.sql`
- `/home/tcntryprd/boss-dev/services/postgres/migrations/002_multi_tenant_functions.sql`
- `/home/tcntryprd/boss-dev/services/redis/redis.conf`
- `/home/tcntryprd/boss-dev/.env.example`
