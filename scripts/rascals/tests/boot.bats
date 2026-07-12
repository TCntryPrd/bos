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

  # Stub curl: emits contents of $CURL_STUB_STDOUT, exits $CURL_STUB_EXIT (default 0)
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
ec="$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
[ -s "$CURL_STUB_STDOUT" ] && cat "$CURL_STUB_STDOUT"
exit "$ec"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"

  # Stub tmux: record invocations, all calls succeed
  export TMUX_STUB_LOG="$BATS_TEST_TMPDIR/tmux.log"
  : > "$TMUX_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1" in
  has-session) exit 1 ;;   # pretend no session exists
esac
exit 0
EOF
  chmod +x "$BATS_TEST_TMPDIR/tmux"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  BOOT="${BATS_TEST_DIRNAME}/../little-rascals-boot.sh"
}

@test "boot creates a tmux session for each enabled rascal returned by the API" {
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla"},{"handle":"spanky","cli":"claude","projectDir":"%s/spanky"}]}' "$RASCALS_ROOT" "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"

  run bash "$BOOT"
  [ "$status" -eq 0 ]
  grep -q "new-session -d -s darla -c ${RASCALS_ROOT}/darla"  "$TMUX_STUB_LOG"
  grep -q "new-session -d -s spanky -c ${RASCALS_ROOT}/spanky" "$TMUX_STUB_LOG"
}

@test "boot does NOT send-keys to start a CLI when RASCALS_TEST_MODE=1" {
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla"}]}' "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  ! grep -q 'send-keys' "$TMUX_STUB_LOG"
}

@test "boot exits 0 with empty registry (no rascals imported yet)" {
  echo '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  ! grep -q 'new-session' "$TMUX_STUB_LOG"
  grep -q 'no enabled rascals' "$RASCALS_LOG_DIR/boot.log"
}

@test "boot exits 0 and logs when the API is unreachable (bulletproof)" {
  echo 22 > "$CURL_STUB_EXIT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  ! grep -q 'new-session' "$TMUX_STUB_LOG"
  grep -q 'API unreachable' "$RASCALS_LOG_DIR/boot.log"
}

@test "boot skips a rascal whose projectDir is missing and logs it" {
  rm -rf "$RASCALS_ROOT/spanky"
  printf '{"rascals":[{"handle":"darla","cli":"claude","projectDir":"%s/darla"},{"handle":"spanky","cli":"claude","projectDir":"%s/spanky"}]}' "$RASCALS_ROOT" "$RASCALS_ROOT" > "$CURL_STUB_STDOUT"
  run bash "$BOOT"
  [ "$status" -eq 0 ]
  grep -q 'new-session -d -s darla' "$TMUX_STUB_LOG"
  ! grep -q 'new-session -d -s spanky' "$TMUX_STUB_LOG"
  grep -q 'spanky' "$RASCALS_LOG_DIR/boot.log"
}
