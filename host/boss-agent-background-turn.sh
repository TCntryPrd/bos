#!/usr/bin/env bash
# Run one bounded background task through the same fresh interactive lifecycle
# used by the portal. The permanent tmux shell remains; Claude exits after the
# turn. This deliberately does not use Claude print mode or --resume.
set -euo pipefail

RUNTIME_ENV="${BOSS_AGENT_RUNTIME_ENV:-/etc/boss-agent-runtime.env}"
if [[ -r "$RUNTIME_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
  set +a
fi

runtime_id="${1:-}"
project_dir="${2:-}"
model="${3:-}"
[[ "$runtime_id" =~ ^[a-z][a-z0-9._-]{1,79}$ ]] || { echo "invalid runtime id" >&2; exit 2; }
[[ -n "$project_dir" && -d "$project_dir" ]] || { echo "project directory missing" >&2; exit 2; }
[[ -z "$model" || "$model" =~ ^[A-Za-z0-9._:-]+$ ]] || { echo "invalid model" >&2; exit 2; }

bridge="${BOSS_AGENT_BRIDGE_BIN:-/usr/local/libexec/boss-agent-runtime-bridge}"
[[ -x "$bridge" ]] || { echo "restricted agent bridge is missing" >&2; exit 2; }
timeout_seconds="${BOSS_AGENT_BACKGROUND_TIMEOUT_SECONDS:-420}"
[[ "$timeout_seconds" =~ ^[0-9]{2,5}$ ]] || timeout_seconds=420
(( timeout_seconds >= 60 && timeout_seconds <= 21600 )) || { echo "invalid background timeout" >&2; exit 2; }

if command -v uuidgen >/dev/null 2>&1; then
  session_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
else
  session_id="$(< /proc/sys/kernel/random/uuid)"
fi

args=(agent-start "$runtime_id" "$project_dir" "$session_id" danger=true)
if [[ -n "$model" ]]; then args+=("model=$model"); fi

# The bridge consumes this script's stdin as the actual task prompt.
BOSS_AGENT_MAX_TURN_SECONDS="$timeout_seconds" \
  env -u SSH_ORIGINAL_COMMAND "$bridge" "${args[@]}" >/dev/null

deadline=$(( $(date +%s) + timeout_seconds + 90 ))
while (( $(date +%s) < deadline )); do
  status="$(env -u SSH_ORIGINAL_COMMAND "$bridge" agent-status "$runtime_id" 2>/dev/null || true)"
  if [[ "$status" == *'"busy":false'* ]]; then break; fi
  sleep 2
done

if (( $(date +%s) >= deadline )); then
  env -u SSH_ORIGINAL_COMMAND "$bridge" agent-interrupt "$runtime_id" "$session_id" >/dev/null 2>&1 || true
  env -u SSH_ORIGINAL_COMMAND "$bridge" agent-finish "$runtime_id" "$session_id" >/dev/null 2>&1 || true
  echo "background turn timed out" >&2
  exit 124
fi

# A shell becoming idle is necessary but not sufficient: report success only
# when the fresh JSONL contains this turn's real text-bearing end_turn frame.
project_slug="${project_dir//\//-}"
jsonl="${BOSS_AGENT_HOME:-$HOME}/.claude/projects/${project_slug}/${session_id}.jsonl"
if python3 - "$jsonl" <<'PY'
import json
import sys

try:
    lines = open(sys.argv[1], encoding='utf-8', errors='replace')
except OSError:
    raise SystemExit(1)
for line in lines:
    try:
        frame = json.loads(line)
    except Exception:
        continue
    message = frame.get('message') or {}
    if frame.get('type') != 'assistant' or message.get('stop_reason') != 'end_turn':
        continue
    if any(isinstance(block, dict) and block.get('type') == 'text' and str(block.get('text') or '').strip()
           for block in (message.get('content') or [])):
        raise SystemExit(0)
raise SystemExit(1)
PY
then
  exit 0
fi

echo "background turn ended without a final response" >&2
exit 1
