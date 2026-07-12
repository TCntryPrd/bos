#!/bin/bash
# Updates status files that the IR Custom AIOS Docker container reads.
# Run via cron every 5 minutes: */5 * * * * /home/tcntryprd/boss-dev/scripts/update-status-files.sh

SCRIPTS_DIR="/home/tcntryprd/boss-dev/scripts"

# System info snapshot (vS.0.1) — runs host-native where all tools work
bash "$SCRIPTS_DIR/sys-info.sh" > "$SCRIPTS_DIR/sys-info-status.json" 2>/dev/null || echo '{"error":"sys-info.sh failed"}' > "$SCRIPTS_DIR/sys-info-status.json"

# Docker container status
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}" > "$SCRIPTS_DIR/docker-status.txt" 2>/dev/null

# System updates available
apt list --upgradable 2>/dev/null > "$SCRIPTS_DIR/updates-check.txt"

# User systemd services
systemctl --user list-units --type=service --state=running --no-pager 2>/dev/null > "$SCRIPTS_DIR/services-status.txt"
echo "" >> "$SCRIPTS_DIR/services-status.txt"
echo "=== System services ===" >> "$SCRIPTS_DIR/services-status.txt"
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | grep -E "docker|n8n|tailscale|boss|nginx" >> "$SCRIPTS_DIR/services-status.txt"

# Crontab snapshot (vS.0.1)
crontab -l > "$SCRIPTS_DIR/crontab-status.txt" 2>/dev/null || echo "no crontab" > "$SCRIPTS_DIR/crontab-status.txt"

# Firewall status (vS.0.1)
sudo ufw status numbered > "$SCRIPTS_DIR/firewall-status.txt" 2>/dev/null || echo "ufw not available" > "$SCRIPTS_DIR/firewall-status.txt"

# Recent git commits (vS.0.1)
git -C /home/tcntryprd/boss-dev log --oneline --format='%H|%s|%ai' -5 > "$SCRIPTS_DIR/git-recent.txt" 2>/dev/null || echo "" > "$SCRIPTS_DIR/git-recent.txt"

# n8n workflow summary (vS.0.1) — n8n is localhost-only, container can't reach it
N8N_KEY=$(grep N8N_API_KEY /home/tcntryprd/boss-dev/.env 2>/dev/null | cut -d= -f2-)
if [ -n "$N8N_KEY" ]; then
  curl -s -H "X-N8N-API-KEY: $N8N_KEY" http://127.0.0.1:7749/api/v1/workflows 2>/dev/null | \
    python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  wfs=d.get("data",[])
  json.dump({"total":len(wfs),"active":sum(1 for w in wfs if w.get("active"))},sys.stdout)
except: json.dump({"error":"parse_failed"},sys.stdout)' > "$SCRIPTS_DIR/n8n-status.txt" 2>/dev/null
else
  echo '{"error":"N8N_API_KEY not found"}' > "$SCRIPTS_DIR/n8n-status.txt"
fi

# GitHub CI runs (vS.0.1) — gh CLI is on host, not in container
gh run list --repo TCntryPrd/boss-dev --limit 5 --json name,status,conclusion,headBranch,createdAt,url > "$SCRIPTS_DIR/gh-ci-status.json" 2>/dev/null || echo '[]' > "$SCRIPTS_DIR/gh-ci-status.json"

# ── vS.1.1 — Defensive posture status files ──────────────────────────────────

# Open ports (listening TCP)
ss -tlnp 2>/dev/null > "$SCRIPTS_DIR/security-ports.txt" || echo "ss not available" > "$SCRIPTS_DIR/security-ports.txt"

# SSL/TLS certificate expiry (Let's Encrypt + any in /etc/letsencrypt)
if [ -d /etc/letsencrypt/live ]; then
  (for cert_dir in /etc/letsencrypt/live/*/; do
    domain=$(basename "$cert_dir")
    expiry=$(openssl x509 -enddate -noout -in "${cert_dir}fullchain.pem" 2>/dev/null | cut -d= -f2)
    echo "$domain|$expiry"
  done) > "$SCRIPTS_DIR/security-certs.txt" 2>/dev/null
else
  echo "no_letsencrypt" > "$SCRIPTS_DIR/security-certs.txt"
fi

# Auth log digest — last 50 failed login attempts + sudo invocations
(grep -E "Failed password|Invalid user|sudo:" /var/log/auth.log 2>/dev/null || echo "auth.log not readable") | tail -50 > "$SCRIPTS_DIR/security-authlog.txt"

# SSH authorized keys inventory
cat ~/.ssh/authorized_keys 2>/dev/null > "$SCRIPTS_DIR/security-ssh-keys.txt" || echo "no authorized_keys" > "$SCRIPTS_DIR/security-ssh-keys.txt"

# fail2ban status
sudo fail2ban-client status 2>/dev/null > "$SCRIPTS_DIR/security-fail2ban.txt" || echo "fail2ban not available" > "$SCRIPTS_DIR/security-fail2ban.txt"

# ── vS.2.0 — Telemetry status files ──────────────────────────────────────────

# Container health: restart counts + unhealthy containers
docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}' > "$SCRIPTS_DIR/telemetry-containers.txt" 2>/dev/null
docker events --since 5m --until 0s --filter event=die --format '{{.Actor.Attributes.name}}|{{.Time}}|{{.Actor.Attributes.exitCode}}' > "$SCRIPTS_DIR/telemetry-container-deaths.txt" 2>/dev/null &
DOCKER_EVENTS_PID=$!
sleep 2
kill $DOCKER_EVENTS_PID 2>/dev/null
wait $DOCKER_EVENTS_PID 2>/dev/null

# Recent deploy smoke results (last run of deploy.sh)
tail -100 "$SCRIPTS_DIR/logs/deploy.log" 2>/dev/null > "$SCRIPTS_DIR/telemetry-deploy-log.txt" || echo "no deploy log" > "$SCRIPTS_DIR/telemetry-deploy-log.txt"

# API container error rate (last 5 min of stderr)
docker logs boss_api --since 5m 2>&1 | grep -iE "error|fail|crash|exception|ECONNREFUSED|timeout" | tail -50 > "$SCRIPTS_DIR/telemetry-api-errors.txt" 2>/dev/null || echo "" > "$SCRIPTS_DIR/telemetry-api-errors.txt"

# Disk usage trend
df -h / | tail -1 | awk '{print $3"|"$4"|"$5}' > "$SCRIPTS_DIR/telemetry-disk.txt" 2>/dev/null

# Memory pressure
free -m | grep Mem | awk '{print $2"|"$3"|"$4"|"$7}' > "$SCRIPTS_DIR/telemetry-memory.txt" 2>/dev/null
