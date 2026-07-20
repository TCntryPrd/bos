#!/usr/bin/env bash
# Install the host-side runtime used by BOS agent workspaces.
#
# The API talks to this account through a forced-command SSH key. Each agent
# owns one durable tmux shell, while Claude itself is started fresh for every
# portal turn and exits back to that shell when the turn is complete.
set -euo pipefail

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BOSS_INSTALL_DIR="${BOSS_INSTALL_DIR:-$REPO_DIR}"
BOSS_AGENT_USER="${BOSS_AGENT_USER:-bosops}"
BOSS_INSTALL_CLAUDE="${BOSS_INSTALL_CLAUDE:-1}"
CLAUDE_INSTALL_URL="${CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}"
RUNTIME_ENV="${BOSS_AGENT_RUNTIME_ENV:-/etc/boss-agent-runtime.env}"
BOSS_AGENT_RUNTIME_ROOT="${BOSS_AGENT_RUNTIME_ROOT:-/var/lib/boss-agent-runtime}"

say()  { printf '\033[0;36m[boss-agent-runtime]\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m[boss-agent-runtime] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$BOSS_AGENT_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "invalid BOSS_AGENT_USER"
[[ -f "$REPO_DIR/host/boss-host-bridge.sh" ]] || fail "host/boss-host-bridge.sh is missing"
[[ -f "$REPO_DIR/host/boss-agent-shells.sh" ]] || fail "host/boss-agent-shells.sh is missing"
[[ "$BOSS_INSTALL_DIR" == /* ]] || fail "BOSS_INSTALL_DIR must be absolute"
[[ "$RUNTIME_ENV" == /* ]] || fail "BOSS_AGENT_RUNTIME_ENV must be absolute"
[[ "$BOSS_AGENT_RUNTIME_ROOT" == /* && "$BOSS_AGENT_RUNTIME_ROOT" != / ]] \
  || fail "BOSS_AGENT_RUNTIME_ROOT must be an absolute non-root path"
[[ "$BOSS_AGENT_RUNTIME_ROOT" != *[[:space:]]* \
  && "$BOSS_AGENT_RUNTIME_ROOT" != *"'"* && "$BOSS_AGENT_RUNTIME_ROOT" != *'#'* ]] \
  || fail "BOSS_AGENT_RUNTIME_ROOT contains unsafe characters"

say "Installing host prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssh-server python3 tmux >/dev/null

if ! id "$BOSS_AGENT_USER" >/dev/null 2>&1; then
  say "Creating locked host account $BOSS_AGENT_USER"
  useradd --create-home --shell /bin/bash "$BOSS_AGENT_USER"
  passwd -l "$BOSS_AGENT_USER" >/dev/null 2>&1 || true
fi

ACCOUNT_HOME="$(getent passwd "$BOSS_AGENT_USER" | cut -d: -f6)"
BOSS_AGENT_HOME="${BOSS_AGENT_HOME:-$ACCOUNT_HOME}"
[[ "$BOSS_AGENT_HOME" == "$ACCOUNT_HOME" ]] || fail "BOSS_AGENT_HOME must match the account home ($ACCOUNT_HOME)"
BOSS_AGENT_UID="$(id -u "$BOSS_AGENT_USER")"
BOSS_AGENT_GID="$(id -g "$BOSS_AGENT_USER")"
BOSS_AGENT_RASCALS_ROOT="${BOSS_AGENT_RASCALS_ROOT:-$BOSS_AGENT_HOME/rascals}"
BOSS_AGENT_OUTSIDERS_ROOT="${BOSS_AGENT_OUTSIDERS_ROOT:-$BOSS_AGENT_HOME/outsiders}"
BOSS_AGENT_COO_ROOT="${BOSS_AGENT_COO_ROOT:-$BOSS_AGENT_HOME/coo}"
BOSS_AGENT_WORKSPACE_ROOT="${BOSS_AGENT_WORKSPACE_ROOT:-$BOSS_AGENT_HOME}"
BOSS_AGENT_TMUX_PREFIX="${BOSS_AGENT_TMUX_PREFIX:-boss-agent-}"
BOSS_AGENT_ALLOWED_ROOTS="$BOSS_AGENT_RASCALS_ROOT:$BOSS_AGENT_OUTSIDERS_ROOT:$BOSS_AGENT_COO_ROOT"
BOSS_AGENT_STATE_DIR="${BOSS_AGENT_STATE_DIR:-$BOSS_AGENT_HOME/.boss-agent-runtime}"
BOSS_AGENT_PATH="$BOSS_AGENT_HOME/.local/bin:$BOSS_AGENT_HOME/bin:/usr/local/bin:/usr/bin:/bin"

for value in "$BOSS_INSTALL_DIR" "$BOSS_AGENT_HOME" "$BOSS_AGENT_RASCALS_ROOT" "$BOSS_AGENT_OUTSIDERS_ROOT" "$BOSS_AGENT_COO_ROOT" "$BOSS_AGENT_WORKSPACE_ROOT"; do
  [[ ! "$value" =~ [[:space:]] ]] || fail "runtime paths cannot contain whitespace"
  [[ "$value" == /* && "$value" != *"'"* && "$value" != *'#'* ]] || fail "runtime paths must be safe absolute paths"
done
[[ "$BOSS_AGENT_TMUX_PREFIX" =~ ^[A-Za-z0-9._-]+$ ]] || fail "invalid BOSS_AGENT_TMUX_PREFIX"
[[ "$BOSS_AGENT_RASCALS_ROOT" == "$BOSS_AGENT_HOME"/* ]] || fail "rascals root must be inside agent home"
[[ "$BOSS_AGENT_OUTSIDERS_ROOT" == "$BOSS_AGENT_HOME"/* ]] || fail "outsiders root must be inside agent home"
[[ "$BOSS_AGENT_COO_ROOT" == "$BOSS_AGENT_HOME"/* ]] || fail "COO root must be inside agent home"

install -d -o "$BOSS_AGENT_UID" -g "$BOSS_AGENT_GID" -m 0750 \
  "$BOSS_AGENT_HOME/.claude" "$BOSS_AGENT_HOME/.claude/projects" \
  "$BOSS_AGENT_RASCALS_ROOT" "$BOSS_AGENT_OUTSIDERS_ROOT" "$BOSS_AGENT_COO_ROOT" \
  "$BOSS_AGENT_STATE_DIR"

# Older customer installs stored the portal-owned Claude subscription under
# the BOS directory. Merge that customer's files into the host runtime account
# without replacing anything already present. Never import an operator home.
LEGACY_CLAUDE_HOME="${BOSS_LEGACY_CLAUDE_HOME:-$BOSS_INSTALL_DIR/claude-home}"
LEGACY_CLAUDE_JSON="${BOSS_LEGACY_CLAUDE_JSON:-$BOSS_INSTALL_DIR/claude.json}"
if [[ -d "$LEGACY_CLAUDE_HOME" ]] && find "$LEGACY_CLAUDE_HOME" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  say "Migrating this BOS's existing Claude auth into the host runtime"
  cp -a -n "$LEGACY_CLAUDE_HOME/." "$BOSS_AGENT_HOME/.claude/"
fi
if [[ -f "$LEGACY_CLAUDE_JSON" && ! -e "$BOSS_AGENT_HOME/.claude.json" ]]; then
  cp -a "$LEGACY_CLAUDE_JSON" "$BOSS_AGENT_HOME/.claude.json"
fi
if [[ ! -e "$BOSS_AGENT_HOME/.claude.json" ]]; then
  printf '{}\n' > "$BOSS_AGENT_HOME/.claude.json"
fi
chown -R "$BOSS_AGENT_UID:$BOSS_AGENT_GID" "$BOSS_AGENT_HOME/.claude"
chown "$BOSS_AGENT_UID:$BOSS_AGENT_GID" "$BOSS_AGENT_HOME/.claude.json"
chmod 0600 "$BOSS_AGENT_HOME/.claude.json"

say "Installing the restricted bridge and tmux reconciler"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$REPO_DIR/host/boss-host-bridge.sh" /usr/local/libexec/boss-agent-runtime-bridge
install -o root -g root -m 0755 "$REPO_DIR/host/boss-agent-shells.sh" /usr/local/bin/boss-agent-shells
if [[ -f "$REPO_DIR/host/boss-agent-background-turn.sh" ]]; then
  install -o root -g root -m 0755 "$REPO_DIR/host/boss-agent-background-turn.sh" /usr/local/bin/boss-agent-background-turn
fi

say "Provisioning the isolated API-to-host SSH key"
KEY_DIR="$BOSS_AGENT_RUNTIME_ROOT/keys"
KEY_PATH="$KEY_DIR/boss-agent-runtime-bridge"
KNOWN_HOSTS_DIR="$BOSS_AGENT_RUNTIME_ROOT/known_hosts"
KNOWN_HOSTS_PATH="$KNOWN_HOSTS_DIR/boss-agent-runtime-known_hosts"
API_SANITIZED_DIR="$BOSS_AGENT_RUNTIME_ROOT/api-sanitized"
API_EMPTY_CLAUDE_DIR="$API_SANITIZED_DIR/claude"
API_EMPTY_CLAUDE_JSON="$API_SANITIZED_DIR/claude.json"
# The directories are root-owned and traversable but not listable by the API
# UID. The key itself remains readable only by the dedicated agent account.
install -d -o root -g root -m 0711 "$BOSS_AGENT_RUNTIME_ROOT" "$KEY_DIR" "$KNOWN_HOSTS_DIR"
install -d -o root -g root -m 0755 "$API_SANITIZED_DIR" "$API_EMPTY_CLAUDE_DIR"
[[ ! -L "$API_EMPTY_CLAUDE_DIR" && ! -L "$API_EMPTY_CLAUDE_JSON" ]] \
  || fail "sanitized API Claude paths must not be symlinks"
if [[ ! -f "$API_EMPTY_CLAUDE_JSON" ]]; then
  printf '{}\n' > "$API_EMPTY_CLAUDE_JSON"
fi
chown root:root "$API_EMPTY_CLAUDE_JSON"
chmod 0444 "$API_EMPTY_CLAUDE_JSON"
if [[ ! -f "$KEY_PATH" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C boss-agent-runtime-bridge -f "$KEY_PATH"
fi
[[ ! -L "$KEY_PATH" ]] || fail "bridge key must not be a symlink"
ssh-keygen -y -f "$KEY_PATH" >/dev/null 2>&1 || fail "bridge key is invalid"
if [[ ! -f "$KEY_PATH.pub" ]]; then
  ssh-keygen -y -f "$KEY_PATH" > "$KEY_PATH.pub"
fi
chown "$BOSS_AGENT_UID:$BOSS_AGENT_GID" "$KEY_PATH"
chown root:root "$KEY_PATH.pub"
chmod 0600 "$KEY_PATH"
chmod 0644 "$KEY_PATH.pub"

# Pin the API container to this host's real SSH host keys. This is deliberately
# generated locally instead of using ssh-keyscan/accept-new: the bridge always
# talks back to this same machine through host.docker.internal, so the host has
# authoritative public keys without a network trust-on-first-use step.
[[ ! -L "$KNOWN_HOSTS_PATH" ]] || fail "bridge known_hosts must not be a symlink"
HOST_KEYS_TMP="$(mktemp "$BOSS_AGENT_RUNTIME_ROOT/.known-hosts.XXXXXX")"
cleanup_host_keys_tmp() { rm -f "$HOST_KEYS_TMP"; }
trap cleanup_host_keys_tmp EXIT
shopt -s nullglob
host_key_pubs=(/etc/ssh/ssh_host_*_key.pub)
shopt -u nullglob
for host_key_pub in "${host_key_pubs[@]}"; do
  [[ -f "$host_key_pub" && ! -L "$host_key_pub" ]] || continue
  ssh-keygen -lf "$host_key_pub" >/dev/null 2>&1 || continue
  IFS=' ' read -r host_key_type host_key_data _ < "$host_key_pub"
  [[ "$host_key_type" =~ ^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521))$ ]] || continue
  [[ "$host_key_data" =~ ^[A-Za-z0-9+/=]+$ ]] || continue
  printf 'host.docker.internal,[host.docker.internal]:22 %s %s\n' \
    "$host_key_type" "$host_key_data" >> "$HOST_KEYS_TMP"
done
[[ -s "$HOST_KEYS_TMP" ]] || fail "no valid local SSH host public key was found to pin the bridge"
install -o root -g root -m 0644 "$HOST_KEYS_TMP" "$KNOWN_HOSTS_PATH"
rm -f "$HOST_KEYS_TMP"
trap - EXIT

runtime_env_line() {
  local key="$1" value="$2"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid runtime environment key"
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *"'"* ]] \
    || fail "unsafe runtime environment value for $key"
  printf "%s='%s'\n" "$key" "$value" >> "$RUNTIME_ENV"
}

install -o root -g root -m 0644 /dev/null "$RUNTIME_ENV"
runtime_env_line BOSS_INSTALL_DIR "$BOSS_INSTALL_DIR"
runtime_env_line BOSS_AGENT_USER "$BOSS_AGENT_USER"
runtime_env_line BOSS_AGENT_HOME "$BOSS_AGENT_HOME"
runtime_env_line BOSS_AGENT_UID "$BOSS_AGENT_UID"
runtime_env_line BOSS_AGENT_GID "$BOSS_AGENT_GID"
runtime_env_line BOSS_AGENT_WORKSPACE_ROOT "$BOSS_AGENT_WORKSPACE_ROOT"
runtime_env_line BOSS_AGENT_RASCALS_ROOT "$BOSS_AGENT_RASCALS_ROOT"
runtime_env_line BOSS_AGENT_OUTSIDERS_ROOT "$BOSS_AGENT_OUTSIDERS_ROOT"
runtime_env_line BOSS_AGENT_COO_ROOT "$BOSS_AGENT_COO_ROOT"
runtime_env_line BOSS_AGENT_TMUX_PREFIX "$BOSS_AGENT_TMUX_PREFIX"
runtime_env_line BOSS_AGENT_ALLOWED_ROOTS "$BOSS_AGENT_ALLOWED_ROOTS"
runtime_env_line BOSS_AGENT_STATE_DIR "$BOSS_AGENT_STATE_DIR"
runtime_env_line BOSS_AGENT_PATH "$BOSS_AGENT_PATH"
runtime_env_line BOSS_HOST_BRIDGE_KEY_SOURCE "$KEY_PATH"
runtime_env_line BOSS_HOST_BRIDGE_KNOWN_HOSTS_SOURCE "$KNOWN_HOSTS_PATH"
runtime_env_line BOSS_API_EMPTY_CLAUDE_DIR "$API_EMPTY_CLAUDE_DIR"
runtime_env_line BOSS_API_EMPTY_CLAUDE_JSON "$API_EMPTY_CLAUDE_JSON"
runtime_env_line CLAUDE_CONFIG_DIR "$BOSS_AGENT_HOME/.claude"
chmod 0644 "$RUNTIME_ENV"

cat > /usr/local/libexec/boss-agent-runtime-bridge-entrypoint <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a
# shellcheck disable=SC1091
source "$RUNTIME_ENV"
set +a
export HOME="\$BOSS_AGENT_HOME"
export USER="\$BOSS_AGENT_USER"
export LOGNAME="\$BOSS_AGENT_USER"
export PATH="\$BOSS_AGENT_HOME/.local/bin:\$BOSS_AGENT_HOME/bin:/usr/local/bin:/usr/bin:/bin"
exec /usr/local/libexec/boss-agent-runtime-bridge
EOF
chmod 0755 /usr/local/libexec/boss-agent-runtime-bridge-entrypoint
chown root:root /usr/local/libexec/boss-agent-runtime-bridge-entrypoint

install -d -o "$BOSS_AGENT_UID" -g "$BOSS_AGENT_GID" -m 0700 "$BOSS_AGENT_HOME/.ssh"
AUTHORIZED_KEYS="$BOSS_AGENT_HOME/.ssh/authorized_keys"
touch "$AUTHORIZED_KEYS"
chown "$BOSS_AGENT_UID:$BOSS_AGENT_GID" "$AUTHORIZED_KEYS"
chmod 0600 "$AUTHORIZED_KEYS"
TEMP_KEYS="$(mktemp)"
grep -v ' boss-agent-runtime-bridge$' "$AUTHORIZED_KEYS" > "$TEMP_KEYS" || true
PUBLIC_KEY="$(awk '{print $1 " " $2}' "$KEY_PATH.pub")"
printf 'restrict,command="/usr/local/libexec/boss-agent-runtime-bridge-entrypoint" %s boss-agent-runtime-bridge\n' "$PUBLIC_KEY" >> "$TEMP_KEYS"
install -o "$BOSS_AGENT_UID" -g "$BOSS_AGENT_GID" -m 0600 "$TEMP_KEYS" "$AUTHORIZED_KEYS"
rm -f "$TEMP_KEYS"

systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1

agent_command() {
  runuser -u "$BOSS_AGENT_USER" -- env \
    HOME="$BOSS_AGENT_HOME" USER="$BOSS_AGENT_USER" LOGNAME="$BOSS_AGENT_USER" \
    PATH="$BOSS_AGENT_HOME/.local/bin:$BOSS_AGENT_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

if ! agent_command bash -lc 'command -v claude >/dev/null 2>&1'; then
  [[ "$BOSS_INSTALL_CLAUDE" == "1" ]] || fail "Claude CLI is missing and BOSS_INSTALL_CLAUDE=0"
  say "Installing Claude CLI for $BOSS_AGENT_USER"
  CLAUDE_INSTALLER="$(mktemp)"
  curl --connect-timeout 15 --max-time 300 -fsSL "$CLAUDE_INSTALL_URL" -o "$CLAUDE_INSTALLER"
  chmod 0755 "$CLAUDE_INSTALLER"
  agent_command bash "$CLAUDE_INSTALLER"
  rm -f "$CLAUDE_INSTALLER"
fi
agent_command bash -lc 'command -v claude >/dev/null 2>&1' || fail "Claude CLI installation did not produce a usable binary"
BOSS_CLAUDE_BIN="$(agent_command bash -lc 'command -v claude' | tail -n 1)"
[[ "$BOSS_CLAUDE_BIN" == /* ]] || fail "Claude CLI did not resolve to an absolute path"
[[ "$BOSS_CLAUDE_BIN" != *[[:space:]]* && "$BOSS_CLAUDE_BIN" != *"'"* ]] \
  || fail "Claude CLI path contains unsafe characters"
runtime_env_line BOSS_CLAUDE_BIN "$BOSS_CLAUDE_BIN"

cat > /etc/systemd/system/boss-agent-shells.service <<EOF
[Unit]
Description=Reconcile permanent BOS agent tmux shells
After=network.target

[Service]
Type=oneshot
User=$BOSS_AGENT_USER
Group=$(id -gn "$BOSS_AGENT_USER")
EnvironmentFile=$RUNTIME_ENV
ExecStart=/usr/local/bin/boss-agent-shells reconcile
EOF

cat > /etc/systemd/system/boss-agent-shells.timer <<'EOF'
[Unit]
Description=Keep BOS agent tmux shells available

[Timer]
OnBootSec=10s
OnUnitActiveSec=30s
AccuracySec=5s
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now boss-agent-shells.timer >/dev/null
agent_command /usr/local/bin/boss-agent-shells reconcile

say "Runtime ready"
echo "  user:             $BOSS_AGENT_USER ($BOSS_AGENT_UID:$BOSS_AGENT_GID)"
echo "  rascal root:      $BOSS_AGENT_RASCALS_ROOT"
echo "  outsider root:    $BOSS_AGENT_OUTSIDERS_ROOT"
echo "  COO root:         $BOSS_AGENT_COO_ROOT"
echo "  bridge key:       $KEY_PATH"
echo "  runtime env:      $RUNTIME_ENV"
