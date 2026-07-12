"""Direct Google Calendar API client using stored OAuth tokens.
Supports multiple Google accounts — aggregates events across all connected calendars."""

import httpx
from datetime import datetime, timezone, timedelta
from .oauth import get_valid_token, get_pg

CALENDAR_API = "https://www.googleapis.com/calendar/v3"


def _get_all_calendar_tokens() -> list[tuple[str, str]]:
    """Get valid tokens for ALL connected calendar accounts. Returns [(email, token)]."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT email, access_token, refresh_token, token_expiry FROM boss_google_oauth WHERE service = 'calendar' ORDER BY email"
            )
            rows = cur.fetchall()

    results = []
    for email, access_token, refresh_token, token_expiry in rows:
        # Try to get a valid token (auto-refreshes if needed)
        token = get_valid_token("calendar", email)
        if token:
            results.append((email, token))
    return results


def _fetch_events(token: str, time_min: str, time_max: str, calendar_id: str = "primary") -> list[dict]:
    """Fetch events from a single calendar."""
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=15) as client:
        resp = client.get(
            f"{CALENDAR_API}/calendars/{calendar_id}/events",
            headers=headers,
            params={
                "timeMin": time_min,
                "timeMax": time_max,
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": 50,
            },
        )
        if resp.status_code != 200:
            return []
    return resp.json().get("items", [])


def _get_calendar_list(token: str) -> list[dict]:
    """Get all calendars for an account (primary + shared + subscribed)."""
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=10) as client:
        resp = client.get(f"{CALENDAR_API}/users/me/calendarList", headers=headers)
        if resp.status_code != 200:
            return []
    return resp.json().get("items", [])


def _format_event(item: dict, account_email: str, calendar_name: str | None = None) -> dict:
    start_dt = item.get("start", {}).get("dateTime") or item.get("start", {}).get("date", "")
    end_dt = item.get("end", {}).get("dateTime") or item.get("end", {}).get("date", "")
    return {
        "id": item.get("id"),
        "summary": item.get("summary", "No title"),
        "start": start_dt,
        "end": end_dt,
        "location": item.get("location"),
        "description": (item.get("description") or "")[:200],
        "attendees": [a.get("email") for a in item.get("attendees", [])],
        "status": item.get("status"),
        "hangout_link": item.get("hangoutLink"),
        "account": account_email,
        "calendar": calendar_name,
    }


def get_events_for_range(start: datetime, end: datetime) -> list[dict]:
    """Get events across ALL connected accounts for a time range.
    Uses primary calendar only per account for speed."""
    tokens = _get_all_calendar_tokens()
    if not tokens:
        raise ConnectionError("No Google Calendar accounts connected. Complete OAuth setup first.")

    all_events = []
    time_min = start.isoformat()
    time_max = end.isoformat()

    for email, token in tokens:
        # Primary calendar only — fast and covers 95% of events
        items = _fetch_events(token, time_min, time_max, "primary")
        for item in items:
            all_events.append(_format_event(item, email, None))

    # Sort by start time
    all_events.sort(key=lambda e: e.get("start", ""))

    # Deduplicate (same event can appear in multiple calendars)
    seen = set()
    unique = []
    for e in all_events:
        key = (e["summary"], e["start"])
        if key not in seen:
            seen.add(key)
            unique.append(e)

    return unique


def get_todays_events() -> list[dict]:
    """Get all events for today across all accounts."""
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return get_events_for_range(start, end)


def get_tomorrows_events() -> list[dict]:
    """Get all events for tomorrow across all accounts."""
    now = datetime.now(timezone.utc)
    start = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return get_events_for_range(start, end)


def get_upcoming_events(hours: int = 4) -> list[dict]:
    """Get events in the next N hours across all accounts."""
    now = datetime.now(timezone.utc)
    end = now + timedelta(hours=hours)
    return get_events_for_range(now, end)


def get_next_n_days(days: int = 3) -> list[dict]:
    """Get events for the next N days across all accounts."""
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=days)
    return get_events_for_range(start, end)


def create_event(summary: str, start_time: str, end_time: str, description: str = "",
                 attendees: list[str] | None = None, location: str = "", email: str | None = None) -> dict:
    """Create a calendar event."""
    token = get_valid_token("calendar", email)
    if not token:
        raise ConnectionError("Google Calendar not connected.")
    body = {
        "summary": summary,
        "start": {"dateTime": start_time, "timeZone": "America/New_York"},
        "end": {"dateTime": end_time, "timeZone": "America/New_York"},
    }
    if description:
        body["description"] = description
    if location:
        body["location"] = location
    if attendees:
        body["attendees"] = [{"email": a} for a in attendees]
    with httpx.Client(timeout=15) as client:
        resp = client.post(
            f"{CALENDAR_API}/calendars/primary/events",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
        )
        resp.raise_for_status()
    data = resp.json()
    return {"id": data["id"], "summary": data.get("summary"), "start": data.get("start"), "link": data.get("htmlLink")}


def update_event(event_id: str, updates: dict, email: str | None = None) -> dict:
    """Update a calendar event. updates can include: summary, start, end, description, location, attendees."""
    token = get_valid_token("calendar", email)
    if not token:
        raise ConnectionError("Google Calendar not connected.")
    body = {}
    if "summary" in updates:
        body["summary"] = updates["summary"]
    if "description" in updates:
        body["description"] = updates["description"]
    if "location" in updates:
        body["location"] = updates["location"]
    if "start" in updates:
        body["start"] = {"dateTime": updates["start"], "timeZone": "America/New_York"}
    if "end" in updates:
        body["end"] = {"dateTime": updates["end"], "timeZone": "America/New_York"}
    if "attendees" in updates:
        body["attendees"] = [{"email": a} for a in updates["attendees"]]
    with httpx.Client(timeout=15) as client:
        resp = client.patch(
            f"{CALENDAR_API}/calendars/primary/events/{event_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
        )
        resp.raise_for_status()
    data = resp.json()
    return {"id": data["id"], "summary": data.get("summary"), "updated": True}


def delete_event(event_id: str, email: str | None = None) -> dict:
    """Delete a calendar event."""
    token = get_valid_token("calendar", email)
    if not token:
        raise ConnectionError("Google Calendar not connected.")
    with httpx.Client(timeout=15) as client:
        resp = client.delete(
            f"{CALENDAR_API}/calendars/primary/events/{event_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
    return {"id": event_id, "deleted": True}
