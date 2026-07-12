#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/backup-split.sh"

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Case 1: small file (<90MB) returns unchanged path, file still exists
echo "small content" > "$TMP/small.bin"
result=$(split_if_large "$TMP/small.bin")
[ "$result" = "$TMP/small.bin" ] || { echo "FAIL small: got $result"; exit 1; }
[ -f "$TMP/small.bin" ] || { echo "FAIL small: file removed"; exit 1; }
echo "PASS small file unchanged"

# Case 2: large file (~95MB) splits into 2 parts, original removed
dd if=/dev/urandom of="$TMP/big.bin" bs=1M count=95 2>/dev/null
parts=$(split_if_large "$TMP/big.bin")
part_count=$(echo "$parts" | wc -l)
[ "$part_count" -ge 2 ] || { echo "FAIL big: only $part_count parts"; exit 1; }
[ ! -f "$TMP/big.bin" ] || { echo "FAIL big: original not removed"; exit 1; }
echo "PASS big file split into $part_count parts"

# Case 3: join parts back
join_parts "$TMP/big.bin"
[ -f "$TMP/big.bin" ] || { echo "FAIL join: result missing"; exit 1; }
ls "$TMP/big.bin".*.part 2>/dev/null && { echo "FAIL join: parts not cleaned"; exit 1; } || true
echo "PASS joined back to single file"

echo "ALL TESTS PASSED"
