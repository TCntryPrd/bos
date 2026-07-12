#!/usr/bin/env bash
# agent-save.sh <handle> <slug>
# Captures the named rascal's tmux scrollback, writes to output/, and ingests
# to Weaviate's Knowledge collection.
#
# Non-disruptive: if Weaviate is unreachable or WEAVIATE_URL is empty, skip
# the ingest step with a log line — the local file is still written.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ "${RASCALS_TEST_MODE:-0}" != "1" ] && [ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

handle="${1:-}"
slug="${2:-wake}"

if [ -z "$handle" ]; then
  echo "Usage: $0 <handle> [slug]" >&2
  exit 2
fi

log_name="save-${handle}"

project_dir="${RASCALS_ROOT}/${handle}"
out_dir="${project_dir}/output"
mkdir -p "$out_dir"

# Sanitize slug
safe_slug="$(printf '%s' "$slug" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"
[ -z "$safe_slug" ] && safe_slug="wake"

date_str="$(date -u +%Y-%m-%d-%H%M)"
out_file="${out_dir}/${date_str}-${safe_slug}.md"

# Capture scrollback. -p prints to stdout; -S -9999 grabs a large chunk.
content=""
if tmux has-session -t "$handle" 2>/dev/null; then
  content="$(tmux capture-pane -t "$handle" -p -S -9999 || true)"
else
  content="[session '${handle}' not found at save time]"
fi

# Write markdown
captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '# %s — %s\n\n' "$handle" "$safe_slug"
  printf 'Captured: %s\n\n' "$captured_at"
  # shellcheck disable=SC2016
  printf -- '---\n\n```\n%s\n```\n' "$content"
} > "$out_file"

rascals_log "$log_name" "wrote ${out_file} ($(wc -c < "$out_file") bytes)"

# Weaviate ingest — non-disruptive
if [ -z "${WEAVIATE_URL:-}" ]; then
  rascals_log "$log_name" "WEAVIATE_URL empty — skipping ingest"
  exit 0
fi

# Build payload via python with argv (safer than heredoc interpolation).
payload="$(python3 - "$handle" "$safe_slug" "$captured_at" "$out_file" <<'PY'
import json, sys
handle, safe_slug, captured_at, out_file = sys.argv[1:5]
with open(out_file) as f:
    body = f.read()
print(json.dumps({
    "class": "Knowledge",
    "properties": {
        "agent": handle,
        "slug": safe_slug,
        "captured_at": captured_at,
        "source": "rascals-save",
        "content": body,
    },
}))
PY
)"

wv_out="$(mktemp)"
wv_err="$(mktemp)"
if ! curl -sS --max-time 30 -X POST \
     -H "Content-Type: application/json" \
     -d "$payload" \
     "${WEAVIATE_URL%/}/v1/objects" > "$wv_out" 2> "$wv_err"; then
  rascals_log "$log_name" "WARN — Weaviate ingest failed: $(tr '\n' ' ' < "$wv_err" | head -c 200)"
  rm -f "$wv_out" "$wv_err"
  exit 0
fi
rascals_log "$log_name" "ingest ok — $(head -c 200 "$wv_out")"
rm -f "$wv_out" "$wv_err"
