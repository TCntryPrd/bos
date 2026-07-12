"""
Alexa Skill for IR Custom AIOS.

One intent: CatchAllIntent. Captures raw speech. Sends everything to OpenClaw.
No intent matching. No slot parsing. No prefixes. Just raw human speech → AI brain.

Simple queries: respond within Alexa's timeout.
Complex tasks: acknowledge, execute async, report on next launch.
"""

import os
import json
import threading
import psycopg
from openai import OpenAI

OPENCLAW_BASE_URL = os.getenv("OPENCLAW_BASE_URL", "http://127.0.0.1:64837/v1")
OPENCLAW_API_KEY = os.getenv("OPENCLAW_API_KEY", "")
OPENCLAW_MODEL = os.getenv("OPENCLAW_MODEL", "openclaw")
POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@127.0.0.1:5434/boss_db")

openclaw_fast = OpenAI(base_url=OPENCLAW_BASE_URL, api_key=OPENCLAW_API_KEY, timeout=5.5)
openclaw_slow = OpenAI(base_url=OPENCLAW_BASE_URL, api_key=OPENCLAW_API_KEY, timeout=120.0)

BOSS_API_URL = os.getenv("BOSS_INTERNAL_URL", "http://127.0.0.1:8001/boss")
BOSS_API_TOKEN = os.getenv("BOSS_API_TOKEN", "")

SYSTEM_PROMPT = (
    "You are IR Custom AIOS, a personal AI operating system responding via voice. "
    "The user speaks naturally — messy, stream of consciousness, multiple requests in one sentence. Parse it all. "
    "Respond in 2-3 sentences MAX. Natural speech only. No markdown, no formatting, no lists. "
    "Use your boss_ tools for ALL Google operations — calendar, email, tasks, sheets, docs, drive. "
    "Do NOT use GOG or any other tools for Google services. Only boss_ tools. "
    "Chain multiple tool calls when needed. Do the work, confirm what you did. "
    "If you need clarification, ask one short question."
)

BOSS_ACTIONS = """
BOSS ACTION API (all at http://127.0.0.1:8001/boss):

CALENDAR:
- GET /google/calendar/today — read today's events
- GET /google/calendar/upcoming — next 4 hours
- POST /google/calendar/create — {summary, start, end, description?, attendees?[], location?, email?}
- PUT /google/calendar/{event_id} — {summary?, start?, end?, description?, location?, attendees?[], email?}
- DELETE /google/calendar/{event_id}?email=X

GMAIL:
- GET /google/gmail/unread — read unread
- POST /google/gmail/send — {to, subject, body, email?}
- POST /google/gmail/reply — {message_id, body, email?}
- POST /google/gmail/mark-read — {message_id, email?}
- DELETE /google/gmail/{message_id}?email=X

TASKS:
- GET /google/tasks/pending — read pending
- POST /google/tasks/create — {title, notes?}
- PUT /google/tasks/{task_id} — {title?, notes?, status?, email?}
- POST /google/tasks/{task_id}/complete
- DELETE /google/tasks/{task_id}

SHEETS:
- GET /google/sheets/read?spreadsheet_id=X&range=Sheet1 — read
- POST /google/sheets/append — {spreadsheet_id, range, rows: [[val,val]], email?}
- POST /google/sheets/update — {spreadsheet_id, range, values: [[val,val]], email?}

DOCS:
- POST /google/docs/create — {title, body_text?, email?}
- POST /google/docs/append — {doc_id, text, email?}

DRIVE:
- GET /google/drive/find?name=X — find files
- GET /google/drive/search?query=X — search
- DELETE /google/drive/{file_id}
- PUT /google/drive/{file_id}/rename — {name, email?}
"""

SYSTEM_PROMPT_BACKGROUND = (
    "You are IR Custom AIOS, a personal AI operating system. "
    "The user gave you a complex task via voice. Execute it completely. "
    "You have access to Google Calendar, Gmail, Tasks, Drive, Sheets, and other services. "
    "To take action, make HTTP calls to the IR Custom AIOS API:\n"
    + BOSS_ACTIONS +
    "\nDo everything asked. When done, summarize what you did in 2-3 short sentences for voice readback."
)


def log(msg):
    print(f"[ALEXA] {msg}", flush=True)


def get_pg():
    return psycopg.connect(POSTGRES_URL)


