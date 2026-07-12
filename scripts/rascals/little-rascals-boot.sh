#!/usr/bin/env bash
# little-rascals-boot.sh — Create tmux sessions for each enabled rascal
# returned by GET /api/agents/rascals?enabled=true.
#
# Behavior:
#   - Sources ~/.config/rascals/.env if present + rascals-common.sh
#   - If the API is unreachable, logs and exits 0 (bulletproof)
#   - If the registry is empty, logs and exits 0 (fresh install path)
#   - For each rascal:
#       * Skips if projectDir missing (logs and continues)
#       * Skips if tmux session already exists (idempotent)
#       * Creates detached tmux session with cwd = projectDir
#       * In prod, sends CLI launch keys with a stagger delay
#       * In RASCALS_TEST_MODE=1, session-creation only (no CLI spawn)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
[ "${RASCALS_TEST_MODE:-0}" != "1" ] && [ -f "$HOME/.config/rascals/.env" ] && . "$HOME/.config/rascals/.env"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/rascals-common.sh"

rascals_log boot "=== boot run starting ==="

STAGGER="${RASCALS_BOOT_STAGGER_SEC:-10}"

registry="$(rascals_fetch_registry)" || {
  rascals_log boot "API unreachable — skipping boot (exit 0)"
  exit 0
}

if [ -z "$registry" ]; then
  rascals_log boot "no enabled rascals — nothing to boot"
  exit 0
fi

while IFS='|' read -r handle cli project_dir; do
  [ -z "$handle" ] && continue

  if [ ! -d "$project_dir" ]; then
    rascals_log boot "SKIP ${handle} — project dir missing: ${project_dir}"
    continue
  fi

  if tmux has-session -t "$handle" 2>/dev/null; then
    rascals_log boot "SKIP ${handle} — tmux session already exists"
    continue
  fi

  rascals_log boot "creating tmux session: ${handle} (cwd=${project_dir})"
  tmux new-session -d -s "$handle" -c "$project_dir"

  if [ "${RASCALS_TEST_MODE:-0}" = "1" ]; then
    rascals_log boot "TEST_MODE — skipping CLI launch for ${handle}"
    continue
  fi

  case "$cli" in
    claude) cli_cmd='claude --dangerously-skip-permissions' ;;
    ollama) cli_cmd='ollama run gemma4' ;;
    *)
      rascals_log boot "WARN ${handle} — unknown cli '${cli}', defaulting to claude"
      cli_cmd='claude --dangerously-skip-permissions'
      ;;
  esac

  rascals_log boot "launching CLI in ${handle}: ${cli_cmd}"
  tmux send-keys -t "$handle" "$cli_cmd" Enter

  sleep "$STAGGER"
done <<< "$registry"

rascals_log boot "=== boot run complete ==="
