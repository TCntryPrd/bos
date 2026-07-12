# IR Custom AIOS Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the event-driven autonomous orchestration engine that transforms IR Custom AIOS from a command-response system into a fully autonomous AIOS.

**Architecture:** Connectors poll external services and emit events to Redis Streams. The Reactor service consumes events, evaluates rules from Postgres, and dispatches actions (OpenClaw execution, direct API calls, or human escalation). All events are persisted for audit and replay.

**Tech Stack:** Python 3.11, FastAPI, Redis Streams (not pub/sub), PostgreSQL, OpenClaw (host, port 64837), Docker Compose

---

### Task 1: Event Bus — Redis Streams Infrastructure

**Files:**
- Create: `services/shared/event_bus.py`
- Create: `services/shared/__init__.py`
- Create: `services/shared/models.py`

**What this builds:** A shared Python module that any service can import to publish/consume events via Redis Streams. Replaces the current pub/sub model with persistent, ordered, replayable streams.

**Step 1: Create shared module directory**

```bash
mkdir -p /home/tcntryprd/boss-dev/services/shared
```

**Step 2: Create event models**

Create `services/shared/models.py`:

```python
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
import uuid
import json


@dataclass
class IR Custom AIOSEvent:
    type: str                    # e.g. "email.received", "calendar.event_ended"
    source: str                  # e.g. "gmail-connector", "manual"
    data: dict = field(default_factory=dict)
    tenant: str = "kevin"
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata: dict = field(default_factory=dict)

    def to_stream(self) -> dict:
        """Serialize for Redis Stream XADD."""
        return {
            "id": self.id,
            "type": self.type,
            "source": self.source,
            "tenant": self.tenant,
            "timestamp": self.timestamp,
            "data": json.dumps(self.data),
            "metadata": json.dumps(self.metadata),
        }

    @classmethod
    def from_stream(cls, entry: dict) -> "IR Custom AIOSEvent":
        """Deserialize from Redis Stream XREAD."""
        return cls(
            id=entry.get("id", ""),
            type=entry.get("type", ""),
            source=entry.get("source", ""),
            tenant=entry.get("tenant", "kevin"),
            timestamp=entry.get("timestamp", ""),
            data=json.loads(entry.get("data", "{}")),
            metadata=json.loads(entry.get("metadata", "{}")),
        )
```

**Step 3: Create event bus**

Create `services/shared/event_bus.py`:

```python
import os
import redis
import json
from .models import IR Custom AIOSEvent

REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
STREAM_KEY = "boss:events"
CONSUMER_GROUP = "boss-reactor"


def get_redis():
    return redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)


def publish_event(event: IR Custom AIOSEvent, r: redis.Redis | None = None):
    """Publish event to Redis Stream."""
    conn = r or get_redis()
    conn.xadd(STREAM_KEY, event.to_stream())


def ensure_consumer_group(r: redis.Redis):
    """Create consumer group if not exists."""
    try:
        r.xgroup_create(STREAM_KEY, CONSUMER_GROUP, id="0", mkstream=True)
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def consume_events(consumer_name: str, count: int = 10, block_ms: int = 2000, r: redis.Redis | None = None):
    """Read events from stream as consumer in group. Returns list of (stream_id, IR Custom AIOSEvent)."""
    conn = r or get_redis()
    ensure_consumer_group(conn)

    results = conn.xreadgroup(
        CONSUMER_GROUP, consumer_name, {STREAM_KEY: ">"}, count=count, block=block_ms
    )

    events = []
    if results:
        for stream_name, entries in results:
            for stream_id, entry in entries:
                events.append((stream_id, IR Custom AIOSEvent.from_stream(entry)))
    return events


def ack_event(stream_id: str, r: redis.Redis | None = None):
    """Acknowledge processed event."""
    conn = r or get_redis()
    conn.xack(STREAM_KEY, CONSUMER_GROUP, stream_id)
```

**Step 4: Create `__init__.py`**

Create `services/shared/__init__.py`:
```python
from .event_bus import publish_event, consume_events, ack_event, get_redis, STREAM_KEY
from .models import IR Custom AIOSEvent
```

**Step 5: Verify**

