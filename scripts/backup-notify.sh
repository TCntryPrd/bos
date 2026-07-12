#!/bin/bash
# vD.1.1 — Nightly backup summary notification
#
# Reads status.json and sends a one-line green/red summary to Telegram.
# Cron: 40 4 * * * (runs after backup.sh at 04:00 and n8n/cc at 04:30-35)
#
# Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS_FILE="/var/lib/boss-backups/status.json"

# Load env
if [ -f "$SCRIPT_DIR/../.env" ]; then
    export $(grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' "$SCRIPT_DIR/../.env" 2>/dev/null | xargs)
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "[backup-notify] Telegram not configured — skipping"
    exit 0
fi

if [ ! -f "$STATUS_FILE" ]; then
    MSG="🔴 Backup status unknown — status.json missing"
else
    # Parse with python
    MSG=$(python3 -c "
import json, sys
from datetime import datetime, timezone

with open('$STATUS_FILE') as f:
    d = json.load(f)

now = datetime.now(timezone.utc)
assets = []
all_ok = True
for name, info in d.items():
    if name.startswith('_') or not isinstance(info, dict):
        continue
    ls = info.get('last_success', '')
    if ls:
        age_h = (now - datetime.fromisoformat(ls.replace('Z', '+00:00'))).total_seconds() / 3600
        icon = '✅' if age_h < 25 else '⚠️'
        if age_h >= 25: all_ok = False
        assets.append(f'{icon} {name}: {age_h:.0f}h ago')
    else:
        all_ok = False
        assets.append(f'❌ {name}: never')

status = '🟢 All backups healthy' if all_ok else '🔴 Backup issues detected'
print(f'{status}\n' + '\n'.join(assets))
" 2>/dev/null || echo "🔴 Backup status parse error")
fi

# Send to Telegram
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=${MSG}" \
    -d "parse_mode=HTML" \
    >/dev/null 2>&1

echo "[backup-notify] Sent: $(echo "$MSG" | head -1)"
