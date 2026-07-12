#!/usr/bin/env bash
set -euo pipefail

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

valid_project_dir() {
  local dir="${1:-}"
  [[ "$dir" == /home/tcntryprd/rascals/* || "$dir" == /home/tcntryprd/outsiders/* || "$dir" == /home/tcntryprd/boss-dev* || "$dir" == /home/tcntryprd/coo* ]]
}

valid_attachment_path() {
  local file="${1:-}"
  [[ "$file" == /home/tcntryprd/outsiders/gio/.tmp/gio-chat-*/* ]]
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

cmd="${SSH_ORIGINAL_COMMAND:-${*:-}}"
[[ -n "$cmd" ]] || err "missing command"

# API-side bridge args are deliberately simple: no spaces or shell syntax.
# shellcheck disable=SC2206
parts=($cmd)
sub="${parts[0]:-}"

case "$sub" in
  status)
    ok ',"status":"ready"'
    ;;

  codex-exec)
    project_dir="${parts[1]:-}"
    valid_project_dir "$project_dir" || err "project dir not allowed"
    [[ -d "$project_dir" ]] || err "project dir missing: $project_dir"

    codex_args=(exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check)
    for item in "${parts[@]:2}"; do
      case "$item" in
        image=*)
          image_path="${item#image=}"
          valid_attachment_path "$image_path" || err "attachment path not allowed"
          [[ -f "$image_path" ]] || err "attachment missing: $image_path"
          codex_args+=(--image "$image_path")
          ;;
      esac
    done

    prompt="$(cat)"
    cd "$project_dir"
    exec codex "${codex_args[@]}" -- "$prompt"
    ;;

  new-chat)
    chat_id="${parts[1]:-}"
    project_dir="${parts[2]:-}"
    cc_session_id="${parts[3]:-}"
    valid_id "$chat_id" || err "invalid chat id"
    valid_id "$cc_session_id" || err "invalid session id"
    valid_project_dir "$project_dir" || err "project dir not allowed"
    [[ -d "$project_dir" ]] || err "project dir missing: $project_dir"

    tmux_name="boss-chat-${chat_id}"
    model_arg=()
    danger_arg=()
    for item in "${parts[@]:4}"; do
      case "$item" in
        model=*) model_arg=(--model "${item#model=}") ;;
        danger=true) danger_arg=(--dangerously-skip-permissions) ;;
      esac
    done

    if ! tmux has-session -t "$tmux_name" 2>/dev/null; then
      tmux new-session -d -s "$tmux_name" -c "$project_dir"
      if [[ -f "/home/tcntryprd/.claude/projects/$(printf '%s' "$project_dir" | sed 's#/#-#g')/${cc_session_id}.jsonl" ]]; then
        tmux send-keys -t "$tmux_name" "claude --resume ${cc_session_id} ${model_arg[*]} ${danger_arg[*]}" Enter
      else
        tmux send-keys -t "$tmux_name" "claude --session-id ${cc_session_id} ${model_arg[*]} ${danger_arg[*]}" Enter
      fi
      sleep 1
      pane="$(tmux capture-pane -t "$tmux_name" -p -S -80 2>/dev/null || true)"
      if [[ "$pane" == *"Bypass Permissions mode"* || "$pane" == *"Enter to confirm"* ]]; then
        tmux send-keys -t "$tmux_name" Down Enter
      fi
      sleep 2
    fi
    ok ",\"tmux\":$(json_escape "$tmux_name")"
    ;;

  send)
    chat_id="${parts[1]:-}"
    valid_id "$chat_id" || err "invalid chat id"
    tmux_name="boss-chat-${chat_id}"
    tmux has-session -t "$tmux_name" 2>/dev/null || err "tmux session missing: $tmux_name"
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    cat > "$tmp"
    tmux load-buffer -b boss-chat-input "$tmp"
    tmux paste-buffer -t "$tmux_name" -b boss-chat-input
    tmux send-keys -t "$tmux_name" Enter
    ok
    ;;

  interrupt)
    chat_id="${parts[1]:-}"
    valid_id "$chat_id" || err "invalid chat id"
    tmux_name="boss-chat-${chat_id}"
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
      tmux send-keys -t "$tmux_name" Escape
    fi
    ok
    ;;

  capture)
    chat_id="${parts[1]:-}"
    valid_id "$chat_id" || err "invalid chat id"
    tmux_name="boss-chat-${chat_id}"
    tmux has-session -t "$tmux_name" 2>/dev/null || err "tmux session missing: $tmux_name"
    pane="$(tmux capture-pane -t "$tmux_name" -p -S -120 2>/dev/null || true)"
    ok ",\"tmux\":$(json_escape "$tmux_name"),\"pane\":$(json_escape "$pane")"
    ;;

  kill)
    chat_id="${parts[1]:-}"
    valid_id "$chat_id" || err "invalid chat id"
    tmux_name="boss-chat-${chat_id}"
    tmux kill-session -t "$tmux_name" 2>/dev/null || true
    ok
    ;;

  *)
    err "unknown command: $sub"
    ;;
esac
