#!/usr/bin/env bash
# Compatibility entry point for customer BOS deployments.
#
# The former script assumed one Vasari-specific container topology and fixed
# container names. Portable installations instead preserve the customer's
# compose files and delegate to the guarded, non-destructive updater.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
UPDATER="$PROJECT_DIR/deploy/update-bos.sh"

fail() { printf '[boss-deploy] ERROR: %s\n' "$*" >&2; exit 1; }
[[ -f "$UPDATER" ]] || fail "portable updater is missing: $UPDATER"

if [[ "${IMAGE_TAG:-local}" != local || -n "${IMAGE_PREFIX:-}" ]]; then
  fail "portable deploy does not guess customer image/service names; stage the release safely, then run deploy/update-bos.sh"
fi

exec bash "$UPDATER"
