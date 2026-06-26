#!/usr/bin/env bash
# WS4 — secret-safety gate. Exit 1 if any secret-like content or forbidden file
# is found. Run on the DISTRIBUTABLE tree before packaging, and in CI.
#   bash deploy/verify-no-secrets.sh [root]
# Note: run this on the packaged/exported tree (no .env, no apps/agent, no
# node_modules) — not a working copy that may hold a local .env.
set -uo pipefail
ROOT="${1:-.}"
fail=0

PAT='sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,}|sk-or-v1-[a-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
ALLOW='placeholder|__[A-Z0-9_]+__|YOUR_|<your|example|REDACTED|CHANGE_ME|xxxx'

echo "[secret-scan] root: $ROOT"

echo "== 1. forbidden files (real env/keys; *.env.example allowed) =="
BAD=$(find "$ROOT" -type f \( -name '.env' -o -name '*.env' -o -name '*.key' -o -name '*.pem' \
  -o -name 'id_rsa' -o -name 'id_ed25519' -o -name '*.p12' -o -name '*.pfx' \) \
  ! -name '*.env.example' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null)
if [ -n "$BAD" ]; then echo "  FAIL — forbidden files present:"; echo "$BAD" | sed 's/^/    /'; fail=1; else echo "  ok"; fi

echo "== 2. secret patterns in shipped content =="
HITS=$(grep -rIEn "$PAT" "$ROOT" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.cjs' --include='*.mjs' \
  --include='*.json' --include='*.sql' --include='*.sh' --include='*.md' --include='*.yml' --include='*.yaml' \
  --exclude='*.env.example' --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | grep -vEi "$ALLOW")
if [ -n "$HITS" ]; then echo "  FAIL — secret patterns:"; echo "$HITS" | head | sed 's/^/    /'; fail=1; else echo "  ok"; fi

echo "== 3. seed/agent prompts (covert leak vector) =="
PHITS=$(grep -rIEn "$PAT" "$ROOT"/deploy/seed*.sql "$ROOT"/agents 2>/dev/null | grep -vEi "$ALLOW")
if [ -n "$PHITS" ]; then echo "  FAIL — secrets in seeds/agents:"; echo "$PHITS" | head | sed 's/^/    /'; fail=1; else echo "  ok"; fi

echo "== 4. owner-specific identifiers (must not ship) =="
OHITS=$(grep -rIEn 'kevin@|starrpartners|travelcraft\.dc|absoluterecoverybureau|last-castle|vasari\.starrpartners' \
  "$ROOT"/deploy "$ROOT"/agents 2>/dev/null --exclude='verify-no-secrets.sh' | grep -vEi 'example')
if [ -n "$OHITS" ]; then echo "  WARN — owner-specific strings (review):"; echo "$OHITS" | head | sed 's/^/    /'; fi

echo "-----"
if [ "$fail" -eq 0 ]; then echo "[secret-scan] PASS"; exit 0; else echo "[secret-scan] FAIL — do NOT package"; exit 1; fi