def ensure_tables():
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_pending_tasks (
                    id SERIAL PRIMARY KEY,
                    query TEXT NOT NULL,
                    status TEXT DEFAULT 'WORKING',
                    result TEXT,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    completed_at TIMESTAMPTZ
                );
            """)
        conn.commit()


def build_response(speech, reprompt=None, end_session=False, session_attributes=None, card_title=None, card_content=None):
    if len(speech) > 6000:
        speech = speech[:5900] + "... Ask me for more details."
    resp = {
        "version": "1.0",
        "sessionAttributes": session_attributes or {},
        "response": {
            "outputSpeech": {"type": "PlainText", "text": speech},
            "shouldEndSession": end_session,
        },
    }
    if reprompt:
        resp["response"]["reprompt"] = {"outputSpeech": {"type": "PlainText", "text": reprompt}}
    if card_title:
        resp["response"]["card"] = {"type": "Simple", "title": card_title, "content": card_content or speech}
    return resp


def elicit_slot(session_attributes=None, speech="Go ahead."):
    """Ask Alexa to keep listening and fill the rawInput slot."""
    return {
        "version": "1.0",
        "sessionAttributes": session_attributes or {},
        "response": {
            "outputSpeech": {"type": "PlainText", "text": speech},
            "shouldEndSession": False,
            "directives": [
                {
                    "type": "Dialog.ElicitSlot",
                    "slotToElicit": "rawInput",
                    "updatedIntent": {
                        "name": "CatchAllIntent",
                        "confirmationStatus": "NONE",
                        "slots": {
                            "rawInput": {
                                "name": "rawInput",
                                "confirmationStatus": "NONE",
                            }
                        },
                    },
                }
            ],
        },
    }


def is_complex(query):
    q = query.lower()
    signals = ["update", "add to", "create", "draft", "send", "write", "transcript",
               "summarize", "sheet", "spreadsheet", "first", "second", "third",
               "and then", "also", "after that", "move", "reschedule", "text", "email to",
               "let him know", "let her know", "let them know"]
    matches = sum(1 for s in signals if s in q)
    return matches >= 2 or len(query) > 200


def ask_fast(query):
    """Send query to OpenClaw. It uses boss_ tools to take action."""
    try:
        r = openclaw_fast.chat.completions.create(
            model=OPENCLAW_MODEL,
            messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": query}],
        )
        out = (r.choices[0].message.content or "").strip()
        return out.replace("**", "").replace("*", "").replace("#", "").replace("`", "")
    except Exception as e:
        log(f"Fast timeout: {e}")
        return None


def run_background(query, task_id):
    log(f"[BG] Task {task_id}: {query[:80]}...")
    try:
        r = openclaw_slow.chat.completions.create(
            model=OPENCLAW_MODEL,
            messages=[{"role": "system", "content": SYSTEM_PROMPT_BACKGROUND}, {"role": "user", "content": query}],
        )
        out = (r.choices[0].message.content or "").strip()
        out = out.replace("**", "").replace("*", "").replace("#", "").replace("`", "")
        log(f"[BG] Task {task_id} done: {out[:150]}...")
        with get_pg() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE boss_pending_tasks SET status='DONE', result=%s, completed_at=now() WHERE id=%s", (out, task_id))
            conn.commit()
    except Exception as e:
        log(f"[BG] Task {task_id} failed: {e}")
        with get_pg() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE boss_pending_tasks SET status='FAILED', result=%s, completed_at=now() WHERE id=%s", (str(e), task_id))
            conn.commit()


def queue_task(query):
    ensure_tables()
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO boss_pending_tasks (query) VALUES (%s) RETURNING id", (query,))
            tid = cur.fetchone()[0]
        conn.commit()
    threading.Thread(target=run_background, args=(query, tid), daemon=True).start()
    return tid


def check_completed():
    ensure_tables()
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, result FROM boss_pending_tasks WHERE status='DONE' ORDER BY completed_at DESC LIMIT 1")
            row = cur.fetchone()
            if row:
                cur.execute("UPDATE boss_pending_tasks SET status='REPORTED' WHERE id=%s", (row[0],))
                conn.commit()
                return row[1]
    return None


def process_query(query, session_attrs):
    """Route a query: fast response or background task."""
    if is_complex(query):
        tid = queue_task(query)
        return build_response(
            speech="Got it. I'm on it. Check back in a minute and I'll have an update.",
            reprompt="Anything else while I work on that?",
            session_attributes={**session_attrs, "pending_task": tid},
        )

    response = ask_fast(query)
    if response:
        return elicit_slot(session_attrs, response + " ... What else?")

    tid = queue_task(query)
    return build_response(
        speech="That's a bigger one. Working on it now. Check back shortly.",
        reprompt="Anything else?",
        session_attributes={**session_attrs, "pending_task": tid},
    )


async def handle_request(body: dict) -> dict:
    rtype = body.get("request", {}).get("type", "")
    session = body.get("session", {})
    attrs = session.get("attributes", {})

    # --- Launch ---
    if rtype == "LaunchRequest":
        done = check_completed()
        if done:
            return elicit_slot(attrs, f"I finished what you asked earlier. {done[:400]} ... What else do you need?")
        return elicit_slot(attrs, "IR Custom AIOS is connected. What do you need?")

    # --- Intent ---
    if rtype == "IntentRequest":
        intent = body["request"].get("intent", {})
        name = intent.get("name", "")

        if name in ("AMAZON.StopIntent", "AMAZON.CancelIntent"):
            return build_response("IR Custom AIOS signing off.", end_session=True)

        if name == "AMAZON.HelpIntent":
            return elicit_slot(attrs, "Just talk to me naturally. Say whatever's on your mind. I'll figure it out.")

        if name == "AMAZON.FallbackIntent":
            return elicit_slot(attrs, "Say that again for me?")

        if name == "CatchAllIntent":
            raw = intent.get("slots", {}).get("rawInput", {}).get("value", "")
            if not raw:
                return elicit_slot(attrs, "I'm listening. Go ahead.")
            log(f"Raw input: {raw}")
            return process_query(raw, attrs)

        # Any other intent — shouldn't happen but handle it
        return elicit_slot(attrs, "What do you need?")

    # --- Session End ---
    if rtype == "SessionEndedRequest":
        return build_response("", end_session=True)

    return build_response("Something went wrong.", end_session=True)
