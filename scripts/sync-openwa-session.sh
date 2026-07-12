#!/usr/bin/env bash
# Sync OpenWA session data from local box to VPS
# Run this on the VPS to pull authenticated session from local

set -euo pipefail

LOCAL_HOST="${1:-localhost}"
SESSION_ID="932ccb22-8072-4bee-906c-0c1bae593a1f"

echo "Syncing OpenWA session from $LOCAL_HOST..."

# Stop VPS OpenWA container
echo "Stopping VPS OpenWA container..."
docker stop boss_openwa 2>/dev/null || true

# Export session data from local box
echo "Exporting session data from local box..."
ssh "$LOCAL_HOST" "docker run --rm -v boss-v2_openwa_data:/data -v /tmp:/backup alpine tar czf /backup/openwa-session.tar.gz -C /data ." || {
  echo "Failed to export from local box. Make sure:"
  echo "  1. SSH access to local box is configured"
  echo "  2. Local OpenWA container is running with volume boss-v2_openwa_data"
  exit 1
}

# Copy tarball from local to VPS
echo "Copying session data..."
scp "$LOCAL_HOST:/tmp/openwa-session.tar.gz" /tmp/ || {
  echo "Failed to copy session data"
  exit 1
}

# Import into VPS volume
echo "Importing session data to VPS..."
docker run --rm -v boss-v2_openwa_data:/data -v /tmp:/backup alpine tar xzf /backup/openwa-session.tar.gz -C /data || {
  echo "Failed to import session data"
  exit 1
}

# Cleanup
rm -f /tmp/openwa-session.tar.gz
ssh "$LOCAL_HOST" "rm -f /tmp/openwa-session.tar.gz"

# Start VPS OpenWA container
echo "Starting VPS OpenWA container..."
cd /home/tcntryprd/boss-dev
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up -d openwa

echo "✓ Session sync complete! Waiting for OpenWA to initialize..."
sleep 10
docker logs boss_openwa --tail 20

echo ""
echo "Check session status with:"
echo "  curl -H 'X-BOSS-Internal: true' http://localhost:8001/api/whatsapp/threads"
