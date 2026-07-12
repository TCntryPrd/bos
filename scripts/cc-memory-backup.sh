#!/usr/bin/env bash
# cc-memory-backup.sh — daily encrypted backup of ~/.claude memory + config
# Schedule: 35 4 * * *  (4:35 UTC, after n8n export)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
[ -f "$PROJECT_DIR/.env" ] && { set -a; source "$PROJECT_DIR/.env"; set +a; }

source "$SCRIPT_DIR/lib/encrypt-helper.sh"
if [ -f "$SCRIPT_DIR/backup-status.sh" ]; then
    source "$SCRIPT_DIR/backup-status.sh"
else
    report_asset_success() { :; }
    report_asset_failure() { :; }
fi

MEMORY_REPO="${CC_MEMORY_REPO:-/home/tcntryprd/cc-memory}"
CONFIG_REPO="${CC_CONFIG_REPO:-/home/tcntryprd/cc-config}"
SOURCE_MEMORY="$HOME/.claude/projects/-home-tcntryprd--claude/memory"
SOURCE_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
SOURCE_OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
SOURCE_CLAUDE_SETTINGS="$HOME/.claude/settings.json"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

backup_one_repo() {
    local repo_dir="$1"
    local origin_url="$2"
    local asset_name="$3"
    local bundle_name="$4"
    shift 4
    local sources=("$@")

    mkdir -p "$repo_dir"
    cd "$repo_dir"
    if [ ! -d .git ]; then
        git init -q
        git remote add origin "$origin_url" 2>/dev/null || true
        git checkout -b main 2>/dev/null || true
    fi

    local bundle="$repo_dir/${bundle_name}-${TIMESTAMP}.tar.gz"
    local existing=()
    for s in "${sources[@]}"; do
        [ -e "$s" ] && existing+=("$s")
    done
    if [ ${#existing[@]} -eq 0 ]; then
        echo "$asset_name: no sources found, skipping"
        return 0
    fi

    tar -czf "$bundle" "${existing[@]}" 2>/dev/null
    local encrypted
    encrypted=$(encrypt_file "$bundle")
    echo "$asset_name: encrypted $(basename "$encrypted") ($(stat -c%s "$encrypted") bytes)"

    git add -A
    if git diff --cached --quiet; then
        echo "$asset_name: no changes"
        report_asset_success "$asset_name" "$encrypted"
    else
        git commit -q -m "$asset_name backup: $TIMESTAMP"
        if git push origin HEAD:main --quiet 2>&1; then
            report_asset_success "$asset_name" "$encrypted"
            echo "$asset_name: pushed to GitHub"
        else
            report_asset_failure "$asset_name" "git push failed"
            echo "  WARN: $asset_name push failed"
        fi
    fi
}

backup_one_repo \
    "$MEMORY_REPO" \
    "https://github.com/TCntryPrd/cc-memory.git" \
    "cc-memory" \
    "cc-memory" \
    "$SOURCE_MEMORY" "$SOURCE_CLAUDE_MD"

backup_one_repo \
    "$CONFIG_REPO" \
    "https://github.com/TCntryPrd/cc-config.git" \
    "cc-config" \
    "cc-config" \
    "$SOURCE_OPENCLAW_JSON" "$SOURCE_CLAUDE_SETTINGS"

echo "Done."
