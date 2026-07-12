#!/usr/bin/env bash
# backup-mirror.sh — rsync the canonical backup dir to USB
# Sourced by backup.sh after all uploads complete

# mirror_to_usb <source_dir> <usb_mount>
# Returns 0 on success, 1 if USB not mounted (logged but not fatal).
mirror_to_usb() {
    local source_dir="$1"
    local usb_mount="$2"

    if ! mountpoint -q "$usb_mount" 2>/dev/null; then
        echo "  [usb-mirror] WARN: $usb_mount is not mounted, skipping"
        return 1
    fi

    if ! touch "$usb_mount/.write-test" 2>/dev/null; then
        echo "  [usb-mirror] WARN: $usb_mount not writable, skipping"
        return 1
    fi
    rm -f "$usb_mount/.write-test"

    echo "  [usb-mirror] rsync $source_dir → $usb_mount"
    rsync -av --delete \
        --exclude='.git-backup-repo' \
        --exclude='*.tmp' \
        "$source_dir/" "$usb_mount/" 2>&1 | tail -5

    local usb_free
    usb_free=$(df -h "$usb_mount" | awk 'NR==2 {print $4}')
    echo "  [usb-mirror] OK ($usb_free free on USB)"
}
