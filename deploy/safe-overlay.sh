#!/usr/bin/env bash
# Apply a curated BOS release overlay without deleting target-owned files.
# Target visuals are verified and backed up first. Any detected visual drift is
# restored automatically; the retained backup also supports an operator rollback.

set -Eeuo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
Usage: safe-overlay.sh RELEASE_DIR TARGET_DIR

Environment:
  BOSS_VISUAL_MANIFEST     Target-owned manifest (default: /var/lib/boss/visual-baseline.json)
  BOSS_VISUAL_BACKUP_ROOT  Backup parent (default: /var/backups/boss/visual-overlays)
  PYTHON_BIN               Python 3 executable (default: python3)
EOF
}

die() {
  printf 'safe overlay failed: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 2 ]] || {
  usage
  exit 2
}

PYTHON_BIN="${PYTHON_BIN:-python3}"
BOSS_VISUAL_MANIFEST="${BOSS_VISUAL_MANIFEST:-/var/lib/boss/visual-baseline.json}"
BOSS_VISUAL_BACKUP_ROOT="${BOSS_VISUAL_BACKUP_ROOT:-/var/backups/boss/visual-overlays}"

command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "Python 3 is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v find >/dev/null 2>&1 || die "find is required"

[[ -d "$1" ]] || die "release directory does not exist: $1"
[[ -d "$2" ]] || die "target directory does not exist: $2"
[[ "$BOSS_VISUAL_MANIFEST" = /* ]] || die "BOSS_VISUAL_MANIFEST must be absolute"
[[ "$BOSS_VISUAL_BACKUP_ROOT" = /* ]] || die "BOSS_VISUAL_BACKUP_ROOT must be absolute"

RELEASE_DIR="$(cd -P -- "$1" && pwd -P)"
TARGET_DIR="$(cd -P -- "$2" && pwd -P)"
[[ -n "$RELEASE_DIR" && -n "$TARGET_DIR" ]] || die "could not resolve release or target path"
[[ "$RELEASE_DIR" != "/" && "$TARGET_DIR" != "/" ]] || die "release and target must not be /"
[[ "$RELEASE_DIR" != "$TARGET_DIR" ]] || die "release and target must be different directories"
case "$RELEASE_DIR/" in
  "$TARGET_DIR/"*) die "release directory must not be inside the target" ;;
esac
case "$TARGET_DIR/" in
  "$RELEASE_DIR/"*) die "target directory must not be inside the release" ;;
esac

VISUAL_TOOL="$RELEASE_DIR/scripts/visual-preserve.py"
[[ -f "$VISUAL_TOOL" && ! -L "$VISUAL_TOOL" ]] || die "release is missing scripts/visual-preserve.py"
[[ -f "$BOSS_VISUAL_MANIFEST" && ! -L "$BOSS_VISUAL_MANIFEST" ]] \
  || die "target visual baseline is missing or unsafe: $BOSS_VISUAL_MANIFEST"

# Only source/runtime trees and non-secret build metadata are eligible. Root
# compose files, .env files, Git metadata, auth, SSH, data, and state never enter
# the overlay, and tar is intentionally run without any delete option.
ALLOWED_DIRS=(apps packages services scripts deploy host public docs config configs prisma)
ALLOWED_FILES=(
  package.json package-lock.json pnpm-lock.yaml pnpm-workspace.yaml yarn.lock
  tsconfig.json tsconfig.base.json turbo.json nx.json
)
OVERLAY_ITEMS=()
for item in "${ALLOWED_DIRS[@]}" "${ALLOWED_FILES[@]}"; do
  [[ -e "$RELEASE_DIR/$item" ]] && OVERLAY_ITEMS+=("$item")
done
(( ${#OVERLAY_ITEMS[@]} > 0 )) || die "release contains none of the curated overlay paths"

FIND_PATHS=()
for item in "${OVERLAY_ITEMS[@]}"; do
  [[ ! -L "$RELEASE_DIR/$item" ]] || die "curated overlay path must not be a symlink: $item"
  if [[ -e "$TARGET_DIR/$item" && -L "$TARGET_DIR/$item" ]]; then
    die "target overlay path must not be a symlink: $item"
  fi
  FIND_PATHS+=("$RELEASE_DIR/$item")
done

unsafe_release_entry="$(
  find "${FIND_PATHS[@]}" \
    \( -type l -o \( ! -type f ! -type d \) \) -print -quit 2>/dev/null || true
)"
[[ -z "$unsafe_release_entry" ]] || die "release contains an unsafe overlay entry: $unsafe_release_entry"

"$PYTHON_BIN" "$VISUAL_TOOL" verify \
  --root "$TARGET_DIR" --manifest "$BOSS_VISUAL_MANIFEST"

# The stored target has just passed its existing baseline. Recapturing now
# upgrades legacy manifests and folds newly supported SVG/GIF assets plus
# dynamically discovered avatar/picker surfaces into the pre-overlay baseline.
"$PYTHON_BIN" "$VISUAL_TOOL" capture \
  --root "$TARGET_DIR" --manifest "$BOSS_VISUAL_MANIFEST"

mkdir -p -- "$BOSS_VISUAL_BACKUP_ROOT"
BACKUP_DIR="$BOSS_VISUAL_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
"$PYTHON_BIN" "$VISUAL_TOOL" backup \
  --root "$TARGET_DIR" --manifest "$BOSS_VISUAL_MANIFEST" --backup-dir "$BACKUP_DIR"

restore_visuals() {
  local reason="$1"
  printf 'safe overlay: %s; restoring target visuals from %s\n' "$reason" "$BACKUP_DIR" >&2
  if ! "$PYTHON_BIN" "$VISUAL_TOOL" restore \
      --root "$TARGET_DIR" --manifest "$BOSS_VISUAL_MANIFEST" --backup-dir "$BACKUP_DIR"; then
    printf 'safe overlay: automatic visual restore failed; backup retained at %s\n' "$BACKUP_DIR" >&2
    return 1
  fi
}

overlay_complete=0
handle_signal() {
  trap - HUP INT TERM
  if (( overlay_complete == 0 )); then
    restore_visuals "overlay interrupted" || true
  fi
  exit 130
}
trap handle_signal HUP INT TERM

TAR_EXCLUDES=(
  --exclude='.git' --exclude='*/.git' --exclude='*/.git/*'
  --exclude='.env' --exclude='.env.*' --exclude='*/.env' --exclude='*/.env.*'
  --exclude='docker-compose.yml' --exclude='docker-compose.override.yml'
  --exclude='compose.yml' --exclude='compose.override.yml'
  --exclude='ssh' --exclude='ssh/*' --exclude='*/ssh' --exclude='*/ssh/*'
  --exclude='.ssh' --exclude='.ssh/*' --exclude='*/.ssh' --exclude='*/.ssh/*'
  --exclude='auth' --exclude='auth/*' --exclude='*/auth' --exclude='*/auth/*'
  --exclude='credentials' --exclude='credentials/*' --exclude='*/credentials' --exclude='*/credentials/*'
  --exclude='secrets' --exclude='secrets/*' --exclude='*/secrets' --exclude='*/secrets/*'
  --exclude='.claude' --exclude='.claude/*' --exclude='*/.claude' --exclude='*/.claude/*'
  --exclude='.claude.json' --exclude='*/.claude.json'
  --exclude='.codex' --exclude='.codex/*' --exclude='*/.codex' --exclude='*/.codex/*'
  --exclude='data' --exclude='data/*' --exclude='*/data' --exclude='*/data/*'
  --exclude='state' --exclude='state/*' --exclude='*/state' --exclude='*/state/*'
  --exclude='sessions' --exclude='sessions/*' --exclude='*/sessions' --exclude='*/sessions/*'
  --exclude='storage' --exclude='storage/*' --exclude='*/storage' --exclude='*/storage/*'
  --exclude='volumes' --exclude='volumes/*' --exclude='*/volumes' --exclude='*/volumes/*'
  --exclude='workspace' --exclude='workspace/*' --exclude='*/workspace' --exclude='*/workspace/*'
  --exclude='workspaces' --exclude='workspaces/*' --exclude='*/workspaces' --exclude='*/workspaces/*'
  --exclude='hermes-workspace' --exclude='hermes-workspace/*' --exclude='*/hermes-workspace' --exclude='*/hermes-workspace/*'
  --exclude='claude-workspace' --exclude='claude-workspace/*' --exclude='*/claude-workspace' --exclude='*/claude-workspace/*'
  --exclude='*.pem' --exclude='*.key' --exclude='id_rsa' --exclude='id_ed25519'
  --exclude='node_modules' --exclude='*/node_modules' --exclude='*/node_modules/*'
)

if ! tar -C "$RELEASE_DIR" "${TAR_EXCLUDES[@]}" -cf - -- "${OVERLAY_ITEMS[@]}" \
    | tar -C "$TARGET_DIR" -xf -; then
  restore_visuals "curated file overlay failed" || true
  die "curated overlay did not complete; backup retained at $BACKUP_DIR"
fi

# Releases staged from Windows or another build host may carry permissive
# archive modes and a foreign UID. The target project ownership is the
# customer-owned convention, so normalize only the files that came from this
# release back to that owner and to conventional source/script modes.
TARGET_OWNER="$(stat -c '%u:%g' "$TARGET_DIR")" || die "could not read target ownership"
[[ "$TARGET_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || die "target ownership is invalid"
is_excluded_overlay_file() {
  case "$1" in
    .git|.git/*|*/.git|*/.git/*|.env|.env.*|*/.env|*/.env.*|\
    docker-compose.yml|docker-compose.override.yml|compose.yml|compose.override.yml|\
    ssh|ssh/*|*/ssh|*/ssh/*|.ssh|.ssh/*|*/.ssh|*/.ssh/*|\
    auth|auth/*|*/auth|*/auth/*|credentials|credentials/*|*/credentials|*/credentials/*|\
    secrets|secrets/*|*/secrets|*/secrets/*|.claude|.claude/*|*/.claude|*/.claude/*|\
    .claude.json|*/.claude.json|.codex|.codex/*|*/.codex|*/.codex/*|\
    data|data/*|*/data|*/data/*|state|state/*|*/state|*/state/*|\
    sessions|sessions/*|*/sessions|*/sessions/*|storage|storage/*|*/storage|*/storage/*|\
    volumes|volumes/*|*/volumes|*/volumes/*|workspace|workspace/*|*/workspace|*/workspace/*|\
    workspaces|workspaces/*|*/workspaces|*/workspaces/*|\
    hermes-workspace|hermes-workspace/*|*/hermes-workspace|*/hermes-workspace/*|\
    claude-workspace|claude-workspace/*|*/claude-workspace|*/claude-workspace/*|\
    *.pem|*.key|id_rsa|id_ed25519|node_modules|node_modules/*|*/node_modules|*/node_modules/*)
      return 0 ;;
    *) return 1 ;;
  esac
}
while IFS= read -r -d '' release_file; do
  relative="${release_file#"$RELEASE_DIR"/}"
  is_excluded_overlay_file "$relative" && continue
  target_file="$TARGET_DIR/$relative"
  [[ -f "$target_file" && ! -L "$target_file" ]] || die "overlaid file is missing or unsafe: $relative"
  chown "$TARGET_OWNER" "$target_file"
  case "$relative" in
    *.sh|*.py) chmod 0755 "$target_file" ;;
    *) chmod 0644 "$target_file" ;;
  esac
done < <(find "${FIND_PATHS[@]}" -type f -print0)

if ! "$PYTHON_BIN" "$VISUAL_TOOL" verify \
    --root "$TARGET_DIR" --manifest "$BOSS_VISUAL_MANIFEST"; then
  restore_visuals "visual drift detected" \
    || die "visual drift detected and automatic restore failed; backup retained at $BACKUP_DIR"
  die "visual drift detected; target visuals restored and backup retained at $BACKUP_DIR"
fi

overlay_complete=1
trap - HUP INT TERM
printf 'safe overlay complete; target visuals verified and backup retained at %s\n' "$BACKUP_DIR"