```bash
python3 -c "import sys; sys.path.insert(0, '/home/tcntryprd/boss-dev/services'); from shared import IR Custom AIOSEvent, publish_event; print('OK')"
```

---

### Task 2: Reactor Service — Rule Engine

**Files:**
- Create: `services/reactor/app/reactor.py`
- Create: `services/reactor/app/rules.py`
- Create: `services/reactor/app/actions.py`
- Create: `services/reactor/Dockerfile`
- Create: `services/reactor/requirements.txt`
- Modify: `infra/docker-compose.yml`

**What this builds:** The brain of IR Custom AIOS. Consumes events from the bus, evaluates rules from Postgres, dispatches actions.

**Step 1: Create directory**

```bash
mkdir -p /home/tcntryprd/boss-dev/services/reactor/app
```

**Step 2: Create rules engine**

Create `services/reactor/app/rules.py`:

```python
import os
import json
import psycopg
from datetime import datetime, timezone

POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@postgres:5432/boss_db")


def get_pg():
    return psycopg.connect(POSTGRES_URL)


def ensure_tables():
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_rules (
                    id SERIAL PRIMARY KEY,
                    name TEXT UNIQUE NOT NULL,
                    description TEXT DEFAULT '',
                    event_type TEXT NOT NULL,
                    conditions JSONB DEFAULT '{}',
                    actions JSONB NOT NULL DEFAULT '[]',
                    enabled BOOLEAN DEFAULT true,
                    priority INT DEFAULT 0,
                    cooldown_seconds INT DEFAULT 0,
                    last_fired_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_rule_executions (
                    id SERIAL PRIMARY KEY,
                    rule_id INT REFERENCES boss_rules(id),
                    rule_name TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    actions_taken JSONB DEFAULT '[]',
                    status TEXT DEFAULT 'SUCCESS',
                    error TEXT,
                    duration_ms INT,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_events_log (
                    id SERIAL PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    source TEXT NOT NULL,
                    tenant TEXT DEFAULT 'kevin',
                    data JSONB DEFAULT '{}',
                    metadata JSONB DEFAULT '{}',
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_escalations (
                    id SERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    context TEXT DEFAULT '',
                    source_event_id TEXT,
                    source_rule TEXT,
                    status TEXT DEFAULT 'PENDING',
                    resolved_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_connectors (
                    id SERIAL PRIMARY KEY,
                    name TEXT UNIQUE NOT NULL,
                    connector_type TEXT NOT NULL,
                    config JSONB DEFAULT '{}',
                    enabled BOOLEAN DEFAULT true,
                    status TEXT DEFAULT 'idle',
                    last_poll_at TIMESTAMPTZ,
                    last_error TEXT,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            """)
        conn.commit()


def seed_default_rules():
    """Seed starter rules if none exist."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM boss_rules")
            if cur.fetchone()[0] > 0:
                return

            rules = [
                {
                    "name": "email_triage",
                    "description": "When email received, classify priority and route",
                    "event_type": "email.received",
                    "conditions": {},
                    "actions": [
                        {"type": "openclaw", "prompt": "Triage this email. Classify as P1_URGENT, P2_REPLY_NEEDED, P3_EYES_ONLY, or PROMOTIONAL. If P1, escalate. If P2, draft a reply. Otherwise log and skip. Email: {data}"},
                    ],
                    "priority": 10,
                    "cooldown_seconds": 0,
                },
                {
                    "name": "meeting_followup",
                    "description": "After meeting ends, fetch transcript and draft follow-up",
                    "event_type": "calendar.event_ended",
                    "conditions": {"has_external_attendees": True},
                    "actions": [
                        {"type": "openclaw", "prompt": "A meeting just ended: {data}. Check for a transcript. Summarize key decisions and action items. Draft a follow-up email to attendees."},
                        {"type": "escalate", "title": "Review meeting follow-up draft", "context": "Meeting: {data.summary}"},
                    ],
                    "priority": 5,
                    "cooldown_seconds": 300,
                },
                {
                    "name": "payment_received",
                    "description": "Log payment and notify",
                    "event_type": "payment.received",
                    "conditions": {},
                    "actions": [
                        {"type": "notify", "channel": "telegram", "message": "Payment received: ${data.amount} from {data.customer}"},
                        {"type": "log", "message": "Payment logged"},
                    ],
                    "priority": 3,
                    "cooldown_seconds": 0,
                },
                {
                    "name": "task_reminder",
                    "description": "When calendar event is starting soon, check for prep tasks",
                    "event_type": "calendar.event_starting",
                    "conditions": {},
                    "actions": [
                        {"type": "openclaw", "prompt": "Meeting starting soon: {data}. Check if there are any prep tasks or documents needed. If anything is missing, escalate."},
                    ],
                    "priority": 8,
                    "cooldown_seconds": 600,
                },
                {
                    "name": "daily_digest",
                    "description": "Morning digest of today's calendar, pending tasks, overnight emails",
                    "event_type": "system.daily_trigger",
                    "conditions": {},
                    "actions": [
                        {"type": "openclaw", "prompt": "Generate the morning briefing. Check today's calendar, pending Google Tasks, unread priority emails from overnight. Summarize into a concise daily brief."},
                        {"type": "notify", "channel": "telegram", "message": "Morning brief ready"},
                    ],
                    "priority": 1,
                    "cooldown_seconds": 86400,
                },
            ]

            for rule in rules:
                cur.execute(
                    "INSERT INTO boss_rules (name, description, event_type, conditions, actions, priority, cooldown_seconds) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (rule["name"], rule["description"], rule["event_type"],
                     json.dumps(rule["conditions"]), json.dumps(rule["actions"]),
                     rule["priority"], rule["cooldown_seconds"]),
                )
        conn.commit()


def get_matching_rules(event_type: str) -> list:
    """Get all enabled rules matching an event type, ordered by priority desc."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, event_type, conditions, actions, cooldown_seconds, last_fired_at FROM boss_rules WHERE event_type = %s AND enabled = true ORDER BY priority DESC",
                (event_type,),
            )
            rows = cur.fetchall()

    rules = []
    now = datetime.now(timezone.utc)
    for r in rows:
        rule_id, name, etype, conditions, actions, cooldown, last_fired = r
        # Check cooldown
        if cooldown and last_fired:
            elapsed = (now - last_fired).total_seconds()
            if elapsed < cooldown:
                continue
        rules.append({
            "id": rule_id,
            "name": name,
            "event_type": etype,
            "conditions": conditions if isinstance(conditions, dict) else json.loads(conditions),
            "actions": actions if isinstance(actions, list) else json.loads(actions),
        })
    return rules


def log_execution(rule_id: int, rule_name: str, event_id: str, event_type: str, actions_taken: list, status: str, error: str | None, duration_ms: int):
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO boss_rule_executions (rule_id, rule_name, event_id, event_type, actions_taken, status, error, duration_ms) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (rule_id, rule_name, event_id, event_type, json.dumps(actions_taken), status, error, duration_ms),
            )
            # Update last_fired_at
            cur.execute("UPDATE boss_rules SET last_fired_at = now() WHERE id = %s", (rule_id,))
        conn.commit()


def log_event_to_db(event):
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO boss_events_log (event_id, event_type, source, tenant, data, metadata) VALUES (%s, %s, %s, %s, %s, %s)",
                (event.id, event.type, event.source, event.tenant, json.dumps(event.data), json.dumps(event.metadata)),
            )
        conn.commit()


def create_escalation(title: str, context: str, event_id: str, rule_name: str):
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO boss_escalations (title, context, source_event_id, source_rule) VALUES (%s, %s, %s, %s) RETURNING id",
                (title, context, event_id, rule_name),
            )
            esc_id = cur.fetchone()[0]
        conn.commit()
    return esc_id
```

