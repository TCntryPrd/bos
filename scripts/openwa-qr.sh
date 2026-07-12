#!/usr/bin/env bash
# Generate WhatsApp QR code HTML page from OpenWA
# Based on playbook: docs/playbooks/whatsapp-openwa.md

set -euo pipefail

OPENWA_API_KEY="owa_k1_28c9a7cf864c4608bfce9e70a6bf7d0aa5008bebfd4fadd688e678e36071a2a2"
OPENWA_SESSION_ID="932ccb22-8072-4bee-906c-0c1bae593a1f"
QR_HTML="/home/tcntryprd/boss-dev/apps/web/public/qr.html"
MAX_WAIT=120

echo "Waiting for OpenWA API to be ready (max ${MAX_WAIT}s)..."
waited=0
while [ $waited -lt $MAX_WAIT ]; do
  if curl -s -f "http://localhost:2785/" > /dev/null 2>&1; then
    echo "OpenWA API is responding"
    break
  fi
  sleep 2
  waited=$((waited + 2))
done

if [ $waited -ge $MAX_WAIT ]; then
  echo "ERROR: OpenWA API did not respond after ${MAX_WAIT}s"
  exit 1
fi

echo "Fetching QR code from OpenWA..."
QR_B64=$(curl -s -H "X-API-Key: $OPENWA_API_KEY" \
  "http://localhost:2785/${OPENWA_SESSION_ID}/qr" 2>&1 | \
  python3 -c "import json,sys; d=json.load(sys.stdin) if sys.stdin.read(1) else {}; sys.stdin.seek(0); print(d.get('qr','').replace('data:image/png;base64',''))" 2>/dev/null || echo "")

if [ -z "$QR_B64" ]; then
  echo "ERROR: Could not get QR code from OpenWA"
  echo "The session may already be authenticated, or the API isn't ready yet."
  echo ""
  echo "Check session status with:"
  echo "  curl -H 'X-API-Key: $OPENWA_API_KEY' http://localhost:2785/${OPENWA_SESSION_ID}"
  exit 1
fi

echo "Generating QR HTML page..."
cat > "$QR_HTML" << EOF
<!DOCTYPE html>
<html>
<head><title>WhatsApp QR</title>
<style>body{background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;color:#fff;font-family:sans-serif}
img{width:300px;height:300px;image-rendering:pixelated;border:4px solid #25d366;border-radius:8px;margin-bottom:20px}
p{text-align:center;max-width:400px;line-height:1.6}</style>
</head>
<body>
<img src="data:image/png;base64,${QR_B64}">
<p>Scan this QR code with WhatsApp on your phone:<br><strong>WhatsApp → Linked Devices → Link a Device</strong></p>
<p style="color:#888;font-size:12px">QR code expires in ~60 seconds. Refresh if needed.</p>
</body>
</html>
EOF

echo "✓ QR HTML page created at: $QR_HTML"
echo ""
echo "Open in your browser:"
echo "  https://last-castle.daggertooth-larch.ts.net/boss/ui/qr.html"
echo ""
echo "After scanning, verify authentication:"
echo "  curl -H 'X-API-Key: $OPENWA_API_KEY' http://localhost:2785/${OPENWA_SESSION_ID}"
echo ""
echo "Then remove the QR page:"
echo "  rm $QR_HTML"
