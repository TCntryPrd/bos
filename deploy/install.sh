#!/usr/bin/env bash
# =============================================================================
# BOS — installer. Works white-glove (operator on a user's VPS) and self-serve.
#   • Detects Traefik → serves over HTTPS through it; else publishes a host port.
#   • Schema is applied by the `migrate` init service on every `up` (idempotent,
#     additive) — NOT the old initdb hook. So rebuilds/repairs are bulletproof.
#   • VERIFIES the table count at the end and FAILS LOUDLY if the schema is short.
# Run from the unpacked BOS directory:  bash deploy/install.sh
# =============================================================================
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
EXPECTED_TABLES="${BOS_EXPECTED_TABLES:-85}"
say(){ printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok(){  printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
gen(){ openssl rand -hex 24 2>/dev/null || head -c18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9'; }

# ---- access gate (password-gated install; repo can be public) ----------------
PWD_IN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pwd) PWD_IN="${2:-}"; shift 2 2>/dev/null || shift ;;
    --pwd=*) PWD_IN="${1#--pwd=}"; shift ;;
    *) shift ;;
  esac
done
EXPECTED_PWD_HASH="fe5b291a1375914ff2b2b5d33bdf988b56289891d60371767120f42c6bf22cfa"
GOT_HASH="$(printf '%s' "$PWD_IN" | sha256sum 2>/dev/null | cut -d' ' -f1)"
[ "$GOT_HASH" = "$EXPECTED_PWD_HASH" ] || die "Access password required. Re-run with:  --pwd <password>   (get it from Industry Rockstar)."
ok "Access verified."


# ---- .env (generated secrets; never shipped) --------------------------------
if [ ! -f .env ]; then
  say "Generating .env (fresh secrets)"
  cp deploy/env.template .env
  PW="$(gen)"; JWT="$(gen)"; SESS="$(gen)"; ENC="$(openssl rand -base64 32 2>/dev/null | tr -d '\n')"
  TID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')"
  sed -i "s|__POSTGRES_PASSWORD__|${PW}|g" .env 2>/dev/null || true
  for kv in "POSTGRES_PASSWORD=${PW}" "BOSS_JWT_SECRET=${JWT}" "BOSS_SESSION_SECRET=${SESS}" \
            "BOSS_TOKEN_ENCRYPTION_KEY=${ENC}" "DEFAULT_TENANT_ID=${TID}"; do
    k="${kv%%=*}"; grep -q "^${k}=" .env && sed -i "s|^${k}=.*|${kv}|" .env || echo "$kv" >> .env
  done
fi

# ---- Traefik detection → HTTPS, else direct port ----------------------------
rm -f docker-compose.override.yml
if docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -qiE 'traefik'; then
  say "Traefik detected — BOS will be served over HTTPS"
  read -rp "  Domain for BOS (its DNS A-record must point at this server, e.g. bos.example.com): " DOM
  [ -n "${DOM:-}" ] || die "A domain is required to serve through Traefik."
  CR="${TRAEFIK_CERTRESOLVER:-letsencrypt}"
  cat > docker-compose.override.yml <<YAML
services:
  web:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.bos.rule=Host(\`${DOM}\`)"
      - "traefik.http.routers.bos.entrypoints=websecure"
      - "traefik.http.routers.bos.tls.certresolver=${CR}"
      - "traefik.http.services.bos.loadbalancer.server.port=80"
YAML
  sed -i '/^WEB_BIND=/d;/^WEB_PORT=/d' .env; { echo "WEB_BIND=127.0.0.1"; echo "WEB_PORT=18015"; } >> .env
  ACCESS="https://${DOM}"
else
  PORT="${WEB_PORT:-8080}"
  say "No Traefik — serving the web UI directly on port ${PORT}"
  sed -i '/^WEB_BIND=/d;/^WEB_PORT=/d' .env; { echo "WEB_BIND=0.0.0.0"; echo "WEB_PORT=${PORT}"; } >> .env
  ACCESS="http://<this-server-ip>:${PORT}"
fi

# ---- build + up (migrate init service applies the COMPLETE schema first) -----
say "Building images"; docker compose build
say "Starting BOS (schema auto-reconciles before the app) ..."; docker compose up -d

say "Waiting for the API to be healthy"
for i in $(seq 1 90); do
  docker compose exec -T api wget -qO- http://127.0.0.1:8001/health >/dev/null 2>&1 && { ok "API healthy"; break; }
  sleep 2; [ "$i" = 90 ] && die "API did not become healthy — check 'docker compose logs api'."
done

# ---- seed Employee Agents (idempotent) --------------------------------------
say "Seeding Employee Agents"
docker compose exec -T postgres psql -U boss -d boss_ir < deploy/seed-agents.sql >/dev/null 2>&1 || true
[ -f deploy/seed.sql ] && docker compose exec -T postgres psql -U boss -d boss_ir < deploy/seed.sql >/dev/null 2>&1 || true

# ---- VERIFY schema (the gate that ends the "still no schema" era) ------------
say "Verifying schema completeness"
TC="$(docker compose exec -T postgres psql -U boss -d boss_ir -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'" | tr -d '[:space:]')"
[ "${TC:-0}" -ge "$EXPECTED_TABLES" ] || die "SCHEMA INCOMPLETE: ${TC:-0}/${EXPECTED_TABLES} tables — install FAILED. Run: docker compose logs migrate"
ok "Schema complete: ${TC} tables"

printf '\n\033[1;32m════════════════════════════════════════════\033[0m\n'
ok "BOS is installed and running."
printf '   Open:  %s\n' "$ACCESS"
printf '   Brain runs on Gemini out of the box; run deploy/claude-login.sh to upgrade to Claude.\n\n'
