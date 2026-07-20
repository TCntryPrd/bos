#!/usr/bin/env bash
set -euo pipefail

# Installer-owned runtime settings. The forced-command SSH bridge does not
# inherit an interactive login shell, so portable customer paths live here.
if [[ -r /etc/boss-agent-runtime.env ]]; then
  # shellcheck disable=SC1091
  source /etc/boss-agent-runtime.env
fi

export PATH="${BOSS_AGENT_PATH:-$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH}"
BOSS_AGENT_ALLOWED_ROOTS="${BOSS_AGENT_ALLOWED_ROOTS:-$HOME/rascals:$HOME/outsiders:$HOME/agents:$HOME/coo:$HOME/vasari-dev}"
BOSS_AGENT_STATE_DIR="${BOSS_AGENT_STATE_DIR:-$HOME/.local/state/boss-agent-runtime}"
BOSS_AGENT_TMUX_PREFIX="${BOSS_AGENT_TMUX_PREFIX:-boss-agent-}"
[[ "$BOSS_AGENT_TMUX_PREFIX" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || BOSS_AGENT_TMUX_PREFIX="boss-agent-"
mkdir -p "$BOSS_AGENT_STATE_DIR"

err() {
  local msg="${1:-error}"
  printf '{"ok":false,"error":%s}\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$msg")"
  exit 1
}

ok() {
  printf '{"ok":true%s}\n' "${1:-}"
}

valid_id() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._-]{1,120}$ ]]
}

valid_agent_id() {
  [[ "${1:-}" =~ ^[a-z][a-z0-9._-]{1,79}$ ]]
}

valid_project_dir() {
  local dir="${1:-}"
  local normalized root normalized_root
  normalized="$(realpath -m -- "$dir" 2>/dev/null)" || return 1
  IFS=':' read -r -a roots <<< "$BOSS_AGENT_ALLOWED_ROOTS"
  for root in "${roots[@]}"; do
    [[ -n "$root" ]] || continue
    normalized_root="$(realpath -m -- "$root" 2>/dev/null)" || continue
    case "$normalized" in
      "$normalized_root"|"$normalized_root"/*) return 0 ;;
    esac
  done
  return 1
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

agent_tmux_name() {
  printf '%s%s' "$BOSS_AGENT_TMUX_PREFIX" "$1"
}

agent_marker() {
  printf '%s/%s.session' "$BOSS_AGENT_STATE_DIR" "$1"
}

pane_command() {
  tmux display-message -p -t "$1" '#{pane_current_command}' 2>/dev/null || true
}

is_shell_command() {
  case "${1##*/}" in
    bash|dash|fish|ksh|sh|zsh) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_agent_shell() {
  local agent_id="$1" project_dir="$2" tmux_name mapping mapped normalized lock_file lock_wait
  valid_agent_id "$agent_id" || { printf 'invalid agent runtime id'; return 1; }
  valid_project_dir "$project_dir" || { printf 'project dir not allowed'; return 1; }
  [[ -d "$project_dir" ]] || { printf 'project dir missing: %s' "$project_dir"; return 1; }
  normalized="$(realpath -m -- "$project_dir")" || { printf 'cannot resolve project dir'; return 1; }
  mkdir -p "$BOSS_AGENT_STATE_DIR/shells" "$BOSS_AGENT_STATE_DIR/locks"
  mapping="$BOSS_AGENT_STATE_DIR/shells/$agent_id.path"
  lock_file="$BOSS_AGENT_STATE_DIR/locks/$agent_id.ensure.lock"
  lock_wait="${BOSS_AGENT_ENSURE_LOCK_WAIT_SECONDS:-30}"
  [[ "$lock_wait" =~ ^[0-9]{1,3}$ ]] || lock_wait=30

  # The same runtime lock is taken by agent-ensure and agent-start. It makes
  # immutable project binding and tmux creation one transaction under bursts
  # of concurrent portal requests.
  (
    flock -w "$lock_wait" 9 || {
      printf 'timed out waiting for agent shell lock'
      exit 1
    }
    if [[ -f "$mapping" ]]; then
      IFS= read -r mapped < "$mapping" || true
      [[ "$mapped" == "$normalized" ]] || {
        printf 'runtime id is already bound to a different project dir'
        exit 1
      }
    else
      printf '%s\n' "$normalized" > "$mapping.tmp.$BASHPID"
      chmod 600 "$mapping.tmp.$BASHPID"
      mv -n -- "$mapping.tmp.$BASHPID" "$mapping" 2>/dev/null || rm -f -- "$mapping.tmp.$BASHPID"
      IFS= read -r mapped < "$mapping" || true
      [[ "$mapped" == "$normalized" ]] || {
        printf 'runtime project mapping race'
        exit 1
      }
    fi
    tmux_name="$(agent_tmux_name "$agent_id")"
    if ! tmux has-session -t "$tmux_name" 2>/dev/null; then
      tmux new-session -d -s "$tmux_name" -c "$project_dir"
    fi
    tmux set-option -t "$tmux_name" history-limit 50000 >/dev/null
    printf '%s' "$tmux_name"
  ) 9>"$lock_file"
}

