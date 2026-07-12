"""
boss/shared/weaviate_client.py
---------------------------------
Weaviate integration for IR Custom AIOS.
Targets Weaviate 1.24.x using weaviate-client v3.

Four collections:
  ConversationMemory  — every Alexa / spoken-command turn + response
  ContactEmbedding    — name / email / phone for "email Sharon" lookups
  EventLog            — every IR Custom AIOSEvent processed by the reactor
  DocumentEmbedding   — Google Drive doc titles/descriptions for search

Vectorization: hash-based 256-dim unit vector (zero external deps).
If OPENAI_API_KEY is set, real text-embedding-3-small embeddings are used
for semantic accuracy.

Usage:
    from shared.weaviate_client import (
        ensure_schemas, store_conversation, search_contacts,
        upsert_contact, find_contact_by_name, store_event, search_events,
        search_conversations, upsert_document, search_documents,
    )

Environment variables:
    WEAVIATE_URL   default http://127.0.0.1:8081
    OPENAI_API_KEY optional — enables real embeddings
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

import weaviate  # v3

WEAVIATE_URL = os.getenv("WEAVIATE_URL", "http://127.0.0.1:8081")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# ── tiny deterministic vector ───────────────────────────────────────────────
_DIM = 256


def _hash_vector(text: str) -> list[float]:
    """256-dim deterministic unit vector from SHA-256 of text."""
    digest = hashlib.sha256(text.encode()).digest()
    raw = [float(digest[i % 32]) / 127.5 - 1.0 for i in range(_DIM)]
    mag = math.sqrt(sum(x * x for x in raw)) or 1.0
    return [x / mag for x in raw]


def _get_embedding(text: str) -> list[float]:
    if not OPENAI_API_KEY:
        return _hash_vector(text)
    try:
        import openai
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        resp = client.embeddings.create(model="text-embedding-3-small", input=text[:8000])
        raw = resp.data[0].embedding
        if len(raw) >= _DIM:
            return raw[:_DIM]
        return raw + [0.0] * (_DIM - len(raw))
    except Exception:
        return _hash_vector(text)


# ── singleton connection ───────────────────────────────────────────────────
_client_lock = threading.Lock()
_client_instance: weaviate.Client | None = None


def get_weaviate() -> weaviate.Client:
    """Return a singleton Weaviate client, reconnecting if stale."""
    global _client_instance
    with _client_lock:
        if _client_instance is not None:
            try:
                if _client_instance.is_ready():
                    return _client_instance
            except Exception:
                _client_instance = None
        _client_instance = weaviate.Client(WEAVIATE_URL)
        return _client_instance


def _safe_client(retries: int = 3, delay: float = 2.0) -> weaviate.Client | None:
    for attempt in range(retries):
        try:
            c = get_weaviate()
            if c.is_ready():
                return c
        except Exception as e:
            # Force reconnect on next attempt
            global _client_instance
            with _client_lock:
                _client_instance = None
            if attempt < retries - 1:
                time.sleep(delay)
            else:
                print(f"[WEAVIATE] Cannot connect after {retries} attempts: {e}", flush=True)
    return None


# ── schema definitions ──────────────────────────────────────────────────────

_SCHEMAS = {
    "ConversationMemory": {
        "class": "ConversationMemory",
        "description": "Every IR Custom AIOS conversation turn — user input and system reply",
        "vectorizer": "none",
        "properties": [
            {"name": "tenant",      "dataType": ["text"]},
            {"name": "source",      "dataType": ["text"]},
            {"name": "userText",    "dataType": ["text"]},
            {"name": "bossReply", "dataType": ["text"]},
            {"name": "intent",      "dataType": ["text"]},
            {"name": "sessionId",   "dataType": ["text"]},
            {"name": "escalated",   "dataType": ["boolean"]},
            {"name": "eventId",     "dataType": ["text"]},
            {"name": "happenedAt",  "dataType": ["date"]},
            {"name": "metadata",    "dataType": ["text"]},
        ],
    },
    "ContactEmbedding": {
        "class": "ContactEmbedding",
        "description": "Contacts with semantic embeddings for natural-language lookup",
        "vectorizer": "none",
        "properties": [
            {"name": "tenant",    "dataType": ["text"]},
            {"name": "fullName",  "dataType": ["text"]},
            {"name": "firstName", "dataType": ["text"]},
            {"name": "lastName",  "dataType": ["text"]},
            {"name": "email",     "dataType": ["text"]},
            {"name": "phone",     "dataType": ["text"]},
            {"name": "company",   "dataType": ["text"]},
            {"name": "title",     "dataType": ["text"]},
            {"name": "notes",     "dataType": ["text"]},
            {"name": "googleId",  "dataType": ["text"]},
            {"name": "account",   "dataType": ["text"]},
            {"name": "updatedAt", "dataType": ["date"]},
        ],
    },
    "EventLog": {
        "class": "EventLog",
        "description": "All IR Custom AIOSEvents processed by the reactor",
        "vectorizer": "none",
        "properties": [
            {"name": "eventId",    "dataType": ["text"]},
            {"name": "eventType",  "dataType": ["text"]},
            {"name": "source",     "dataType": ["text"]},
            {"name": "tenant",     "dataType": ["text"]},
            {"name": "summary",    "dataType": ["text"]},
            {"name": "dataJson",   "dataType": ["text"]},
            {"name": "escalated",  "dataType": ["boolean"]},
            {"name": "happenedAt", "dataType": ["date"]},
        ],
    },
    "DocumentEmbedding": {
        "class": "DocumentEmbedding",
        "description": "Google Drive document titles and descriptions for semantic search",
        "vectorizer": "none",
        "properties": [
            {"name": "tenant",      "dataType": ["text"]},
            {"name": "docId",       "dataType": ["text"]},
            {"name": "title",       "dataType": ["text"]},
            {"name": "description", "dataType": ["text"]},
            {"name": "mimeType",    "dataType": ["text"]},
            {"name": "driveUrl",    "dataType": ["text"]},
            {"name": "account",     "dataType": ["text"]},
            {"name": "indexedAt",   "dataType": ["date"]},
        ],
    },
}

# Allowed Google accounts for sync operations
_ALLOWED_ACCOUNTS = frozenset({
    "kevin@starrpartners.ai",
    "d.caine@dcaine.com",
    "absoluterecoverybureau@gmail.com",
    "travelcraft.dc@gmail.com",
})


def validate_account(email: str) -> str:
    """Validate that an email is in the allowed accounts list. Returns normalized email."""
    email = email.strip().lower()
    if email not in _ALLOWED_ACCOUNTS:
        raise ValueError(f"Account '{email}' is not an authorized Google account")
    return email


def ensure_schemas() -> None:
    """Create Weaviate classes if they don't already exist."""
    client = _safe_client()
    if not client:
        return
    existing = {c["class"] for c in client.schema.get().get("classes", [])}
    for name, schema_def in _SCHEMAS.items():
        if name not in existing:
            client.schema.create_class(schema_def)
            print(f"[WEAVIATE] Created class: {name}", flush=True)
        else:
            print(f"[WEAVIATE] Class already exists: {name}", flush=True)


