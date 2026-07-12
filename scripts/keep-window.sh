#!/usr/bin/env bash
# Keep the 5-hour Claude rate limit window on a predictable rotation.
# Sends a minimal "Hi" to the IR Custom AIOS API brain (Haiku) to register activity.
curl -sf -X POST http://127.0.0.1:8010/api/brain/chat \
  -H "X-BOSS-Internal: true" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hi","conversationId":"window-keepalive","model":"claude-haiku-4-5"}' \
  > /dev/null 2>&1
echo "[$(date -Iseconds)] Window keepalive sent" >> /tmp/window-keepalive.log
