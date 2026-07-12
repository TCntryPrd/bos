#!/usr/bin/env bash
# wake-agent.sh <handle> "<prompt>"
# Sends a prompt into the named rascal's tmux session, under the global lock.
#
# Flow:
#   1. Validate handle is enabled
#   2. Acquire global lock (flock, timeout = RASCALS_WAKE_TIMEOUT_SEC)
#   3. Ensure tmux session exists (create if not — boot script should have done this, but be defensive)
#   4. Send prompt to the session via send-keys
#   5. Append wake entry to state/wake-log.json
#   6. Release lock and exit (completion detection and save are the job of agent-save.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ "${RASCALS_TEST_MODE:-0}" != "1" ] && [ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

handle="${1:-}"
prompt="${2:-}"

if [ -z "$handle" ] || [ -z "$prompt" ]; then
  echo "Usage: $0 <handle> \"<prompt>\"" >&2
  exit 2
fi

log_name="wake-${handle}"

# Validate the handle is present and enabled in the DB-backed registry.
# We query GET /api/agents/rascals?handle=<h>&enabled=true. Empty result => refuse.
lookup_url="${BOSS_API_URL%/}/api/agents/rascals?enabled=true&handle=${handle}"
lookup_json="$(curl -sS --max-time 10 \
  -H 'X-BOSS-Internal: true' \
  -H "X-Tenant-ID: ${BOSS_TENANT_ID}" \
  "$lookup_url" 2>/dev/null || echo '')"

if ! printf '%s' "$lookup_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    sys.exit(0 if data.get("rascals") else 1)
except Exception:
    sys.exit(1)
'; then
  rascals_log "$log_name" "REFUSED — handle '${handle}' not enabled or not found"
  exit 3
fi

# Extract project_dir and cli for this handle (no hardcoded handle-to-cli mapping).
project_dir="$(printf '%s' "$lookup_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["rascals"][0]["projectDir"])
')"
rascal_cli="$(printf '%s' "$lookup_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["rascals"][0]["cli"])
')"

timeout="${RASCALS_WAKE_TIMEOUT_SEC:-900}"
if ! rascals_acquire_lock "$timeout"; then
  rascals_log "$log_name" "ABORT — could not acquire lock within ${timeout}s"
  exit 4
fi
trap 'rascals_release_lock' EXIT

# Defensive: recreate session if missing. Normally boot script does this.
if ! tmux has-session -t "$handle" 2>/dev/null; then
  rascals_log "$log_name" "session missing — creating ${handle} in ${project_dir}"
  tmux new-session -d -s "$handle" -c "$project_dir"
  # In prod, also launch CLI. In test mode, caller stubs tmux so this is moot.
  if [ "${RASCALS_TEST_MODE:-0}" != "1" ]; then
    case "$rascal_cli" in
      ollama) tmux send-keys -t "$handle" 'ollama run gemma4' Enter ;;
      claude) tmux send-keys -t "$handle" 'claude --dangerously-skip-permissions' Enter ;;
      *)
        rascals_log "$log_name" "WARN unknown cli '${rascal_cli}' — defaulting to claude"
        tmux send-keys -t "$handle" 'claude --dangerously-skip-permissions' Enter
        ;;
    esac
    sleep 5
  fi
fi

rascals_log "$log_name" "sending prompt to ${handle} (${#prompt} chars)"
tmux send-keys -t "$handle" "$prompt" Enter

# Append to wake-log.json (atomic: write-temp + mv)
mkdir -p "${project_dir}/state"
log_file="${project_dir}/state/wake-log.json"
[ -f "$log_file" ] || echo '[]' > "$log_file"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp)"
# Use jq if available; otherwise append a bare entry and let save.sh normalize.
if command -v jq >/dev/null 2>&1; then
  jq --arg ts "$ts" --arg prompt "$prompt" \
     '. + [{timestamp: $ts, prompt: $prompt, status: "sent"}]' \
     "$log_file" > "$tmp"
  mv "$tmp" "$log_file"
else
  # Fallback: naive append (drops closing ']', writes entry, appends ']')
  # This path is used only if jq is missing; install jq on any real rascals host.
  sed -i 's/]$//' "$log_file"
  if [ "$(tr -d '[:space:]' < "$log_file")" = "[" ]; then
    printf '{"timestamp":"%s","prompt":%s,"status":"sent"}\n]\n' "$ts" \
      "$(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      >> "$log_file"
  else
    printf ',\n{"timestamp":"%s","prompt":%s,"status":"sent"}\n]\n' "$ts" \
      "$(printf '%s' "$prompt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      >> "$log_file"
  fi
fi

rascals_log "$log_name" "wake complete"