# ── ConversationMemory ──────────────────────────────────────────────────────

def store_conversation(
    user_text: str,
    boss_reply: str,
    source: str = "api",
    intent: str = "",
    session_id: str = "",
    escalated: bool = False,
    event_id: str = "",
    tenant: str = "kevin",
    metadata: dict | None = None,
) -> str | None:
    """Store a conversation turn. Returns UUID or None on failure."""
    client = _safe_client()
    if not client:
        return None
    try:
        # Truncate inputs to prevent unbounded storage
        user_text = user_text[:10000]
        boss_reply = boss_reply[:10000]
        intent = intent[:500]
        source = source[:100]

        vector = _get_embedding(f"{user_text} {boss_reply} {intent}")
        obj = {
            "tenant":      tenant[:100],
            "source":      source,
            "userText":    user_text,
            "bossReply": boss_reply,
            "intent":      intent,
            "sessionId":   session_id[:200],
            "escalated":   bool(escalated),
            "eventId":     event_id[:200],
            "happenedAt":  _iso_now(),
            "metadata":    json.dumps(metadata or {})[:5000],
        }
        result = client.data_object.create(
            data_object=obj,
            class_name="ConversationMemory",
            vector=vector,
        )
        return result
    except Exception as e:
        print(f"[WEAVIATE] store_conversation error: {e}", flush=True)
        return None