cmd="${SSH_ORIGINAL_COMMAND:-${*:-}}"
[[ -n "$cmd" ]] || err "missing command"

# API-side bridge args are deliberately simple: no quoting, globbing, or shell
# syntax is accepted by this forced-command boundary.
[[ "$cmd" =~ ^[A-Za-z0-9._/:=-]+([[:space:]]+[A-Za-z0-9._/:=-]+)*$ ]] \
  || err "invalid command characters"
read -r -a parts <<< "$cmd"
sub="${parts[0]:-}"

case "$sub" in
  status)
    ok ',"status":"ready"'
    ;;

  agent-ensure)
    agent_id="${parts[1]:-}"
    project_dir="${parts[2]:-}"
    if ! tmux_name="$(ensure_agent_shell "$agent_id" "$project_dir" 2>&1)"; then err "$tmux_name"; fi
    current="$(pane_command "$tmux_name")"
    busy=true
    if is_shell_command "$current"; then busy=false; fi
    ok ",\"tmux\":$(json_escape "$tmux_name"),\"command\":$(json_escape "$current"),\"busy\":$busy"
    ;;

  agent-start)
    agent_id="${parts[1]:-}"
    project_dir="${parts[2]:-}"
    cc_session_id="${parts[3]:-}"
    valid_agent_id "$agent_id" || err "invalid agent runtime id"
    valid_id "$cc_session_id" || err "invalid session id"
    exec 7>"$BOSS_AGENT_STATE_DIR/$agent_id.start.lock"
    flock -n 7 || err "agent start already in progress"
    if ! tmux_name="$(ensure_agent_shell "$agent_id" "$project_dir" 2>&1)"; then err "$tmux_name"; fi
    marker="$(agent_marker "$agent_id")"
    current="$(pane_command "$tmux_name")"
    if is_shell_command "$current"; then
      # A stale marker can remain if Claude exited on its own.
      rm -f -- "$marker"
    else
      err "agent shell busy: $agent_id ($current)"
    fi

    claude_bin="${BOSS_CLAUDE_BIN:-$(command -v claude || true)}"
    [[ -n "$claude_bin" && -x "$claude_bin" ]] || err "claude CLI is not installed for $USER"
    model=""
    danger=false
    for item in "${parts[@]:4}"; do
      case "$item" in
        model=*)
          model="${item#model=}"
          [[ "$model" =~ ^[A-Za-z0-9._:-]+$ ]] || err "invalid model"
          ;;
        danger=true) danger=true ;;
      esac
    done

    claude_args=("$claude_bin" --session-id "$cc_session_id")
    if [[ -n "$model" ]]; then claude_args+=(--model "$model"); fi
    effort="${BOSS_CLAUDE_EFFORT:-}"
    if [[ -z "$effort" ]]; then
      case "$model" in
        *fable*) effort=xhigh ;;
        *sonnet-5*) effort=high ;;
      esac
    fi
    if [[ -n "$effort" ]]; then
      [[ "$effort" =~ ^(low|medium|high|xhigh)$ ]] || err "invalid effort"
      claude_args+=(--effort "$effort")
    fi
    if [[ "$danger" == true ]]; then claude_args+=(--dangerously-skip-permissions); fi

    prompt_file="$(mktemp)"
    agent_cli_launched=false
    agent_start_committed=false
    cleanup_agent_start() {
      local rc=$?
      trap - EXIT
      rm -f -- "${prompt_file:-}"
      if [[ "$agent_cli_launched" == true && "$agent_start_committed" != true ]]; then
        set +e
        tmux send-keys -t "$tmux_name" Escape
        sleep 1
        tmux send-keys -t "$tmux_name" -l -- '/exit'
        tmux send-keys -t "$tmux_name" Enter
        sleep 2
        rm -f -- "$marker"
      fi
      exit "$rc"
    }
    trap cleanup_agent_start EXIT
    cat > "$prompt_file"
    [[ -s "$prompt_file" ]] || err "empty agent prompt"

    printf '%s\n%s\n%s\n' "$cc_session_id" "$project_dir" "$(date +%s)" > "$marker"
    chmod 600 "$marker"
    printf -v quoted_dir '%q' "$project_dir"
    printf -v quoted_command '%q ' "${claude_args[@]}"
    launch="cd -- $quoted_dir && ${quoted_command% }"
    tmux send-keys -t "$tmux_name" -l -- "$launch"
    tmux send-keys -t "$tmux_name" Enter
    agent_cli_launched=true

    ready_ticks=0
    confirmed_bypass=false
    confirmed_trust=false
    for attempt in $(seq 1 45); do
      sleep 1
      pane="$(tmux capture-pane -t "$tmux_name" -p -S -80 2>/dev/null || true)"
      current="$(pane_command "$tmux_name")"
      if [[ "$pane" == *"Bypass Permissions mode"* || "$pane" == *"Enter to confirm"* ]]; then
        if [[ "$confirmed_bypass" == false ]]; then
          tmux send-keys -t "$tmux_name" Down Enter
          confirmed_bypass=true
          ready_ticks=0
          continue
        fi
      fi
      if [[ "$pane" == *"Do you trust the files"* || "$pane" == *"Yes, proceed"* ]]; then
        if [[ "$confirmed_trust" == false ]]; then
          tmux send-keys -t "$tmux_name" Enter
          confirmed_trust=true
          ready_ticks=0
          continue
        fi
      fi
      if is_shell_command "$current"; then
        if [[ $attempt -gt 2 ]]; then
          rm -f -- "$marker"
          err "claude CLI exited before accepting the prompt: $(printf '%s' "$pane" | tail -15)"
        fi
        continue
      fi
      ready_ticks=$((ready_ticks + 1))
      if [[ $ready_ticks -ge 2 ]]; then break; fi
    done
    current="$(pane_command "$tmux_name")"
    if is_shell_command "$current"; then
      rm -f -- "$marker"
      err "claude CLI did not become interactive"
    fi

    buffer_name="boss-agent-input-${agent_id}"
    tmux load-buffer -b "$buffer_name" "$prompt_file"
    tmux paste-buffer -d -t "$tmux_name" -b "$buffer_name"
    tmux send-keys -t "$tmux_name" Enter
    bridge_self="$(readlink -f -- "$0")"
    watcher_log="$BOSS_AGENT_STATE_DIR/watchers.log"
    # Do not let the detached watcher inherit the startup flock. Otherwise its
    # later agent-finish call waits on a lock held by the watcher itself.
    agent_start_committed=true
    flock -u 7
    exec 7>&-
    nohup env -u SSH_ORIGINAL_COMMAND "$bridge_self" agent-watch \
      "$agent_id" "$project_dir" "$cc_session_id" </dev/null >>"$watcher_log" 2>&1 7>&- 8>&- &
    ok ",\"tmux\":$(json_escape "$tmux_name"),\"sessionId\":$(json_escape "$cc_session_id"),\"command\":$(json_escape "$current")"
    ;;

  agent-watch)
    # Detached safety net. The API normally owns streaming and cleanup, but if
    # its container restarts this watcher still observes the true end_turn and
    # exits only Claude, never the permanent tmux shell.
    agent_id="${parts[1]:-}"
    project_dir="${parts[2]:-}"
    cc_session_id="${parts[3]:-}"
    valid_agent_id "$agent_id" || err "invalid agent runtime id"
    valid_project_dir "$project_dir" || err "project dir not allowed"
    valid_id "$cc_session_id" || err "invalid session id"
    tmux_name="$(agent_tmux_name "$agent_id")"
    marker="$(agent_marker "$agent_id")"
    claude_home="${BOSS_AGENT_HOME:-$HOME}"
    project_slug="$(printf '%s' "$project_dir" | sed 's#/#-#g')"
    jsonl="$claude_home/.claude/projects/$project_slug/$cc_session_id.jsonl"
    max_seconds="${BOSS_AGENT_MAX_TURN_SECONDS:-21600}"
    [[ "$max_seconds" =~ ^[0-9]{2,6}$ ]] || max_seconds=21600

    if python3 - "$jsonl" "$marker" "$cc_session_id" "$tmux_name" "$max_seconds" <<'PY'
