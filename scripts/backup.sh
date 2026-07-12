#!/usr/bin/env bash
# IR Custom AIOS v2 — Encrypted Backup System
# Dual authentication: Layer 1 (destination access) + Layer 2 (AES-256 per file)
# Usage: ./backup.sh [--type full|postgres|weaviate] [--dest git|s3|both]

set -euo pipefail

# ============================================================================
# Configuration (from environment or .env)
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
    set -a; source "$PROJECT_DIR/.env"; set +a
fi

BACKUP_TYPE="${1:---type}"
if [ "$BACKUP_TYPE" = "--type" ]; then
    BACKUP_TYPE="${2:-full}"
fi

BACKUP_DEST_ARG="${3:---dest}"
if [ "$BACKUP_DEST_ARG" = "--dest" ]; then
    BACKUP_DEST_VALUE="${4:-${BACKUP_DEST:-git}}"
else
    BACKUP_DEST_VALUE="${BACKUP_DEST:-git}"
fi

# Parse flags properly
while [[ $# -gt 0 ]]; do
    case $1 in
        --type) BACKUP_TYPE="$2"; shift 2 ;;
        --dest) BACKUP_DEST_VALUE="$2"; shift 2 ;;
        *) shift ;;
    esac
done

BACKUP_DIR="${BACKUP_DIR:-/var/lib/boss-backups}"
USB_MIRROR_DIR="${USB_MIRROR_DIR:-/mnt/usb-backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-15}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

# Source helpers (split, mirror, encrypt, status)
source "$SCRIPT_DIR/lib/backup-split.sh"
source "$SCRIPT_DIR/lib/backup-mirror.sh"
source "$SCRIPT_DIR/lib/encrypt-helper.sh"
source "$SCRIPT_DIR/backup-status.sh"

# Database connection
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-boss}"
DB_NAME="${POSTGRES_DB:-boss_db}"
DB_PASSWORD="${POSTGRES_PASSWORD:-bosspass}"

# Weaviate
WEAVIATE_URL="${WEAVIATE_URL:-http://localhost:8080}"

echo "============================================"
echo "IR Custom AIOS v2 — Backup System"
echo "Type: $BACKUP_TYPE | Dest: $BACKUP_DEST_VALUE"
echo "Timestamp: $TIMESTAMP"
echo "============================================"

# ============================================================================
# Validation
# ============================================================================
if [ -z "$ENCRYPTION_KEY" ]; then
    echo "ERROR: BACKUP_ENCRYPTION_KEY is required (Layer 2 auth)"
    echo "Generate one: openssl rand -hex 32"
    exit 1
fi

