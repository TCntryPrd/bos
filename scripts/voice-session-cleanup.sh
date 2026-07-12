#!/bin/bash
# voice-session-cleanup.sh — Kill the voice tmux session.
# Called when voice mode is muted (toggled off).

set -euo pipefail

TMUX_NAME="voice-session"

if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
  tmux kill-session -t "$TMUX_NAME" 2>/dev/null
  echo '{"cleaned": true, "session": "voice-session"}'
else
  echo '{"cleaned": false, "session": "voice-session", "reason": "not running"}'
fi
