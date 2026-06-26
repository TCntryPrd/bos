# vD.0.1 — Backup-Push Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the 6-night silent backup-push failure, mount the 16GB USB drive (`/dev/sda1`) as a local mirror, fix the `boss-backups` git repo so future pushes succeed, capture n8n workflows + memory + config to new private GitHub repos, add a `boss_backup_status` brain tool with deploy-smoke #46, and verify all assets land in both destinations.

**Architecture:**
- **Existing pattern preserved:** `scripts/backup.sh` already AES-256-CBC encrypts every artifact and supports `--dest git|s3|both`. Extending, not rewriting.
- **GitHub remains primary off-host destination.** The 173.94 MB Weaviate snapshot (commit `<TBD-find-via-filter-repo>`) gets purged from `boss-backups` history, then large files get split into 90 MB chunks before commit so future pushes never hit the 100 MB ceiling.
- **USB local mirror** at `/mnt/usb-backups` via `rsync` after each daily backup. Belt-and-suspenders. FAT32 has a 4 GB single-file limit but 90 MB chunks comfortably fit.
- **Three new private GitHub repos:** `n8n-workflow-archive`, `cc-memory`, `cc-config`. Existing `boss-backups` keeps Postgres + Weaviate.
- **Health surface:** new brain tool `boss_backup_status` (observer-tier) reads a JSON status file written by `backup.sh` after every run. Deploy-smoke #46 enforces last-uploaded-within-25h on all five assets.
- **Weekly rotation** keeps git histories under ~5 GB by dropping >14-day artifacts from git but retaining 15 days on USB and `/var/lib/boss-backups/`.

**Tech Stack:** bash, openssl, gzip, tar, split, rsync, git, git-filter-repo, GitHub CLI (`gh`), Fastify (TypeScript) for the brain tool, vitest.

**Spec:** `docs/superpowers/specs/2026-04-29-boss-forward-plan.md` §2 vD.0.1
**Audit context:** `docs/superpowers/specs/2026-04-29-state-of-boss-audit.md` §4 (durability inventory)

---

## File structure

**Created:**
```
/etc/systemd/system/mnt-usb\x2dbackups.mount  — systemd mount unit (host)
/var/lib/boss-backups/                       — new local snapshot dir (replaces /tmp/)
/mnt/usb-backups/                              — USB mount point
scripts/lib/backup-split.sh                    — 90 MB chunking helpers
scripts/lib/backup-mirror.sh                   — rsync to USB helper
scripts/n8n-workflow-export.sh                 — daily n8n export to JSON
scripts/cc-memory-backup.sh                    — daily memory + config dump
scripts/backup-status.sh                       — writes /var/lib/boss-backups/status.json
apps/api/src/tools/backup-status.ts            — new boss_backup_status brain tool
apps/api/src/tools/backup-status.test.ts       — vitest for the tool
docs/playbooks/backup-recovery.md              — how to restore from any layer
```

**Modified:**
```
scripts/backup.sh                              — switch BACKUP_DIR, add chunking, add USB mirror, write status JSON
scripts/auto-commit-all.sh                     — add cc-memory + cc-config repos to REPOS array
apps/api/src/tools/registry.ts                 — register boss_backup_status
apps/api/src/tools/trust.ts                    — add observer-tier permission
scripts/deploy.sh                              — add deploy-smoke #46
crontab (host)                                 — add n8n-workflow-export.sh + cc-memory-backup.sh
```

**Already in place (verify, don't touch):**
```
encrypt_file() in scripts/backup.sh:80-95      — AES-256-CBC works fine
.env file with BACKUP_ENCRYPTION_KEY            — required, presumed set
GitHub repo TCntryPrd/boss-backups            — exists, broken history will be filter-repo'd
```

---

## Task 1: Pre-flight + USB mount

**Files:** `/etc/systemd/system/mnt-usb\x2dbackups.mount`, `/etc/fstab` (or systemd unit), `/var/lib/boss-backups/`

- [ ] **Step 1: Verify USB drive presence and current state**

```bash
lsblk -no NAME,SIZE,FSTYPE,MOUNTPOINT,LABEL /dev/sda 2>&1
mount | grep sda || echo 'sda NOT mounted (expected)'
ls -la /mnt/ 2>&1 | head -10
df -h / | tail -1
```

Expected:
- `sda1 14.6G vfat ... UBUNTU 24_0` (or similar label)
- `sda NOT mounted (expected)`
- `/mnt/` exists; `/mnt/usb-backups` may or may not exist
- root disk has ample space (>20 GB free)

If `lsblk` shows `sda` is unexpectedly already mounted somewhere, **STOP and ask** — Kevin may have manually mounted it.

- [ ] **Step 2: Create mount point + persistent local backup dir**

```bash
sudo mkdir -p /mnt/usb-backups
sudo chown tcntryprd:tcntryprd /mnt/usb-backups
sudo mkdir -p /var/lib/boss-backups
sudo chown tcntryprd:tcntryprd /var/lib/boss-backups
ls -ld /mnt/usb-backups /var/lib/boss-backups
```

Expected: both dirs exist, owned by `tcntryprd:tcntryprd`, mode `0755`.

This step requires `sudo`. IR Custom AIOS can't yet (vS.1.0 isn't shipped); execution is human-driven for now.

- [ ] **Step 3: Mount the USB drive (one-time)**

```bash
sudo mount -o uid=1000,gid=1000,umask=022 /dev/sda1 /mnt/usb-backups
ls -la /mnt/usb-backups | head -10
df -h /mnt/usb-backups
```

