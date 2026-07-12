from hashlib import sha256
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from psycopg.types.json import Jsonb

from .config import get_settings
from .db import apply_migrations, connect
from .linkedin_system import (
    approve_action,
    cancel_action,
    linkedin_overview,
    save_post_draft,
    sync_accounts,
    sync_linkedin_posts,
    update_post_accept_message,
)
from .unipile_client import UnipileClient

app = FastAPI(title="Vasari Unipile", version="0.1.0")


@app.on_event("startup")
def startup() -> None:
    apply_migrations()


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    client = UnipileClient()
    db_ok = True
    try:
        with connect() as conn:
            conn.execute("SELECT 1")
    except Exception:
        db_ok = False
    return {
        "ok": db_ok,
        "service": "vasari_unipile",
        "db": db_ok,
        "unipile_configured": client.configured,
    }


@app.get("/views/account-health")
async def account_health() -> dict[str, Any]:
    client = UnipileClient()
    accounts: list[dict[str, Any]] = []
    if client.configured:
        accounts = await client.list_accounts()
    with connect() as conn:
        queue = conn.execute(
            """
            SELECT status, count(*)::int AS count
              FROM unipile.action_queue
             GROUP BY status
             ORDER BY status
            """
        ).fetchall()
        budgets = conn.execute(
            """
            SELECT action_type, day, count, cap
              FROM unipile.rate_budget_ledger
             WHERE day = CURRENT_DATE
             ORDER BY action_type
            """
        ).fetchall()
        last_webhooks = conn.execute(
            """
            SELECT source, max(received_at) AS last_received_at
              FROM unipile.webhook_event
             GROUP BY source
             ORDER BY source
            """
        ).fetchall()
    return {
        "configured": client.configured,
        "accounts": [
            {
                "id": item.get("id"),
                "type": item.get("type"),
                "name": item.get("name"),
                "sources": item.get("sources", []),
            }
            for item in accounts
        ],
        "queue": queue,
        "budgets": budgets,
        "last_webhooks": last_webhooks,
    }


@app.get("/views/linkedin")
async def linkedin_view() -> dict[str, Any]:
    return await linkedin_overview()


@app.post("/tools/sync-accounts")
async def sync_accounts_tool() -> dict[str, Any]:
    rows = await sync_accounts()
    return {"ok": True, "accounts": rows}


@app.post("/tools/sync-linkedin")
async def sync_linkedin_tool() -> dict[str, Any]:
    return await sync_linkedin_posts()


@app.post("/tools/post-accept-message")
async def post_accept_message_tool(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        result = update_post_accept_message(
            str(payload.get("message") or ""),
            payload.get("auto_send") if "auto_send" in payload else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "post_accept_message": result}


@app.post("/tools/post-draft")
async def post_draft_tool(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        result = save_post_draft(payload if isinstance(payload, dict) else {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "action": result}


@app.post("/tools/actions/{action_id}/approve")
async def approve_action_tool(action_id: int) -> dict[str, Any]:
    try:
        return {"ok": True, "action": approve_action(action_id)}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/tools/actions/{action_id}/cancel")
async def cancel_action_tool(action_id: int) -> dict[str, Any]:
    try:
        return {"ok": True, "action": cancel_action(action_id)}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/webhooks/unipile/{source}")
async def receive_webhook(
    source: str,
    request: Request,
    unipile_auth: str | None = Header(default=None, alias="Unipile-Auth"),
) -> dict[str, Any]:
    settings = get_settings()
    if settings.webhook_secret and unipile_auth != settings.webhook_secret:
        raise HTTPException(status_code=401, detail="bad webhook secret")
    payload = await request.json()
    event_type = str(payload.get("event") or payload.get("type") or source)
    unipile_ref = str(
        payload.get("message_id")
        or payload.get("id")
        or payload.get("account_id")
        or payload.get("user_provider_id")
        or ""
    )
    dedupe_source = f"{source}:{event_type}:{unipile_ref}:{payload}"
    dedupe_key = sha256(dedupe_source.encode("utf-8")).hexdigest()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO unipile.webhook_event (source, event_type, unipile_ref, payload, dedupe_key)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (dedupe_key) DO NOTHING
            """,
            (source, event_type, unipile_ref or None, Jsonb(payload), dedupe_key),
        )
        conn.commit()
    return {"ok": True}
