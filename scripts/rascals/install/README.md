# Little Rascals — Install Guide

IR Custom AIOS ships with zero rascals. Each rascal is created per-client via the
import/onboarding flow. This guide walks through enabling the first one
(Darla for Debbie/TTC) post-v1.4.0 deploy.

## Order of operations

1. Migration 016 ran (part of v1.4.0 deploy).
2. Install shared host directories + env file.
3. Import Darla via API.
4. Seed Darla's CLAUDE.md + morning-check.md.
5. Enable Darla in the registry.
6. Install systemd unit and start it (creates her tmux session + launches CLI).
7. Install the cron, append Darla's wake + save lines.
8. Smoke test.

## 2. Shared host setup

```bash
mkdir -p /home/tcntryprd/rascals/logs /home/tcntryprd/rascals/locks

mkdir -p /home/tcntryprd/.config/rascals
cat > /home/tcntryprd/.config/rascals/.env <<EOF
BOSS_API_URL="http://127.0.0.1:8001"
BOSS_TENANT_ID="default"
WEAVIATE_URL="http://127.0.0.1:8081"
RASCALS_ROOT="/home/tcntryprd/rascals"
RASCALS_LOCK="/home/tcntryprd/rascals/locks/little-rascals.lock"
RASCALS_LOG_DIR="/home/tcntryprd/rascals/logs"
RASCALS_WAKE_TIMEOUT_SEC=900
RASCALS_WAKE_COMPLETION_SEC=1200
RASCALS_BOOT_STAGGER_SEC=10
EOF
chmod 700 /home/tcntryprd/.config/rascals
chmod 600 /home/tcntryprd/.config/rascals/.env
```

## 3. Import Darla from presets

```bash
curl -sS -X POST \
  -H 'X-BOSS-Internal: true' \
  -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' \
  -d '{"handles":["darla"]}' \
  http://127.0.0.1:8001/api/agents/rascals/import-presets | jq
# Expected: {"imported":["darla"],"skipped":[]}
```

Verify the row:
```bash
curl -sS -H 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' \
  http://127.0.0.1:8001/api/agents/rascals | jq
```

Create the per-rascal project dirs (the API only writes the DB row — the filesystem tree is the operator's responsibility):
```bash
mkdir -p /home/tcntryprd/rascals/darla/{crons,output,state}
```

## 4. Seed Darla's prompt files

```bash
cp scripts/rascals/install/examples/darla/CLAUDE.md                /home/tcntryprd/rascals/darla/
cp scripts/rascals/install/examples/darla/crons/morning-check.md   /home/tcntryprd/rascals/darla/crons/
```

Edit `/home/tcntryprd/rascals/darla/CLAUDE.md` to replace the `(TODO — Kevin to fill this in)` section with the real Debbie/TTC context. Darla only knows what's in this file + what she can query.

## 5. Enable Darla

```bash
curl -sS -X PATCH \
  -H 'X-BOSS-Internal: true' \
  -H 'X-Tenant-ID: default' \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' \
  http://127.0.0.1:8001/api/agents/rascals/darla | jq
# Expected: "enabled":true in the response
```

## 6. Install + start systemd

```bash
sudo cp scripts/rascals/install/little-rascals.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable little-rascals.service
sudo systemctl start little-rascals.service
sudo systemctl status little-rascals.service   # expect "active (exited)"
tmux list-sessions | grep darla                # expect `darla: 1 windows ...`
```

## 7. Install cron + append Darla's lines

```bash
sudo cp scripts/rascals/install/rascals.crontab /etc/cron.d/little-rascals
sudo chmod 644 /etc/cron.d/little-rascals

# Append Darla's wake + save lines
sudo tee -a /etc/cron.d/little-rascals >/dev/null <<'EOF'
0  7 * * 1-5 tcntryprd /home/tcntryprd/boss-dev/scripts/rascals/wake-agent.sh darla "Run crons/morning-check.md for $(date +%F)"
15 7 * * 1-5 tcntryprd /home/tcntryprd/boss-dev/scripts/rascals/agent-save.sh darla morning-check
EOF
sudo systemctl reload cron
```

## 8. Smoke test (don't wait for cron)

See Task 13 of the implementation plan for the full end-to-end check, or run the short version:
```bash
/home/tcntryprd/boss-dev/scripts/rascals/wake-agent.sh darla "Smoke: reply 'hello' then stop."
sleep 90
/home/tcntryprd/boss-dev/scripts/rascals/agent-save.sh darla smoke-test
ls /home/tcntryprd/rascals/darla/output/
tail -20 /home/tcntryprd/rascals/logs/wake-darla.log
tail -20 /home/tcntryprd/rascals/logs/save-darla.log
```

## Onboarding a new rascal (post-v1.4.0)

For each new client:
1. `POST /api/agents/rascals` with a fresh `{handle, displayName, cli, client}` (or `import-presets` if the character is in the roster).
2. `cp` or hand-write the client's `CLAUDE.md` and `crons/*.md` into the newly-created project dir.
3. `PATCH /api/agents/rascals/{handle}` with `{"enabled": true}`.
4. Append morning-check + save cron lines to `/etc/cron.d/little-rascals` (stagger ≥2 min from existing rascals).
5. `sudo systemctl restart little-rascals.service` → new tmux session + CLI launch.
