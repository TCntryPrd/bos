from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from cryptography.fernet import Fernet, InvalidToken
import psycopg
import os
import requests
from datetime import datetime
from typing import List, Optional

router = APIRouter(prefix="/credentials")

_fernet_instance = None


def get_fernet() -> Fernet:
    global _fernet_instance
    if _fernet_instance is not None:
        return _fernet_instance
    key = os.getenv("BOSS_CRED_KEY", "")
    if not key:
        raise HTTPException(status_code=500, detail="Credential encryption not configured")
    try:
        _fernet_instance = Fernet(key.encode() if isinstance(key, str) else key)
    except (ValueError, Exception):
        raise HTTPException(status_code=500, detail="Credential encryption misconfigured")
    return _fernet_instance


def get_pg_connection():
    url = os.getenv("POSTGRES_URL", "postgresql://boss:bosspass@127.0.0.1:5434/boss_db")
    return psycopg.connect(url)


def ensure_credentials_table():
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_credentials (
                    id SERIAL PRIMARY KEY,
                    platform TEXT NOT NULL,
                    key_name TEXT NOT NULL,
                    encrypted_value TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    last_tested TIMESTAMP,
                    test_status TEXT,
                    UNIQUE (platform, key_name)
                );
            """)
        conn.commit()


try:
    ensure_credentials_table()
except Exception as e:
    print(f"[CREDENTIALS] Table init error (will retry): {e}")


class CredentialCreate(BaseModel):
    platform: str
    key_name: str
    value: str


class CredentialOut(BaseModel):
    id: int
    platform: str
    key_name: str
    masked_value: str
    created_at: Optional[datetime]
    last_tested: Optional[datetime]
    test_status: Optional[str]


class TestResult(BaseModel):
    success: bool
    message: str


def _mask_value(decrypted: str) -> str:
    if len(decrypted) > 4:
        return "****" + decrypted[-4:]
    return "****"


@router.post("/", response_model=dict)
def create_credential(credential: CredentialCreate):
    f = get_fernet()
    encrypted = f.encrypt(credential.value.encode()).decode()
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO boss_credentials (platform, key_name, encrypted_value)
                VALUES (%s, %s, %s)
                ON CONFLICT (platform, key_name)
                DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, last_tested = NULL, test_status = NULL
                RETURNING id
            """, (credential.platform, credential.key_name, encrypted))
            row = cur.fetchone()
        conn.commit()
    return {"id": row[0], "platform": credential.platform, "key_name": credential.key_name}


@router.get("/", response_model=List[CredentialOut])
def list_credentials():
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, platform, key_name, encrypted_value, created_at, last_tested, test_status FROM boss_credentials ORDER BY platform, key_name")
            rows = cur.fetchall()

    f = get_fernet()
    results = []
    for row in rows:
        try:
            decrypted = f.decrypt(row[3].encode()).decode()
            masked = _mask_value(decrypted)
        except InvalidToken:
            masked = "****[decrypt error]"
        results.append(CredentialOut(
            id=row[0], platform=row[1], key_name=row[2],
            masked_value=masked, created_at=row[4],
            last_tested=row[5], test_status=row[6]
        ))
    return results


@router.get("/{cred_id}", response_model=CredentialOut)
def get_credential(cred_id: int):
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, platform, key_name, encrypted_value, created_at, last_tested, test_status FROM boss_credentials WHERE id = %s", (cred_id,))
            row = cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")

    f = get_fernet()
    try:
        decrypted = f.decrypt(row[3].encode()).decode()
        masked = _mask_value(decrypted)
    except InvalidToken:
        masked = "****[decrypt error]"

    return CredentialOut(
        id=row[0], platform=row[1], key_name=row[2],
        masked_value=masked, created_at=row[4],
        last_tested=row[5], test_status=row[6]
    )


@router.delete("/{cred_id}", response_model=dict)
def delete_credential(cred_id: int):
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM boss_credentials WHERE id = %s RETURNING id", (cred_id,))
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")
    return {"deleted": cred_id}


# Supported platform test configs: (header_factory, url)
_PLATFORM_TESTS = {
    "openai": (
        lambda v: {"Authorization": f"Bearer {v}"},
        "https://api.openai.com/v1/models",
    ),
    "anthropic": (
        lambda v: {"x-api-key": v, "anthropic-version": "2023-06-01"},
        "https://api.anthropic.com/v1/models",
    ),
    "elevenlabs": (
        lambda v: {"xi-api-key": v},
        "https://api.elevenlabs.io/v1/voices",
    ),
}


def _test_stripe(value: str) -> tuple[bool, str]:
    try:
        r = requests.get("https://api.stripe.com/v1/balance", auth=(value, ""), timeout=10)
        ok = r.status_code == 200
        return ok, "Stripe key valid" if ok else "Stripe key rejected"
    except requests.RequestException:
        return False, "Stripe connection failed"


@router.post("/{cred_id}/test", response_model=TestResult)
def test_credential(cred_id: int):
    f = get_fernet()
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT platform, encrypted_value FROM boss_credentials WHERE id = %s", (cred_id,))
            row = cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")

    platform, encrypted = row
    try:
        value = f.decrypt(encrypted.encode()).decode()
    except InvalidToken:
        return TestResult(success=False, message="Failed to decrypt credential")

    success = False
    message = ""

    if platform == "stripe":
        success, message = _test_stripe(value)
    elif platform in _PLATFORM_TESTS:
        header_fn, url = _PLATFORM_TESTS[platform]
        try:
            r = requests.get(url, headers=header_fn(value), timeout=10)
            success = r.status_code == 200
            message = f"{platform.title()} key valid" if success else f"{platform.title()} key rejected"
        except requests.RequestException:
            message = f"{platform.title()} connection failed"
    else:
        message = f"No test defined for platform '{platform}' — stored but untested"
        success = True

    # Update test result in DB
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE boss_credentials SET last_tested = NOW(), test_status = %s WHERE id = %s",
                ("ok" if success else "failed", cred_id)
            )
        conn.commit()

    return TestResult(success=success, message=message)
