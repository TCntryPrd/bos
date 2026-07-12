import os
import time
import sys
import traceback
import psycopg
import redis
import httpx
from typing import Dict, Any

POSTGRES_URL = os.getenv(
    "POSTGRES_URL",
    "postgresql://boss:bosspass@postgres:5432/boss_db"
)

REDIS_HOST = os.getenv("REDIS_HOST", "redis")

# OpenClaw configuration
OPENCLAW_BASE_URL = os.getenv("OPENCLAW_BASE_URL", "http://127.0.0.1:64837/v1")
OPENCLAW_API_KEY = os.getenv("OPENCLAW_API_KEY", "")
OPENCLAW_MODEL = os.getenv("OPENCLAW_MODEL", "openclaw")


def log(msg: str):
    print(msg, flush=True)


def get_pg_connection():
    return psycopg.connect(POSTGRES_URL)


def parse_event(event_data: str):
    if "|" in event_data:
        intent, payload = event_data.split("|", 1)
        return intent, payload
    return "UNKNOWN", event_data


def detect_intent(text: str) -> str:
    """
    Detect intent from spoken command text based on keywords.
    """
    t = text.lower()

    # Define intent keywords
    intent_keywords = {
        "email_read": ["email", "inbox", "messages", "mail"],
        "crm_check": ["pipeline", "leads", "follow up", "outreach"],
        "brief_me": ["brief", "briefing", "what's happening", "catch me up", "update"],
        "project_status": ["micazen", "magnussen", "pessy", "clients", "projects"],
        "web_search": ["search", "look up", "what is", "find", "google"],
        "calendar_check": ["calendar", "schedule", "meetings", "today", "tomorrow"]
    }

    # Check each intent category
    for intent, keywords in intent_keywords.items():
        for keyword in keywords:
            if keyword in t:
                return intent

    # Default to unknown if no intent detected
    return "UNKNOWN"


def route_intent(intent: str, command: str) -> str:
    """
    Route each intent to a specific OpenClaw prompt that includes the original command.
    """
    # Prepare the prompt based on intent
    if intent == "email_read":
        prompt = f"Check Kevin's email inbox and provide a summary of unread messages. Original command: {command}"
    elif intent == "crm_check":
        prompt = f"Check Kevin's CRM pipeline for leads and outreach status. Original command: {command}"
    elif intent == "brief_me":
        prompt = f"Provide Kevin with a briefing on what's happening. Original command: {command}"
    elif intent == "project_status":
        prompt = f"Check the status of Kevin's projects, especially Micazen, Magnussen, or Pessy if mentioned. Original command: {command}"
    elif intent == "web_search":
        prompt = f"Perform a web search based on this request: {command}"
    elif intent == "calendar_check":
        prompt = f"Check Kevin's calendar for today's or tomorrow's schedule. Original command: {command}"
    else:
        prompt = f"Process this command: {command}"

    # Send the request to OpenClaw
    try:
        response = send_to_openclaw(prompt)
        return response
    except Exception as e:
        log(f"Error routing intent {intent}: {str(e)}")
        return f"Error processing intent: {str(e)}"


def send_to_openclaw(prompt: str) -> str:
    """
    Send a request to OpenClaw and return the response.
    """
    headers = {
        "Authorization": f"Bearer {OPENCLAW_API_KEY}",
        "Content-Type": "application/json"
    }

    data = {
        "model": OPENCLAW_MODEL,
        "messages": [{"role": "user", "content": prompt}]
    }

    with httpx.Client(timeout=60) as client:
        response = client.post(f"{OPENCLAW_BASE_URL}/chat/completions", headers=headers, json=data)
        response.raise_for_status()

        result = response.json()
        return result["choices"][0]["message"]["content"] if result.get("choices") else "No response from OpenClaw"


def main():
    try:
        log("IR Custom AIOS worker starting...")

        if not OPENCLAW_API_KEY:
            log("WARNING: OPENCLAW_API_KEY not set. AI routing will fail.")


        log(f"Connecting to Redis at host={REDIS_HOST}")
        r = redis.Redis(host=REDIS_HOST, port=6379, decode_responses=True)
        r.ping()
        log("Redis connected.")

        log("Connecting to Postgres...")
        pg_conn = get_pg_connection()
        log("Postgres connected.")

        with pg_conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_worker_log (
                    id SERIAL PRIMARY KEY,
                    event TEXT,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_build_queue (
                    id SERIAL PRIMARY KEY,
                    request_text TEXT,
                    status TEXT DEFAULT 'NEW',
                    result TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            pg_conn.commit()

        log("boss_worker_log ready.")
        log("boss_build_queue ready.")

        pubsub = r.pubsub()
        pubsub.subscribe("boss_events")
        log("Subscribed to boss_events")

        for message in pubsub.listen():
            log(f"Raw message: {message}")

            if message["type"] != "message":
                continue

            event_data = message["data"]
            intent, payload = parse_event(event_data)

            log(f"Received intent: {intent}")
            log(f"Received payload: {payload}")

            with pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO boss_worker_log (event) VALUES (%s);",
                    (f"{intent}|{payload}",)
                )

                if intent == "BUILD":
                    # Process BUILD intent as before
                    cur.execute(
                        "INSERT INTO boss_build_queue (request_text, status) VALUES (%s, %s);",
                        (payload, "NEW")
                    )
                    log(f"Queued BUILD request: {payload}")
                elif intent == "SYSTEM":
                    # Handle SYSTEM intent which may include spoken commands
                    detected_intent = detect_intent(payload)
                    log(f"Detected intent from spoken command: {detected_intent}")

                    # Route to appropriate handler
                    result = route_intent(detected_intent, payload)

                    # Update the build queue with the result
                    cur.execute(
                        """
                        INSERT INTO boss_build_queue (request_text, status, result)
                        VALUES (%s, 'DONE', %s)
                        """,
                        (payload, result)
                    )

                    log(f"Processed intent {detected_intent} for: {payload}")
                else:
                    # Handle other intents if needed
                    detected_intent = detect_intent(payload)
                    log(f"Detected intent from {intent} command: {detected_intent}")

                    if detected_intent != "UNKNOWN":
                        result = route_intent(detected_intent, payload)

                        # Update the build queue with the result
                        cur.execute(
                            """
                            INSERT INTO boss_build_queue (request_text, status, result)
                            VALUES (%s, 'DONE', %s)
                            """,
                            (payload, result)
                        )

                        log(f"Processed detected intent {detected_intent} for: {payload}")
                    else:
                        # If no specific intent detected, log but don't process
                        log(f"No specific intent detected for: {payload}")

                pg_conn.commit()

            log(f"Logged event: {intent}|{payload}")
            time.sleep(1)

    except Exception as e:
        log("Worker crashed with exception:")
        log(str(e))
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
