# Backup Recovery Playbook (vD.0.1+)

## Layers

1. **GitHub** (canonical off-host) — `boss-backups`, `n8n-workflow-archive`, `cc-memory`, `cc-config`. AES-256-CBC encrypted per file. Some files split into 90MB `.partNN` chunks.
2. **USB local mirror** — `/mnt/usb-backups/` (ext4 on `/dev/sda1`).
3. **Persistent local snapshot** — `/var/lib/boss-backups/` (15-day retention).

## Restore: Postgres

```bash
git clone -b backups https://github.com/TCntryPrd/boss-backups /tmp/restore
cd /tmp/restore
# pick the snapshot:
ls boss_pg_*.enc | sort | tail -5
SNAP=boss_pg_20260429_040001.sql.gz.enc

# decrypt:
IV=$(head -c 16 "$SNAP" | xxd -p | tr -d '\n')
KEY=$(echo -n "$BACKUP_ENCRYPTION_KEY" | xxd -p | tr -d '\n' | head -c 64)
tail -c +17 "$SNAP" | openssl enc -d -aes-256-cbc -K "$KEY" -iv "$IV" > "${SNAP%.enc}"
gunzip "${SNAP%.enc}"

# restore:
psql -U boss -h localhost boss_db < "${SNAP%.sql.gz.enc}.sql"
```

## Restore: Weaviate (chunked)

```bash
git clone -b backups https://github.com/TCntryPrd/boss-backups /tmp/restore
cd /tmp/restore
SNAP=boss_wv_20260429_040002.tar.gz.enc

# Concatenate chunks (if any):
if ls "$SNAP".*.part 2>/dev/null; then
    cat "$SNAP".*.part > "$SNAP"
fi

# decrypt + extract:
IV=$(head -c 16 "$SNAP" | xxd -p | tr -d '\n')
KEY=$(echo -n "$BACKUP_ENCRYPTION_KEY" | xxd -p | tr -d '\n' | head -c 64)
tail -c +17 "$SNAP" | openssl enc -d -aes-256-cbc -K "$KEY" -iv "$IV" > "${SNAP%.enc}"
tar -xzf "${SNAP%.enc}"

# Re-import: see Weaviate docs (depends on schema version)
```

## Restore: n8n workflows (encrypted bundle)

```bash
git clone https://github.com/TCntryPrd/n8n-workflow-archive /tmp/restore-n8n
cd /tmp/restore-n8n
SNAP=$(ls workflows/*.tar.gz.enc | sort | tail -1)

# Decrypt:
IV=$(head -c 16 "$SNAP" | xxd -p | tr -d '\n')
KEY=$(echo -n "$BACKUP_ENCRYPTION_KEY" | xxd -p | tr -d '\n' | head -c 64)
tail -c +17 "$SNAP" | openssl enc -d -aes-256-cbc -K "$KEY" -iv "$IV" > "${SNAP%.enc}"
tar -xzf "${SNAP%.enc}" -C /tmp/n8n-restore

# The bundle is a single JSON with "workflows": [...]; split + import:
python3 -c '
import json, sys, glob
files = glob.glob("/tmp/n8n-restore/n8n-workflows-*.json")
d = json.load(open(files[0]))
for wf in d["workflows"]:
    open(f"/tmp/n8n-restore/wf-{wf[\"id\"]}.json", "w").write(json.dumps(wf))
'
for f in /tmp/n8n-restore/wf-*.json; do
    docker exec -i n8n n8n import:workflow --input=- < "$f"
done
```

## Restore: cc-memory + cc-config (encrypted bundles)

```bash
# Memory:
git clone https://github.com/TCntryPrd/cc-memory /tmp/restore-mem
cd /tmp/restore-mem
SNAP=$(ls cc-memory-*.tar.gz.enc | sort | tail -1)
IV=$(head -c 16 "$SNAP" | xxd -p | tr -d '\n')
KEY=$(echo -n "$BACKUP_ENCRYPTION_KEY" | xxd -p | tr -d '\n' | head -c 64)
tail -c +17 "$SNAP" | openssl enc -d -aes-256-cbc -K "$KEY" -iv "$IV" > "${SNAP%.enc}"
mkdir -p /tmp/mem-restore && tar -xzf "${SNAP%.enc}" -C /tmp/mem-restore
rsync -av /tmp/mem-restore/home/tcntryprd/.claude/projects/-home-tcntryprd--claude/memory/ \
    ~/.claude/projects/-home-tcntryprd--claude/memory/
cp /tmp/mem-restore/home/tcntryprd/.claude/CLAUDE.md ~/.claude/CLAUDE.md

# Config:
git clone https://github.com/TCntryPrd/cc-config /tmp/restore-cfg
cd /tmp/restore-cfg
SNAP=$(ls cc-config-*.tar.gz.enc | sort | tail -1)
IV=$(head -c 16 "$SNAP" | xxd -p | tr -d '\n')
tail -c +17 "$SNAP" | openssl enc -d -aes-256-cbc -K "$KEY" -iv "$IV" > "${SNAP%.enc}"
mkdir -p /tmp/cfg-restore && tar -xzf "${SNAP%.enc}" -C /tmp/cfg-restore
cp /tmp/cfg-restore/home/tcntryprd/.claude/settings.json ~/.claude/settings.json
```

## Disaster scenarios

- **GitHub unreachable:** USB at `/mnt/usb-backups/` has same `.enc` files. Decrypt with the same key.
- **USB lost AND GitHub unreachable:** `/var/lib/boss-backups/` retains 15 days local.
- **Whole box lost:** `BACKUP_ENCRYPTION_KEY` is in `.env` which is in the source repo (`boss-dev`). It's NOT in any backup intentionally — clone `boss-dev` to a fresh box first, then restore from GitHub.
- **`BACKUP_ENCRYPTION_KEY` lost:** All backups become unreadable. Key must be archived separately (1Password / Kevin's head / paper in safe).
