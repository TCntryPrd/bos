#!/usr/bin/env bash
# Create a one-time curated Hermes code sandbox without touching the live tree.
# Existing sandboxes are deliberately left intact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET="${HERMES_SANDBOX_DIR:-$PROJECT_DIR/hermes-workspace/boss-dev}"
OWNER_UID="${HERMES_SANDBOX_UID:-100}"
OWNER_GID="${HERMES_SANDBOX_GID:-101}"

fail() { printf '[hermes-sandbox] ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$TARGET" == /* && "$TARGET" != / ]] || fail "sandbox target must be an absolute non-root path"
[[ "$OWNER_UID" =~ ^[0-9]+$ && "$OWNER_GID" =~ ^[0-9]+$ ]] || fail "sandbox owner must be numeric"
if [[ -e "$TARGET" ]]; then
  printf '[hermes-sandbox] Existing sandbox preserved: %s\n' "$TARGET"
  exit 0
fi

PARENT="$(dirname "$TARGET")"
install -d -m 0750 "$PARENT"
TEMP_DIR="$(mktemp -d "$PARENT/.boss-dev.new.XXXXXX")"

entries=()
for entry in apps packages services host scripts deploy package.json package-lock.json pnpm-lock.yaml \
  pnpm-workspace.yaml yarn.lock tsconfig.json turbo.json README.md CLAUDE.md; do
  [[ -e "$PROJECT_DIR/$entry" ]] && entries+=("$entry")
done
[[ ${#entries[@]} -gt 0 ]] || fail "no curated project files were found"

tar -C "$PROJECT_DIR" \
  --exclude='.git' --exclude='*/.git' \
  --exclude='.env' --exclude='*/.env' --exclude='*/.env.*' \
  --exclude='.ssh' --exclude='*/.ssh' --exclude='*.pem' --exclude='*.key' \
  --exclude='auth' --exclude='*/auth' --exclude='credentials' --exclude='*/credentials' \
  --exclude='secrets' --exclude='*/secrets' --exclude='sessions' --exclude='*/sessions' \
  --exclude='claude-home' --exclude='codex-home' --exclude='hermes-home' --exclude='hermes-workspace' \
  --exclude='data' --exclude='*/data' --exclude='state' --exclude='*/state' \
  --exclude='storage' --exclude='*/storage' --exclude='volumes' --exclude='*/volumes' \
  --exclude='.boss-agent-runtime' --exclude='*/.boss-agent-runtime' \
  -cf - "${entries[@]}" | tar -C "$TEMP_DIR" -xf -

chown -R "$OWNER_UID:$OWNER_GID" "$TEMP_DIR"
chmod -R u=rwX,g=rX,o= "$TEMP_DIR"
mv -T "$TEMP_DIR" "$TARGET"
printf '[hermes-sandbox] Curated sandbox created: %s\n' "$TARGET"