Expected:
- mount succeeds (no errors)
- listing shows whatever was on the drive (likely Ubuntu installer remnants — that's fine, ignore)
- `df` shows ~14 GB available on `/mnt/usb-backups`

- [ ] **Step 4: Add fstab entry for persistence across reboots**

Append to `/etc/fstab`:
```
/dev/sda1  /mnt/usb-backups  vfat  defaults,uid=1000,gid=1000,umask=022,nofail  0  0
```

Run with sudo:
```bash
echo '/dev/sda1  /mnt/usb-backups  vfat  defaults,uid=1000,gid=1000,umask=022,nofail  0  0' | sudo tee -a /etc/fstab
sudo mount -a
mount | grep usb-backups
```

The `nofail` flag means a missing/unplugged drive won't break boot.

Expected: `mount -a` runs cleanly; final `mount` output shows `/dev/sda1 on /mnt/usb-backups type vfat`.

- [ ] **Step 5: Migrate any existing snapshots from /tmp/boss-backups to /var/lib/boss-backups**

```bash
test -d /tmp/boss-backups && \
    sudo rsync -av /tmp/boss-backups/ /var/lib/boss-backups/ && \
    ls -la /var/lib/boss-backups/ | head -15 || \
    echo 'no /tmp/boss-backups to migrate'
```

Expected: 9 daily encrypted snapshots from Apr 21–29 land in `/var/lib/boss-backups/`. (Audit confirmed they exist.)

- [ ] **Step 6: Commit the fstab + dir-creation note**

There's nothing to commit in git for the host-level setup itself, but write a host-state log:

```bash
cat <<'EOF' > /home/tcntryprd/boss-dev/scripts/host-state-2026-04-29.md
# Host state changes for vD.0.1 (2026-04-29)
- Mounted /dev/sda1 at /mnt/usb-backups (vfat, uid=1000)
- Added fstab entry with nofail
- Created /var/lib/boss-backups (replaces /tmp/boss-backups)
- Migrated 9 existing snapshots from /tmp
EOF
cd /home/tcntryprd/boss-dev
git add scripts/host-state-2026-04-29.md
git commit -m "chore(vD.0.1): host-state log for USB mount + persistent backup dir"
```

---

## Task 2: Fix the broken boss-backups GitHub repo

**Files:** local clone of `boss-backups` repo (will be created in `/tmp/boss-backups-fix/`)

The 173.94 MB `boss_wv_20260423_040001.tar.gz.enc` is permanently in git history blocking pushes. Use `git filter-repo` to drop it.

- [ ] **Step 1: Install git-filter-repo if missing**

```bash
which git-filter-repo || sudo apt-get install -y git-filter-repo
git-filter-repo --version
```

Expected: prints version (e.g., `2.45.0`).

- [ ] **Step 2: Clone the broken repo into a fix workspace**

```bash
rm -rf /tmp/boss-backups-fix
git clone https://github.com/TCntryPrd/boss-backups /tmp/boss-backups-fix
cd /tmp/boss-backups-fix
git branch -a | head
ls -la *.enc 2>&1 | head -5
git log --oneline -5
```

Expected: repo clones, `backups` branch exists, ~6 large `.enc` files visible, recent commits show the failed nightly attempts.

- [ ] **Step 3: Identify all >90MB blobs in history**

```bash
cd /tmp/boss-backups-fix
git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1=="blob" && $3 > 94371840 {print $3, $4}' \
  | sort -nr | head -10
```

Expected: lists the offending Weaviate `.tar.gz.enc` files >90MB (94371840 bytes) sorted desc. The 173MB Apr-23 file should be first.

- [ ] **Step 4: Strip the oversize blobs from history**

```bash
cd /tmp/boss-backups-fix
git filter-repo --strip-blobs-bigger-than 94M --force
git gc --aggressive --prune=now
du -sh .git
```

Expected: `.git` dir size drops dramatically (e.g., 200MB → 30MB).

- [ ] **Step 5: Force-push the cleaned history (REQUIRES KEVIN'S CONFIRM)**

This is a **destructive remote operation**. The standing rule (BOSS_HANDOFF) forbids force-push to `main`/`master`. The `backups` branch on the `boss-backups` repo is owned by automation, not by humans, so force-pushing it is the correct intent — but pause execution here and ask Kevin to confirm before running:

> "About to `git push --force` the cleaned `boss-backups` history. This permanently destroys the 173MB Weaviate blob from remote git history. Local + USB snapshots are untouched. Confirm?"

After Kevin confirms:

```bash
cd /tmp/boss-backups-fix
git remote -v
git push origin --force --all
git push origin --force --tags
```

Expected: push succeeds without HTTP 500.

- [ ] **Step 6: Verify the push landed and history is clean**

```bash
cd /tmp/boss-backups-fix
git log --all --oneline | wc -l
git ls-remote origin | head -5
```

Expected: same number of commits locally and remotely; no errors.

- [ ] **Step 7: Wipe and re-clone the production backup work-dir**

The live backup script's `.git-backup-repo` work-dir under `/var/lib/boss-backups/.git-backup-repo` (after migration) still has the broken history. Replace it.

```bash
rm -rf /var/lib/boss-backups/.git-backup-repo
ls /var/lib/boss-backups/ | head
```

Expected: `.git-backup-repo` gone. The dir will be re-cloned by `backup.sh` next run.

- [ ] **Step 8: Commit the cleanup record**

```bash
cd /home/tcntryprd/boss-dev
cat <<'EOF' > scripts/backup-history-cleanup-2026-04-29.md
# boss-backups history cleanup (vD.0.1)
- git filter-repo --strip-blobs-bigger-than 94M
- Force-pushed cleaned backups branch
- Wiped /var/lib/boss-backups/.git-backup-repo (re-cloned on next backup run)
- Pre-existing snapshots in /var/lib/boss-backups/ retained
EOF
git add scripts/backup-history-cleanup-2026-04-29.md
git commit -m "chore(vD.0.1): record boss-backups history cleanup"
```

---

## Task 3: Add 90 MB chunking helpers

**Files:** `scripts/lib/backup-split.sh` (new)

- [ ] **Step 1: Create the helpers file**

Create `scripts/lib/backup-split.sh`:

```bash
#!/usr/bin/env bash
# backup-split.sh — split files >90MB into 90MB chunks, restore via cat
# Sourced by backup.sh

# split_if_large <file>
# If file > 94371840 bytes, splits into <file>.partXX (90MB each), removes original.
# Echoes the resulting file list (one per line). If file is small enough, echoes the original path.
split_if_large() {
    local file="$1"
    local size
    size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file")

    if [ "$size" -le 94371840 ]; then
        echo "$file"
        return 0
    fi

    local base
    base=$(basename "$file")
    local dir
    dir=$(dirname "$file")
    # split: 90MB chunks, suffix = numeric, .partNN extension
    split -b 90M -d -a 2 --additional-suffix=.part "$file" "$dir/$base."
    rm -f "$file"

    # echo each part on its own line
    ls -1 "$dir/$base."*.part 2>/dev/null
}

# join_parts <prefix>
# Concatenates all <prefix>.NN.part files into <prefix>, removes parts.
# Inverse of split_if_large.
join_parts() {
    local prefix="$1"
    cat "$prefix".*.part > "$prefix"
    rm -f "$prefix".*.part
}
```

- [ ] **Step 2: Write a vitest-equivalent shell test**

Create `scripts/lib/backup-split.test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/backup-split.sh"

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Case 1: small file (<90MB) returns unchanged path, file still exists
echo "small content" > "$TMP/small.bin"
result=$(split_if_large "$TMP/small.bin")
[ "$result" = "$TMP/small.bin" ] || { echo "FAIL small: got $result"; exit 1; }
[ -f "$TMP/small.bin" ] || { echo "FAIL small: file removed"; exit 1; }
echo "PASS small file unchanged"

# Case 2: large file (~95MB) splits into 2 parts, original removed
dd if=/dev/urandom of="$TMP/big.bin" bs=1M count=95 2>/dev/null
parts=$(split_if_large "$TMP/big.bin")
part_count=$(echo "$parts" | wc -l)
[ "$part_count" -ge 2 ] || { echo "FAIL big: only $part_count parts"; exit 1; }
[ ! -f "$TMP/big.bin" ] || { echo "FAIL big: original not removed"; exit 1; }
echo "PASS big file split into $part_count parts"

# Case 3: join parts back
mv "$TMP/big.bin.00.part" "$TMP/big.bin.00.part.bak"  # save copy for later compare
mv "$TMP/big.bin.00.part.bak" "$TMP/big.bin.00.part"
join_parts "$TMP/big.bin"
[ -f "$TMP/big.bin" ] || { echo "FAIL join: result missing"; exit 1; }
ls "$TMP/big.bin".*.part 2>/dev/null && { echo "FAIL join: parts not cleaned"; exit 1; }
echo "PASS joined back to single file"

echo "ALL TESTS PASSED"
```

- [ ] **Step 3: Run the shell test**

```bash
chmod +x /home/tcntryprd/boss-dev/scripts/lib/backup-split.sh
chmod +x /home/tcntryprd/boss-dev/scripts/lib/backup-split.test.sh
/home/tcntryprd/boss-dev/scripts/lib/backup-split.test.sh
```

Expected:
```
PASS small file unchanged
PASS big file split into 2 parts
PASS joined back to single file
ALL TESTS PASSED
```

- [ ] **Step 4: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/lib/backup-split.sh scripts/lib/backup-split.test.sh
git commit -m "feat(vD.0.1): backup-split helpers (split >90MB, join parts back)"
```

---

## Task 4: Add USB mirror helper

**Files:** `scripts/lib/backup-mirror.sh` (new)

- [ ] **Step 1: Create the mirror helper**

Create `scripts/lib/backup-mirror.sh`:

```bash
#!/usr/bin/env bash
# backup-mirror.sh — rsync the canonical backup dir to USB
# Sourced by backup.sh after all uploads complete

# mirror_to_usb <source_dir> <usb_mount>
# Returns 0 on success, 1 if USB not mounted (logged but not fatal).
mirror_to_usb() {
    local source_dir="$1"
    local usb_mount="$2"

    # Verify USB is mounted (FAT32 mountpoint check)
    if ! mountpoint -q "$usb_mount" 2>/dev/null; then
        echo "  [usb-mirror] WARN: $usb_mount is not mounted, skipping"
        return 1
    fi

    # Verify writable
    if ! touch "$usb_mount/.write-test" 2>/dev/null; then
        echo "  [usb-mirror] WARN: $usb_mount not writable, skipping"
        return 1
    fi
    rm -f "$usb_mount/.write-test"

    echo "  [usb-mirror] rsync $source_dir → $usb_mount"
    rsync -av --delete \
        --exclude='.git-backup-repo' \
        --exclude='*.tmp' \
        "$source_dir/" "$usb_mount/" 2>&1 | tail -5

    local usb_free
    usb_free=$(df -h "$usb_mount" | awk 'NR==2 {print $4}')
    echo "  [usb-mirror] OK ($usb_free free on USB)"
}
```

- [ ] **Step 2: Quick smoke**

```bash
chmod +x /home/tcntryprd/boss-dev/scripts/lib/backup-mirror.sh
source /home/tcntryprd/boss-dev/scripts/lib/backup-mirror.sh
mirror_to_usb /var/lib/boss-backups /mnt/usb-backups
ls /mnt/usb-backups/ | head -10
```

Expected: rsync runs, encrypted snapshots appear on USB, free-space report prints.

- [ ] **Step 3: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/lib/backup-mirror.sh
git commit -m "feat(vD.0.1): USB mirror helper (rsync to /mnt/usb-backups, soft-fail if unmounted)"
```

---

## Task 5: Wire chunking + USB mirror into backup.sh

**Files:** `scripts/backup.sh` (modify)

- [ ] **Step 1: Update BACKUP_DIR default and source helpers**

Open `scripts/backup.sh`. Find the line `BACKUP_DIR="${BACKUP_DIR:-/tmp/boss-backups}"` and change to:

```bash
BACKUP_DIR="${BACKUP_DIR:-/var/lib/boss-backups}"
USB_MIRROR_DIR="${USB_MIRROR_DIR:-/mnt/usb-backups}"

# Source helpers
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/backup-split.sh"
source "$SCRIPT_DIR/lib/backup-mirror.sh"
```

(Adjust the `SCRIPT_DIR` line — the existing script already defines it near the top; if so, just add the two `source` lines after the existing `SCRIPT_DIR=` line.)

- [ ] **Step 2: Update upload_git() to chunk before commit**

In `scripts/backup.sh`, find `upload_git()` (around line 200). Replace its body with:

```bash
upload_git() {
    local file="$1"
    local filename=$(basename "$file")

    echo "  Uploading to Git: $filename"

    local git_repo="${BACKUP_GIT_REPO:-}"
    local git_branch="${BACKUP_GIT_BRANCH:-backups}"

    if [ -z "$git_repo" ]; then
        echo "  ERROR: BACKUP_GIT_REPO not set"
        return 1
    fi

    local git_dir="$BACKUP_DIR/.git-backup-repo"

    if [ ! -d "$git_dir/.git" ]; then
        git clone --depth 1 -b "$git_branch" "$git_repo" "$git_dir" 2>/dev/null || {
            git clone "$git_repo" "$git_dir"
            cd "$git_dir"
            git checkout -b "$git_branch"
            cd - > /dev/null
        }
    else
        cd "$git_dir"
        git pull --rebase 2>/dev/null || true
        cd - > /dev/null
    fi

    # Stage file in the git workdir, splitting if oversize
    cp "$file" "$git_dir/$filename"
    cd "$git_dir"

    # Use the helper — split returns one path (small file) or multiple (chunks)
    local staged_files
    staged_files=$(split_if_large "$git_dir/$filename")

    # `staged_files` is newline-separated; add each
    while IFS= read -r staged; do
        [ -z "$staged" ] && continue
        git add "$(basename "$staged")"
    done <<< "$staged_files"

    git commit -m "Backup: $filename" --quiet 2>/dev/null || true
    git push origin "$git_branch" --quiet
    cd - > /dev/null

    echo "  Pushed to $git_branch (chunks: $(echo "$staged_files" | wc -l))"
}
```

- [ ] **Step 3: Add USB mirror call at end of main flow**

In `scripts/backup.sh`, find the section that runs after all uploads (near the bottom, before any final summary echo). Add:

```bash
# Layer 3: USB local mirror (best-effort, non-fatal)
if [ -n "${USB_MIRROR_DIR:-}" ] && [ -d "$USB_MIRROR_DIR" ]; then
    echo ""
    echo "--- USB Mirror ---"
    mirror_to_usb "$BACKUP_DIR" "$USB_MIRROR_DIR" || \
        echo "  [usb-mirror] continuing despite USB mirror failure"
fi
```

- [ ] **Step 4: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/backup.sh
git commit -m "feat(vD.0.1): backup.sh chunks >90MB files, mirrors to USB, uses /var/lib/boss-backups"
```

---

## Task 6: n8n workflow export (encrypted before push)

**Files:** `scripts/lib/encrypt-helper.sh` (new), `scripts/n8n-workflow-export.sh` (new), crontab

The new repos (n8n, cc-memory, cc-config) push **encrypted files** to GitHub — same AES-256-CBC pattern as the existing backup.sh. The `encrypt_file()` function lives in backup.sh; extracting to a shared helper so the new scripts can use it.

- [ ] **Step 1: Extract the shared encryption helper**

Create `scripts/lib/encrypt-helper.sh`:

```bash
#!/usr/bin/env bash
# encrypt-helper.sh — AES-256-CBC encryption for backup files
# Sourced by backup.sh, n8n-workflow-export.sh, cc-memory-backup.sh
# Requires: BACKUP_ENCRYPTION_KEY env var (>=32 chars)

# encrypt_file <input_path>
# Encrypts in place: removes <input_path>, creates <input_path>.enc with IV prepended.
# Echoes the .enc path on success. Exits 1 on missing key.
encrypt_file() {
    local input_file="$1"
    local output_file="${input_file}.enc"

    if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
        echo "ERROR: BACKUP_ENCRYPTION_KEY required" >&2
        return 1
    fi

    local iv
    iv=$(openssl rand -hex 16)

    echo -n "$iv" | xxd -r -p > "$output_file"
    openssl enc -aes-256-cbc -salt \
        -in "$input_file" \
        -K "$(echo -n "$BACKUP_ENCRYPTION_KEY" | xxd -p | tr -d '\n' | head -c 64)" \
        -iv "$iv" \
        >> "$output_file"

    rm -f "$input_file"
    echo "$output_file"
}
```

- [ ] **Step 2: Refactor existing backup.sh to source the helper**

In `scripts/backup.sh`, find the existing `encrypt_file()` function (lines ~80-95 per audit) and **replace** the function body with a single sourced line at the top of the file (right after the existing `source` lines from Task 5):

```bash
source "$SCRIPT_DIR/lib/encrypt-helper.sh"
```

Then delete the inlined `encrypt_file() { ... }` definition entirely (the sourced version is identical behavior).

Verify by running a test backup after Task 5 finishes.

- [ ] **Step 3: Create the n8n export script**

Create `scripts/n8n-workflow-export.sh`:

```bash
#!/usr/bin/env bash
# n8n-workflow-export.sh — daily encrypted dump of all n8n workflows
# Schedule: 30 4 * * *  (4:30 UTC, after main backup)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
[ -f "$PROJECT_DIR/.env" ] && { set -a; source "$PROJECT_DIR/.env"; set +a; }

source "$SCRIPT_DIR/lib/encrypt-helper.sh"
source "$SCRIPT_DIR/backup-status.sh"

ARCHIVE_DIR="${N8N_ARCHIVE_DIR:-/home/tcntryprd/n8n-workflow-archive}"
N8N_CONTAINER="${N8N_CONTAINER:-n8n}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DATE_DIR=$(date +%Y%m%d)

mkdir -p "$ARCHIVE_DIR/workflows" "$ARCHIVE_DIR/logs"
LOGFILE="$ARCHIVE_DIR/logs/export-$DATE_DIR.log"
exec > >(tee -a "$LOGFILE") 2>&1
echo "============================================"
echo "n8n workflow export — $TIMESTAMP"
echo "============================================"

# Dump all workflows into one bundle (easier to encrypt + commit as one file)
BUNDLE="$ARCHIVE_DIR/workflows/n8n-workflows-$DATE_DIR.json"
{
    echo '{'
    echo '  "exported_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",'
    echo '  "workflows": ['
    first=1
    docker exec "$N8N_CONTAINER" n8n list:workflow 2>/dev/null | tail -n +2 | while read -r line; do
        id=$(echo "$line" | awk -F'|' '{print $1}' | xargs)
        [ -z "$id" ] && continue
        if [ "$first" = "1" ]; then first=0; else echo ','; fi
        docker exec "$N8N_CONTAINER" n8n export:workflow --id="$id" --pretty 2>/dev/null \
            || echo '{}'
    done
    echo
    echo '  ]'
    echo '}'
} > "$BUNDLE"

count=$(grep -c '"id"' "$BUNDLE" 2>/dev/null || echo 0)
size=$(stat -c%s "$BUNDLE")
echo "Exported $count workflows, $size bytes"

# Encrypt the bundle (Layer 2 protection)
encrypted=$(encrypt_file "$BUNDLE")
echo "Encrypted: $(basename "$encrypted")"

# Commit + push to private GitHub repo (Layer 1: repo-level auth)
cd "$ARCHIVE_DIR"
if [ ! -d .git ]; then
    git init -q
    git remote add origin "https://github.com/TCntryPrd/n8n-workflow-archive.git" 2>/dev/null || true
    git checkout -b main 2>/dev/null || true
fi
git add -A workflows/ logs/
if git diff --cached --quiet; then
    echo "No changes since last export"
    report_asset_success "n8n" "$encrypted"
else
    git commit -q -m "n8n-export: $TIMESTAMP ($count workflows)"
    if git push origin HEAD:main --quiet 2>&1; then
        report_asset_success "n8n" "$encrypted"
        echo "Pushed to GitHub"
    else
        report_asset_failure "n8n" "git push failed"
        echo "  WARN: push failed (will retry next run)"
    fi
fi

# Clean up local plaintext-bundle leftovers (already deleted by encrypt_file but be safe)
find "$ARCHIVE_DIR/workflows/" -name '*.json' -mtime +0 -delete 2>/dev/null || true

echo "Done."
```

- [ ] **Step 2: Create the GitHub repo**

```bash
gh repo create TCntryPrd/n8n-workflow-archive --private --description "Daily dumps of n8n workflows from last-castle"
```

Expected: repo URL printed.

- [ ] **Step 3: Test the script manually**

```bash
chmod +x /home/tcntryprd/boss-dev/scripts/n8n-workflow-export.sh
/home/tcntryprd/boss-dev/scripts/n8n-workflow-export.sh
ls /home/tcntryprd/n8n-workflow-archive/workflows/ | head -10
ls /home/tcntryprd/n8n-workflow-archive/workflows/ | wc -l
```

Expected: ≥17 JSON files (per audit). `git log` in `/home/tcntryprd/n8n-workflow-archive` shows one commit. Repo on GitHub has the workflows.

- [ ] **Step 4: Add cron entry**

```bash
crontab -l > /tmp/cron-current
echo '30 4 * * * /home/tcntryprd/boss-dev/scripts/n8n-workflow-export.sh >> /home/tcntryprd/scripts/logs/n8n-export.log 2>&1' >> /tmp/cron-current
crontab /tmp/cron-current
crontab -l | grep n8n-workflow
```

Expected: the cron line is present in `crontab -l`.

- [ ] **Step 5: Commit the script**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/n8n-workflow-export.sh
git commit -m "feat(vD.0.1): nightly n8n workflow export → GitHub archive"
```

---

## Task 7: cc-memory + cc-config backup

**Files:** `scripts/cc-memory-backup.sh` (new), crontab, two new GitHub repos

- [ ] **Step 1: Create the backup script (with encryption)**

Create `scripts/cc-memory-backup.sh`:

```bash
#!/usr/bin/env bash
# cc-memory-backup.sh — daily encrypted backup of ~/.claude memory + config
# Schedule: 35 4 * * *  (4:35 UTC, after n8n export)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
[ -f "$PROJECT_DIR/.env" ] && { set -a; source "$PROJECT_DIR/.env"; set +a; }

source "$SCRIPT_DIR/lib/encrypt-helper.sh"
source "$SCRIPT_DIR/backup-status.sh"

MEMORY_REPO="${CC_MEMORY_REPO:-/home/tcntryprd/cc-memory}"
CONFIG_REPO="${CC_CONFIG_REPO:-/home/tcntryprd/cc-config}"
SOURCE_MEMORY="$HOME/.claude/projects/-home-tcntryprd--claude/memory"
SOURCE_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
SOURCE_OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
SOURCE_CLAUDE_SETTINGS="$HOME/.claude/settings.json"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

backup_one_repo() {
    local repo_dir="$1"
    local origin_url="$2"
    local asset_name="$3"
    local bundle_name="$4"
    shift 4
    local sources=("$@")  # paths to bundle

    mkdir -p "$repo_dir"
    cd "$repo_dir"
    if [ ! -d .git ]; then
        git init -q
        git remote add origin "$origin_url" 2>/dev/null || true
        git checkout -b main 2>/dev/null || true
    fi

    # Bundle the sources into a tar.gz, then encrypt
    local bundle="$repo_dir/${bundle_name}-${TIMESTAMP}.tar.gz"
    local existing=()
    for s in "${sources[@]}"; do
        [ -e "$s" ] && existing+=("$s")
    done
    if [ ${#existing[@]} -eq 0 ]; then
        echo "$asset_name: no sources found, skipping"
        return 0
    fi

    tar -czf "$bundle" "${existing[@]}" 2>/dev/null
    local encrypted
    encrypted=$(encrypt_file "$bundle")
    echo "$asset_name: encrypted $(basename "$encrypted") ($(stat -c%s "$encrypted") bytes)"

    git add -A
    if git diff --cached --quiet; then
        echo "$asset_name: no changes"
        report_asset_success "$asset_name" "$encrypted"
    else
        git commit -q -m "$asset_name backup: $TIMESTAMP"
        if git push origin HEAD:main --quiet 2>&1; then
            report_asset_success "$asset_name" "$encrypted"
            echo "$asset_name: pushed to GitHub"
        else
            report_asset_failure "$asset_name" "git push failed"
            echo "  WARN: $asset_name push failed"
        fi
    fi
}

# Backup memory (everything in the memory dir + CLAUDE.md)
backup_one_repo \
    "$MEMORY_REPO" \
    "https://github.com/TCntryPrd/cc-memory.git" \
    "cc-memory" \
    "cc-memory" \
    "$SOURCE_MEMORY" "$SOURCE_CLAUDE_MD"

# Backup config (openclaw.json + claude settings.json)
backup_one_repo \
    "$CONFIG_REPO" \
    "https://github.com/TCntryPrd/cc-config.git" \
    "cc-config" \
    "cc-config" \
    "$SOURCE_OPENCLAW_JSON" "$SOURCE_CLAUDE_SETTINGS"

echo "Done."
```

- [ ] **Step 2: Create the two GitHub repos**

```bash
gh repo create TCntryPrd/cc-memory --private --description "IR Custom AIOS main-session memory files (auto-backup)"
gh repo create TCntryPrd/cc-config --private --description "IR Custom AIOS main-session config files (auto-backup)"
```

- [ ] **Step 3: Test the script manually**

```bash
chmod +x /home/tcntryprd/boss-dev/scripts/cc-memory-backup.sh
/home/tcntryprd/boss-dev/scripts/cc-memory-backup.sh
ls /home/tcntryprd/cc-memory/*.enc | head -3
ls /home/tcntryprd/cc-config/*.enc | head -3
git -C /home/tcntryprd/cc-memory log --oneline -2
git -C /home/tcntryprd/cc-config log --oneline -2
```

Expected: one `cc-memory-<timestamp>.tar.gz.enc` in `cc-memory/` and one `cc-config-<timestamp>.tar.gz.enc` in `cc-config/`, both pushed to GitHub. The plaintext bundle is NOT on disk (encrypt_file removed it).

- [ ] **Step 4: Add cron entry**

```bash
crontab -l > /tmp/cron-current
echo '35 4 * * * /home/tcntryprd/boss-dev/scripts/cc-memory-backup.sh >> /home/tcntryprd/scripts/logs/cc-memory.log 2>&1' >> /tmp/cron-current
crontab /tmp/cron-current
crontab -l | grep cc-memory
```

- [ ] **Step 5: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/cc-memory-backup.sh
git commit -m "feat(vD.0.1): nightly cc-memory + cc-config backup → GitHub"
```

---

## Task 8: backup-status writer + brain tool

**Files:** `scripts/backup-status.sh` (new), `apps/api/src/tools/backup-status.ts` (new), `apps/api/src/tools/registry.ts` (modify), `apps/api/src/tools/trust.ts` (modify), `apps/api/src/tools/backup-status.test.ts` (new)

- [ ] **Step 1: Status writer (called by backup.sh after each run)**

Create `scripts/backup-status.sh`:

```bash
#!/usr/bin/env bash
# backup-status.sh — write JSON status snapshot for boss_backup_status tool to read
# Sourced by backup.sh
set -uo pipefail

STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/boss-backups/status.json}"

# write_status_entry <asset> <last_attempt_iso> <success_iso_or_empty> <size_bytes_or_0> <last_error_or_empty>
write_status_entry() {
    local asset="$1"
    local attempt="$2"
    local success="$3"
    local size="$4"
    local err="$5"

    python3 - <<PY 2>/dev/null
import json, os, sys
status = {}
if os.path.exists("$STATUS_FILE"):
    try: status = json.load(open("$STATUS_FILE"))
    except Exception: status = {}
status["$asset"] = {
    "last_attempt": "$attempt",
    "last_success": "$success",
    "size_bytes": int("$size") if "$size" else 0,
    "last_error": "$err"
}
status["_written_at"] = "$attempt"
with open("$STATUS_FILE", "w") as f: json.dump(status, f, indent=2)
PY
}

# Convenience wrapper for backup.sh: report_asset_success <asset> <file>
report_asset_success() {
    local asset="$1"
    local file="$2"
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local size
    size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
    write_status_entry "$asset" "$now" "$now" "$size" ""
}

# report_asset_failure <asset> <error_message>
report_asset_failure() {
    local asset="$1"
    local err="$2"
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Preserve last_success if any
    python3 - <<PY 2>/dev/null
import json, os, sys
status = {}
if os.path.exists("$STATUS_FILE"):
    try: status = json.load(open("$STATUS_FILE"))
    except Exception: status = {}
prev = status.get("$asset", {})
status["$asset"] = {
    "last_attempt": "$now",
    "last_success": prev.get("last_success", ""),
    "size_bytes": prev.get("size_bytes", 0),
    "last_error": "$err"[:500]
}
status["_written_at"] = "$now"
with open("$STATUS_FILE", "w") as f: json.dump(status, f, indent=2)
PY
}
```

- [ ] **Step 2: Wire status calls into backup.sh**

In `scripts/backup.sh`, near the top after sourcing other helpers, add:

```bash
source "$SCRIPT_DIR/backup-status.sh"
```

Then in `backup_postgres()` (after the `local encrypted=$(encrypt_file ...)` line), add:

```bash
report_asset_success "postgres" "$encrypted"
```

And similarly in `backup_weaviate()`:

```bash
report_asset_success "weaviate" "$encrypted"
```

For failure reporting, wrap the upload calls in trap-style guards. Example for `upload_git`:

```bash
if upload_git "$encrypted"; then
    report_asset_success "$asset_label" "$encrypted"
else
    report_asset_failure "$asset_label" "git push failed"
    return 1
fi
```

(Replace the existing simple call site at the end of the postgres + weaviate flows.)

The n8n + cc-memory + cc-config scripts also need to call `write_status_entry` — easiest way is for each script to source `backup-status.sh` and call `report_asset_success "<asset>" "<file>"` on success. Add those calls to the three other scripts (Tasks 6, 7) — single line near the end of each.

- [ ] **Step 3: Brain tool TypeScript implementation**

Create `apps/api/src/tools/backup-status.ts`:

```typescript
import { promises as fs } from 'node:fs';
import type { BrainTool } from './types';

const STATUS_FILE = process.env.BACKUP_STATUS_FILE
  ?? '/var/lib/boss-backups/status.json';

const REQUIRED_ASSETS = [
  'postgres',
  'weaviate',
  'n8n',
  'cc-memory',
  'cc-config',
] as const;

export const boss_backup_status: BrainTool = {
  name: 'boss_backup_status',
  description:
    'Reports last-attempt and last-success timestamps for each backup asset (postgres, weaviate, n8n, cc-memory, cc-config). Returns "stale" status if any asset has not had a successful backup in >25h. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  trustLevel: 'observer',
  async run(_input, _ctx) {
    let status: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(STATUS_FILE, 'utf-8');
      status = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        error: 'status_file_unreadable',
        path: STATUS_FILE,
        detail: e instanceof Error ? e.message : String(e),
      };
    }

    const now = Date.now();
    const STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000;

    const assetReports = REQUIRED_ASSETS.map((asset) => {
      const entry = (status[asset] as Record<string, unknown> | undefined) ?? null;
      if (!entry) {
        return {
          asset,
          state: 'never_attempted' as const,
          last_attempt: null,
          last_success: null,
          age_hours: null,
          size_bytes: 0,
          last_error: null,
        };
      }
      const lastSuccess = entry.last_success as string;
      const successMs = lastSuccess ? Date.parse(lastSuccess) : NaN;
      const ageMs = Number.isFinite(successMs) ? now - successMs : Infinity;
      const isStale = ageMs > STALE_THRESHOLD_MS;
      return {
        asset,
        state: isStale ? ('stale' as const) : ('fresh' as const),
        last_attempt: (entry.last_attempt as string) ?? null,
        last_success: lastSuccess || null,
        age_hours: Number.isFinite(ageMs)
          ? Math.round((ageMs / 3600000) * 10) / 10
          : null,
        size_bytes: (entry.size_bytes as number) ?? 0,
        last_error: (entry.last_error as string) || null,
      };
    });

    const anyStale = assetReports.some(
      (r) => r.state === 'stale' || r.state === 'never_attempted',
    );

    return {
      ok: true,
      overall: anyStale ? 'degraded' : 'healthy',
      checked_at: new Date(now).toISOString(),
      stale_threshold_hours: 25,
      assets: assetReports,
    };
  },
};
```

- [ ] **Step 4: Register the tool**

Open `apps/api/src/tools/registry.ts`. Find the section where `boss_sys_info` is registered (around line 130 per audit) and add nearby:

```typescript
import { boss_backup_status } from './backup-status';
```

In the assembly array, add `boss_backup_status` to the list. The pattern matches existing registrations (the audit cited registry.ts:64-198).

- [ ] **Step 5: Trust gate**

Open `apps/api/src/tools/trust.ts`. Add `boss_backup_status: 'observer'` to the per-tool gate map (line 40-182 per audit).

- [ ] **Step 6: Vitest**

Create `apps/api/src/tools/backup-status.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { boss_backup_status } from './backup-status';

