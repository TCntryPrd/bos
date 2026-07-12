#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"
  export BOSS_TENANT_ID="default"
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs" "$RASCALS_ROOT/darla/crons" "$RASCALS_ROOT/darla/state"
  echo '[]' > "$RASCALS_ROOT/darla/state/wake-log.json"

  # Default curl stub: emits an "enabled darla" row; tests override by rewriting
  # $CURL_STUB_STDOUT before calling the script.
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla","enabled":true}]}' "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$TMUX_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1" in
  has-session) exit 0 ;;
  send-keys)   exit 0 ;;
  new-session) exit 0 ;;
esac
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/tmux"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  WAKE="${BATS_TEST_DIRNAME}/../wake-agent.sh"
}

@test "wake-agent requires a handle argument" {
  run bash "$WAKE"
  [ "$status" -ne 0 ]
}

@test "wake-agent rejects a handle that isn't enabled in the API" {
  # Stub curl to return empty (rascal not found / not enabled).
  # The wake script will look up the one handle via ?handle=alfalfa&enabled=true.
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  printf '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  run bash "$WAKE" alfalfa "hello"
  [ "$status" -ne 0 ]
  grep -q 'not enabled\|not found' "$RASCALS_LOG_DIR/wake-alfalfa.log"
}

@test "wake-agent sends the prompt via tmux send-keys" {
  run bash "$WAKE" darla "say hi"
  [ "$status" -eq 0 ]
  grep -q 'send-keys -t darla' "$TMUX_STUB_LOG"
  grep -q 'say hi' "$TMUX_STUB_LOG"
}

@test "wake-agent appends an entry to the agent's wake-log.json" {
  run bash "$WAKE" darla "first prompt"
  [ "$status" -eq 0 ]
  [ -s "$RASCALS_ROOT/darla/state/wake-log.json" ]
  grep -q 'first prompt' "$RASCALS_ROOT/darla/state/wake-log.json"
}

@test "wake-agent skips if the global lock is already held" {
  # Hold the lock with a real background process (proven pattern from Task 6/7)
  flock -x "$RASCALS_LOCK" sleep 3 &
  BLOCKER_PID=$!
  sleep 0.3
  export RASCALS_WAKE_TIMEOUT_SEC=1
  run bash "$WAKE" darla "blocked"
  [ "$status" -ne 0 ]
  grep -q 'lock' "$RASCALS_LOG_DIR/wake-darla.log"
  wait "$BLOCKER_PID" 2>/dev/null || true
}