import json
import os
import subprocess
import sys
import time

path, marker, expected, tmux_name, max_seconds = sys.argv[1:]
deadline = time.time() + int(max_seconds)
cursor = 0
remainder = ""
candidate = None
shells = {"bash", "dash", "fish", "ksh", "sh", "zsh"}

def marker_matches():
    try:
        with open(marker, "r", encoding="utf-8") as fh:
            return fh.readline().strip() == expected
    except OSError:
        return False

def pane_is_shell():
    try:
        result = subprocess.run(
            ["tmux", "display-message", "-p", "-t", tmux_name, "#{pane_current_command}"],
            check=False, capture_output=True, text=True, timeout=3,
        )
        if result.returncode != 0:
            return True
        return os.path.basename(result.stdout.strip()) in shells
    except Exception:
        return False

while time.time() < deadline:
    if not marker_matches() or pane_is_shell():
        raise SystemExit(3)
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    if size > cursor:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                fh.seek(cursor)
                chunk = fh.read(size - cursor)
                cursor = fh.tell()
        except OSError:
            chunk = ""
        text = remainder + chunk
        lines = text.split("\n")
        remainder = lines.pop() if text and not text.endswith("\n") else ""
        for line in lines:
            try:
                frame = json.loads(line)
            except Exception:
                continue
            frame_type = frame.get("type")
            if frame_type in {"assistant", "user"} and candidate is not None:
                candidate = None
            if frame_type != "assistant":
                continue
            message = frame.get("message") or {}
            blocks = message.get("content") or []
            has_text = any(
                isinstance(block, dict)
                and block.get("type") == "text"
                and str(block.get("text") or "").strip()
                for block in blocks
            )
            if message.get("stop_reason") == "end_turn" and has_text:
                candidate = time.time()
    if candidate is not None and time.time() - candidate >= 6:
        raise SystemExit(0)
    time.sleep(0.25)
