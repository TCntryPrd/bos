#!/usr/bin/env bash
# encrypt-helper.sh — AES-256-CBC encryption for backup files
# Sourced by backup.sh, n8n-workflow-export.sh, cc-memory-backup.sh
# Requires: BACKUP_ENCRYPTION_KEY env var (>=32 chars)

# encrypt_file <input_path>
# Encrypts in place: removes <input_path>, creates <input_path>.enc with IV prepended.
# Echoes the .enc path on success. Returns 1 on missing key.
encrypt_file() {
    local input_file="$1"
    local output_file="${input_file}.enc"

    local key="${BACKUP_ENCRYPTION_KEY:-${ENCRYPTION_KEY:-}}"
    if [ -z "$key" ]; then
        echo "ERROR: BACKUP_ENCRYPTION_KEY required" >&2
        return 1
    fi

    local iv
    iv=$(openssl rand -hex 16)

    echo -n "$iv" | xxd -r -p > "$output_file"
    openssl enc -aes-256-cbc -salt \
        -in "$input_file" \
        -K "$(echo -n "$key" | xxd -p | tr -d '\n' | head -c 64)" \
        -iv "$iv" \
        >> "$output_file"

    rm -f "$input_file"
    echo "$output_file"
}
