#!/bin/bash
# Chạy probe guess-KDF DƯỚI quyền BT của Terminal. Output → /tmp/probe_kdf.log
cd /Users/baduongvan/dev/smarthome/d100-aquara-matter || exit 1
export PATH="$HOME/.bun/bin:$PATH"
echo "kdf probe pid=$$ at $(date -u +%H:%M:%S) — SEND_0710=${SEND_0710:-0} KDF=${KDF:-hkdf_empty}" > /tmp/probe_kdf.log
env SEND_0710="${SEND_0710:-0}" KDF="${KDF:-hkdf_empty}" "$HOME/.bun/bin/bun" run client/probe_kdf.ts >> /tmp/probe_kdf.log 2>&1
echo "kdf probe done rc=$? at $(date -u +%H:%M:%S)" >> /tmp/probe_kdf.log
