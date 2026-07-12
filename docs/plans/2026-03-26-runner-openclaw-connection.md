# Runner → OpenClaw Connection Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the IR Custom AIOS pipeline by connecting the runner service to OpenClaw's OpenAI-compatible HTTP API so jobs flow end-to-end: Command → API → Redis → Worker → Runner → OpenClaw → Result in Postgres.

**Architecture:** The runner stays in Docker with `network_mode: host` so it can reach OpenClaw on `127.0.0.1:64837`. OpenClaw's gateway needs its HTTP chat completions endpoint enabled (disabled by default). The runner uses the standard OpenAI Python SDK to call `/v1/chat/completions` with Bearer token auth.

**Tech Stack:** Python 3.11, OpenAI SDK, psycopg, OpenClaw gateway (host), PostgreSQL, Redis, Docker Compose

---

### Task 1: Enable OpenClaw HTTP API Endpoint

**Files:**
- Modify: `~/.openclaw/openclaw.json` (gateway config on host)

**Step 1: Enable the chatCompletions endpoint**

```bash
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
```

**Step 2: Restart the gateway**

```bash
systemctl --user restart openclaw-gateway
```

**Step 3: Wait for gateway to start and verify**

```bash
sleep 5
curl -s -H "Authorization: Bearer 49ae6887589e068d4df37dfb3415faecd007e7ef8987dffb" \
  http://127.0.0.1:64837/v1/models
```

Expected: JSON response listing models like `{"data": [{"id": "openclaw", ...}]}` — NOT HTML.

**Step 4: Test chat completions endpoint**

```bash
curl -s -X POST http://127.0.0.1:64837/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 49ae6887589e068d4df37dfb3415faecd007e7ef8987dffb" \
  -d '{"model":"openclaw","messages":[{"role":"user","content":"Say hello in one sentence"}]}'
```

Expected: JSON response with `choices[0].message.content` containing a reply.

If this fails: check `journalctl --user -u openclaw-gateway -n 20` for errors.

---

### Task 2: Fix Runner Service Code

**Files:**
- Modify: `/home/tcntryprd/boss-dev/services/runner/app/runner.py`
- Modify: `/home/tcntryprd/boss-dev/services/runner/requirements.txt`

**Step 1: Write the runner with OpenAI SDK + proper auth**

Replace `services/runner/app/runner.py` with:

```python
import os
import time
import psycopg
from openai import OpenAI

POSTGRES_URL = os.getenv(
    "POSTGRES_URL",
    "postgresql://boss:bosspass@127.0.0.1:5434/boss_db"
)

OPENCLAW_BASE_URL = os.getenv(
    "OPENCLAW_BASE_URL",
    "http://127.0.0.1:64837/v1"
)

OPENCLAW_API_KEY = os.getenv(
    "OPENCLAW_API_KEY",
    "not-needed"
)

OPENCLAW_MODEL = os.getenv(
    "OPENCLAW_MODEL",
    "openclaw"
)

client = OpenAI(
    base_url=OPENCLAW_BASE_URL,
    api_key=OPENCLAW_API_KEY,
)


def log(msg):
    print(msg, flush=True)


def get_pg():
    return psycopg.connect(POSTGRES_URL)


def process_build(request_text):
    log(f"[RUNNER] Sending to OpenClaw: {request_text}")
    log(f"[RUNNER] URL: {OPENCLAW_BASE_URL}, Model: {OPENCLAW_MODEL}")

    try:
        response = client.chat.completions.create(
            model=OPENCLAW_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are IR Custom AIOS, an AI orchestration system. "
                        "Execute the user's build request and return a clear, "
                        "actionable response."
                    ),
                },
                {"role": "user", "content": request_text},
            ],
        )

        output = (response.choices[0].message.content or "").strip()
        log(f"[RUNNER OUTPUT] {output[:200]}")
        return True, output

    except Exception as e:
        log(f"[RUNNER ERROR] {type(e).__name__}: {e}")
        return False, f"ERROR: {type(e).__name__}: {e}"


def main():
    log("IR Custom AIOS runner starting...")
    log(f"[RUNNER] OpenClaw: {OPENCLAW_BASE_URL}")
    log(f"[RUNNER] Model: {OPENCLAW_MODEL}")
    log(f"[RUNNER] Postgres: {POSTGRES_URL}")

    while True:
        try:
            with get_pg() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT id, request_text
                        FROM boss_build_queue
                        WHERE status = 'NEW'
                        ORDER BY id
                        LIMIT 1
                    """)
                    row = cur.fetchone()

                    if not row:
                        time.sleep(2)
                        continue

                    job_id, request_text = row
                    log(f"[RUNNER] Picked job {job_id}: {request_text}")

                    cur.execute(
                        "UPDATE boss_build_queue SET status = %s WHERE id = %s",
                        ("PROCESSING", job_id),
                    )
                    conn.commit()

                    ok, result_text = process_build(request_text)
                    status = "DONE" if ok else "FAILED"

                    cur.execute(
                        "UPDATE boss_build_queue SET status = %s, result = %s WHERE id = %s",
                        (status, result_text, job_id),
                    )
                    conn.commit()

                    log(f"[RUNNER] Job {job_id} → {status}")

        except Exception as e:
            log(f"[RUNNER ERROR] {e}")
            time.sleep(3)


if __name__ == "__main__":
    main()
```