**Step 3: Create actions executor**

Create `services/reactor/app/actions.py`:

```python
import os
import json
import re
from openai import OpenAI

OPENCLAW_BASE_URL = os.getenv("OPENCLAW_BASE_URL", "http://127.0.0.1:64837/v1")
OPENCLAW_API_KEY = os.getenv("OPENCLAW_API_KEY", "not-needed")
OPENCLAW_MODEL = os.getenv("OPENCLAW_MODEL", "openclaw")

openclaw = OpenAI(base_url=OPENCLAW_BASE_URL, api_key=OPENCLAW_API_KEY)


def log(msg):
    print(msg, flush=True)


def render_template(template: str, event) -> str:
    """Simple template rendering: {data}, {data.field}, {type}, etc."""
    result = template
    result = result.replace("{type}", event.type)
    result = result.replace("{source}", event.source)
    result = result.replace("{tenant}", event.tenant)
    result = result.replace("{data}", json.dumps(event.data, default=str))

    # Handle {data.field} patterns
    for match in re.finditer(r'\{data\.(\w+)\}', template):
        field = match.group(1)
        value = event.data.get(field, f"<missing:{field}>")
        result = result.replace(match.group(0), str(value))

    return result


def execute_action(action: dict, event, rule_name: str) -> dict:
    """Execute a single action. Returns result dict."""
    action_type = action.get("type", "unknown")

    if action_type == "openclaw":
        return execute_openclaw(action, event)
    elif action_type == "escalate":
        return execute_escalate(action, event, rule_name)
    elif action_type == "notify":
        return execute_notify(action, event)
    elif action_type == "log":
        return execute_log(action, event)
    else:
        return {"type": action_type, "status": "skipped", "reason": f"Unknown action type: {action_type}"}


def execute_openclaw(action: dict, event) -> dict:
    """Send prompt to OpenClaw via OpenAI-compatible API."""
    prompt = render_template(action.get("prompt", ""), event)
    log(f"[ACTION:openclaw] {prompt[:150]}...")

    try:
        response = openclaw.chat.completions.create(
            model=OPENCLAW_MODEL,
            messages=[
                {"role": "system", "content": "You are IR Custom AIOS. Execute the task autonomously. If you need human input, say ESCALATE: followed by what you need."},
                {"role": "user", "content": prompt},
            ],
        )
        output = (response.choices[0].message.content or "").strip()
        log(f"[ACTION:openclaw] Response: {output[:200]}")

        # Check if OpenClaw is requesting escalation
        needs_escalation = output.upper().startswith("ESCALATE:")
        return {
            "type": "openclaw",
            "status": "escalation_requested" if needs_escalation else "success",
            "output": output,
        }
    except Exception as e:
        log(f"[ACTION:openclaw] Error: {e}")
        return {"type": "openclaw", "status": "error", "error": str(e)}


def execute_escalate(action: dict, event, rule_name: str) -> dict:
    """Create human escalation."""
    from .rules import create_escalation
    title = render_template(action.get("title", "Action needed"), event)
    context = render_template(action.get("context", ""), event)
    esc_id = create_escalation(title, context, event.id, rule_name)
    log(f"[ACTION:escalate] Created escalation #{esc_id}: {title}")
    return {"type": "escalate", "status": "created", "escalation_id": esc_id}


def execute_notify(action: dict, event) -> dict:
    """Send notification (Telegram via OpenClaw, or log for now)."""
    channel = action.get("channel", "log")
    message = render_template(action.get("message", ""), event)
    log(f"[ACTION:notify:{channel}] {message}")
    # TODO: Wire to OpenClaw Telegram delivery or direct API
    return {"type": "notify", "status": "logged", "channel": channel, "message": message}


def execute_log(action: dict, event) -> dict:
    """Just log the message."""
    message = render_template(action.get("message", ""), event)
    log(f"[ACTION:log] {message}")
    return {"type": "log", "status": "logged", "message": message}
```

