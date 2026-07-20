#!/usr/bin/env bash
# BOS — Business Operating System: single-box installer.
# Run as root on a fresh Ubuntu VPS with DNS for $DOMAIN already pointed here.
#
# Usage:
#   DOMAIN=client.example.com OPERATOR_NAME="Jane Smith" ./install-bos.sh
#
# What it does: unpacks alongside this script's repo checkout, generates
# secrets, wires Traefik (with Let's Encrypt), initializes the database,
# installs the Hermes Agent into a persistent mount, applies the security
# baseline, and brings the stack up. Customer keys are NEVER part of this —
# the owner enters their own keys in the Setup wizard after install.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN=your.domain.tld}"
: "${OPERATOR_NAME:?Set OPERATOR_NAME=\"Full Name\" (the BOS owner)}"
INSTALL_DIR="${INSTALL_DIR:-/docker/bos}"
ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"
BOSS_AGENT_USER="${BOSS_AGENT_USER:-bosops}"
BOSS_VISUAL_MANIFEST="${BOSS_VISUAL_MANIFEST:-/var/lib/boss/visual-baseline.json}"
BOSS_MEMORY_DEVICE_ID="${BOSS_MEMORY_DEVICE_ID:-$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-' | sed 's/^-//;s/-$//')}"
POSTGRES_READY_TIMEOUT="${POSTGRES_READY_TIMEOUT:-180}"
API_READY_TIMEOUT="${API_READY_TIMEOUT:-300}"

say()  { printf '\033[0;36m[bos-install]\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m[bos-install] FATAL:\033[0m %s\n' "$*"; exit 1; }

# ── 0. Prereqs ───────────────────────────────────────────────────────────
[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "run the installer as root"
command -v docker >/dev/null || fail "Docker is required (curl -fsSL https://get.docker.com | sh)"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"
command -v python3 >/dev/null || fail "python3 is required"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "DOMAIN is not a valid hostname"
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != / && "$INSTALL_DIR" != *[[:space:]]* ]] \
  || fail "INSTALL_DIR must be an absolute non-root path without whitespace"
[[ "$POSTGRES_READY_TIMEOUT" =~ ^[0-9]+$ && "$API_READY_TIMEOUT" =~ ^[0-9]+$ ]] \
  || fail "readiness timeouts must be whole seconds"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO_DIR/docker-compose.yml" ] || fail "run from inside the unpacked BOS release (deploy/install-bos.sh)"
for required in deploy/env.template deploy/schema.sql deploy/install-agent-runtime.sh \
  deploy/bootstrap-runtime-env.sh deploy/compose-runtime.sh deploy/docker-compose.agent-runtime.yml \
  deploy/ensure-memory-gateway-route.py; do
  [[ -f "$REPO_DIR/$required" ]] || fail "release file is missing: $required"
done

