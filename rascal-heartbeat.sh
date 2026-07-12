#!/bin/bash
# rascal-heartbeat.sh — wake IDLE client-manager rascals to draft routed CLIENT emails.
# The Email Suite routes a client email to its manager by creating a board task
# (boss_tasks, assigned_agent=<rascal>, title "CLIENT [..]"). This polls those tasks and,
# for each rascal that is NOT busy, runs a one-shot `claude -p` so the rascal reads the
# email (it has Gmail connectors + that client's context) and writes a reply DRAFT.
#
# HARD RULE: never interrupt a rascal that is actively working. "Busy" = it has a live
# chat tmux pane in its project dir. We also hard-skip any handle in DO_NOT_DISTURB.
set -uo pipefail
PG="docker exec hermes-agent-qtbk-postgres-1 psql -U boss -d boss_ir -t -A"
LOG=/home/tcntryprd/logs/rascal-heartbeat.log
TMUX="tmux -S /tmp/tmux-1000/default"
DO_NOT_DISTURB="darla"   # Kevin actively working Darla; leave her alone for now
mkdir -p /home/tcntryprd/logs
exec 9>/home/tcntryprd/logs/.rascal-hb.lock; flock -n 9 || exit 0
say(){ echo "[$(date -u +%F\ %H:%M:%S)] $*" >> "$LOG"; }

# Rascals currently BUSY = any with a live tmux pane whose cwd is their project dir.
BUSY=$($TMUX list-panes -a -F '#{pane_current_path}' 2>/dev/null | grep -oE 'rascals/[a-z0-9]+' | sed 's#rascals/##' | sort -u)

# Enabled client-manager rascals.
mapfile -t RASCALS < <($PG -c "SELECT handle FROM boss_rascals WHERE enabled = true ORDER BY handle;")

for handle in "${RASCALS[@]}"; do
  [ -z "$handle" ] && continue
  # don't-disturb guards
  echo "$DO_NOT_DISTURB" | tr ',' '\n' | grep -qx "$handle" && continue
  echo "$BUSY" | grep -qx "$handle" && continue
  dir="/home/tcntryprd/rascals/$handle"
  [ -d "$dir" ] || continue

  # Pending CLIENT tasks for this rascal.
  tasks=$($PG -c "SELECT title FROM boss_tasks WHERE assigned_agent = '$handle' AND status = 'pending' AND title LIKE 'CLIENT %' ORDER BY priority, created_at LIMIT 10;")
  [ -z "$tasks" ] && continue

  n=$(echo "$tasks" | grep -c . )
  say "$handle: $n pending CLIENT task(s), waking (idle, not busy)"

  display=$($PG -c "SELECT coalesce(display_name, handle) FROM boss_rascals WHERE handle='$handle';")
  client=$($PG -c "SELECT coalesce(client,'your client') FROM boss_rascals WHERE handle='$handle';")
  prompt="You are ${display}, the client manager for ${client}. New client email(s) were routed to you and need a reply DRAFT. For EACH item below, search your Gmail for the email (by the sender and subject), read the thread, and write a contextual reply DRAFT in the client's expected voice using your knowledge of this client and their history. Save it as a Gmail DRAFT (create_draft) — do NOT send. Keep it tight, no fluff. When done, list which you drafted, then exit. Do not loop.

CLIENT EMAILS TO DRAFT:
${tasks}"

  # One-shot, time-boxed, in the rascal's own dir (uses its model + connectors).
  ( cd "$dir" && timeout 420 claude -p --dangerously-skip-permissions "$prompt" >> "$LOG" 2>&1 ) && rc=0 || rc=$?
  if [ "${rc:-1}" -eq 0 ]; then
    # Mark this rascal's CLIENT tasks handled (the drafts are now in Gmail for Kevin to review).
    $PG -c "UPDATE boss_tasks SET status='completed', updated_at=now() WHERE assigned_agent='$handle' AND status='pending' AND title LIKE 'CLIENT %';" >/dev/null 2>&1
    say "$handle: draft pass complete, tasks marked completed"
  else
    say "$handle: draft pass FAILED (rc=$rc), leaving tasks pending for retry"
  fi
done
exit 0
