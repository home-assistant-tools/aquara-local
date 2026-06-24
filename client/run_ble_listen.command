#!/bin/bash
# Launcher để chạy passive BLE scanner DƯỚI quyền BT của Terminal.app (đã grant sẵn).
# Mở bằng: open -a Terminal client/run_ble_listen.command
# Output → /tmp/ble_listen.log (đọc từ xa được).
cd /Users/baduongvan/dev/smarthome/d100-aquara-matter || exit 1
export PATH="$HOME/.bun/bin:$PATH"
echo "launcher pid=$$ at $(date -u +%H:%M:%S) — LISTEN_SECONDS=${LISTEN_SECONDS:-0} LOG_ALL=${LOG_ALL:-0}" > /tmp/ble_listen.log
env LISTEN_SECONDS="${LISTEN_SECONDS:-0}" LOG_ALL="${LOG_ALL:-0}" "$HOME/.bun/bin/bun" run client/ble_mac_listen.ts >> /tmp/ble_listen.log 2>&1
echo "launcher done rc=$? at $(date -u +%H:%M:%S)" >> /tmp/ble_listen.log
