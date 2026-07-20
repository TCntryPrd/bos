#!/usr/bin/env python3
"""Idempotently wire the guarded memory gateway into an existing API server.

Sparse customer overlays intentionally preserve their existing server.ts.  That
means an older customer API can receive routes/memory-gateway.ts without the
two small server registrations it needs.  This script changes only those
missing lines and fails closed if the target does not look like a supported
Fastify server.
"""

from __future__ import annotations

import os
import re
import stat
import sys
from pathlib import Path


IMPORT = "import { memoryGatewayRoutes } from './routes/memory-gateway.js';"
IMPORT_PATTERN = re.compile(
    r"^\s*import\s+\{\s*memoryGatewayRoutes\s*\}\s+from\s+['\"]\./routes/memory-gateway\.js['\"];\s*$",
    re.MULTILINE,
)
REGISTER_PATTERN = re.compile(
    r"await\s+server\.register\(\s*memoryGatewayRoutes(?:\s*,[^)]*)?\s*\)",
)
BUILD_SERVER_PATTERN = re.compile(
    r"\nexport\s+async\s+function\s+buildServer\s*\(",
)
RETURN_SERVER_PATTERN = re.compile(
    r"^(?P<indent>[ \t]*)return\s+server\s*;\s*$",
    re.MULTILINE,
)


def fail(message: str) -> None:
    print(f"[boss-memory-route] ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: ensure-memory-gateway-route.py /absolute/path/to/apps/api/src/server.ts")

    target = Path(sys.argv[1])
    if not target.is_absolute():
        fail("server path must be absolute")
    if target.is_symlink() or not target.is_file():
        fail("server path is missing, unsafe, or not a regular file")

    source = target.read_text(encoding="utf-8")
    changed: list[str] = []

    if not IMPORT_PATTERN.search(source):
        if re.search(r"\bmemoryGatewayRoutes\b", source):
            fail("memoryGatewayRoutes appears in server.ts but its canonical import is missing")
        marker = BUILD_SERVER_PATTERN.search(source)
        if marker is None:
            fail("could not find exported async buildServer() for safe import placement")
        source = source[: marker.start()] + "\n" + IMPORT + source[marker.start() :]
        changed.append("import")

    if not REGISTER_PATTERN.search(source):
        if BUILD_SERVER_PATTERN.search(source) is None:
            fail("could not find exported async buildServer() for safe route placement")
        returns = list(RETURN_SERVER_PATTERN.finditer(source))
        if not returns:
            fail("could not find return server; for safe route placement")
        marker = returns[-1]
        indent = marker.group("indent")
        registration = (
            f"{indent}// AIOS Memory Gateway - the only permitted edge-device writer to canonical Weaviate.\n"
            f"{indent}await server.register(memoryGatewayRoutes);\n\n"
        )
        source = source[: marker.start()] + registration + source[marker.start() :]
        changed.append("registration")

    if not changed:
        print("[boss-memory-route] already wired")
        return

    original_stat = target.stat()
    mode = stat.S_IMODE(original_stat.st_mode)
    temporary = target.with_name(f".{target.name}.boss-memory-{os.getpid()}.tmp")
    try:
        temporary.write_text(source, encoding="utf-8")
        os.chmod(temporary, mode)
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            os.chown(temporary, original_stat.st_uid, original_stat.st_gid)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()

    print(f"[boss-memory-route] added {', '.join(changed)}")


if __name__ == "__main__":
    main()
