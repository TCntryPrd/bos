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

say()  { printf '\033[0;36m[bos-install]\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m[bos-install] FATAL:\033[0m %s\n' "$*"; exit 1; }

# ── 0. Prereqs ───────────────────────────────────────────────────────────
command -v docker >/dev/null || fail "Docker is required (curl -fsSL https://get.docker.com | sh)"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"
command -v git >/dev/null || fail "git is required (apt-get install -y git)"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO_DIR/docker-compose.yml" ] || fail "run from inside the unpacked BOS release (deploy/install-bos.sh)"

# ── 1. Place the repo ────────────────────────────────────────────────────
say "Installing BOS to $INSTALL_DIR for domain $DOMAIN"
mkdir -p "$(dirname "$INSTALL_DIR")"
if [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
  [ -e "$INSTALL_DIR" ] && fail "$INSTALL_DIR already exists — refusing to overwrite"
  cp -a "$REPO_DIR" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
git init -q 2>/dev/null || true

# Brand the AIOS name into the web lockup (optional; blank -> plain "BOS").
AIOS_NAME="${AIOS_NAME:-}"
if [ -n "$AIOS_NAME" ]; then
  say "Branding AIOS name: $AIOS_NAME"
  sed -i "s|<meta name=\"aios-name\" content=\"\"|<meta name=\"aios-name\" content=\"$AIOS_NAME\"|" apps/web/index.html || true
fi

# ── 2. Generate .env (unique secrets per install) ────────────────────────
say "Generating .env with fresh secrets"
rnd() { head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40; }
PG_PASS="$(rnd)"
sed -e "s|__POSTGRES_PASSWORD__|$PG_PASS|g" \
    -e "s|__JWT_SECRET__|$(rnd)|g" \
    -e "s|__BOSS_JWT_SECRET__|$(rnd)|g" \
    -e "s|__BOSS_TOKEN_ENCRYPTION_KEY__|$(rnd)|g" \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    deploy/env.template > .env
chmod 600 .env

# ── 3. Domain into Traefik labels ────────────────────────────────────────
say "Routing $DOMAIN through Traefik"
sed -i "s|Host(\`[^\`]*\`)|Host(\`$DOMAIN\`)|g" docker-compose.yml

# ── 4. Override compose: agent mounts (auth lives OUTSIDE the image) ─────
say "Creating agent mounts"
mkdir -p claude-home gio-workspace hermes-home hermes-workspace/memory
echo "{}" > claude.json
cat > docker-compose.override.yml <<EOF
services:
  api:
    environment:
      BOSS_BACKGROUND_AGENTS: "off"
      TELEGRAM_BOT_TOKEN: ""
      BOSS_HOME_OVERRIDE: /home/boss
      BOSS_CHAT_RUNNER: local
      BOSS_GIO_WORKSPACE: /home/boss/gio
      BOSS_GIO_ATTACHMENT_ROOT: /home/boss/gio/.tmp
    volumes:
      - .:/home/boss/boss-dev
      - ./gio-workspace:/home/boss/gio
      - ./claude-home:/home/boss/.claude
      - ./claude.json:/home/boss/.claude.json
      - ./hermes-home:/home/boss/.hermes
EOF

# Hermes briefing — injected into every Hermes conversation
sed "s|__OPERATOR_NAME__|$OPERATOR_NAME|g" deploy/hermes-context.template.md \
  > hermes-workspace/memory/hermes-context.md

# Container runtime uid:gid (alpine `boss` user) owns the agent dirs
chown -R 100:101 claude-home hermes-home hermes-workspace gio-workspace claude.json

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
# WS-1: build-context pre-flight — fail early if a referenced context is missing
for _df in apps/api/Dockerfile apps/web/Dockerfile; do
  [ -f "$_df" ] || { echo "FATAL: missing build context $_df — aborting before build"; exit 1; }
done
docker compose build
docker compose up -d postgres redis weaviate
say "Waiting for Postgres"
until docker compose exec -T postgres pg_isready -U boss >/dev/null 2>&1; do sleep 2; done

# ── 7. Database schema + default tenant ──────────────────────────────────
say "Applying schema"
bash deploy/migrate.sh   # WS-3: idempotent ledgered migration runner (was: psql < schema.sql)
docker compose exec -T postgres psql -U boss -d boss_ir -c \
  "INSERT INTO tenants (id, name) VALUES ('${DEFAULT_TENANT_ID}', 'default') ON CONFLICT (id) DO NOTHING" \
  2>/dev/null || true

say "Seeding prebuilt employee agents"
docker compose exec -T postgres psql -U boss -d boss_ir < deploy/seed-employees.sql 2>/dev/null || true
docker compose exec -T postgres psql -U boss -d boss_ir < deploy/seed-agents.sql 2>/dev/null || true   # WS1: Employee Agents

docker compose up -d
say "Waiting for the API"
for i in $(seq 1 30); do
  docker compose exec -T api sh -c 'wget -qO- http://127.0.0.1:8001/health' >/dev/null 2>&1 && break
  sleep 5
done

# ── 8. Hermes Agent (persistent mount; python pinned INSIDE the mount) ───
say "Installing the Hermes Agent (Nous Research)"
docker compose exec -T api sh -c '
  export HOME=/home/boss UV_PYTHON_INSTALL_DIR=/home/boss/.hermes/python
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash >/dev/null 2>&1
  /home/boss/.hermes/hermes-agent/venv/bin/hermes config set model.default gemini-2.5-flash >/dev/null 2>&1
  /home/boss/.hermes/hermes-agent/venv/bin/hermes --version'

# Hermes gets its own working copy of the codebase (never the live tree)
say "Creating Hermes code sandbox"
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
true  # WS-0: installer no longer git-adds/commits .env at install
rm -rf hermes-workspace/boss-dev
git clone --quiet "$INSTALL_DIR" hermes-workspace/boss-dev 2>/dev/null || true
chown -R 100:101 hermes-workspace

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
H="$(docker compose exec -T api sh -c 'wget -qO- http://127.0.0.1:8001/health' 2>/dev/null | head -c 40)"
echo "  api health: $H"
docker compose ps --format '  {{.Name}}\t{{.Status}}'
echo
say "DONE. Next steps:"
echo "  1. Stage the owner's invite:  deploy/stage-invite.sh owner@email.com"
echo "  2. Send them the setup link:  https://$DOMAIN/#/onboarding?email=<email>&passkey=<key>"
echo "  3. They bring their own keys (Gemini required; OpenAI + Claude optional)."
