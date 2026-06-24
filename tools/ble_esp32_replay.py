#!/usr/bin/env python3
"""Replay-mode unlock via ESP32 proxy — reuse cached sessionKey from /tmp/d100_session.json.

Same handshake flow as ble_esp32_test.py but skips cloud calls when the cached
devicePublicKey matches what the lock returns in 0610. Lets you mở khoá khi
không có AQARA_EMAIL/PASSWORD sẵn (e.g. tay đau, lười gõ).

Cần env tối thiểu:
  ESP32_HOST=192.168.2.162
  ESP32_NOISE_PSK="<base64>"
  LOCK_MAC=ED:56:4D:00:58:5A   # tuỳ chọn — nếu chưa có, script tự scan tìm 'DP1A'

Cache phải còn hợp lệ (< 6h kể từ lần cloud-fresh handshake gần nhất).
"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import logging
import os
import pathlib
import sys
import time
import types

from aioesphomeapi import APIClient

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / "custom_components" / "aquara_local"
_ns = types.ModuleType("aqd100")
_ns.__path__ = [str(PKG_DIR)]
sys.modules["aqd100"] = _ns
gatt = importlib.import_module("aqd100.gatt")
protocol = importlib.import_module("aqd100.protocol")

# Reuse the Esp32Lock class — already does connect/discover/handshake/openLock.
test_mod = importlib.import_module("ble_esp32_test")
Esp32Lock = test_mod.Esp32Lock
discover_address = test_mod.discover_address
scan_only = test_mod.scan_only
_mac_to_int = test_mod._mac_to_int

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
_LOG = logging.getLogger("d100.esp32replay")

SESSION_CACHE = pathlib.Path("/tmp/d100_session.json")
SESSION_MAX_AGE = 6 * 3600
HANDSHAKE_TIMEOUT = 9.0
OP_TYPES = {"open": protocol.OPEN_OPEN, "close": protocol.OPEN_CLOSE, "unbolt": protocol.OPEN_UNBOLT}


def load_cache() -> dict | None:
    try:
        data = json.loads(SESSION_CACHE.read_text())
        age = time.time() - data.get("ts", 0)
        if age > SESSION_MAX_AGE:
            _LOG.warning("Cache stale (age=%.0fs > %.0f) — refusing replay", age, SESSION_MAX_AGE)
            return None
        _LOG.info("Cache hit did=%s age=%.0fs", data["did"], age)
        return data
    except (FileNotFoundError, json.JSONDecodeError) as e:
        _LOG.warning("No usable cache: %s", e)
        return None


async def replay_unlock(lock: "Esp32Lock", cached: dict, op_type: int) -> int | None:
    """0610 with cached cloudPublicKey → compare device_pub → 0710 → openLock."""
    cloud_pub = bytes.fromhex(cached["cloudPublicKey"])
    _LOG.info("BLE: 0610 cloudPublicKey (cached) → device_pub…")
    resp = await lock.hs_exchange(0x0610, cloud_pub)
    device_pub = gatt.extract_pubkey(resp).hex()
    if device_pub != cached["devicePublicKey"]:
        _LOG.error(
            "Lock returned new devicePublicKey (%s…) — cache invalid; need cloud /verify.",
            device_pub[:24],
        )
        return None
    _LOG.info("♻️ devicePublicKey khớp cache → reuse sessionKey")

    try:
        await lock.hs_exchange(0x0710, bytes.fromhex(cached["verifyData"]))
    except (asyncio.TimeoutError, TimeoutError):
        _LOG.debug("0710 push không nhả status frame (continuing)")

    key = protocol.LockKey(
        session_key=bytes.fromhex(cached["sessionKey"]),
        nonce=bytes.fromhex(cached["nonce"]),
    )
    return await lock.open_lock(key, op_type)


async def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--op", choices=list(OP_TYPES), default="open")
    p.add_argument("--scan", action="store_true")
    p.add_argument("--dry", action="store_true")
    args = p.parse_args()

    host = os.environ.get("ESP32_HOST")
    if not host:
        print("ERROR: set ESP32_HOST", file=sys.stderr)
        return 2
    cli = APIClient(host, 6053, None, noise_psk=os.environ.get("ESP32_NOISE_PSK") or None)
    await cli.connect(login=True)
    info = await cli.device_info()
    _LOG.info("ESP32 %s (esphome %s, bt_flags=%s)",
              info.name, info.esphome_version, getattr(info, "bluetooth_proxy_feature_flags", 0))
    try:
        if args.scan:
            await scan_only(cli)
            return 0

        cached = load_cache()
        if not cached:
            return 1

        mac = os.environ.get("LOCK_MAC", "ED:56:4D:00:58:5A")  # known D100 BLE addr from scan
        target = _mac_to_int(mac)
        flags = getattr(info, "bluetooth_proxy_feature_flags", 0)
        attempts = int(os.environ.get("BLE_ATTEMPTS", "30"))
        lock = None
        for n in range(1, attempts + 1):
            addr, addr_type = await discover_address(cli, target)
            _LOG.info("Lock advert ✓ %012x type=%s (try %d/%d)", addr, addr_type, n, attempts)
            lock = Esp32Lock(cli, addr, addr_type, feature_flags=flags)
            try:
                await lock.connect()
                break
            except Exception as e:  # noqa: BLE001
                _LOG.warning("connect %d/%d failed: %s", n, attempts, str(e)[:80])
                try:
                    await cli.bluetooth_device_disconnect(addr)
                except Exception:  # noqa: BLE001
                    pass
                if n == attempts:
                    raise
                await asyncio.sleep(0.5)

        try:
            if args.dry:
                _LOG.info("--dry: GATT dumped, skip unlock.")
                return 0
            status = await replay_unlock(lock, cached, OP_TYPES[args.op])
            label = {0: "LOCKED", 1: "UNLOCKED", 2: "ERROR"}.get(status, "unknown")
            _LOG.info("RESULT op=%s → status=%s (%s)", args.op, status, label)
        finally:
            await lock.disconnect()
        return 0
    finally:
        await cli.disconnect()


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