**Step 4: Create reactor main loop**

Create `services/reactor/app/reactor.py`:

```python
import os
import sys
import time
import json

# Add shared module to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from shared.event_bus import consume_events, ack_event, get_redis
from shared.models import IR Custom AIOSEvent
from app.rules import ensure_tables, seed_default_rules, get_matching_rules, log_execution, log_event_to_db
from app.actions import execute_action


def log(msg):
    print(msg, flush=True)


def process_event(stream_id: str, event: IR Custom AIOSEvent):
    """Process a single event through the rule engine."""
    log(f"[REACTOR] Processing event {event.type} from {event.source} (id={event.id[:8]}...)")

    # Persist event
    log_event_to_db(event)

    # Find matching rules
    rules = get_matching_rules(event.type)
    if not rules:
        log(f"[REACTOR] No rules match {event.type}")
        ack_event(stream_id)
        return

    for rule in rules:
        start_ms = time.time()
        log(f"[REACTOR] Firing rule: {rule['name']}")

        actions_taken = []
        status = "SUCCESS"
        error = None

        try:
            for action_def in rule["actions"]:
                result = execute_action(action_def, event, rule["name"])
                actions_taken.append(result)

                # If OpenClaw requested escalation, create one
                if result.get("status") == "escalation_requested":
                    from app.rules import create_escalation
                    create_escalation(
                        f"OpenClaw escalation from rule '{rule['name']}'",
                        result.get("output", ""),
                        event.id,
                        rule["name"],
                    )

                # Stop chain on error
                if result.get("status") == "error":
                    status = "PARTIAL"
                    error = result.get("error", "Unknown error")
                    break

        except Exception as e:
            status = "FAILED"
            error = str(e)
            log(f"[REACTOR] Rule {rule['name']} failed: {e}")

        duration_ms = int((time.time() - start_ms) * 1000)
        log_execution(rule["id"], rule["name"], event.id, event.type, actions_taken, status, error, duration_ms)
        log(f"[REACTOR] Rule {rule['name']} → {status} ({duration_ms}ms)")

    ack_event(stream_id)


def main():
    log("IR Custom AIOS Reactor starting...")
    log("[REACTOR] Initializing database tables...")
    ensure_tables()
    seed_default_rules()
    log("[REACTOR] Tables ready, default rules seeded")

    r = get_redis()
    consumer_name = f"reactor-{os.getpid()}"
    log(f"[REACTOR] Consumer: {consumer_name}")
    log("[REACTOR] Listening for events on boss:events...")

    while True:
        try:
            events = consume_events(consumer_name, count=5, block_ms=2000, r=r)
            for stream_id, event in events:
                process_event(stream_id, event)
        except Exception as e:
            log(f"[REACTOR] Error: {e}")
            time.sleep(3)


if __name__ == "__main__":
    main()
```

