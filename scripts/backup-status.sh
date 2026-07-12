#!/usr/bin/env bash
# backup-status.sh — write JSON status snapshot for boss_backup_status tool to read
# Sourced by backup.sh, n8n-workflow-export.sh, cc-memory-backup.sh
set -uo pipefail

STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/boss-backups/status.json}"

# write_status_entry <asset> <last_attempt_iso> <success_iso_or_empty> <size_bytes_or_0> <last_error_or_empty>
write_status_entry() {
    local asset="$1"
    local attempt="$2"
    local success="$3"
    local size="$4"
    local err="$5"

    python3 - <<PY 2>/dev/null
import json, os
status = {}
if os.path.exists("$STATUS_FILE"):
    try: status = json.load(open("$STATUS_FILE"))
    except Exception: status = {}
status["$asset"] = {
    "last_attempt": "$attempt",
    "last_success": "$success",
    "size_bytes": int("$size") if "$size" else 0,
    "last_error": "$err"
}
status["_written_at"] = "$attempt"
with open("$STATUS_FILE", "w") as f: json.dump(status, f, indent=2)
PY
}

# report_asset_success <asset> <file>
report_asset_success() {
    local asset="$1"
    local file="$2"
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local size
    size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
    write_status_entry "$asset" "$now" "$now" "$size" ""
}

# report_asset_failure <asset> <error_message>
report_asset_failure() {
    local asset="$1"
    local err="$2"
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    python3 - <<PY 2>/dev/null
import json, os
status = {}
if os.path.exists("$STATUS_FILE"):
    try: status = json.load(open("$STATUS_FILE"))
    except Exception: status = {}
prev = status.get("$asset", {})
status["$asset"] = {
    "last_attempt": "$now",
    "last_success": prev.get("last_success", ""),
    "size_bytes": prev.get("size_bytes", 0),
    "last_error": "$err"[:500]
}
status["_written_at"] = "$now"
with open("$STATUS_FILE", "w") as f: json.dump(status, f, indent=2)
PY
}