const TMP_STATUS = '/tmp/boss-backup-status-test.json';

beforeEach(() => {
  process.env.BACKUP_STATUS_FILE = TMP_STATUS;
});

afterEach(async () => {
  await fs.rm(TMP_STATUS, { force: true });
});

describe('boss_backup_status', () => {
  it('returns ok=false when status file missing', async () => {
    const out = await boss_backup_status.run({}, {} as never);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toBe('status_file_unreadable');
  });

  it('reports fresh + healthy when all assets within 25h', async () => {
    const now = new Date().toISOString();
    await fs.writeFile(
      TMP_STATUS,
      JSON.stringify({
        postgres: { last_attempt: now, last_success: now, size_bytes: 7300000 },
        weaviate: { last_attempt: now, last_success: now, size_bytes: 220000000 },
        n8n: { last_attempt: now, last_success: now, size_bytes: 50000 },
        'cc-memory': { last_attempt: now, last_success: now, size_bytes: 1000000 },
        'cc-config': { last_attempt: now, last_success: now, size_bytes: 5000 },
      }),
    );
    const out = (await boss_backup_status.run({}, {} as never)) as {
      ok: boolean;
      overall: string;
      assets: Array<{ asset: string; state: string }>;
    };
    expect(out.ok).toBe(true);
    expect(out.overall).toBe('healthy');
    expect(out.assets.every((a) => a.state === 'fresh')).toBe(true);
  });

  it('reports degraded + stale when an asset is >25h old', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    await fs.writeFile(
      TMP_STATUS,
      JSON.stringify({
        postgres: { last_attempt: now, last_success: now, size_bytes: 7300000 },
        weaviate: { last_attempt: old, last_success: old, size_bytes: 220000000 },
        n8n: { last_attempt: now, last_success: now, size_bytes: 50000 },
        'cc-memory': { last_attempt: now, last_success: now, size_bytes: 1000000 },
        'cc-config': { last_attempt: now, last_success: now, size_bytes: 5000 },
      }),
    );
    const out = (await boss_backup_status.run({}, {} as never)) as {
      ok: boolean;
      overall: string;
      assets: Array<{ asset: string; state: string }>;
    };
    expect(out.ok).toBe(true);
    expect(out.overall).toBe('degraded');
    expect(out.assets.find((a) => a.asset === 'weaviate')?.state).toBe('stale');
  });

  it('reports degraded when any asset never attempted', async () => {
    const now = new Date().toISOString();
    await fs.writeFile(
      TMP_STATUS,
      JSON.stringify({
        postgres: { last_attempt: now, last_success: now, size_bytes: 7300000 },
      }),
    );
    const out = (await boss_backup_status.run({}, {} as never)) as {
      ok: boolean;
      overall: string;
      assets: Array<{ asset: string; state: string }>;
    };
    expect(out.overall).toBe('degraded');
    expect(out.assets.find((a) => a.asset === 'weaviate')?.state).toBe(
      'never_attempted',
    );
  });
});
```

- [ ] **Step 7: Run vitest**

```bash
cd /home/tcntryprd/boss-dev && npx vitest run apps/api/src/tools/backup-status.test.ts 2>&1 | tail -10
```

Expected: 4 passed.

- [ ] **Step 8: tsc clean**

```bash
cd /home/tcntryprd/boss-dev/apps/api && npx tsc --noEmit 2>&1 | grep -v 'react-native' | grep -i 'error TS' | head -5
```

Expected: empty.

- [ ] **Step 9: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/backup-status.sh \
        scripts/backup.sh \
        scripts/n8n-workflow-export.sh \
        scripts/cc-memory-backup.sh \
        apps/api/src/tools/backup-status.ts \
        apps/api/src/tools/backup-status.test.ts \
        apps/api/src/tools/registry.ts \
        apps/api/src/tools/trust.ts
git commit -m "feat(vD.0.1): boss_backup_status brain tool + status writer wired into backup scripts"
```

