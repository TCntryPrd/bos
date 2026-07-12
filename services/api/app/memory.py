"""
boss/api/app/memory.py
-------------------------
FastAPI router for Weaviate-backed memory and contact search.

Endpoints:
  GET  /memory/search              — semantic search over ConversationMemory
  GET  /memory/events/search       — semantic search over EventLog
  GET  /memory/contacts/search     — semantic contact search (used by voice pipeline)
  POST /memory/contacts            — upsert a contact into Weaviate
  POST /memory/contacts/sync       — sync Google Contacts → Weaviate for one account
  POST /memory/conversation        — store a conversation turn (internal/service use)
"""
from __future__ import annotations

import os
import sys
from fastapi import APIRouter, Query, HTTPException

# shared is in /app/shared inside the container, or services/ on host
sys.path.insert(0, "/app")

from shared.weaviate_client import (
    ensure_schemas,
    store_conversation,
    search_conversations,
    upsert_contact,
    search_contacts,
    find_contact_by_name,
    store_event,
    search_events,
    validate_account,
)

router = APIRouter(prefix="/memory", tags=["memory"])

# Hard cap on contacts synced per request
_MAX_SYNC_PAGES = 10  # People API pageSize=1000, so 10 pages = 10K contacts max

# ── bootstrap on first import ────────────────────────────────────────────────
try:
    ensure_schemas()
except Exception as _e:
    print(f"[MEMORY] Weaviate schema init on import: {_e}", flush=True)


# ── Conversation endpoints ────────────────────────────────────────────────────

@router.get("/search")
def memory_search(
    q: str = Query(..., description="Natural-language query", max_length=5000),
    limit: int = Query(5, ge=1, le=50),
    tenant: str = Query("kevin", max_length=100),
):
    """Semantic search over past IR Custom AIOS conversations."""
    results = search_conversations(q, limit=limit, tenant=tenant)
    return {"query": q, "count": len(results), "results": results}


@router.post("/conversation")
def memory_store_conversation(payload: dict):
    """
    Store a conversation turn.
    Required: user_text, boss_reply
    Optional: source, intent, session_id, escalated, event_id, tenant, metadata
    """
    user_text = (payload.get("user_text") or "").strip()
    boss_reply = (payload.get("boss_reply") or "").strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="user_text is required")
    uid = store_conversation(
        user_text=user_text,
        boss_reply=boss_reply,
        source=payload.get("source", "api"),
        intent=payload.get("intent", ""),
        session_id=payload.get("session_id", ""),
        escalated=bool(payload.get("escalated", False)),
        event_id=payload.get("event_id", ""),
        tenant=payload.get("tenant", "kevin"),
        metadata=payload.get("metadata"),
    )
    if uid is None:
        raise HTTPException(status_code=503, detail="Weaviate unavailable — conversation not stored")
    return {"status": "stored", "uuid": uid}


# ── Event endpoints ───────────────────────────────────────────────────────────

@router.get("/events/search")
def memory_events_search(
    q: str = Query(..., description="Natural-language query", max_length=5000),
    limit: int = Query(10, ge=1, le=100),
    tenant: str = Query("kevin", max_length=100),
):
    """Semantic search over the Weaviate EventLog."""
    results = search_events(q, limit=limit, tenant=tenant)
    return {"query": q, "count": len(results), "results": results}


# ── Contact endpoints ─────────────────────────────────────────────────────────

@router.get("/contacts/search")
def memory_contacts_search(
    q: str = Query(..., description="Name, company, or description. e.g. 'Sharon' or 'Micazen contact'", max_length=2000),
    limit: int = Query(5, ge=1, le=20),
    tenant: str = Query("kevin", max_length=100),
):
    """
    Semantic contact search.
    Powers natural-language commands like 'email Sharon'.
    """
    results = search_contacts(q, limit=limit, tenant=tenant)
    best = find_contact_by_name(q, tenant=tenant)
    return {
        "query": q,
        "best_match": best,
        "count": len(results),
        "results": results,
    }


