"""
Google data sync — pulls calendar, email, tasks into local Postgres cache.
Called by the connectors service on a schedule.
Also callable manually via API.

The cache is the source of truth for voice queries — no live API calls needed.
"""

import os
import json
import psycopg
from datetime import datetime, timezone, timedelta
from .oauth import get_valid_token, get_pg
from . import calendar as gcal
from . import gmail as ggmail
from . import tasks as gtasks

POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@postgres:5432/boss_db")


def _upsert_cache(key: str, data: any, source: str = "sync"):
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO boss_cache (cache_key, data, source, updated_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (cache_key) DO UPDATE
                SET data = EXCLUDED.data, source = EXCLUDED.source, updated_at = now()
            """, (key, json.dumps(data, default=str), source))
        conn.commit()


def _get_cache(key: str) -> dict | list | None:
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT data, updated_at FROM boss_cache WHERE cache_key = %s", (key,))
            row = cur.fetchone()
    if not row:
        return None
    return row[0]


def _get_cache_with_age(key: str) -> tuple[any, float]:
    """Returns (data, age_in_seconds). Returns (None, inf) if not cached."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT data, updated_at FROM boss_cache WHERE cache_key = %s", (key,))
            row = cur.fetchone()
    if not row:
        return None, float('inf')
    age = (datetime.now(timezone.utc) - row[1]).total_seconds()
    return row[0], age


def sync_calendars():
    """Pull today's, tomorrow's, next 7 days, and upcoming events into cache."""
    try:
        today = gcal.get_todays_events()
        _upsert_cache("calendar:today", today, "calendar-sync")
    except Exception as e:
        print(f"[SYNC] Calendar today failed: {e}", flush=True)

    try:
        tomorrow = gcal.get_tomorrows_events()
        _upsert_cache("calendar:tomorrow", tomorrow, "calendar-sync")
    except Exception as e:
        print(f"[SYNC] Calendar tomorrow failed: {e}", flush=True)

    try:
        upcoming = gcal.get_upcoming_events(hours=4)
        _upsert_cache("calendar:upcoming", upcoming, "calendar-sync")
    except Exception as e:
        print(f"[SYNC] Calendar upcoming failed: {e}", flush=True)

    try:
        week = gcal.get_next_n_days(7)
        _upsert_cache("calendar:week", week, "calendar-sync")
    except Exception as e:
        print(f"[SYNC] Calendar week failed: {e}", flush=True)

    print(f"[SYNC] Calendars synced", flush=True)


def sync_email():
    """Pull unread emails into cache."""
    try:
        messages = ggmail.get_unread_messages(max_results=10)
        _upsert_cache("email:unread", messages, "email-sync")
        print(f"[SYNC] Email synced: {len(messages)} unread", flush=True)
    except Exception as e:
        print(f"[SYNC] Email sync failed: {e}", flush=True)


def sync_tasks():
    """Pull pending tasks into cache."""
    try:
        tasks = gtasks.get_pending_tasks()
        _upsert_cache("tasks:pending", tasks, "tasks-sync")
        print(f"[SYNC] Tasks synced: {len(tasks)} pending", flush=True)
    except Exception as e:
        print(f"[SYNC] Tasks sync failed: {e}", flush=True)


def sync_all():
    """Full sync — calendars, email, tasks."""
    sync_calendars()
    sync_email()
    sync_tasks()


# --- Cache readers for voice queries (instant, no API calls) ---

def get_cached_today(max_age_seconds: int = 600) -> list[dict] | None:
    """Get today's events from cache. Returns None if stale."""
    data, age = _get_cache_with_age("calendar:today")
    if age > max_age_seconds:
        return None
    return data


def get_cached_tomorrow(max_age_seconds: int = 600) -> list[dict] | None:
    data, age = _get_cache_with_age("calendar:tomorrow")
    if age > max_age_seconds:
        return None
    return data


def get_cached_upcoming(max_age_seconds: int = 600) -> list[dict] | None:
    data, age = _get_cache_with_age("calendar:upcoming")
    if age > max_age_seconds:
        return None
    return data


def get_cached_week(max_age_seconds: int = 600) -> list[dict] | None:
    data, age = _get_cache_with_age("calendar:week")
    if age > max_age_seconds:
        return None
    return data


def get_cached_email(max_age_seconds: int = 600) -> list[dict] | None:
    data, age = _get_cache_with_age("email:unread")
    if age > max_age_seconds:
        return None
    return data


def get_cached_tasks(max_age_seconds: int = 600) -> list[dict] | None:
    data, age = _get_cache_with_age("tasks:pending")
    if age > max_age_seconds:
        return None
    return data
