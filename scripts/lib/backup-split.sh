#!/usr/bin/env bash
# backup-split.sh — split files >90MB into 90MB chunks, restore via cat
# Sourced by backup.sh

# split_if_large <file>
# If file > 94371840 bytes, splits into <file>.NN.part (90MB each), removes original.
# Echoes the resulting file list (one per line). If file is small enough, echoes the original path.
split_if_large() {
    local file="$1"
    local size
    size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file")

    if [ "$size" -le 94371840 ]; then
        echo "$file"
        return 0
    fi

    local base
    base=$(basename "$file")
    local dir
    dir=$(dirname "$file")
    # split: 90MB chunks, suffix = numeric, .part extension
    split -b 90M -d -a 2 --additional-suffix=.part "$file" "$dir/$base."
    rm -f "$file"

    # echo each part on its own line
    ls -1 "$dir/$base."*.part 2>/dev/null
}

# join_parts <prefix>
# Concatenates all <prefix>.NN.part files into <prefix>, removes parts.
# Inverse of split_if_large.
join_parts() {
    local prefix="$1"
    cat "$prefix".*.part > "$prefix"
    rm -f "$prefix".*.part
}
