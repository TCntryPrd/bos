"""
boss/api/app/google/contacts.py
-----------------------------------
Google Contacts (People API) integration for IR Custom AIOS.

Uses existing OAuth tokens stored in boss_google_oauth Postgres table.
Provides search and sync functionality.

Usage:
    from app.google.contacts import search_contacts, sync_to_weaviate, get_contact_by_email
"""
from __future__ import annotations

import os
import json
from typing import Optional

import httpx
import psycopg

POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@127.0.0.1:5434/boss_db")

GOOGLE_ACCOUNTS = [
    "user@example.com",
    "user2@example.com",
]

PEOPLE_API_BASE = "https://people.googleapis.com/v1"


def _get_token(email: str) -> Optional[str]:
    """Fetch a valid access token for an account from Postgres."""
    try:
        with psycopg.connect(POSTGRES_URL) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT token_data FROM boss_google_oauth WHERE email = %s ORDER BY id LIMIT 1",
                    (email,),
                )
                row = cur.fetchone()
        if not row:
            return None
        td = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        return td.get("token") or td.get("access_token")
    except Exception as e:
        print(f"[CONTACTS] Token fetch error for {email}: {e}", flush=True)
        return None


def search_contacts(query: str, email: str = "user@example.com") -> list[dict]:
    """
    Search Google Contacts for a name query using People API.
    Returns list of contact dicts.
    """
    token = _get_token(email)
    if not token:
        return []
    try:
        url = f"{PEOPLE_API_BASE}/people:searchContacts"
        params = {
            "query": query,
            "readMask": "names,emailAddresses,phoneNumbers,organizations,biographies",
            "pageSize": 10,
        }
        headers = {"Authorization": f"Bearer {token}"}
        with httpx.Client(timeout=15) as client:
            resp = client.get(url, params=params, headers=headers)
        if resp.status_code != 200:
            print(f"[CONTACTS] API {resp.status_code}: {resp.text[:200]}", flush=True)
            return []

        results = []
        for r in resp.json().get("results", []):
            person = r.get("person", {})
            results.append(_parse_person(person, account=email))
        return results
    except Exception as e:
        print(f"[CONTACTS] search error: {e}", flush=True)
        return []


def get_all_contacts(email: str = "user@example.com", max_results: int = 1000) -> list[dict]:
    """
    Fetch all contacts for an account via People API.
    Returns list of contact dicts.
    """
    token = _get_token(email)
    if not token:
        return []
    try:
        url = f"{PEOPLE_API_BASE}/people/me/connections"
        params = {
            "personFields": "names,emailAddresses,phoneNumbers,organizations,biographies",
            "pageSize": min(max_results, 1000),
        }
        headers = {"Authorization": f"Bearer {token}"}
        contacts = []
        page_token = None
        while True:
            if page_token:
                params["pageToken"] = page_token
            with httpx.Client(timeout=30) as client:
                resp = client.get(url, params=params, headers=headers)
            if resp.status_code != 200:
                break
            data = resp.json()
            for person in data.get("connections", []):
                contacts.append(_parse_person(person, account=email))
            page_token = data.get("nextPageToken")
            if not page_token or len(contacts) >= max_results:
                break
        return contacts
    except Exception as e:
        print(f"[CONTACTS] get_all error: {e}", flush=True)
        return []


def sync_to_weaviate(email: str = "user@example.com", tenant: str = "kevin") -> int:
    """
    Sync all Google Contacts for an account into Weaviate ContactEmbedding.
    Returns count of contacts synced.
    """
    try:
        from shared.weaviate_client import upsert_contact
    except ImportError:
        return 0

    contacts = get_all_contacts(email)
    synced = 0
    for c in contacts:
        try:
            upsert_contact(
                full_name=c.get("full_name") or c.get("email") or "",
                email=c.get("email", ""),
                phone=c.get("phone", ""),
                company=c.get("company", ""),
                title=c.get("title", ""),
                notes=c.get("notes", ""),
                google_id=c.get("google_id", ""),
                account=email,
                tenant=tenant,
            )
            synced += 1
        except Exception:
            pass
    return synced


def _parse_person(person: dict, account: str = "") -> dict:
    """Convert People API person object to a flat dict."""
    names = person.get("names", [])
    emails = person.get("emailAddresses", [])
    phones = person.get("phoneNumbers", [])
    orgs = person.get("organizations", [])
    bios = person.get("biographies", [])

    return {
        "full_name": names[0].get("displayName", "") if names else "",
        "first_name": names[0].get("givenName", "") if names else "",
        "last_name": names[0].get("familyName", "") if names else "",
        "email": emails[0].get("value", "") if emails else "",
        "phone": phones[0].get("value", "") if phones else "",
        "company": orgs[0].get("name", "") if orgs else "",
        "title": orgs[0].get("title", "") if orgs else "",
        "notes": bios[0].get("value", "")[:500] if bios else "",
        "google_id": person.get("resourceName", ""),
        "account": account,
    }
