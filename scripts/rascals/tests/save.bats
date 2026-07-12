#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"   # unused by save (no registry lookup)
  export BOSS_TENANT_ID="default"
  export WEAVIATE_URL="http://127.0.0.1:65000"     # stubbed below
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs" "$RASCALS_ROOT/darla/output"

  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$TMUX_STUB_LOG"
  # tmux capture-pane stub emits fixed content
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1" in
  capture-pane)
    echo "fake scrollback line 1"
    echo "fake scrollback line 2"
    ;;
  has-session) exit 0 ;;
esac
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/tmux"

  # curl stub that records and succeeds
  export CURL_STUB_LOG="$BATS_TEST_TMPDIR/curl.log"
  : > "$CURL_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$CURL_STUB_LOG"
echo '{"id":"stub-uuid"}'
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  SAVE="${BATS_TEST_DIRNAME}/../agent-save.sh"
}

@test "save requires a handle" {
  run bash "$SAVE"
  [ "$status" -ne 0 ]
}

@test "save writes an output file under output/" {
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  ls "$RASCALS_ROOT/darla/output/" | grep -qE '\.md$'
}

@test "save captures tmux scrollback into the output file" {
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  grep -rq 'fake scrollback line 1' "$RASCALS_ROOT/darla/output/"
}

@test "save posts to Weaviate with agent and slug labels" {
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  grep -q 'Knowledge' "$CURL_STUB_LOG"
  grep -q 'darla' "$CURL_STUB_LOG"
}

@test "save skips the Weaviate call if WEAVIATE_URL is empty" {
  export WEAVIATE_URL=""
  run bash "$SAVE" darla "morning-check"
  [ "$status" -eq 0 ]
  ! grep -q 'Knowledge' "$CURL_STUB_LOG"
}