**Step 5: Create Dockerfile and requirements**

Create `services/reactor/requirements.txt`:
```
psycopg[binary]
redis
openai
python-dotenv
```

Create `services/reactor/Dockerfile`:
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ../shared /app/shared
COPY ./app ./app
CMD ["python", "-u", "app/reactor.py"]
```

**Step 6: Add to docker-compose.yml**

Add reactor service:
```yaml
  reactor:
    build:
      context: ../services
      dockerfile: reactor/Dockerfile
    container_name: boss_reactor
    restart: unless-stopped
    network_mode: host
    environment:
      POSTGRES_URL: postgresql://boss:bosspass@127.0.0.1:5434/boss_db
      REDIS_HOST: 127.0.0.1
      REDIS_PORT: "6381"
      OPENCLAW_BASE_URL: http://127.0.0.1:64837/v1
      OPENCLAW_MODEL: openclaw
      OPENCLAW_API_KEY: "49ae6887589e068d4df37dfb3415faecd007e7ef8987dffb"
```

**Step 7: Build and test**

```bash
cd ~/boss-dev/infra && docker compose up -d --build reactor
docker logs boss_reactor --tail 20
```

Expected: "IR Custom AIOS Reactor starting... Tables ready, default rules seeded... Listening for events..."

---

### Task 3: Connectors Service — Gmail + Calendar

**Files:**
- Create: `services/connectors/app/connectors.py`
- Create: `services/connectors/app/gmail_connector.py`
- Create: `services/connectors/app/calendar_connector.py`
- Create: `services/connectors/app/scheduler.py`
- Create: `services/connectors/Dockerfile`
- Create: `services/connectors/requirements.txt`

**What this builds:** A polling service that watches Gmail and Google Calendar, emitting events to the bus when things happen.

**Step 1: Create directory**

```bash
mkdir -p /home/tcntryprd/boss-dev/services/connectors/app
```

**Step 2: Create Gmail connector**

Create `services/connectors/app/gmail_connector.py`:

```python
import os
import json
import httpx

# Uses the IR Custom AIOS API which proxies to MCP Gmail tools
BOSS_API = os.getenv("BOSS_API_URL", "http://127.0.0.1:8001/boss")
BOSS_TOKEN = os.getenv("BOSS_API_TOKEN", "")


def log(msg):
    print(msg, flush=True)