if [ ${#ENCRYPTION_KEY} -lt 32 ]; then
    echo "ERROR: BACKUP_ENCRYPTION_KEY must be at least 32 characters (AES-256)"
    exit 1
fi

mkdir -p "$BACKUP_DIR"

# ============================================================================
# Layer 2: AES-256 Encryption — see scripts/lib/encrypt-helper.sh
# ============================================================================

# ============================================================================
# Postgres Backup
# ============================================================================
backup_postgres() {
    echo ""
    echo "--- Postgres Backup ---"
    local dump_file="$BACKUP_DIR/boss_pg_${TIMESTAMP}.sql.gz"

    PGPASSWORD="$DB_PASSWORD" pg_dump \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        --no-owner \
        --no-privileges \
        --clean \
        --if-exists \
        | gzip > "$dump_file"

    local size=$(stat -f%z "$dump_file" 2>/dev/null || stat -c%s "$dump_file" 2>/dev/null || echo "unknown")
    echo "  Dump size: $size bytes"

    local encrypted=$(encrypt_file "$dump_file")
    echo "  Encrypted: $(basename "$encrypted")"
    echo "$encrypted"
}

# ============================================================================
# Weaviate Backup
# ============================================================================
backup_weaviate() {
    echo ""
    echo "--- Weaviate Backup ---"
    local backup_id="boss_wv_${TIMESTAMP}"
    local export_dir="$BACKUP_DIR/$backup_id"
    mkdir -p "$export_dir"

    # Get all collections
    local collections=$(curl -sf "$WEAVIATE_URL/v1/schema" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data.get('classes', []):
    print(c['class'])
" 2>/dev/null || echo "")

    if [ -z "$collections" ]; then
        echo "  No Weaviate collections found or Weaviate unreachable"
        # Create a marker file so we still have a backup record
        echo '{"status": "empty", "timestamp": "'"$TIMESTAMP"'"}' > "$export_dir/manifest.json"
    else
        for collection in $collections; do
            echo "  Exporting collection: $collection"
            # Export objects via scroll API
            local cursor=""
            local page=0
            local output_file="$export_dir/${collection}.jsonl"
            > "$output_file"

            while true; do
                local url="$WEAVIATE_URL/v1/objects?class=$collection&limit=100"
                [ -n "$cursor" ] && url="${url}&after=$cursor"

                local response=$(curl -sf "$url" 2>/dev/null || echo '{"objects":[]}')
                local count=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('objects',[])))" 2>/dev/null || echo "0")

                if [ "$count" = "0" ] || [ "$count" = "" ]; then
                    break
                fi

                echo "$response" >> "$output_file"
                cursor=$(echo "$response" | python3 -c "
import json, sys
d = json.load(sys.stdin)
objs = d.get('objects', [])
if objs:
    print(objs[-1].get('id', ''))
" 2>/dev/null || echo "")
                page=$((page + 1))

                [ -z "$cursor" ] && break
                [ $page -gt 1000 ] && break  # safety limit
            done

            local obj_count=$(wc -l < "$output_file" 2>/dev/null || echo "0")
            echo "    Exported $obj_count pages"
        done
    fi

    # Tar and compress
    local tar_file="$BACKUP_DIR/${backup_id}.tar.gz"
    tar -czf "$tar_file" -C "$BACKUP_DIR" "$backup_id"
    rm -rf "$export_dir"

    local encrypted=$(encrypt_file "$tar_file")
    echo "  Encrypted: $(basename "$encrypted")"
    echo "$encrypted"
}

# ============================================================================
# Layer 1: Destination Upload — Git
# ============================================================================
upload_git() {
    local file="$1"
    local filename=$(basename "$file")

    echo "  Uploading to Git: $filename"

    local git_repo="${BACKUP_GIT_REPO:-}"
    local git_branch="${BACKUP_GIT_BRANCH:-backups}"

    if [ -z "$git_repo" ]; then
        echo "  ERROR: BACKUP_GIT_REPO not set"
        return 1
    fi

    local git_dir="$BACKUP_DIR/.git-backup-repo"

    if [ ! -d "$git_dir/.git" ]; then
        git clone --depth 1 -b "$git_branch" "$git_repo" "$git_dir" 2>/dev/null || {
            git clone "$git_repo" "$git_dir"
            cd "$git_dir"
            git checkout -b "$git_branch"
            cd - > /dev/null
        }
    else
        cd "$git_dir"
        git pull --rebase 2>/dev/null || true
        cd - > /dev/null
    fi

    # Stage file in the git workdir, splitting if oversize (>90MB)
    cp "$file" "$git_dir/$filename"
    cd "$git_dir"

    local staged_files
    staged_files=$(split_if_large "$git_dir/$filename")

    while IFS= read -r staged; do
        [ -z "$staged" ] && continue
        git add "$(basename "$staged")"
    done <<< "$staged_files"

    git commit -m "Backup: $filename" --quiet 2>/dev/null || true
    git push origin "$git_branch" --quiet
    cd - > /dev/null

    local part_count
    part_count=$(echo "$staged_files" | wc -l)
    echo "  Pushed to $git_branch (chunks: $part_count)"
}

# ============================================================================
# Layer 1: Destination Upload — S3
# ============================================================================
upload_s3() {
    local file="$1"
    local filename=$(basename "$file")

    echo "  Uploading to S3: $filename"

    local bucket="${BACKUP_S3_BUCKET:-}"
    local region="${BACKUP_S3_REGION:-us-east-1}"

    if [ -z "$bucket" ]; then
        echo "  ERROR: BACKUP_S3_BUCKET not set"
        return 1
    fi

    if command -v aws &>/dev/null; then
        AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-}" \
        AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-}" \
        aws s3 cp "$file" "s3://$bucket/boss-backups/$filename" \
            --region "$region" --quiet
    else
        echo "  ERROR: aws CLI not found. Install: pip install awscli"
        return 1
    fi

    echo "  Uploaded to s3://$bucket/boss-backups/$filename"
}

# ============================================================================
# Upload to destination(s)
# ============================================================================
upload_backup() {
    local file="$1"

    case "$BACKUP_DEST_VALUE" in
        git)  upload_git "$file" ;;
        s3)   upload_s3 "$file" ;;
        both)
            upload_git "$file"
            upload_s3 "$file"
            ;;
        *)
            echo "  Unknown destination: $BACKUP_DEST_VALUE"
            return 1
            ;;
    esac
}

