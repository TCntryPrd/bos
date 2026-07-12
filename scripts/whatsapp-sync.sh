#!/usr/bin/env bash
# Background sync for WhatsApp messages sent from phone/desktop
# Runs every 30 seconds and syncs recent threads

set -euo pipefail

API_BASE="${BOSS_API_BASE:-http://localhost:8001}"
SYNC_INTERVAL="${WHATSAPP_SYNC_INTERVAL:-30}"

echo "WhatsApp sync daemon starting (interval: ${SYNC_INTERVAL}s)"

while true; do
  # Get all active threads from IR Custom AIOS DB
  THREADS=$(curl -s -H 'X-BOSS-Internal: true' \
    "${API_BASE}/api/whatsapp/threads" | \
    python3 -c "import json,sys; threads=json.load(sys.stdin).get('threads',[]); print('\n'.join([t['chat_id'] for t in threads[:10]]))" 2>/dev/null || echo "")

  if [ -n "$THREADS" ]; then
    echo "[$(date +%H:%M:%S)] Syncing $(echo "$THREADS" | wc -l) threads..."

    while IFS= read -r chat_id; do
      [ -z "$chat_id" ] && continue

      # Trigger sync for this thread
      RESULT=$(curl -s -X POST -H 'X-BOSS-Internal: true' \
        "${API_BASE}/api/whatsapp/threads/${chat_id}/sync" 2>/dev/null || echo '{"error":"failed"}')

      SYNCED=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('synced',0))" 2>/dev/null || echo "0")

      if [ "$SYNCED" -gt 0 ]; then
        echo "  ✓ ${chat_id}: synced ${SYNCED} messages"
      fi
    done <<< "$THREADS"
  fi

  sleep "$SYNC_INTERVAL"
done
