#!/bin/bash
# Chạy probe devicePublicKey DƯỚI quyền BT của Terminal.app. Output → /tmp/probe_dpk.log
cd /Users/baduongvan/dev/smarthome/d100-aquara-matter || exit 1
export PATH="$HOME/.bun/bin:$PATH"
echo "probe pid=$$ at $(date -u +%H:%M:%S) — PROBES=${PROBES:-2} GAP_MS=${GAP_MS:-3000}" > /tmp/probe_dpk.log
env PROBES="${PROBES:-2}" GAP_MS="${GAP_MS:-3000}" "$HOME/.bun/bin/bun" run client/probe_devicepk.ts >> /tmp/probe_dpk.log 2>&1
echo "probe done rc=$? at $(date -u +%H:%M:%S)" >> /tmp/probe_dpk.log