# ── 1. Place the repo ────────────────────────────────────────────────────
say "Installing BOS to $INSTALL_DIR for domain $DOMAIN"
mkdir -p "$(dirname "$INSTALL_DIR")"
if [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
  [ -e "$INSTALL_DIR" ] && fail "$INSTALL_DIR already exists — refusing to overwrite"
  cp -a "$REPO_DIR" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
bos_compose() { bash "$INSTALL_DIR/deploy/compose-runtime.sh" "$@"; }

# ── 2. Generate .env (unique secrets per install) ────────────────────────
[[ ! -e .env ]] || fail "$INSTALL_DIR/.env already exists; refusing to replace customer secrets"
say "Generating .env with fresh secrets"
rnd() { head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40; }
PG_PASS="$(rnd)"
sed -e "s|__POSTGRES_PASSWORD__|$PG_PASS|g" \
    -e "s|__JWT_SECRET__|$(rnd)|g" \
    -e "s|__BOSS_JWT_SECRET__|$(rnd)|g" \
    -e "s|__BOSS_TOKEN_ENCRYPTION_KEY__|$(rnd)|g" \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    deploy/env.template > .env
cat >> .env <<EOF

# BOS-local guarded cognitive memory and host agent runtime.
DOMAIN=$DOMAIN
AIOS_PUBLIC_BASE=https://$DOMAIN
BOSS_MEMORY_DEVICE_ID=$BOSS_MEMORY_DEVICE_ID
BOSS_AGENT_USER=$BOSS_AGENT_USER
BOSS_VISUAL_MANIFEST=$BOSS_VISUAL_MANIFEST
EOF
chmod 600 .env

# ── 3. Domain into Traefik labels ────────────────────────────────────────
say "Routing $DOMAIN through Traefik"
sed -i "s|Host(\`[^\`]*\`)|Host(\`$DOMAIN\`)|g" docker-compose.yml

# ── 4. Override compose: agent mounts (auth lives OUTSIDE the image) ─────
say "Installing the permanent host agent runtime"
BOSS_INSTALL_DIR="$INSTALL_DIR" BOSS_AGENT_USER="$BOSS_AGENT_USER" \
  bash ./deploy/install-agent-runtime.sh

# shellcheck disable=SC1091
source /etc/boss-agent-runtime.env
BOSS_ENV_FILE="$INSTALL_DIR/.env" bash ./deploy/bootstrap-runtime-env.sh

say "Creating agent mounts"
mkdir -p gio-workspace hermes-home hermes-workspace/memory

# Hermes briefing — injected into every Hermes conversation
if [[ -f deploy/hermes-context.template.md ]]; then
  sed "s|__OPERATOR_NAME__|$OPERATOR_NAME|g" deploy/hermes-context.template.md \
    > hermes-workspace/memory/hermes-context.md
else
  printf '# BOS customer context\n\nOperator: %s\n' "$OPERATOR_NAME" \
    > hermes-workspace/memory/hermes-context.md
fi

# Agent-facing mounts use the host runtime UID; Hermes keeps its image UID.
chown -R "$BOSS_AGENT_UID:$BOSS_AGENT_GID" gio-workspace
chown -R 100:101 hermes-home hermes-workspace
# Source paths intentionally writable by the API's pinned host UID. Customer
# secrets, auth, state, and .env remain outside this ownership change.
say "Ensuring the guarded memory gateway is wired into the API"
python3 "$INSTALL_DIR/deploy/ensure-memory-gateway-route.py" \
  "$INSTALL_DIR/apps/api/src/server.ts"
for writable in apps packages services scripts host deploy package.json package-lock.json \
  pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json turbo.json; do
  [[ -e "$writable" ]] && chown -R "$BOSS_AGENT_UID:$BOSS_AGENT_GID" "$writable"
done

# ── 5. Traefik (skip if one is already running on this host) ─────────────
if ! docker ps --format '{{.Names}}' | grep -q traefik; then
  say "Starting Traefik with Let's Encrypt ($ACME_EMAIL)"
  mkdir -p /docker/traefik/letsencrypt
  cat > /docker/traefik/docker-compose.yml <<EOF
services:
  traefik:
    image: traefik:v3.1
    container_name: traefik
    restart: unless-stopped
    network_mode: host
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.email=$ACME_EMAIL
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.le.acme.httpchallenge.entrypoint=web
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /docker/traefik/letsencrypt:/letsencrypt
EOF
  (cd /docker/traefik && docker compose up -d)
else
  say "Traefik already running — reusing it"
fi

# ── 6. Build + start the stack ───────────────────────────────────────────
say "Building BOS containers (several minutes on first run)"
bos_compose build
bos_compose up -d postgres redis weaviate embeddings
say "Waiting for Postgres"
elapsed=0
until bos_compose exec -T postgres pg_isready -U boss -d boss_ir >/dev/null 2>&1; do
  (( elapsed >= POSTGRES_READY_TIMEOUT )) && fail "Postgres did not become ready"
  sleep 2
  elapsed=$((elapsed + 2))
done

# ── 7. Database schema + default tenant ──────────────────────────────────
say "Applying schema"
bos_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U boss -d boss_ir < deploy/schema.sql
bos_compose exec -T postgres psql -U boss -d boss_ir -c \
  "INSERT INTO tenants (id, name) VALUES (gen_random_uuid(), 'default') ON CONFLICT DO NOTHING" \
  2>/dev/null || true

say "Seeding prebuilt employee agents"
if [[ -f deploy/seed-employees.sql ]]; then
  bos_compose exec -T postgres psql -U boss -d boss_ir < deploy/seed-employees.sql
fi

say "Binding agent records to this VPS's host workspaces"
bos_compose exec -T postgres psql -U boss -d boss_ir \
  -v rascal_root="$BOSS_AGENT_RASCALS_ROOT" -v outsider_root="$BOSS_AGENT_OUTSIDERS_ROOT" <<'SQL'
UPDATE boss_rascals
   SET project_dir = :'rascal_root' || '/' || handle
 WHERE project_dir IS NULL OR project_dir = '' OR project_dir LIKE '/home/%/rascals/%';
UPDATE boss_outsiders
   SET project_dir = :'outsider_root' || '/' || handle
 WHERE project_dir IS NULL OR project_dir = '' OR project_dir LIKE '/home/%/outsiders/%';
SQL

say "Creating permanent tmux shells for enabled agents"
while IFS='|' read -r tenant_id agent_kind handle project_dir; do
  [[ -n "$tenant_id" && -n "$agent_kind" && -n "$handle" && -n "$project_dir" ]] || continue
  runtime_id="$(runuser -u "$BOSS_AGENT_USER" -- env HOME="$BOSS_AGENT_HOME" \
    BOSS_AGENT_RUNTIME_ENV=/etc/boss-agent-runtime.env \
    /usr/local/bin/boss-agent-shells runtime-id "$tenant_id" "$agent_kind" "$handle")"
  runuser -u "$BOSS_AGENT_USER" -- env HOME="$BOSS_AGENT_HOME" \
    BOSS_AGENT_RUNTIME_ENV=/etc/boss-agent-runtime.env \
    /usr/local/bin/boss-agent-shells ensure "$runtime_id" "$project_dir"
done < <(bos_compose exec -T postgres psql -U boss -d boss_ir -At -F '|' -c \
  "SELECT tenant_id, 'rascal', handle, project_dir FROM boss_rascals WHERE enabled UNION ALL SELECT tenant_id, 'outsider', handle, project_dir FROM boss_outsiders WHERE enabled ORDER BY 1,2,3")

bos_compose up -d
say "Waiting for the API"
ready=false
elapsed=0
while (( elapsed < API_READY_TIMEOUT )); do
  if bos_compose exec -T api sh -c 'wget -qO- -T 10 http://127.0.0.1:8001/health' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done
[[ "$ready" == true ]] || fail "API did not become healthy"

say "Initializing guarded BOS-local cognitive memory"
bash ./deploy/init-local-memory.sh

# ── 8. Hermes Agent (persistent mount; python pinned INSIDE the mount) ───
say "Installing the Hermes Agent (Nous Research)"
bos_compose exec -T api sh -c '
  export HOME=/home/boss UV_PYTHON_INSTALL_DIR=/home/boss/.hermes/python
  installer="$(mktemp)"
  trap '\''rm -f "$installer"'\'' EXIT
  curl --connect-timeout 15 --max-time 300 -fsSL https://hermes-agent.nousresearch.com/install.sh -o "$installer"
  bash "$installer" >/dev/null 2>&1
  /home/boss/.hermes/hermes-agent/venv/bin/hermes config set model.default gemini-2.5-flash >/dev/null 2>&1
  /home/boss/.hermes/hermes-agent/venv/bin/hermes --version'

# Hermes gets its own working copy of the codebase (never the live tree)
say "Creating Hermes code sandbox"
HERMES_SANDBOX_DIR="$INSTALL_DIR/hermes-workspace/boss-dev" \
  bash ./deploy/create-hermes-sandbox.sh

# ── 9. Security baseline (see playbook: docker ports bypass UFW — the
#      compose binds internal services to 127.0.0.1 already) ──────────────
say "Applying security baseline (UFW + fail2ban)"
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
fi
if ! command -v fail2ban-client >/dev/null; then apt-get install -y -qq fail2ban >/dev/null 2>&1 || true; fi
if command -v fail2ban-client >/dev/null; then
  printf '[sshd]\nenabled=true\nport=22\nmaxretry=5\nbantime=1h\nfindtime=10m\n' > /etc/fail2ban/jail.d/sshd.local
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
fi
# NOTE: key-only SSH is NOT forced here (lockout risk) — do it manually per
# deploy/README.md with the dead-man's-switch pattern.

# ── 10. Verify ───────────────────────────────────────────────────────────
say "Verifying"
H="$(bos_compose exec -T api sh -c 'wget -qO- -T 10 http://127.0.0.1:8001/health' 2>/dev/null | head -c 40)"
echo "  api health: $H"
BRIDGE="$(bos_compose exec -T api ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/data/home/.ssh/boss-agent-runtime-known_hosts \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o IdentitiesOnly=yes \
  -i /data/home/.ssh/boss-agent-runtime-bridge "$BOSS_AGENT_USER@host.docker.internal" status 2>/dev/null)"
echo "  agent bridge: $BRIDGE"

say "Capturing this customer's protected visual baseline"
python3 scripts/visual-preserve.py capture --root "$INSTALL_DIR" --manifest "$BOSS_VISUAL_MANIFEST"
bos_compose ps --format '  {{.Name}}\t{{.Status}}'
echo
say "DONE. Next steps:"
echo "  1. Stage the owner's invite:  deploy/stage-invite.sh owner@email.com"
echo "  2. Send them the setup link:  https://$DOMAIN/#/onboarding?email=<email>&passkey=<key>"
echo "  3. They bring their own keys (Gemini required; OpenAI + Claude optional)."
echo "  4. Complete the customer's Claude sign-in; host and portal share only that customer's auth directory."
