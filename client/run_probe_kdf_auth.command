#!/bin/bash
# Thử 0710 với cả 11 candidate + baseline (1 connection). Output → /tmp/probe_kdf.log
cd /Users/baduongvan/dev/smarthome/d100-aquara-matter || exit 1
export PATH="$HOME/.bun/bin:$PATH"
echo "kdf AUTH probe pid=$$ at $(date -u +%H:%M:%S) — SEND_0710=1 KDF=all" > /tmp/probe_kdf.log
env SEND_0710=1 KDF=all "$HOME/.bun/bin/bun" run client/probe_kdf.ts >> /tmp/probe_kdf.log 2>&1
echo "kdf AUTH probe done rc=$? at $(date -u +%H:%M:%S)" >> /tmp/probe_kdf.log
