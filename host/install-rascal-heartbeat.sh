#!/usr/bin/env bash
# Stage, test, and explicitly activate the fresh-interactive rascal heartbeat.
# This intentionally does not create a second timer or alter cron.  Activation
# replaces only the existing scheduler target with a small wrapper and keeps a
# timestamped backup for immediate rollback.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-rascal-heartbeat.sh --stage | --activate | --rollback

--stage     Install /usr/local/sbin/boss-rascal-heartbeat only. No scheduler is
            changed.
--activate  Stage the helper, back up the configured legacy target, and replace
            that target with a wrapper that preserves the existing schedule.
--rollback  Restore the newest backup of the configured legacy target.

Environment:
  BOSS_RASCAL_HEARTBEAT_TARGET  helper path (default /usr/local/sbin/boss-rascal-heartbeat)
  BOSS_RASCAL_HEARTBEAT_LEGACY  scheduler target (default /docker/hermes-agent-qtbk/rascal-heartbeat.sh)
  BOSS_RASCAL_HEARTBEAT_BACKUP_DIR  backup directory
EOF
}

action="${1:-}"
case "$action" in
  --stage|--activate|--rollback) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo 'must run as root' >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/boss-rascal-heartbeat.sh"
TARGET="${BOSS_RASCAL_HEARTBEAT_TARGET:-/usr/local/sbin/boss-rascal-heartbeat}"
LEGACY="${BOSS_RASCAL_HEARTBEAT_LEGACY:-/docker/hermes-agent-qtbk/rascal-heartbeat.sh}"
BACKUP_DIR="${BOSS_RASCAL_HEARTBEAT_BACKUP_DIR:-/var/lib/boss-agent-runtime/legacy-heartbeat-backups}"

[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || { echo "missing staged helper: $SOURCE" >&2; exit 2; }
[[ "$TARGET" == /* && "$LEGACY" == /* && "$BACKUP_DIR" == /* ]] || { echo 'all paths must be absolute' >&2; exit 2; }
bash -n "$SOURCE"

stage() {
  install -d -o root -g root -m 0755 "$(dirname "$TARGET")"
  install -o root -g root -m 0755 "$SOURCE" "$TARGET"
  echo "staged $TARGET"
}

case "$action" in
  --stage)
    stage
    echo "Run '$TARGET --dry-run' before --activate."
    ;;
  --activate)
    stage
    [[ -f "$LEGACY" && ! -L "$LEGACY" ]] || { echo "legacy target is not a regular file: $LEGACY" >&2; exit 2; }
    legacy_uid="$(stat -c '%u' "$LEGACY")"
    legacy_gid="$(stat -c '%g' "$LEGACY")"
    legacy_mode="$(stat -c '%a' "$LEGACY")"
    install -d -o root -g root -m 0700 "$BACKUP_DIR"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    backup="$BACKUP_DIR/rascal-heartbeat.${stamp}.sh"
    cp -p -- "$LEGACY" "$backup"
    chmod 0600 "$backup"
    wrapper="$(mktemp "${LEGACY}.new.XXXXXX")"
    trap 'rm -f -- "${wrapper:-}"' EXIT
    cat > "$wrapper" <<EOF
#!/usr/bin/env bash
exec "$TARGET" "\$@"
EOF
    install -o "$legacy_uid" -g "$legacy_gid" -m "$legacy_mode" "$wrapper" "$LEGACY"
    rm -f -- "$wrapper"
    trap - EXIT
    echo "activated fresh-interactive heartbeat; backup: $backup"
    ;;
  --rollback)
    [[ -d "$BACKUP_DIR" ]] || { echo "no backup directory: $BACKUP_DIR" >&2; exit 2; }
    backup="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rascal-heartbeat.*.sh' -printf '%T@ %p\n' | sort -nr | awk 'NR == 1 { print $2 }')"
    [[ -n "$backup" && -f "$backup" ]] || { echo 'no heartbeat backup found' >&2; exit 2; }
    [[ -f "$LEGACY" && ! -L "$LEGACY" ]] || { echo "legacy target is not a regular file: $LEGACY" >&2; exit 2; }
    legacy_uid="$(stat -c '%u' "$LEGACY")"
    legacy_gid="$(stat -c '%g' "$LEGACY")"
    legacy_mode="$(stat -c '%a' "$LEGACY")"
    install -o "$legacy_uid" -g "$legacy_gid" -m "$legacy_mode" "$backup" "$LEGACY"
    echo "restored $LEGACY from $backup"
    ;;
esac
