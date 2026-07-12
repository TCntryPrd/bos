from contextlib import contextmanager
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

from .config import get_settings
from .migrations import UNIPILE_SCHEMA_SQL


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    settings = get_settings()
    with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
        yield conn


def apply_migrations() -> None:
    with connect() as conn:
        conn.execute(UNIPILE_SCHEMA_SQL)
        conn.commit()


def get_runtime_config_value(keys: list[str], tenant_id: str = "default") -> str:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT value
              FROM runtime_config
             WHERE tenant_id = %s
               AND key = ANY(%s)
             ORDER BY array_position(%s::text[], key)
             LIMIT 1
            """,
            (tenant_id, keys, keys),
        ).fetchone()
        if row:
            return str(row["value"] or "").strip()
        fallback = conn.execute(
            """
            SELECT value
              FROM runtime_config
             WHERE key = ANY(%s)
             ORDER BY updated_at DESC
             LIMIT 1
            """,
            (keys,),
        ).fetchone()
        return str(fallback["value"] or "").strip() if fallback else ""