---

## Task 9: Deploy-smoke #46

**Files:** `scripts/deploy.sh` (modify)

- [ ] **Step 1: Find insertion point**

The audit notes the last existing smoke is the Kanban SSE smoke (#40 from v1.7.12). Insert smoke #46 after it.

- [ ] **Step 2: Append the smoke**

In `scripts/deploy.sh`, find the line `log "Kanban SSE smoke passed (task.changed event observed within 2s of mutation)"` and immediately after, before `log "Deployment complete"`, append:

```bash
# Backup-status smoke (vD.0.1): every backup asset must have last_success
# within 25h. Catches silent backup-push failures like the 6-night
# boss-backups regression of 2026-04-23.
log "Running backup-status smoke..."
status_resp=$(docker exec boss_api wget -qO- \
    --header="X-BOSS-Internal: true" \
    --header="X-Tenant-ID: default" \
    "http://127.0.0.1:8001/api/tools/run" \
    --post-data='{"name":"boss_backup_status","input":{}}' \
    2>/dev/null || echo "")

overall=$(echo "$status_resp" | python3 -c '
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get("output", {}).get("overall", "unknown"))
except Exception as e:
  print("parse_error")' 2>/dev/null)

if [ "$overall" != "healthy" ]; then
    fail "Backup-status smoke failed: boss_backup_status reports overall='$overall'. One or more backup assets have not succeeded within 25h. Check boss_api logs and /var/lib/boss-backups/status.json. Most common: a backup script failed silently or last night's cron didn't run."
fi
log "Backup-status smoke passed (overall=$overall)"
```

- [ ] **Step 3: Bash syntax check**

```bash
bash -n /home/tcntryprd/boss-dev/scripts/deploy.sh && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add scripts/deploy.sh
git commit -m "feat(vD.0.1): deploy-smoke #46 — boss_backup_status overall=healthy"
```

---

## Task 10: End-to-end verification (manual full backup run)

**Files:** none (read-only verification)

- [ ] **Step 1: Trigger a manual full backup**

```bash
cd /home/tcntryprd/boss-dev
sudo BACKUP_DIR=/var/lib/boss-backups USB_MIRROR_DIR=/mnt/usb-backups \
    bash scripts/backup.sh --type full --dest git 2>&1 | tail -40
```

Expected output highlights:
- `--- Postgres Backup ---` then `Pushed to backups`
- `--- Weaviate Backup ---` then `Pushed to backups (chunks: 3)` (or however many 90MB chunks)
- `--- USB Mirror ---` then `[usb-mirror] OK (X.XG free on USB)`
- No HTTP 500 errors

- [ ] **Step 2: Verify GitHub got the new files**

```bash
cd /tmp && rm -rf boss-backups-verify && \
    git clone --depth=1 -b backups https://github.com/TCntryPrd/boss-backups boss-backups-verify && \
    ls -la boss-backups-verify/ | grep -E "$(date +%Y%m%d)" | head -10
```

Expected: today's `.enc` files (and `.part` chunks for Weaviate) all present.

- [ ] **Step 3: Verify USB got the same files**

```bash
ls -la /mnt/usb-backups/ | head -20
df -h /mnt/usb-backups
```

Expected: today's `.enc` files visible, ample free space.

- [ ] **Step 4: Verify status.json is current**

```bash
cat /var/lib/boss-backups/status.json | python3 -m json.tool | head -40
```

Expected: each asset has a `last_success` timestamp from minutes ago.

- [ ] **Step 5: Trigger n8n + cc-memory exports manually and verify**

```bash
/home/tcntryprd/boss-dev/scripts/n8n-workflow-export.sh
/home/tcntryprd/boss-dev/scripts/cc-memory-backup.sh
git -C /home/tcntryprd/n8n-workflow-archive log --oneline -3
git -C /home/tcntryprd/cc-memory log --oneline -3
git -C /home/tcntryprd/cc-config log --oneline -3
cat /var/lib/boss-backups/status.json | python3 -c '
import sys, json
d = json.load(sys.stdin)
for k in ["postgres","weaviate","n8n","cc-memory","cc-config"]:
    print(f"{k}: {d.get(k,{}).get(\"last_success\",\"NEVER\")}")'
```

Expected: each asset reports a `last_success` from today.

- [ ] **Step 6: Test the brain tool via API**

After `boss_api` is restarted (which only happens on next deploy), the tool will be registered. For now, run a unit invocation:

```bash
cd /home/tcntryprd/boss-dev/apps/api && \
    npx vitest run src/tools/backup-status.test.ts 2>&1 | tail -10
```

Expected: 4 passed (this is the same test from Task 8 Step 7; rerunning to confirm nothing regressed).

---

## Task 11: Recovery playbook

**Files:** `docs/playbooks/backup-recovery.md` (new)

- [ ] **Step 1: Write the playbook**

Create `docs/playbooks/backup-recovery.md`:

```markdown
# Backup Recovery Playbook (vD.0.1+)

## Layers

1. **GitHub** (canonical off-host) — `boss-backups`, `n8n-workflow-archive`, `cc-memory`, `cc-config`. AES-256-CBC encrypted per file. Some files split into 90MB `.partNN.enc` chunks.
2. **USB local mirror** — `/mnt/usb-backups/` (FAT32 on `/dev/sda1`).
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
import json, sys
d = json.load(open("/tmp/n8n-restore/n8n-workflows-*.json".replace("*", sys.argv[1])))
for wf in d["workflows"]:
    open(f"/tmp/n8n-restore/wf-{wf[\"id\"]}.json", "w").write(json.dumps(wf))
' <DATE>
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
cp /tmp/cfg-restore/home/tcntryprd/.openclaw/openclaw.json ~/.openclaw/
cp /tmp/cfg-restore/home/tcntryprd/.claude/settings.json ~/.claude/settings.json
```

## Disaster scenarios

- **GitHub unreachable:** USB at `/mnt/usb-backups/` has same `.enc` files. Decrypt with the same key.
- **USB lost AND GitHub unreachable:** `/var/lib/boss-backups/` retains 15 days local.
- **Whole box lost:** `BACKUP_ENCRYPTION_KEY` is in `.env` which is in the source repo (`boss-dev`). It's NOT in any backup intentionally — clone `boss-dev` to a fresh box first, then restore from GitHub.
- **`BACKUP_ENCRYPTION_KEY` lost:** All backups become unreadable. Key must be archived separately (1Password / Kevin's head / paper in safe).
```

- [ ] **Step 2: Commit**

```bash
cd /home/tcntryprd/boss-dev
git add docs/playbooks/backup-recovery.md
git commit -m "docs(vD.0.1): backup recovery playbook"
```

---

## Task 12: Push, PR, merge, tag, CI green, verify, memory

**Files:** none new; ship ceremony

- [ ] **Step 1: Push branch + create PR**

```bash
cd /home/tcntryprd/boss-dev
git checkout -b feat/vD-0-1-backup-fix
git push -u origin feat/vD-0-1-backup-fix
gh pr create --title "vD.0.1 — backup-push fix + USB mirror + status tool" --body "$(cat <<'EOF'
## Summary

Closes the 6-night silent backup-push failure that started 2026-04-23 when
a 173.94 MB Weaviate snapshot exceeded GitHub's 100MB file ceiling and
blocked every subsequent push to `boss-backups`.

## What this ships

- **boss-backups history cleaned** via `git filter-repo` (>94MB blobs purged)
- **90MB chunking** via `scripts/lib/backup-split.sh` — large artifacts split before commit, joined on restore
- **USB local mirror** at `/mnt/usb-backups/` (`/dev/sda1` 14.6G FAT32) via `scripts/lib/backup-mirror.sh`
- **Persistent local snapshot dir** at `/var/lib/boss-backups/` (replaces `/tmp/`)
- **3 new private GitHub repos** for the previously-unbacked assets:
  - `n8n-workflow-archive` — daily exports of all n8n workflows (17 today)
  - `cc-memory` — `~/.claude/projects/.../memory/` + `~/.claude/CLAUDE.md`
  - `cc-config` — `~/.openclaw/openclaw.json` + `~/.claude/settings.json`
- **`boss_backup_status` brain tool** (observer-tier) reports per-asset
  freshness; healthy if all <25h, degraded otherwise
- **Deploy-smoke #46** asserts `boss_backup_status` returns `overall=healthy`
- **Recovery playbook** at `docs/playbooks/backup-recovery.md`

## Out of scope (deferred)

- Off-host non-GitHub destination (B2/S3/MinIO) — Kevin's call to defer
- Container volume snapshots — that's vD.1.0
- Backup observability dashboard UI — that's vD.1.1

## Test plan

- [x] Shell tests for `backup-split.sh` (small + large + join roundtrip) pass
- [x] vitest for `boss_backup_status` (4 cases: missing file, healthy, stale, never_attempted) pass
- [x] tsc clean in `apps/api`
- [x] Manual full backup run produces fresh GitHub commits + USB mirror
- [x] `status.json` reflects all 5 assets with timestamps
- [ ] CI deploy + 46 smokes green
- [ ] Manual: in production, `boss_backup_status` invokable and returns healthy

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Squash-merge**

```bash
PR_NUM=$(gh pr list --head feat/vD-0-1-backup-fix --json number --jq '.[0].number')
gh pr merge "$PR_NUM" --squash --subject "feat: vD.0.1 — backup-push fix + USB mirror + status tool (#${PR_NUM})"
git checkout master && git pull --ff-only origin master
```

- [ ] **Step 3: Tag (date-check first per standing rule #37)**

```bash
date -u    # confirm minute is in 05..50 (avoid auto-backup window)
git tag vD.0.1 -m "vD.0.1 — backup-push fix + USB mirror + status tool"
git push origin vD.0.1
git rev-list -n 1 vD.0.1   # confirm = master HEAD
git rev-parse master
```

- [ ] **Step 4: Watch CI to green**

```bash
RUN_ID=$(gh run list --limit 1 --json databaseId,headBranch --jq '.[0] | select(.headBranch=="vD.0.1") | .databaseId')
gh run watch "$RUN_ID" --exit-status
```

Expected: `✓ Run deploy`, `✓ Notify deployment success`. Smoke #46 in particular must pass.

- [ ] **Step 5: Verify production**

```bash
docker ps --filter 'name=boss_(api|web|worker|executor)' --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker exec boss_api wget -qO- \
    --header='X-BOSS-Internal: true' \
    --header='X-Tenant-ID: d05cde41-4754-4f1f-ae13-ecb0be8b6fad' \
    'http://127.0.0.1:8001/api/tools/run' \
    --post-data='{"name":"boss_backup_status","input":{}}' \
    | python3 -m json.tool | head -30
```

Expected: 4/4 healthy on `:vD.0.1`; tool returns `overall=healthy`.

- [ ] **Step 6: Memory pointer**

Append to `~/.claude/projects/-home-tcntryprd--claude/memory/MEMORY.md` (top, new line 1):

```
- [IR Custom AIOS vD.0.1 shipped (2026-04-29 PM, durability stream first ship)](project_boss_vd_0_1_shipped.md) — backup-push fix: boss-backups git-filter-repo'd to drop 173MB blob, 90MB chunking via scripts/lib/backup-split.sh, USB local mirror at /mnt/usb-backups (sda1 14.6G FAT32) via rsync, /var/lib/boss-backups replaces /tmp, 3 new private GitHub repos (n8n-workflow-archive, cc-memory, cc-config), boss_backup_status brain tool (observer-tier), deploy-smoke #46 asserts overall=healthy, recovery playbook at docs/playbooks/backup-recovery.md. Closes 6-night failed-push regression that started 2026-04-23. PR #N → master `<HASH>` → tag vD.0.1 → CI green → 4/4 containers on :vD.0.1. First sovereignty-stream sibling vS.0.1 is next.
```

And write the body file `~/.claude/projects/-home-tcntryprd--claude/memory/project_boss_vd_0_1_shipped.md` with full ship details (mirror the v1.7.12 template).

---

## Definition of done

- [ ] All 12 tasks above complete
- [ ] `boss_backup_status` returns `overall=healthy` against the live `/var/lib/boss-backups/status.json`
- [ ] GitHub `boss-backups` repo has today's snapshots, no failed pushes
- [ ] `n8n-workflow-archive` has 17+ workflow JSONs from today
- [ ] `cc-memory` has 41+ files from today
- [ ] `cc-config` has both `openclaw.json` and `claude-settings.json`
- [ ] USB mounted persistently (`mount -a` after reboot would re-mount)
- [ ] Deploy-smoke #46 green in CI
- [ ] Tag `vD.0.1` pushed and CI green
- [ ] Memory pointer added

---

## Roll-back

If anything goes sideways post-tag:

```bash
# Disable the new cron entries (revert to before-state):
crontab -l | grep -v -E 'n8n-workflow-export|cc-memory-backup' | crontab -

# Unmount USB:
sudo umount /mnt/usb-backups
sudo sed -i '\|/dev/sda1|d' /etc/fstab

# Revert backup.sh to pre-vD.0.1 commit:
cd /home/tcntryprd/boss-dev
git revert <vD.0.1-squash-commit-sha> --no-edit
git push origin master
```

The 173MB Weaviate blob removal from `boss-backups` is NOT reversible without a force-push of the old SHAs from a separate clone. Document this in the rollback note. Acceptable: that blob was the blocker; restoring it would re-break pushes.

---

## Open follow-ups (for vD.1.0+)

- Container volume snapshots (vD.1.0) — daily tar.gz of `boss_postgres`, `boss_weaviate`, `n8n_postgres_data`, `n8n_n8n_data`, `boss_redis` to GitHub + USB
- Restore-rehearsal monthly script (vD.1.0)
- Backup observability dashboard at `/coe` (vD.1.1)
- Slack/Telegram nightly summary (vD.1.1)
- Off-site cloud destination (B2/S3) when Kevin opens that door
