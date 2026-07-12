#!/usr/bin/env bash
# Stage a BOS owner invite: generates a passkey, stores only its hash,
# prints the passkey + setup link. Run from the BOS install dir.
set -euo pipefail
EMAIL="${1:?Usage: stage-invite.sh owner@email.com [days-valid (default 7)]}"
DAYS="${2:-7}"
KEY="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ' | cut -c1-9)"
while [ "${#KEY}" -lt 9 ]; do KEY="${KEY}$((RANDOM % 10))"; done
HASH="$(printf '%s' "$KEY" | sha256sum | cut -d' ' -f1)"
docker compose exec -T postgres psql -U boss -d boss_ir -c \
  "DELETE FROM boss_pending_passkeys WHERE email='$EMAIL';
   INSERT INTO boss_pending_passkeys (email, passkey_hash, created_at, expires_at)
   VALUES ('$EMAIL', '$HASH', now(), now() + interval '$DAYS days')" >/dev/null
DOMAIN="$(grep -oE 'Host\(`[^`]+`\)' docker-compose.yml | head -1 | sed -E 's/Host\(`([^`]+)`\)/\1/')"
echo "Invite staged for $EMAIL (expires in $DAYS days)"
echo "  Passkey:    $KEY"
echo "  Setup link: https://${DOMAIN}/#/onboarding?email=${EMAIL}&passkey=${KEY}"
