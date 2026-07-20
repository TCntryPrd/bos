#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ENV="${BOSS_AGENT_RUNTIME_ENV:-/etc/boss-agent-runtime.env}"
if [[ -r "$RUNTIME_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
  set +a
fi

: "${BOSS_AGENT_USER:=$(id -un)}"
: "${BOSS_AGENT_HOME:=$HOME}"
: "${BOSS_AGENT_RASCALS_ROOT:=$BOSS_AGENT_HOME/rascals}"
: "${BOSS_AGENT_OUTSIDERS_ROOT:=$BOSS_AGENT_HOME/outsiders}"
: "${BOSS_AGENT_TMUX_PREFIX:=boss-agent-}"
: "${BOSS_AGENT_STATE_DIR:=$BOSS_AGENT_HOME/.boss-agent-runtime}"

fail() { printf '[boss-agent-shells] ERROR: %s\n' "$*" >&2; exit 1; }
log()  { printf '[boss-agent-shells] %s\n' "$*"; }

valid_runtime_id() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9._-]{1,79}$ ]]
}

allowed_project_dir() {
  local dir="${1:-}" normalized root normalized_root
  [[ ! "$dir" =~ [[:space:]] ]] || return 1
  normalized="$(realpath -m -- "$dir" 2>/dev/null)" || return 1
  for root in "$BOSS_AGENT_RASCALS_ROOT" "$BOSS_AGENT_OUTSIDERS_ROOT"; do
    normalized_root="$(realpath -m -- "$root" 2>/dev/null)" || continue
    case "$normalized" in
      "$normalized_root"/*) return 0 ;;
    esac
  done
  return 1
}

ensure_memory_skeleton() {
  local runtime_id="$1" project_dir="$2" handle
  handle="$(basename "$project_dir")"
  mkdir -p "$project_dir/memory/episodes" "$project_dir/memory/procedures" "$project_dir/memory/knowledge"
  if [[ ! -e "$project_dir/MEMORY.md" ]]; then
    printf '# %s cognitive memory\n\nDurable summaries and pointers for this agent.\n' "$handle" > "$project_dir/MEMORY.md"
  fi
  if [[ ! -e "$project_dir/CLAUDE.md" ]]; then
    cat > "$project_dir/CLAUDE.md" <<EOF
# $handle workspace

Read MEMORY.md and the relevant files under memory/ before acting. Keep durable
recaps concise, redact credentials, and preserve target-specific customer data.
EOF
  fi
}

ensure_shell() {
  local runtime_id="${1:-}" project_dir="${2:-}" register="${3:-true}"
  valid_runtime_id "$runtime_id" || fail "invalid agent runtime id: $runtime_id"
  allowed_project_dir "$project_dir" || fail "project directory outside configured roots: $project_dir"
  project_dir="$(realpath -m -- "$project_dir")"
  ensure_memory_skeleton "$runtime_id" "$project_dir"

  if [[ "$register" == true ]]; then
    local registry temp
    registry="$BOSS_AGENT_STATE_DIR/shells/$runtime_id.path"
    mkdir -p "$(dirname "$registry")"
    if [[ -f "$registry" ]]; then
      local registered
      IFS= read -r registered < "$registry" || registered=""
      [[ "$registered" == "$project_dir" ]] \
        || fail "runtime id is already bound to a different project: $runtime_id"
    fi
    temp="${registry}.tmp.$$"
    printf '%s\n' "$project_dir" > "$temp"
    chmod 0600 "$temp"
    mv -n -- "$temp" "$registry" 2>/dev/null || rm -f -- "$temp"
    IFS= read -r registered < "$registry" || registered=""
    [[ "$registered" == "$project_dir" ]] || fail "runtime project mapping race: $runtime_id"
  fi

  local session="${BOSS_AGENT_TMUX_PREFIX}${runtime_id}"
  if ! tmux has-session -t "$session" 2>/dev/null; then
    tmux new-session -d -s "$session" -c "$project_dir" "exec bash -l"
    tmux set-option -t "$session" remain-on-exit off >/dev/null
    log "started $session in $project_dir"
  fi
  tmux set-option -t "$session" history-limit 50000 >/dev/null
}

safe_part() {
  local value="$1" fallback="$2" max="$3" safe
  safe="$(printf '%s' "$value" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-"$max")"
  printf '%s' "${safe:-$fallback}"
}

runtime_id() {
  local tenant_id="$1" kind="$2" handle="$3" tenant agent digest
  [[ "$kind" == rascal || "$kind" == outsider ]] || fail "invalid agent kind: $kind"
  tenant="$(safe_part "$tenant_id" default 18)"
  agent="$(safe_part "$handle" agent 32)"
  digest="$(printf '%s' "$tenant_id" | sha256sum | awk '{print substr($1,1,10)}')"
  printf '%s-%s-%s-%s\n' "$kind" "$agent" "$tenant" "$digest"
}

reconcile_registered() {
  local registry record runtime_id project_dir
  registry="$BOSS_AGENT_STATE_DIR/shells"
  [[ -d "$registry" ]] || return 0
  while IFS= read -r -d '' record; do
    runtime_id="$(basename "$record" .path)"
    valid_runtime_id "$runtime_id" || continue
    IFS= read -r project_dir < "$record" || continue
    ensure_shell "$runtime_id" "$project_dir" false
  done < <(find "$registry" -mindepth 1 -maxdepth 1 -type f -name '*.path' -print0)
}

case "${1:-reconcile}" in
  ensure)
    [[ $# -eq 3 ]] || fail "usage: boss-agent-shells ensure RUNTIME_ID PROJECT_DIR"
    ensure_shell "$2" "$3"
    ;;
  runtime-id)
    [[ $# -eq 4 ]] || fail "usage: boss-agent-shells runtime-id TENANT_ID KIND HANDLE"
    runtime_id "$2" "$3" "$4"
    ;;
  reconcile)
    reconcile_registered
    ;;
  status)
    tmux list-sessions -F '#{session_name}\t#{session_attached}\t#{pane_current_path}' 2>/dev/null \
      | awk -v prefix="$BOSS_AGENT_TMUX_PREFIX" 'index($1, prefix) == 1'
    ;;
  *)
    fail "usage: boss-agent-shells {ensure RUNTIME_ID PROJECT_DIR|runtime-id TENANT_ID KIND HANDLE|reconcile|status}"
    ;;
esac
