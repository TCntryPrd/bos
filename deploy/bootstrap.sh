#!/usr/bin/env bash
# One-line bootstrap:  curl -fsSL <raw-url>/deploy/bootstrap.sh | bash
set -euo pipefail
REPO="${BOS_REPO:-https://github.com/TCntryPrd/bos.git}"
DIR="${BOS_DIR:-bos}"
[ -d "$DIR/.git" ] && (cd "$DIR" && git pull) || git clone "$REPO" "$DIR"
cd "$DIR"
exec bash deploy/install.sh "$@"