# ============================================================================
# Retention: Auto-delete old backups
# ============================================================================
cleanup_old_backups() {
    echo ""
    echo "--- Cleanup (retention: ${RETENTION_DAYS} days) ---"

    # Local cleanup
    local deleted=0
    find "$BACKUP_DIR" -name "boss_*.enc" -type f -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | while read f; do
        echo "  Deleted: $(basename "$f")"
        deleted=$((deleted + 1))
    done

    # S3 cleanup (if using S3)
    if [ "$BACKUP_DEST_VALUE" = "s3" ] || [ "$BACKUP_DEST_VALUE" = "both" ]; then
        if command -v aws &>/dev/null && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
            local cutoff_date=$(date -d "-${RETENTION_DAYS} days" +%Y-%m-%d 2>/dev/null || date -v "-${RETENTION_DAYS}d" +%Y-%m-%d 2>/dev/null || echo "")
            if [ -n "$cutoff_date" ]; then
                echo "  S3 cleanup: removing files older than $cutoff_date"
                AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-}" \
                AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-}" \
                aws s3 ls "s3://${BACKUP_S3_BUCKET}/boss-backups/" --region "${BACKUP_S3_REGION:-us-east-1}" 2>/dev/null \
                | while read -r line; do
                    local file_date=$(echo "$line" | awk '{print $1}')
                    local file_name=$(echo "$line" | awk '{print $4}')
                    if [[ "$file_date" < "$cutoff_date" ]] && [ -n "$file_name" ]; then
                        echo "    Deleting S3: $file_name"
                        AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-}" \
                        AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-}" \
                        aws s3 rm "s3://${BACKUP_S3_BUCKET}/boss-backups/$file_name" \
                            --region "${BACKUP_S3_REGION:-us-east-1}" --quiet 2>/dev/null || true
                    fi
                done
            fi
        fi
    fi

    echo "  Cleanup complete"
}

# ============================================================================
# Run Backup
# ============================================================================
BACKUP_FILES=()

case "$BACKUP_TYPE" in
    postgres)
        result=$(backup_postgres)
        file=$(echo "$result" | tail -1)
        BACKUP_FILES+=("$file")
        ;;
    weaviate)
        result=$(backup_weaviate)
        file=$(echo "$result" | tail -1)
        BACKUP_FILES+=("$file")
        ;;
    full)
        result_pg=$(backup_postgres)
        file_pg=$(echo "$result_pg" | tail -1)
        BACKUP_FILES+=("$file_pg")

        result_wv=$(backup_weaviate)
        file_wv=$(echo "$result_wv" | tail -1)
        BACKUP_FILES+=("$file_wv")
        ;;
    *)
        echo "ERROR: Unknown backup type: $BACKUP_TYPE"
        echo "Usage: $0 --type [full|postgres|weaviate] --dest [git|s3|both]"
        exit 1
        ;;
esac

# Upload each backup file (with status reporting)
echo ""
echo "--- Uploading to $BACKUP_DEST_VALUE ---"
for file in "${BACKUP_FILES[@]}"; do
    if [ -f "$file" ]; then
        # Derive asset label from filename
        bn=$(basename "$file")
        case "$bn" in
            boss_pg_*) asset="postgres" ;;
            boss_wv_*) asset="weaviate" ;;
            *)           asset="unknown" ;;
        esac
        if upload_backup "$file"; then
            report_asset_success "$asset" "$file"
        else
            report_asset_failure "$asset" "upload to $BACKUP_DEST_VALUE failed"
        fi
    fi
done

# Run retention cleanup
cleanup_old_backups

# Layer 3: USB local mirror (best-effort, non-fatal)
if [ -n "${USB_MIRROR_DIR:-}" ] && [ -d "$USB_MIRROR_DIR" ]; then
    echo ""
    echo "--- USB Mirror ---"
    mirror_to_usb "$BACKUP_DIR" "$USB_MIRROR_DIR" || \
        echo "  [usb-mirror] continuing despite USB mirror failure"
fi

echo ""
echo "============================================"
echo "Backup complete: $TIMESTAMP"
echo "Files: ${#BACKUP_FILES[@]}"
echo "============================================"
