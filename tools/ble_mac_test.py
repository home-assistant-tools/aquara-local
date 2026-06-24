#!/usr/bin/env python3
"""Direct macOS CoreBluetooth handshake to D100 — no ESP32.

Same flow as ble_esp32_test.py (cloud login → 0610/0710 → sessionKey) but
via bleak/CoreBluetooth on the Mac itself. Good for ruling out whether the
Mac antenna + scan duty can win the lock's ADV_IND window the way Android RN
does, vs. the ESPHome+TCP path that's been missing it.

Notes on CoreBluetooth quirks:
- macOS hides the BLE MAC behind a per-host UUID. We can't match by `LOCK_MAC`
  from cloud; we match by advertised name 'DP1A' (same as the RN app).
- We retry connect a lot of times with short timeout — mimics BlePlxClient
  pattern that worked on the phone.

Usage:
  export AQARA_EMAIL=... AQARA_PASSWORD=...
  python3 tools/ble_mac_test.py            # full handshake → print sessionKey
  python3 tools/ble_mac_test.py --scan     # just scan and list devices
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
from typing import Optional

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / "custom_components" / "aquara_local"
_ns = types.ModuleType("aqd100")
_ns.__path__ = [str(PKG_DIR)]
sys.modules["aqd100"] = _ns
cloud = importlib.import_module("aqd100.cloud")
gatt = importlib.import_module("aqd100.gatt")
protocol = importlib.import_module("aqd100.protocol")

import aiohttp  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
_LOG = logging.getLogger("d100.mac")

SCAN_TIMEOUT = 300.0  # 5 phút — đủ user đứng dậy đi vẫy tay trước khoá để wake
SESSION_CACHE = pathlib.Path("/tmp/d100_session.json")
SESSION_MAX_AGE = 60 * 60 * 6  # 6h — sessionKey thường sống lâu nhưng giới hạn an toàn


def load_cached_session(did: str) -> Optional[dict]:
    try:
        data = json.loads(SESSION_CACHE.read_text())
        if data.get("did") != did:
            return None
        if time.time() - data.get("ts", 0) > SESSION_MAX_AGE:
            return None
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_cached_session(did: str, cloud_pub: str, dev_pub: str,
                        session_key: str, nonce: str, verify_data: str) -> None:
    SESSION_CACHE.write_text(json.dumps({
        "did": did, "ts": time.time(),
        "cloudPublicKey": cloud_pub, "devicePublicKey": dev_pub,
        "sessionKey": session_key, "nonce": nonce, "verifyData": verify_data,
    }))
CONNECT_TIMEOUT = 8.0
CONNECT_ATTEMPTS = 25
HANDSHAKE_TIMEOUT = 9.0


async def scan_for_lock(timeout: float = SCAN_TIMEOUT) -> Optional[BLEDevice]:
    _LOG.info("Scanning %.0fs for advert name 'DP1A'…", timeout)
    found: asyncio.Future[BLEDevice] = asyncio.get_running_loop().create_future()

    # macOS hide MAC; CoreBluetooth dùng UUID per-host ổn định. Pin UUID D100 đã verify:
    #   59E9553D-BCF3-B01A-9EB8-3288E4A9BE46 (lần --scan đầu thấy name='DP1A', mac=5A58004D56ED)
    # Khoá thứ 2 'Aqara Smart Door Lock 8459' (UUID B7C7245D-...) cùng nhà nhưng KHÔNG phải D100.
    pinned = os.environ.get(
        "MAC_BLE_UUID",
        "59E9553D-BCF3-B01A-9EB8-3288E4A9BE46",
    ).upper()

    def cb(dev: BLEDevice, adv) -> None:
        addr = (dev.address or "").upper()
        name = (dev.name or adv.local_name or "") or ""
        if addr == pinned or name.strip().lower() == "dp1a":
            if not found.done():
                _LOG.info("Lock found: %s rssi=%s name=%r", dev.address, adv.rssi, name)
                found.set_result(dev)

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    try:
        return await asyncio.wait_for(found, timeout)
    except asyncio.TimeoutError:
        return None
    finally:
        await scanner.stop()


async def scan_only(timeout: float = 20.0) -> None:
    seen: dict[str, tuple[int, str]] = {}

    def cb(dev: BLEDevice, adv) -> None:
        name = (dev.name or adv.local_name or "") or ""
        prev = seen.get(dev.address)
        # keep strongest rssi
        rssi = adv.rssi
        keep_name = name or (prev[1] if prev else "")
        if not prev or rssi > prev[0]:
            seen[dev.address] = (rssi, keep_name)

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    try:
        await asyncio.sleep(timeout)
    finally:
        await scanner.stop()
    rows = sorted(seen.items(), key=lambda kv: -kv[1][0])
    print(f"\n{len(rows)} devices:")
    for addr, (rssi, name) in rows:
        flag = "  ← DP1A (lock)" if name.strip().lower() == "dp1a" else ""
        print(f"  {addr}  rssi={rssi:>4}  name={name!r}{flag}")


async def connect_with_retry(target) -> BleakClient:
    """target = BLEDevice (from scan) hoặc string UUID (direct retrieve, no scan)."""
    last_err: Optional[BaseException] = None
    for n in range(1, CONNECT_ATTEMPTS + 1):
        _LOG.info("connect attempt %d/%d…", n, CONNECT_ATTEMPTS)
        try:
            cli = BleakClient(target, timeout=CONNECT_TIMEOUT)
            await cli.connect()
            if cli.is_connected:
                _LOG.info("connected ✓")
                return cli
            await cli.disconnect()
        except Exception as e:  # noqa: BLE001
            last_err = e
            msg = str(e)[:60]
            _LOG.warning("attempt %d failed: %s", n, msg)
            await asyncio.sleep(0.5)
    raise RuntimeError(f"could not connect after {CONNECT_ATTEMPTS}: {last_err}")


async def hs_exchange(
    cli: BleakClient,
    pack_cmd: int,
    payload: bytes,
    timeout: float = HANDSHAKE_TIMEOUT,
) -> bytes:
    """Send a 0610/0710 frame, wait for the reassembled 'da' response on FFB2."""
    reasm = gatt.HsReassembler()
    fut: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()

    def on_notify(_handle, data: bytearray) -> None:
        full = reasm.push(bytes(data))
        if full and not fut.done():
            fut.set_result(full)

    await cli.start_notify(gatt.HANDSHAKE_NOTIFY, on_notify)
    # Dump characteristic properties so we know if writes need response
    hs_chr = None
    for svc in cli.services:
        for ch in svc.characteristics:
            if ch.uuid.lower() == gatt.HANDSHAKE_WRITE.lower():
                hs_chr = ch
                break
        if hs_chr:
            break
    use_response = bool(hs_chr and "write" in (hs_chr.properties or []))
    _LOG.info("FFB1 properties=%s → response=%s", hs_chr.properties if hs_chr else "?", use_response)
    try:
        for frame in gatt.build_aiot_frames(pack_cmd, payload):
            await cli.write_gatt_char(gatt.HANDSHAKE_WRITE, frame, response=use_response)
        return await asyncio.wait_for(fut, timeout)
    finally:
        try:
            await cli.stop_notify(gatt.HANDSHAKE_NOTIFY)
        except Exception:  # noqa: BLE001
            pass


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", action="store_true", help="only scan + list")
    args = parser.parse_args()

    if args.scan:
        await scan_only()
        return 0

    # 1) Cloud login (same path the integration uses)
    email = os.environ["AQARA_EMAIL"]
    password = os.environ["AQARA_PASSWORD"]
    area = os.environ.get("AQARA_AREA", "SEA")
    district = os.environ.get("AQARA_DISTRICT", "VN")
    async with aiohttp.ClientSession() as session:
        _LOG.info("Cloud login %s (area=%s)…", email, area)
        auth = await cloud.login_with_password(session, email, password, area, district)
        _LOG.info("Login ✓ userId=%s", auth["userId"])
        cl = cloud.AqaraCloud(session, area, auth["token"], auth["userId"])

        did = os.environ.get("LOCK_DID")
        if not did:
            locks = await cl.list_locks()
            if not locks:
                _LOG.error("No lock on account.")
                return 1
            did = locks[0]["did"]
            _LOG.info("Using lock did=%s", did)

        # 2) Try session cache first (skip cloud + skip fresh handshake)
        cached = load_cached_session(did)
        if cached:
            _LOG.info("♻️ Session cache hit (age=%.0fs) — will probe lock with cached cloudPK",
                      time.time() - cached["ts"])
            cloud_pub_hex = cached["cloudPublicKey"]
        else:
            _LOG.info("Cloud: publickey (no cache)…")
            pk = await cl.publickey(did)
            cloud_pub_hex = pk["cloudPublicKey"]
            _LOG.info("cloudPublicKey=%s… mac=%s", cloud_pub_hex[:24], pk.get("mac"))

        # 3) Connect — TRY direct UUID retrieve first (no scan), fallback to scan.
        #    CoreBluetooth nhớ peripheral đã từng kết nối → centralManager.
        #    retrievePeripheralsWithIdentifiers() trả ngay, skip cả 34s scan.
        pinned_uuid = os.environ.get("MAC_BLE_UUID", "59E9553D-BCF3-B01A-9EB8-3288E4A9BE46")
        cli: Optional[BleakClient] = None
        if not os.environ.get("FORCE_SCAN"):
            try:
                _LOG.info("Trying direct UUID connect (skip scan): %s", pinned_uuid)
                cli = await connect_with_retry(pinned_uuid)
            except Exception as e:  # noqa: BLE001
                _LOG.warning("Direct UUID connect failed (%s) → fallback scan…", str(e)[:80])
                cli = None
        if cli is None:
            dev = await scan_for_lock()
            if not dev:
                _LOG.error("scan timed out — no 'DP1A' seen. Move closer to the lock.")
                return 1
            cli = await connect_with_retry(dev)

        try:
            # 4) Confirm characteristics
            svcs = cli.services
            chars = []
            for svc in svcs:
                for ch in svc.characteristics:
                    chars.append(ch.uuid)
            if gatt.HANDSHAKE_WRITE not in chars or gatt.HANDSHAKE_NOTIFY not in chars:
                _LOG.error("Missing FFB1/FFB2 — got chars: %s", chars[:20])
                return 1
            _LOG.info("GATT discover ✓ (%d services)", len(list(svcs)))
            for svc in svcs:
                for ch in svc.characteristics:
                    if ch.uuid.lower() in (gatt.HANDSHAKE_WRITE.lower(),
                                            gatt.HANDSHAKE_NOTIFY.lower(),
                                            gatt.CMD_WRITE.lower(),
                                            gatt.CMD_NOTIFY.lower()):
                        _LOG.info("  %s handle=%s props=%s",
                                  ch.uuid, ch.handle, ch.properties)

            # 5) BLE handshake: send 0610 (cached or fresh cloudPK) → devicePublicKey
            _LOG.info("BLE: send 0610 cloudPublicKey, wait devicePublicKey…")
            resp0610 = await hs_exchange(cli, 0x0610, bytes.fromhex(cloud_pub_hex))
            dev_pub = gatt.extract_pubkey(resp0610)
            dev_pub_hex = dev_pub.hex()
            _LOG.info("devicePublicKey=%s…", dev_pub_hex[:24])

            # 6) Decide: reuse cache or fresh cloud verify
            if cached and cached["devicePublicKey"] == dev_pub_hex:
                _LOG.info("♻️ Same devicePublicKey → REUSE cached sessionKey (no cloud verify!)")
                v = {"sessionKey": cached["sessionKey"], "nonce": cached["nonce"],
                     "verifyData": cached["verifyData"]}
            else:
                if cached:
                    _LOG.info("Lock returned NEW publicKey → cache stale → fresh cloud handshake")
                _LOG.info("Cloud: verify…")
                v = await cl.verify(did, dev_pub_hex)
                _LOG.info("sessionKey=%s… nonce=%s",
                          v["sessionKey"][:24], v["nonce"])
                save_cached_session(did, cloud_pub_hex, dev_pub_hex,
                                    v["sessionKey"], v["nonce"], v["verifyData"])

            _LOG.info("BLE: send 0710 verifyData…")
            try:
                await hs_exchange(cli, 0x0710, bytes.fromhex(v["verifyData"]), timeout=5.0)
            except asyncio.TimeoutError:
                pass  # 0710 'da' ack is best-effort
            _LOG.info("✅ HANDSHAKE COMPLETE — sessionKey=%s nonce=%s",
                      v["sessionKey"], v["nonce"])

            # 7) Optional: fire openLock (01/74) via CMD channel ff61, listen status on ff62.
            op = (os.environ.get("OP") or "").lower()
            if not op:
                _LOG.info("OP env empty → skipping unlock. Set OP=open|close|unbolt to fire.")
                return 0

            op_map = {"open": protocol.OPEN_OPEN, "close": protocol.OPEN_CLOSE,
                      "unbolt": protocol.OPEN_UNBOLT}
            if op not in op_map:
                _LOG.error("OP must be one of: open close unbolt (got %r)", op)
                return 2
            key = protocol.LockKey(
                session_key=bytes.fromhex(v["sessionKey"]),
                nonce=bytes.fromhex(v["nonce"]),
            )
            _LOG.info("⚠️ FIRING %s (01/74) — this moves the real lock!", op.upper())

            status: Optional[protocol.LockFrame] = None
            event = asyncio.Event()

            def on_cmd_notify(_handle, data: bytearray) -> None:
                nonlocal status
                try:
                    frame = protocol.unpack(key, bytes(data))
                except Exception as e:  # noqa: BLE001
                    _LOG.debug("notify decrypt skip: %s", e)
                    return
                _LOG.info("notify main=0x%02x sub=0x%02x data=%s",
                          frame.main_cmd, frame.sub_cmd, frame.data.hex())
                ls = protocol.parse_door_status(frame)
                if ls is not None and status is None:
                    status = frame
                    event.set()

            await cli.start_notify(gatt.CMD_NOTIFY, on_cmd_notify)
            try:
                frame_bytes = protocol.build_open_lock(key, op_map[op])
                _LOG.info("BLE: send %s (%d bytes) on FF61…", op, len(frame_bytes))
                await cli.write_gatt_char(gatt.CMD_WRITE, frame_bytes, response=False)

                # wait up to 3s for an explicit status notify
                try:
                    await asyncio.wait_for(event.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    pass

                if status is not None:
                    ls = protocol.parse_door_status(status)
                    label = {0: "LOCKED", 1: "UNLOCKED", 2: "ERROR"}.get(ls, f"state={ls}")
                    _LOG.info("✅ Lock reported: %s (raw sub=0x%02x data=%s)",
                              label, status.sub_cmd, status.data.hex())
                else:
                    _LOG.info("Command sent. No status notify in 3s — query separately.")
                # also fire an explicit door status query
                q = protocol.build_door_status_report_query(key)
                await cli.write_gatt_char(gatt.CMD_WRITE, q, response=False)
                await asyncio.sleep(1.5)
            finally:
                try:
                    await cli.stop_notify(gatt.CMD_NOTIFY)
                except Exception:  # noqa: BLE001
                    pass
            return 0
        finally:
            try:
                await cli.disconnect()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