**Step 2: Confirm requirements.txt is correct**

`services/runner/requirements.txt`:
```
psycopg[binary]
python-dotenv
openai
```

No changes needed — already has openai.

---

### Task 3: Fix Docker Compose for Runner

**Files:**
- Modify: `/home/tcntryprd/boss-dev/infra/docker-compose.yml`

**Step 1: Confirm runner service config**

The runner section should be:
```yaml
  runner:
    build: ../services/runner
    container_name: boss_runner
    restart: unless-stopped
    network_mode: host
    environment:
      POSTGRES_URL: postgresql://boss:bosspass@127.0.0.1:5434/boss_db
      OPENCLAW_BASE_URL: http://127.0.0.1:64837/v1
      OPENCLAW_MODEL: openclaw
      OPENCLAW_API_KEY: "49ae6887589e068d4df37dfb3415faecd007e7ef8987dffb"
```

Key points:
- `network_mode: host` — runner shares host network, reaches OpenClaw on loopback
- Postgres URL uses `127.0.0.1:5434` (host-mapped port, not Docker DNS)
- No `depends_on` (host network can't use Docker service names)
- No `extra_hosts` needed (already on host network)

---

### Task 4: Fix Database Schema (add result column)

**Files:**
- Modify: `/home/tcntryprd/boss-dev/services/worker/app/worker.py`

**Step 1: Add result column to CREATE TABLE in worker**

In `worker.py`, update the `boss_build_queue` CREATE TABLE to include the `result` column:

```sql
CREATE TABLE IF NOT EXISTS boss_build_queue (
    id SERIAL PRIMARY KEY,
    request_text TEXT,
    status TEXT DEFAULT 'NEW',
    result TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Step 2: Add the column to existing table (one-time migration)**

```bash
docker exec boss_postgres psql -U boss -d boss_db -c \
  "ALTER TABLE boss_build_queue ADD COLUMN IF NOT EXISTS result TEXT;"
```

Expected: `ALTER TABLE`

---

### Task 5: Rebuild, Restart, and End-to-End Test

**Step 1: Rebuild runner**

```bash
cd ~/boss-dev/infra && docker compose up -d --build runner
```

**Step 2: Check runner logs**

```bash
docker logs boss_runner --tail 10
```

Expected: `IR Custom AIOS runner starting...` with URL/model info, no errors.

**Step 3: Reset old failed jobs**

```bash
docker exec boss_postgres psql -U boss -d boss_db -c \
  "UPDATE boss_build_queue SET status = 'CANCELLED' WHERE status IN ('FAILED', 'PROCESSING');"
```

**Step 4: Insert test job**

```bash
docker exec boss_postgres psql -U boss -d boss_db -c \
  "INSERT INTO boss_build_queue (request_text, status) VALUES ('Say hello and confirm IR Custom AIOS pipeline is working end to end', 'NEW');"
```

**Step 5: Wait and check result**

```bash
sleep 30 && docker exec boss_postgres psql -U boss -d boss_db -c \
  "SELECT id, status, left(result, 200) as result_preview FROM boss_build_queue ORDER BY id DESC LIMIT 3;"
```

Expected: Latest job has `status = 'DONE'` with a response in `result_preview`.

**Step 6: Full pipeline test via API**

```bash
curl -s -X POST http://localhost:8001/spoken-command \
  -H "Content-Type: application/json" \
  -d '{"text": "build me a hello world python script"}'
```

Then wait 30s and check:
```bash
docker exec boss_postgres psql -U boss -d boss_db -c \
  "SELECT id, status, left(result, 200) FROM boss_build_queue ORDER BY id DESC LIMIT 1;"
```

Expected: `DONE` with an actual response from OpenClaw.

---

### Task 6: Verify TUI Still Works

**Step 1: Check OpenClaw TUI wasn't disrupted**

```bash
tmux capture-pane -t sp-main:3 -p | tail -5
```

Expected: `gateway connected | idle` — TUI should reconnect after gateway restart.

If disconnected, restart TUI:
```bash
tmux send-keys -t sp-main:3 "openclaw tui" Enter
```
