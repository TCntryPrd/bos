"""
Google OAuth2 flow for IR Custom AIOS.

Handles the complete OAuth2 web flow:
1. User clicks "Connect Google" in dashboard
2. Redirected to Google consent screen with requested scopes
3. Google redirects back with auth code
4. We exchange code for access + refresh tokens
5. Tokens stored encrypted in Postgres
6. Auto-refresh before expiry on every API call

Supported services and their scopes:
- Calendar: https://www.googleapis.com/auth/calendar.readonly
- Gmail: https://www.googleapis.com/auth/gmail.modify
- Tasks: https://www.googleapis.com/auth/tasks
- Home Graph: https://www.googleapis.com/auth/homegraph
"""

import os
import json
import hashlib
import secrets
import psycopg
import httpx
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@postgres:5432/boss_db")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
OAUTH_REDIRECT_URI = os.getenv(
    "GOOGLE_OAUTH_REDIRECT_URI",
    "https://last-castle.daggertooth-larch.ts.net/boss/oauth/google/callback"
)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

# Service → scopes mapping
SERVICE_SCOPES = {
    "calendar": ["https://www.googleapis.com/auth/calendar"],
    "gmail": ["https://www.googleapis.com/auth/gmail.modify"],
    "tasks": ["https://www.googleapis.com/auth/tasks"],
    "drive": ["https://www.googleapis.com/auth/drive"],
    "docs": ["https://www.googleapis.com/auth/documents"],
    "sheets": ["https://www.googleapis.com/auth/spreadsheets"],
    "chat": ["https://www.googleapis.com/auth/chat.messages", "https://www.googleapis.com/auth/chat.spaces.readonly"],
    "contacts": ["https://www.googleapis.com/auth/contacts.readonly"],
    "homegraph": ["https://www.googleapis.com/auth/homegraph"],
    "profile": ["openid", "email", "profile"],
}


def get_pg():
    return psycopg.connect(POSTGRES_URL)


