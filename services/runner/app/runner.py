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
