#!/usr/bin/env bash
# n8n-workflow-export.sh — daily encrypted dump of all n8n workflows
# Schedule: 30 4 * * *  (4:30 UTC, after main backup)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
[ -f "$PROJECT_DIR/.env" ] && { set -a; source "$PROJECT_DIR/.env"; set +a; }

source "$SCRIPT_DIR/lib/encrypt-helper.sh"
# backup-status helpers (created in Task 8). Sourced if available; report calls are no-ops otherwise.
if [ -f "$SCRIPT_DIR/backup-status.sh" ]; then
    source "$SCRIPT_DIR/backup-status.sh"
else
    report_asset_success() { :; }
    report_asset_failure() { :; }
fi

ARCHIVE_DIR="${N8N_ARCHIVE_DIR:-/home/tcntryprd/n8n-workflow-archive}"
N8N_CONTAINER="${N8N_CONTAINER:-n8n}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DATE_DIR=$(date +%Y%m%d)

mkdir -p "$ARCHIVE_DIR/workflows" "$ARCHIVE_DIR/logs"
LOGFILE="$ARCHIVE_DIR/logs/export-$DATE_DIR.log"
exec > >(tee -a "$LOGFILE") 2>&1
echo "============================================"
echo "n8n workflow export — $TIMESTAMP"
echo "============================================"

BUNDLE="$ARCHIVE_DIR/workflows/n8n-workflows-$DATE_DIR.json"
{
    echo '{'
    echo '  "exported_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
    echo '  "workflows": ['
    first=1
    docker exec "$N8N_CONTAINER" n8n list:workflow 2>/dev/null | tail -n +2 | while read -r line; do
        id=$(echo "$line" | awk -F'|' '{print $1}' | xargs)
        [ -z "$id" ] && continue
        if [ "$first" = "1" ]; then first=0; else echo ','; fi
        docker exec "$N8N_CONTAINER" n8n export:workflow --id="$id" --pretty 2>/dev/null \
            || echo '{}'
    done
    echo
    echo '  ]'
    echo '}'
} > "$BUNDLE"

count=$(grep -c '"id"' "$BUNDLE" 2>/dev/null || echo 0)
size=$(stat -c%s "$BUNDLE")
echo "Exported $count workflows, $size bytes"

encrypted=$(encrypt_file "$BUNDLE")
echo "Encrypted: $(basename "$encrypted")"

cd "$ARCHIVE_DIR"
if [ ! -d .git ]; then
    git init -q
    git remote add origin "https://github.com/TCntryPrd/n8n-workflow-archive.git" 2>/dev/null || true
    git checkout -b main 2>/dev/null || true
fi
git add -A workflows/ logs/
if git diff --cached --quiet; then
    echo "No changes since last export"
    report_asset_success "n8n" "$encrypted"
else
    git commit -q -m "n8n-export: $TIMESTAMP ($count workflows)"
    if git push origin HEAD:main --quiet 2>&1; then
        report_asset_success "n8n" "$encrypted"
        echo "Pushed to GitHub"
    else
        report_asset_failure "n8n" "git push failed"
        echo "  WARN: push failed (will retry next run)"
    fi
fi

# Plaintext bundle was deleted by encrypt_file; sweep any orphan json
find "$ARCHIVE_DIR/workflows/" -name '*.json' -mtime +0 -delete 2>/dev/null || true

echo "Done."