def search_conversations(
    query: str,
    limit: int = 5,
    tenant: str = "kevin",
) -> list[dict]:
    """Semantic search over past conversations."""
    client = _safe_client()
    if not client:
        return []
    try:
        limit = max(1, min(limit, 50))
        vector = _get_embedding(query[:5000])
        result = (
            client.query
            .get("ConversationMemory", ["userText", "bossReply", "intent", "source", "happenedAt", "escalated"])
            .with_near_vector({"vector": vector})
            .with_where({
                "path": ["tenant"],
                "operator": "Equal",
                "valueText": tenant,
            })
            .with_limit(limit)
            .do()
        )
        return result.get("data", {}).get("Get", {}).get("ConversationMemory", [])
    except Exception as e:
        print(f"[WEAVIATE] search_conversations error: {e}", flush=True)
        return []


# ── ContactEmbedding ────────────────────────────────────────────────────────

def upsert_contact(
    full_name: str,
    email: str = "",
    phone: str = "",
    company: str = "",
    title: str = "",
    notes: str = "",
    google_id: str = "",
    account: str = "kevin@starrpartners.ai",
    tenant: str = "kevin",
) -> str | None:
    """Store or update a contact. Returns UUID."""
    client = _safe_client()
    if not client:
        return None
    try:
        full_name = full_name.strip()[:500]
        email = email.strip()[:500]
        notes = notes[:2000]

        parts = full_name.split()
        first = parts[0] if parts else ""
        last = " ".join(parts[1:]) if len(parts) > 1 else ""
        vector = _get_embedding(f"{full_name} {email} {company} {title} {notes}")

        obj = {
            "tenant":    tenant[:100],
            "fullName":  full_name,
            "firstName": first,
            "lastName":  last,
            "email":     email,
            "phone":     phone[:50],
            "company":   company[:500],
            "title":     title[:500],
            "notes":     notes,
            "googleId":  google_id[:200],
            "account":   account[:200],
            "updatedAt": _iso_now(),
        }

        # Check for existing contact by googleId first (most stable), then email
        for field, value in [("googleId", google_id), ("email", email)]:
            if not value:
                continue
            existing = (
                client.query
                .get("ContactEmbedding", ["_additional {id}"])
                .with_where({"path": [field], "operator": "Equal", "valueText": value})
                .with_limit(1)
                .do()
            )
            hits = existing.get("data", {}).get("Get", {}).get("ContactEmbedding", [])
            if hits:
                uuid = hits[0]["_additional"]["id"]
                client.data_object.update(
                    data_object=obj,
                    class_name="ContactEmbedding",
                    uuid=uuid,
                    vector=vector,
                )
                return uuid

        return client.data_object.create(
            data_object=obj,
            class_name="ContactEmbedding",
            vector=vector,
        )
    except Exception as e:
        print(f"[WEAVIATE] upsert_contact error: {e}", flush=True)
        return None


def search_contacts(
    query: str,
    limit: int = 5,
    tenant: str = "kevin",
) -> list[dict]:
    """
    Semantic contact search.
    'Sharon' → Sharon Ashley; 'BodyShopConnect' → Sharon/Jim; etc.
    """
    client = _safe_client()
    if not client:
        return []
    try:
        limit = max(1, min(limit, 20))
        vector = _get_embedding(query[:2000])
        result = (
            client.query
            .get("ContactEmbedding", ["fullName", "firstName", "lastName", "email", "phone", "company", "title", "notes"])
            .with_near_vector({"vector": vector})
            .with_where({"path": ["tenant"], "operator": "Equal", "valueText": tenant})
            .with_limit(limit)
            .do()
        )
        return result.get("data", {}).get("Get", {}).get("ContactEmbedding", [])
    except Exception as e:
        print(f"[WEAVIATE] search_contacts error: {e}", flush=True)
        return []


def find_contact_by_name(name: str, tenant: str = "kevin") -> dict | None:
    """Best-match contact by name fragment. Returns top hit or None."""
    results = search_contacts(name, limit=5, tenant=tenant)
    if not results:
        return None
    name_lower = name.lower().strip()
    for r in results:
        full = (r.get("fullName") or "").lower()
        first = (r.get("firstName") or "").lower()
        last = (r.get("lastName") or "").lower()
        if name_lower in full or name_lower == first or name_lower == last:
            return r
    return results[0]


# ── EventLog ─────────────────────────────────────────────────────────────────

