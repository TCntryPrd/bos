# Fresh-interactive rascal heartbeat

`boss-rascal-heartbeat.sh` is the safe replacement for Vasari's legacy
`rascal-heartbeat.sh`.  It preserves the existing cron cadence and
`DO_NOT_DISTURB=darla` behavior, but it no longer runs Claude print mode.

For every enabled client manager with selected pending `CLIENT` tasks, it:

1. Checks the tenant-scoped permanent tmux runtime is idle.
2. Starts one fresh interactive Claude process through
   `/usr/local/bin/boss-agent-background-turn`.
3. Lets the restricted bridge's watcher finish that Claude process while the
   tmux shell remains available.
4. Marks only the exact task IDs selected before the turn complete, and only
   after the turn has an `end_turn` text response.

It does not write directly to Weaviate, invoke `claude -p`, use `--resume` or
`--continue`, or create/change a scheduler.  Portal work always wins: a busy
tmux runtime is skipped and its tasks stay pending for the next heartbeat.

## Safe Vasari rollout

Run this only after the restricted runtime and
`/usr/local/bin/boss-agent-background-turn` have been installed.  The first
command only stages the helper; it changes neither the existing cron entry nor
the legacy script.

```bash
cd /docker/hermes-agent-qtbk
sudo bash host/install-rascal-heartbeat.sh --stage
sudo /usr/local/sbin/boss-rascal-heartbeat --dry-run
```

Review `/home/tcntryprd/logs/rascal-heartbeat.log`.  A dry run must show Darla
as skipped and must not start Claude or change task statuses.  If it is clean,
activate it with the default legacy target:

```bash
sudo bash host/install-rascal-heartbeat.sh --activate
sudo /docker/hermes-agent-qtbk/rascal-heartbeat.sh --dry-run
```

Activation installs a thin wrapper at the current cron target, retaining its
owner and mode, and saves a timestamped original under
`/var/lib/boss-agent-runtime/legacy-heartbeat-backups/`.  It adds no duplicate
cron/systemd schedule.

To temporarily preserve a different DND set or database service during a
maintenance window, set only these validated environment variables in the
existing scheduler context:

```bash
BOSS_RASCAL_HEARTBEAT_DO_NOT_DISTURB=darla,spanky
BOSS_RASCAL_HEARTBEAT_DB_CONTAINER=hermes-agent-qtbk-postgres-1
```

The compose-based database command is the normal Vasari path; the container
override exists only for a legacy compose naming issue.  Neither setting is
required for the default Vasari installation.

If rollback is needed, restore the newest preserved script without touching
cron, tmux, Claude auth, task records, or any customer workspace:

```bash
sudo bash host/install-rascal-heartbeat.sh --rollback
```