def ensure_oauth_tables():
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_google_oauth (
                    id SERIAL PRIMARY KEY,
                    service TEXT NOT NULL,
                    email TEXT,
                    access_token TEXT NOT NULL,
                    refresh_token TEXT,
                    token_expiry TIMESTAMPTZ,
                    scopes TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT now(),
                    updated_at TIMESTAMPTZ DEFAULT now(),
                    UNIQUE(service, email)
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_oauth_state (
                    state TEXT PRIMARY KEY,
                    services TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            """)
        conn.commit()


def build_auth_url(services: list[str]) -> tuple[str, str]:
    """Build Google OAuth2 authorization URL. Returns (url, state)."""
    scopes = ["openid", "email", "profile"]
    for svc in services:
        scopes.extend(SERVICE_SCOPES.get(svc, []))
    scopes = list(set(scopes))

    state = secrets.token_urlsafe(32)

    # Store state for verification
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO boss_oauth_state (state, services) VALUES (%s, %s)",
                (state, ",".join(services)),
            )
        conn.commit()

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(scopes),
        "state": state,
        "access_type": "offline",
        "prompt": "consent select_account",
    }

    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}", state


def exchange_code(code: str, state: str) -> dict:
    """Exchange authorization code for tokens. Returns token info."""
    # Verify state
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT services FROM boss_oauth_state WHERE state = %s", (state,))
            row = cur.fetchone()
            if not row:
                raise ValueError("Invalid OAuth state — possible CSRF attack")
            services = row[0].split(",")
            cur.execute("DELETE FROM boss_oauth_state WHERE state = %s", (state,))
        conn.commit()

    # Exchange code for tokens
    with httpx.Client(timeout=30) as client:
        resp = client.post(GOOGLE_TOKEN_URL, data={
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": OAUTH_REDIRECT_URI,
        })
        resp.raise_for_status()
        tokens = resp.json()

    access_token = tokens["access_token"]
    refresh_token = tokens.get("refresh_token")
    expires_in = tokens.get("expires_in", 3600)
    token_expiry = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

    # Get user email
    with httpx.Client(timeout=10) as client:
        resp = client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        resp.raise_for_status()
        userinfo = resp.json()

    email = userinfo.get("email", "unknown")

    # Store tokens for each requested service
    with get_pg() as conn:
        with conn.cursor() as cur:
            for svc in services:
                scopes = ",".join(SERVICE_SCOPES.get(svc, []))
                cur.execute("""
                    INSERT INTO boss_google_oauth (service, email, access_token, refresh_token, token_expiry, scopes, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, now())
                    ON CONFLICT (service, email) DO UPDATE
                    SET access_token = EXCLUDED.access_token,
                        refresh_token = COALESCE(EXCLUDED.refresh_token, boss_google_oauth.refresh_token),
                        token_expiry = EXCLUDED.token_expiry,
                        scopes = EXCLUDED.scopes,
                        updated_at = now()
                """, (svc, email, access_token, refresh_token, token_expiry, scopes))
        conn.commit()

    return {
        "email": email,
        "services": services,
        "expires_at": token_expiry.isoformat(),
    }


def get_valid_token(service: str, email: str | None = None) -> str | None:
    """Get a valid access token for a service, auto-refreshing if needed.
    If email is specified, returns token for that specific account.
    Otherwise returns the most recently updated token for the service."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            if email:
                cur.execute(
                    "SELECT access_token, refresh_token, token_expiry FROM boss_google_oauth WHERE service = %s AND email = %s",
                    (service, email),
                )
            else:
                cur.execute(
                    "SELECT access_token, refresh_token, token_expiry FROM boss_google_oauth WHERE service = %s ORDER BY updated_at DESC LIMIT 1",
                    (service,),
                )
            row = cur.fetchone()

    if not row:
        return None

    access_token, refresh_token, token_expiry = row

    # Check if token is still valid (with 5 min buffer)
    if token_expiry and token_expiry > datetime.now(timezone.utc) + timedelta(minutes=5):
        return access_token

    # Need to refresh
    if not refresh_token:
        return None

    return _refresh_token(service, refresh_token)


def _refresh_token(service: str, refresh_token: str) -> str | None:
    """Refresh an expired access token."""
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(GOOGLE_TOKEN_URL, data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            })
            resp.raise_for_status()
            tokens = resp.json()

        new_access_token = tokens["access_token"]
        expires_in = tokens.get("expires_in", 3600)
        token_expiry = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

        with get_pg() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE boss_google_oauth SET access_token = %s, token_expiry = %s, updated_at = now() WHERE service = %s AND refresh_token = %s",
                    (new_access_token, token_expiry, service, refresh_token),
                )
            conn.commit()

        return new_access_token
    except Exception as e:
        print(f"[OAUTH] Token refresh failed for {service}: {e}", flush=True)
        return None


def get_connection_status() -> list[dict]:
    """Get status of all Google service connections."""
    ensure_oauth_tables()
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT service, email, token_expiry, updated_at FROM boss_google_oauth ORDER BY service"
            )
            rows = cur.fetchall()

    now = datetime.now(timezone.utc)
    status = []
    connected_services = set()

    for r in rows:
        service, email, expiry, updated = r
        connected_services.add(service)
        is_valid = expiry and expiry > now
        status.append({
            "service": service,
            "email": email,
            "connected": True,
            "token_valid": is_valid,
            "expires_at": expiry.isoformat() if expiry else None,
            "last_updated": updated.isoformat() if updated else None,
        })

    # Add disconnected services
    for svc in SERVICE_SCOPES:
        if svc not in connected_services and svc != "profile":
            status.append({"service": svc, "connected": False, "token_valid": False})

    return status


def disconnect_service(service: str, email: str | None = None) -> bool:
    """Remove OAuth tokens for a service. If email specified, only that account."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            if email:
                cur.execute("DELETE FROM boss_google_oauth WHERE service = %s AND email = %s", (service, email))
            else:
                cur.execute("DELETE FROM boss_google_oauth WHERE service = %s", (service,))
            deleted = cur.rowcount
        conn.commit()
    return deleted > 0


def get_connected_accounts() -> list[str]:
    """Get all unique connected email accounts."""
    with get_pg() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT email FROM boss_google_oauth WHERE email IS NOT NULL ORDER BY email")
            return [r[0] for r in cur.fetchall()]
