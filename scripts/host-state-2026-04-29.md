# Host state changes for vD.0.1 (2026-04-29)

- Mounted `/dev/sda1` (USB drive, 16GB) at `/mnt/usb-backups`, **ext4** (was FAT32 Ubuntu installer; wiped per Kevin's call to use full drive for backups; no longer FAT32-compatible with Win/Mac sneakernet)
- Added fstab entry: `/dev/sda1  /mnt/usb-backups  ext4  defaults,nofail  0  2`
- Created `/var/lib/boss-backups` (replaces `/tmp/boss-backups`) — owned by `tcntryprd:tcntryprd`
- Migrated 9 daily Postgres + 5 Weaviate snapshots from `/tmp/boss-backups/` into `/var/lib/boss-backups/` via rsync (~2.5 GB, including the broken `.git-backup-repo` working copy which will be rebuilt by `backup.sh` next run)
- USB mount has 14 GB free post-wipe; entire drive is the backup target (no subdir)
- Confirmed: passwordless sudo works for `tcntryprd` user (relevant for vS.1.0 host-OS management plan)