def store_event(
    event_id: str,
    event_type: str,
    source: str,
    data: dict,
    escalated: bool = False,
    tenant: str = "kevin",
) -> str | None:
    """Store a IR Custom AIOSEvent vector in EventLog. Returns UUID."""
    client = _safe_client()
    if not client:
        return None
    try:
        data_json = json.dumps(data, default=str)[:10000]
        summary = f"{event_type} from {source}: {data_json[:500]}"
        vector = _get_embedding(summary)
        obj = {
            "eventId":   event_id[:200],
            "eventType": event_type[:200],
            "source":    source[:200],
            "tenant":    tenant[:100],
            "summary":   summary[:2000],
            "dataJson":  data_json,
            "escalated": bool(escalated),
            "happenedAt": _iso_now(),
        }
        return client.data_object.create(
            data_object=obj,
            class_name="EventLog",
            vector=vector,
        )
    except Exception as e:
        print(f"[WEAVIATE] store_event error: {e}", flush=True)
        return None


def search_events(
    query: str,
    limit: int = 10,
    tenant: str = "kevin",
) -> list[dict]:
    """Semantic search over the event log."""
    client = _safe_client()
    if not client:
        return []
    try:
        limit = max(1, min(limit, 100))
        vector = _get_embedding(query[:5000])
        result = (
            client.query
            .get("EventLog", ["eventId", "eventType", "source", "summary", "escalated", "happenedAt"])
            .with_near_vector({"vector": vector})
            .with_where({"path": ["tenant"], "operator": "Equal", "valueText": tenant})
            .with_limit(limit)
            .do()
        )
        return result.get("data", {}).get("Get", {}).get("EventLog", [])
    except Exception as e:
        print(f"[WEAVIATE] search_events error: {e}", flush=True)
        return []


# ── DocumentEmbedding ────────────────────────────────────────────────────────

def upsert_document(
    doc_id: str,
    title: str,
    description: str = "",
    mime_type: str = "",
    drive_url: str = "",
    account: str = "kevin@starrpartners.ai",
    tenant: str = "kevin",
) -> str | None:
    """Store or update a Drive document embedding. Returns UUID."""
    client = _safe_client()
    if not client:
        return None
    try:
        title = title[:1000]
        description = description[:5000]

        vector = _get_embedding(f"{title} {description}")
        obj = {
            "tenant":      tenant[:100],
            "docId":       doc_id[:200],
            "title":       title,
            "description": description,
            "mimeType":    mime_type[:200],
            "driveUrl":    drive_url[:2000],
            "account":     account[:200],
            "indexedAt":   _iso_now(),
        }
        # Check for existing doc by docId
        existing = (
            client.query
            .get("DocumentEmbedding", ["_additional {id}"])
            .with_where({"path": ["docId"], "operator": "Equal", "valueText": doc_id})
            .with_limit(1)
            .do()
        )
        hits = existing.get("data", {}).get("Get", {}).get("DocumentEmbedding", [])
        if hits:
            uuid = hits[0]["_additional"]["id"]
            client.data_object.update(
                data_object=obj,
                class_name="DocumentEmbedding",
                uuid=uuid,
                vector=vector,
            )
            return uuid

        return client.data_object.create(
            data_object=obj,
            class_name="DocumentEmbedding",
            vector=vector,
        )
    except Exception as e:
        print(f"[WEAVIATE] upsert_document error: {e}", flush=True)
        return None


def search_documents(
    query: str,
    limit: int = 10,
    tenant: str = "kevin",
) -> list[dict]:
    """Semantic search over indexed Drive documents."""
    client = _safe_client()
    if not client:
        return []
    try:
        limit = max(1, min(limit, 50))
        vector = _get_embedding(query[:5000])
        result = (
            client.query
            .get("DocumentEmbedding", ["docId", "title", "description", "mimeType", "driveUrl", "account", "indexedAt"])
            .with_near_vector({"vector": vector})
            .with_where({"path": ["tenant"], "operator": "Equal", "valueText": tenant})
            .with_limit(limit)
            .do()
        )
        return result.get("data", {}).get("Get", {}).get("DocumentEmbedding", [])
    except Exception as e:
        print(f"[WEAVIATE] search_documents error: {e}", flush=True)
        return []


# ── helpers ───────────────────────────────────────────────────────────────────

def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
