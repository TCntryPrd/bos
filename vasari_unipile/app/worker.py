import asyncio

from .db import apply_migrations
from .linkedin_system import run_worker_loop


def run() -> None:
    apply_migrations()
    print("vasari_unipile LinkedIn worker online.", flush=True)
    asyncio.run(run_worker_loop())
