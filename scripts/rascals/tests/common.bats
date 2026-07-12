#!/usr/bin/env bats

setup() {
  export RASCALS_TEST_MODE=1
  export RASCALS_ROOT="$BATS_TEST_TMPDIR/rascals"
  export RASCALS_LOCK="$RASCALS_ROOT/locks/little-rascals.lock"
  export RASCALS_LOG_DIR="$RASCALS_ROOT/logs"
  export BOSS_API_URL="http://127.0.0.1:65000"   # stubbed
  export BOSS_TENANT_ID="default"
  mkdir -p "$RASCALS_ROOT/locks" "$RASCALS_ROOT/logs"

  # curl stub: writes invocation to $CURL_STUB_LOG, emits content from $CURL_STUB_STDOUT file (or empty).
  export CURL_STUB_LOG="$BATS_TEST_TMPDIR/curl.log"
  export CURL_STUB_STDOUT="$BATS_TEST_TMPDIR/curl.out"
  export CURL_STUB_EXIT="$BATS_TEST_TMPDIR/curl.exit"
  : > "$CURL_STUB_LOG"
  cat > "$BATS_TEST_TMPDIR/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$CURL_STUB_LOG"
ec="$(cat "$CURL_STUB_EXIT" 2>/dev/null || echo 0)"
if [ -s "$CURL_STUB_STDOUT" ]; then cat "$CURL_STUB_STDOUT"; fi
exit "$ec"
EOF
  chmod +x "$BATS_TEST_TMPDIR/curl"
  export PATH="$BATS_TEST_TMPDIR:$PATH"

  source "${BATS_TEST_DIRNAME}/../lib/rascals-common.sh"
}

@test "rascals_log appends a timestamped line to the named log" {
  rascals_log "boot" "hello world"
  grep -q "hello world" "$RASCALS_LOG_DIR/boot.log"
  grep -qE '^\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T' "$RASCALS_LOG_DIR/boot.log"
}

@test "rascals_acquire_lock exits non-zero when lock is held by another process" {
  flock -x "$RASCALS_LOCK" sleep 2 &
  sleep 0.2
  run rascals_acquire_lock 1
  [ "$status" -ne 0 ]
}

@test "rascals_acquire_lock succeeds when no lock is held" {
  run bash -c ". ${BATS_TEST_DIRNAME}/../lib/rascals-common.sh && rascals_acquire_lock 1 && echo ok"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok"* ]]
}

@test "rascals_fetch_registry parses JSON and emits handle|cli|project_dir lines" {
  cat > "$CURL_STUB_STDOUT" <<'JSON'
{"rascals":[
  {"handle":"darla","cli":"claude","projectDir":"/home/tcntryprd/rascals/darla"},
  {"handle":"maryann","cli":"claude","projectDir":"/home/tcntryprd/rascals/maryann"}
]}
JSON
  run rascals_fetch_registry
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | wc -l)" -eq 2 ]
  [[ "$output" == *"darla|claude|/home/tcntryprd/rascals/darla"* ]]
  [[ "$output" == *"maryann|claude|/home/tcntryprd/rascals/maryann"* ]]
}

@test "rascals_fetch_registry passes enabled=true and tenant header to curl" {
  printf '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run rascals_fetch_registry
  [ "$status" -eq 0 ]
  grep -q 'enabled=true'     "$CURL_STUB_LOG"
  grep -q 'X-BOSS-Internal' "$CURL_STUB_LOG"
  grep -q 'X-Tenant-ID: default' "$CURL_STUB_LOG"
}

@test "rascals_fetch_registry returns non-zero and empty stdout when API is down" {
  echo 22 > "$CURL_STUB_EXIT"
  run rascals_fetch_registry
  [ "$status" -ne 0 ]
  [ -z "$output" ]
}

@test "rascals_fetch_registry emits nothing when the registry is empty" {
  printf '{"rascals":[]}' > "$CURL_STUB_STDOUT"
  run rascals_fetch_registry
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
