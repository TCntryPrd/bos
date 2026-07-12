#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"
  export BOSS_TENANT_ID="default"
  export RASCALS_BOOT_STAGGER_SEC=0
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs" "$RASCALS_ROOT/darla" "$RASCALS_ROOT/spanky"

  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla"},{"handle":"spanky","cli":"claude","projectDir":"%s/spanky"}]}' "$RASCALS_ROOT" "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  export TMUX_STATE_DIR="$BATS_TEST_TMPDIR/tmux-state"
  mkdir -p "$TMUX_STATE_DIR"
  : > "$TMUX_STUB_LOG"
  # Stateful tmux stub: has-session reports presence based on marker files.
  # Lets reset's kill-session remove the session so boot's subsequent has-session
  # reports "missing" and boot calls new-session. Handle is the 3rd arg (after -t).
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
cmd="$1"
handle="$3"
case "$cmd" in
  has-session)
    [ -e "$TMUX_STATE_DIR/$handle" ] && exit 0
    exit 1
    ;;
  kill-session)
    rm -f "$TMUX_STATE_DIR/$handle"
    ;;
  new-session)
    # -s <name> is usually -s darla, not -t darla. Parse explicitly.
    for a in "$@"; do
      if [ "$prev" = "-s" ]; then touch "$TMUX_STATE_DIR/$a"; fi
      prev="$a"
    done
    ;;
esac
exit 0
EOF
  # Seed "existing" sessions for handles we care about
  touch "$TMUX_STATE_DIR/darla" "$TMUX_STATE_DIR/spanky"
  chmod +x "$BATS_TEST_TMPDIR/tmux"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  RESET="${BATS_TEST_DIRNAME}/../rascals-reset.sh"
}

@test "reset kills each enabled session (from API) and invokes boot" {
  run bash "$RESET"
  [ "$status" -eq 0 ]
  grep -q 'kill-session -t darla'  "$TMUX_STUB_LOG"
  grep -q 'kill-session -t spanky' "$TMUX_STUB_LOG"
  grep -q 'new-session -d -s darla'  "$TMUX_STUB_LOG"
  grep -q 'new-session -d -s spanky' "$TMUX_STUB_LOG"
}

@test "reset exits 0 and logs on empty registry" {
  echo '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run bash "$RESET"
  [ "$status" -eq 0 ]
  ! grep -q 'kill-session' "$TMUX_STUB_LOG"
  grep -q 'nothing to reset' "$RASCALS_LOG_DIR/reset.log"
}

@test "reset logs to reset.log" {
  run bash "$RESET"
  [ -s "$RASCALS_LOG_DIR/reset.log" ]
}