def poll_gmail(last_check_id: str | None = None) -> list:
    """Poll Gmail for new messages since last check. Returns list of event dicts."""
    # For Phase 1, we use OpenClaw to check Gmail via the MCP tools
    # This will be replaced with direct Gmail API in Phase 2
    events = []

    try:
        headers = {"Authorization": f"Bearer {BOSS_TOKEN}"} if BOSS_TOKEN else {}
        with httpx.Client(timeout=30) as client:
            # Use the spoken-command endpoint to ask OpenClaw to check email
            # This is a bootstrap approach — direct Gmail API integration comes in Phase 2
            resp = client.post(
                f"{BOSS_API}/spoken-command",
                headers=headers,
                json={"text": "check my email inbox for any new unread messages in the last 30 minutes. List sender, subject, and a one-line summary for each. Return as JSON array."},
            )
            if resp.status_code == 200:
                data = resp.json()
                response_text = data.get("response", "")
                if response_text and response_text != "No response within timeout":
                    events.append({
                        "type": "email.check_completed",
                        "data": {"raw_response": response_text},
                    })
    except Exception as e:
        log(f"[GMAIL] Poll error: {e}")

    return events
```

**Step 3: Create Calendar connector**

Create `services/connectors/app/calendar_connector.py`:

```python
import os
import httpx
from datetime import datetime, timezone, timedelta


BOSS_API = os.getenv("BOSS_API_URL", "http://127.0.0.1:8001/boss")
BOSS_TOKEN = os.getenv("BOSS_API_TOKEN", "")


def log(msg):
    print(msg, flush=True)


def poll_calendar() -> list:
    """Check calendar for upcoming events and recently ended events."""
    events = []

    try:
        headers = {"Authorization": f"Bearer {BOSS_TOKEN}"} if BOSS_TOKEN else {}
        now = datetime.now(timezone.utc)

        with httpx.Client(timeout=30) as client:
            # Check for events starting in the next 15 minutes
            resp = client.post(
                f"{BOSS_API}/spoken-command",
                headers=headers,
                json={"text": f"Check my Google Calendar. What meetings do I have in the next 15 minutes? And did any meetings end in the last 15 minutes? Return as JSON with 'upcoming' and 'ended' arrays. Each entry should have: title, start_time, end_time, attendees."},
            )
            if resp.status_code == 200:
                data = resp.json()
                response_text = data.get("response", "")
                if response_text and response_text != "No response within timeout":
                    events.append({
                        "type": "calendar.check_completed",
                        "data": {"raw_response": response_text, "checked_at": now.isoformat()},
                    })
    except Exception as e:
        log(f"[CALENDAR] Poll error: {e}")

    return events
```

**Step 4: Create scheduler/main loop**

Create `services/connectors/app/scheduler.py`:

```python
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from shared.event_bus import publish_event, get_redis
from shared.models import IR Custom AIOSEvent
from app.gmail_connector import poll_gmail
from app.calendar_connector import poll_calendar


def log(msg):
    print(msg, flush=True)


# Poll intervals in seconds
GMAIL_INTERVAL = int(os.getenv("GMAIL_POLL_INTERVAL", "300"))       # 5 min
CALENDAR_INTERVAL = int(os.getenv("CALENDAR_POLL_INTERVAL", "300")) # 5 min
DAILY_TRIGGER_HOUR = int(os.getenv("DAILY_TRIGGER_HOUR", "8"))      # 8 AM UTC


def emit_events(raw_events: list, source: str, r):
    """Convert raw connector events to IR Custom AIOSEvents and publish."""
    for raw in raw_events:
        event = IR Custom AIOSEvent(
            type=raw["type"],
            source=source,
            data=raw.get("data", {}),
            metadata=raw.get("metadata", {}),
        )
        publish_event(event, r)
        log(f"[CONNECTOR] Emitted {event.type} from {source}")


