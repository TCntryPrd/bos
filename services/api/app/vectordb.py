"""
boss/api/app/vectordb.py
---------------------------
FastAPI router for Weaviate vector DB — document search endpoints.

Endpoints:
  GET  /vectordb/health           — Weaviate connection health check
  GET  /vectordb/documents/search — semantic search over Drive documents
  POST /vectordb/documents        — upsert a document embedding
  POST /vectordb/documents/sync   — sync Drive file list into Weaviate for one account
"""
from __future__ import annotations

import os
import sys
from fastapi import APIRouter, Query, HTTPException

sys.path.insert(0, "/app")

from shared.weaviate_client import (
    ensure_schemas,
    upsert_document,
    search_documents,
    get_weaviate,
    validate_account,
)

router = APIRouter(prefix="/vectordb", tags=["vectordb"])

# Hard cap on documents synced per request to prevent runaway memory/time
_MAX_SYNC_PAGES = 20  # 20 pages × 100 files = 2000 docs max


@router.get("/health")
def vectordb_health():
    """Check Weaviate connectivity and list collections."""
    try:
        client = get_weaviate()
        ready = client.is_ready()
        classes = [c["class"] for c in client.schema.get().get("classes", [])]
        return {"weaviate_ready": ready, "collections": classes}
    except Exception as e:
        return {"weaviate_ready": False, "error": str(e)}


@router.get("/documents/search")
def vectordb_documents_search(
    q: str = Query(..., description="Natural-language query, e.g. 'BSC proposal'", max_length=5000),
    limit: int = Query(10, ge=1, le=50),
    tenant: str = Query("kevin", max_length=100),
):
    """Semantic search over indexed Drive documents."""
    results = search_documents(q, limit=limit, tenant=tenant)
    return {"query": q, "count": len(results), "results": results}


@router.post("/documents")
def vectordb_upsert_document(payload: dict):
    """
    Upsert a document embedding into Weaviate.
    Required: doc_id, title
    Optional: description, mime_type, drive_url, account, tenant
    """
    doc_id = (payload.get("doc_id") or "").strip()
    title = (payload.get("title") or "").strip()
    if not doc_id or not title:
        raise HTTPException(status_code=400, detail="doc_id and title are required")
    uid = upsert_document(
        doc_id=doc_id,
        title=title,
        description=payload.get("description", ""),
        mime_type=payload.get("mime_type", ""),
        drive_url=payload.get("drive_url", ""),
        account=payload.get("account", "user@example.com"),
        tenant=payload.get("tenant", "kevin"),
    )
    if uid is None:
        raise HTTPException(status_code=503, detail="Weaviate unavailable — document not stored")
    return {"status": "upserted", "uuid": uid, "doc_id": doc_id, "title": title}


@router.post("/documents/sync")
def vectordb_sync_documents(payload: dict):
    """
    Sync Drive files for one Google account into Weaviate.
    Required: email (must be one of the 4 authorized Google accounts)
    Optional: tenant, max_pages (default 20, max 50)
    """
    account_email = (payload.get("email") or "user@example.com").strip()
    tenant = (payload.get("tenant") or "kevin").strip()
    max_pages = min(int(payload.get("max_pages", _MAX_SYNC_PAGES)), 50)

    try:
        account_email = validate_account(account_email)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    try:
        count = _sync_drive_documents(account_email, tenant, max_pages=max_pages)
        return {"status": "synced", "account": account_email, "documents_synced": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _sync_drive_documents(
    account_email: str,
    tenant: str = "kevin",
    max_pages: int = _MAX_SYNC_PAGES,
) -> int:
    """
    Fetch file list from Google Drive via IR Custom AIOS's OAuth tokens
    and upsert them into Weaviate DocumentEmbedding.
    Bounded to max_pages pages (100 files each).
    """
    import psycopg
    import json
    import httpx

    POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@localhost:5434/boss_db")

    with psycopg.connect(POSTGRES_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT token_data FROM boss_google_oauth WHERE email = %s AND service = %s LIMIT 1",
                (account_email, "drive"),
            )
            row = cur.fetchone()

    if not row:
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

    url = "https://www.googleapis.com/drive/v3/files"
    params = {
        "fields": "nextPageToken,files(id,name,description,mimeType,webViewLink)",
        "pageSize": 100,
        "q": "trashed = false",
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
            raise ValueError(f"Google Drive API error {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        files = data.get("files", [])
        pages_fetched += 1

        for f in files:
            doc_id = f.get("id", "")
            title = f.get("name", "")
            if doc_id and title:
                upsert_document(
                    doc_id=doc_id,
                    title=title,
                    description=f.get("description", ""),
                    mime_type=f.get("mimeType", ""),
                    drive_url=f.get("webViewLink", ""),
                    account=account_email,
                    tenant=tenant,
                )
                synced += 1

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return synced