raise SystemExit(2)
PY
    then
      watch_rc=0
    else
      watch_rc=$?
    fi

    marker_session=""
    if [[ -f "$marker" ]]; then IFS= read -r marker_session < "$marker" || true; fi
    if [[ "$marker_session" != "$cc_session_id" ]]; then exit 0; fi
    if [[ "$watch_rc" -eq 3 ]]; then
      rm -f -- "$marker"
      exit 0
    fi
    # rc=0 is a normal final response; rc=2 is an abandoned-turn timeout.
    if [[ "$watch_rc" -eq 2 ]]; then
      env -u SSH_ORIGINAL_COMMAND "$(readlink -f -- "$0")" agent-interrupt \
        "$agent_id" "$cc_session_id" >/dev/null 2>&1 || true
    fi
    env -u SSH_ORIGINAL_COMMAND "$(readlink -f -- "$0")" agent-finish \
      "$agent_id" "$cc_session_id" >/dev/null 2>&1 || true
    ;;

  agent-interrupt)
    agent_id="${parts[1]:-}"
    expected_session="${parts[2]:-}"
    valid_agent_id "$agent_id" || err "invalid agent runtime id"
    if [[ -n "$expected_session" ]]; then valid_id "$expected_session" || err "invalid session id"; fi
    tmux_name="$(agent_tmux_name "$agent_id")"
    marker="$(agent_marker "$agent_id")"
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
      current="$(pane_command "$tmux_name")"
      if ! is_shell_command "$current"; then
        marker_session=""
        if [[ -f "$marker" ]]; then IFS= read -r marker_session < "$marker" || true; fi
        [[ -n "$marker_session" ]] || err "refusing to interrupt an unowned process"
        if [[ -n "$expected_session" && "$marker_session" != "$expected_session" ]]; then
          err "refusing to interrupt a newer agent turn"
        fi
        tmux send-keys -t "$tmux_name" Escape
      fi
    fi
    ok ",\"tmux\":$(json_escape "$tmux_name")"
    ;;

  agent-finish)
    agent_id="${parts[1]:-}"
    expected_session="${parts[2]:-}"
    valid_agent_id "$agent_id" || err "invalid agent runtime id"
    if [[ -n "$expected_session" ]]; then valid_id "$expected_session" || err "invalid session id"; fi
    exec 7>"$BOSS_AGENT_STATE_DIR/$agent_id.start.lock"
    flock -w 90 7 || err "timed out waiting for agent start lock"
    exec 8>"$BOSS_AGENT_STATE_DIR/$agent_id.finish.lock"
    flock -w 45 8 || err "timed out waiting for agent cleanup lock"
    tmux_name="$(agent_tmux_name "$agent_id")"
    marker="$(agent_marker "$agent_id")"
    tmux has-session -t "$tmux_name" 2>/dev/null || err "agent shell missing: $tmux_name"
    marker_session=""
    if [[ -f "$marker" ]]; then IFS= read -r marker_session < "$marker" || true; fi
    current="$(pane_command "$tmux_name")"
    if ! is_shell_command "$current"; then
      [[ -n "$marker_session" ]] || err "refusing to stop an unowned process"
      if [[ -n "$expected_session" && "$marker_session" != "$expected_session" ]]; then
        err "refusing to stop a newer agent turn"
      fi
      # The JSONL end frame can precede Claude's Stop hook. Give cognitive
      # memory/Weaviate hooks time to finish, then request a normal /exit so
      # SessionEnd hooks also run. Interrupt callers already sent Escape via
      # agent-interrupt before entering this cleanup path.
      hook_grace="${BOSS_AGENT_HOOK_GRACE_SECONDS:-8}"
      [[ "$hook_grace" =~ ^[0-9]{1,3}$ ]] || hook_grace=8
      sleep "$hook_grace"
      tmux send-keys -t "$tmux_name" -l -- '/exit'
      tmux send-keys -t "$tmux_name" Enter
      for attempt in $(seq 1 60); do
        sleep 1
        current="$(pane_command "$tmux_name")"
        if is_shell_command "$current"; then break; fi
      done
      if ! is_shell_command "$current"; then
        tmux send-keys -t "$tmux_name" C-d
        sleep 3
        current="$(pane_command "$tmux_name")"
      fi
    fi
    if ! is_shell_command "$current"; then err "claude CLI did not exit cleanly ($current)"; fi
    rm -f -- "$marker"
    ok ",\"tmux\":$(json_escape "$tmux_name"),\"command\":$(json_escape "$current"),\"busy\":false"
    ;;

  agent-capture)
    agent_id="${parts[1]:-}"
    valid_agent_id "$agent_id" || err "invalid agent runtime id"
    tmux_name="$(agent_tmux_name "$agent_id")"
    tmux has-session -t "$tmux_name" 2>/dev/null || err "agent shell missing: $tmux_name"
    pane="$(tmux capture-pane -t "$tmux_name" -p -S -200 2>/dev/null || true)"
    current="$(pane_command "$tmux_name")"
    busy=true
    if is_shell_command "$current"; then busy=false; fi
    marker_session=""
    if [[ -f "$(agent_marker "$agent_id")" ]]; then
      IFS= read -r marker_session < "$(agent_marker "$agent_id")" || true
    fi
    ok ",\"tmux\":$(json_escape "$tmux_name"),\"pane\":$(json_escape "$pane"),\"command\":$(json_escape "$current"),\"busy\":$busy,\"sessionId\":$(json_escape "$marker_session")"
    ;;

  agent-status)
    agent_id="${parts[1]:-}"
    valid_agent_id "$agent_id" || err "invalid agent runtime id"
    tmux_name="$(agent_tmux_name "$agent_id")"
    marker="$(agent_marker "$agent_id")"
    if ! tmux has-session -t "$tmux_name" 2>/dev/null; then
      ok ",\"tmux\":$(json_escape "$tmux_name"),\"exists\":false,\"busy\":false"
      exit 0
    fi
    current="$(pane_command "$tmux_name")"
    busy=true
    if is_shell_command "$current"; then
      busy=false
      rm -f -- "$marker"
    fi
    marker_session=""
    if [[ -f "$marker" ]]; then IFS= read -r marker_session < "$marker" || true; fi
    ok ",\"tmux\":$(json_escape "$tmux_name"),\"exists\":true,\"busy\":$busy,\"command\":$(json_escape "$current"),\"sessionId\":$(json_escape "$marker_session")"
    ;;

  *)
    err "unknown command: $sub"
    ;;
esac