def main():
    log("IR Custom AIOS Connectors starting...")
    r = get_redis()

    last_gmail = 0
    last_calendar = 0
    last_daily = ""

    while True:
        now = time.time()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        current_hour = datetime.now(timezone.utc).hour

        try:
            # Gmail poll
            if now - last_gmail >= GMAIL_INTERVAL:
                log("[CONNECTOR] Polling Gmail...")
                events = poll_gmail()
                emit_events(events, "gmail-connector", r)
                last_gmail = now

            # Calendar poll
            if now - last_calendar >= CALENDAR_INTERVAL:
                log("[CONNECTOR] Polling Calendar...")
                events = poll_calendar()
                emit_events(events, "calendar-connector", r)
                last_calendar = now

            # Daily trigger (once per day at specified hour)
            if current_hour == DAILY_TRIGGER_HOUR and last_daily != today:
                log("[CONNECTOR] Emitting daily trigger...")
                event = IR Custom AIOSEvent(
                    type="system.daily_trigger",
                    source="scheduler",
                    data={"date": today, "hour": current_hour},
                )
                publish_event(event, r)
                last_daily = today

        except Exception as e:
            log(f"[CONNECTOR] Error: {e}")

        time.sleep(30)  # Check every 30 seconds if any poll is due


if __name__ == "__main__":
    main()
```

**Step 5: Dockerfile and requirements**

Create `services/connectors/requirements.txt`:
```
redis
httpx
python-dotenv
```

Create `services/connectors/Dockerfile`:
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ../shared /app/shared
COPY ./app ./app
CMD ["python", "-u", "app/scheduler.py"]
```

**Step 6: Add to docker-compose.yml**

```yaml
  connectors:
    build:
      context: ../services
      dockerfile: connectors/Dockerfile
    container_name: boss_connectors
    restart: unless-stopped
    network_mode: host
    environment:
      BOSS_API_URL: http://127.0.0.1:8001/boss
      BOSS_API_TOKEN: "<REDACTED: BOSS_API_TOKEN — see .env.boss-token>"
      REDIS_HOST: 127.0.0.1
      REDIS_PORT: "6381"
      GMAIL_POLL_INTERVAL: "300"
      CALENDAR_POLL_INTERVAL: "300"
```

---

### Task 4: Wire Existing Worker to Event Bus

**Files:**
- Modify: `services/worker/app/worker.py`

**What this builds:** Bridges the old pub/sub worker to also publish events to the new Redis Streams bus, so manual commands flow through the same reactor pipeline.

**Step 1: Update worker to publish to event bus**

Add after the existing pub/sub message handling — when a BUILD command comes in, also publish to the event bus stream so the reactor sees it:

In the worker's message loop, after the existing `INSERT INTO boss_build_queue` block, add:
```python
# Also publish to event bus for reactor
from shared.event_bus import publish_event
from shared.models import IR Custom AIOSEvent

event = IR Custom AIOSEvent(
    type=f"command.{intent.lower()}",
    source="manual",
    data={"text": payload, "intent": intent},
)
publish_event(event, redis_conn)
```

This means manual commands (`/spoken-command`) emit events that the reactor can also react to.

---

### Task 5: API Endpoints for AIOS Management

**Files:**
- Modify: `services/api/app/main.py`

**What this builds:** Dashboard endpoints to view/manage the AIOS: rules, connectors, escalations, event log.

New endpoints (admin only):
- `GET /aios/rules` — list all rules
- `POST /aios/rules` — create rule
- `PUT /aios/rules/{id}` — update rule (enable/disable/modify)
- `GET /aios/events` — event log (last 100)
- `GET /aios/executions` — rule execution log
- `GET /aios/escalations` — pending escalations
- `POST /aios/escalations/{id}/resolve` — mark escalation resolved
- `GET /aios/connectors` — connector status
- `POST /aios/test-event` — manually inject an event for testing

---

### Task 6: Dashboard AIOS Pages

**Files:**
- Create: `services/dashboard/src/pages/AIOSPage.tsx`
- Modify: `services/dashboard/src/App.tsx`
- Modify: `services/dashboard/src/components/Layout.tsx`

**What this builds:** Dashboard view into the AIOS brain — event stream, active rules, rule executions, pending escalations, connector health.

New page: AIOS Control
- Live event stream (polling /aios/events)
- Active rules list with enable/disable toggles
- Rule execution log with status badges
- Pending escalations with resolve buttons
- Connector status indicators
- Test event injection form

Add nav item and route for the AIOS page.

---

## Execution Order

Tasks 1-3 are the core — event bus, reactor, connectors. They can be built in sequence (each depends on the previous). Task 4 bridges old and new. Tasks 5-6 add visibility.

**Critical path:** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6
