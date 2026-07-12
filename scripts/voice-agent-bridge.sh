#!/bin/bash
# voice-agent-bridge.sh — Route a voice prompt to an agent via the shared voice tmux session.
#
# Usage: voice-agent-bridge.sh <project-dir> <cli> <prompt>
#
# One tmux session: "voice-session". Always reused.
# cd to project dir → fire CLI with prompt → capture output → CLI exits.
# Tmux stays alive until voice mode is muted.

set -euo pipefail

PROJECT_DIR="${1:?project dir required}"
CLI="${2:?cli type required (claude|gemini)}"
PROMPT="${3:?prompt required}"

TMUX_NAME="voice-session"
LOG_DIR="/home/tcntryprd/boss-dev/scripts/logs/voice"
mkdir -p "$LOG_DIR"

AGENT_NAME=$(basename "$PROJECT_DIR")
LOG_FILE="$LOG_DIR/${AGENT_NAME}-$(date +%Y%m%d-%H%M%S).log"
OUTPUT_FILE="/tmp/voice-agent-output-$$.txt"

# Clean up output file on exit
trap 'rm -f "$OUTPUT_FILE"' EXIT

# Ensure the voice tmux session exists
if ! tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
  tmux new-session -d -s "$TMUX_NAME" -c "$PROJECT_DIR"
  sleep 0.3
fi

# cd to the agent's project directory and fire the CLI
cd "$PROJECT_DIR"

if [ "$CLI" = "gemini" ]; then
  echo "$PROMPT" | timeout 110 gemini -p \
    2>&1 | tee -a "$LOG_FILE" > "$OUTPUT_FILE" || true
else
  echo "$PROMPT" | timeout 110 claude -p \
    --dangerously-skip-permissions \
    --model claude-sonnet-4-6 \
    2>&1 | tee -a "$LOG_FILE" > "$OUTPUT_FILE" || true
fi

# Return the output (brain captures stdout)
if [ -f "$OUTPUT_FILE" ] && [ -s "$OUTPUT_FILE" ]; then
  # Truncate long responses for voice readback
  head -c 8000 "$OUTPUT_FILE"
else
  echo "Agent processed the request but produced no output."
fi