@router.post("/contacts")
def memory_upsert_contact(payload: dict):
    """
    Upsert a contact into Weaviate.
    Required: full_name
    Optional: email, phone, company, title, notes, google_id, account, tenant
    """
    full_name = (payload.get("full_name") or "").strip()
    if not full_name:
        raise HTTPException(status_code=400, detail="full_name is required")
    uid = upsert_contact(
        full_name=full_name,
        email=payload.get("email", ""),
        phone=payload.get("phone", ""),
        company=payload.get("company", ""),
        title=payload.get("title", ""),
        notes=payload.get("notes", ""),
        google_id=payload.get("google_id", ""),
        account=payload.get("account", "kevin@starrpartners.ai"),
        tenant=payload.get("tenant", "kevin"),
    )
    if uid is None:
        raise HTTPException(status_code=503, detail="Weaviate unavailable — contact not stored")
    return {"status": "upserted", "uuid": uid, "full_name": full_name}


@router.post("/contacts/sync")
def memory_sync_contacts(payload: dict):
    """
    Sync Google Contacts for one account into Weaviate.
    Required: email (must be one of the 4 authorized Google accounts)
    Optional: tenant, max_pages (default 10, max 20)
    """
    account_email = (payload.get("email") or "kevin@starrpartners.ai").strip()
    tenant = (payload.get("tenant") or "kevin").strip()
    max_pages = min(int(payload.get("max_pages", _MAX_SYNC_PAGES)), 20)

    try:
        account_email = validate_account(account_email)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    try:
        count = _sync_google_contacts(account_email, tenant, max_pages=max_pages)
        return {"status": "synced", "account": account_email, "contacts_synced": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _sync_google_contacts(
    account_email: str,
    tenant: str = "kevin",
    max_pages: int = _MAX_SYNC_PAGES,
) -> int:
    """
    Fetch contacts from Google People API via IR Custom AIOS's OAuth tokens
    and upsert them into Weaviate.
    Returns number of contacts synced.
    """
    import psycopg
    import json
    import httpx

    POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@localhost:5434/boss_db")

    # Get access token from Postgres
    with psycopg.connect(POSTGRES_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT token_data FROM boss_google_oauth WHERE email = %s AND service = %s LIMIT 1",
                (account_email, "contacts"),
            )
            row = cur.fetchone()

    if not row:
        # Try with 'people' service name
        with psycopg.connect(POSTGRES_URL) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT token_data FROM boss_google_oauth WHERE email = %s LIMIT 1",
                    (account_email,),
                )
                row = cur.fetchone()

    if not row:
        raise ValueError(f"No OAuth token found for {account_email}")

    token_data = row[0] if isinstance(row[0], dict) else json.loads(row[0])
    access_token = token_data.get("token") or token_data.get("access_token")

    if not access_token:
        raise ValueError(f"No access token in OAuth data for {account_email}")

    # Fetch contacts from Google People API
    url = "https://people.googleapis.com/v1/people/me/connections"
    params = {
        "personFields": "names,emailAddresses,phoneNumbers,organizations,biographies",
        "pageSize": 1000,
    }
    headers = {"Authorization": f"Bearer {access_token}"}

    synced = 0
    page_token = None
    pages_fetched = 0

    while pages_fetched < max_pages:
        if page_token:
            params["pageToken"] = page_token

        with httpx.Client(timeout=30) as client:
            resp = client.get(url, params=params, headers=headers)

        if resp.status_code != 200:
            raise ValueError(f"Google API error {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        connections = data.get("connections", [])
        pages_fetched += 1

        for person in connections:
            names = person.get("names", [])
            emails = person.get("emailAddresses", [])
            phones = person.get("phoneNumbers", [])
            orgs = person.get("organizations", [])
            bios = person.get("biographies", [])

            full_name = names[0].get("displayName", "") if names else ""
            email = emails[0].get("value", "") if emails else ""
            phone = phones[0].get("value", "") if phones else ""
            company = orgs[0].get("name", "") if orgs else ""
            title = orgs[0].get("title", "") if orgs else ""
            notes = bios[0].get("value", "")[:500] if bios else ""
            google_id = person.get("resourceName", "")

            if full_name or email:
                upsert_contact(
                    full_name=full_name or email,
                    email=email,
                    phone=phone,
                    company=company,
                    title=title,
                    notes=notes,
                    google_id=google_id,
                    account=account_email,
                    tenant=tenant,
                )
                synced += 1

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return synced
