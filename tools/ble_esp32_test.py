#!/usr/bin/env python3
"""Standalone D100 unlock test through an ESP32 (ESPHome bluetooth_proxy).

No Home Assistant required. The Mac talks to the ESP32 over the ESPHome native
API (TCP); the ESP32 is the BLE radio next to the door — this sidesteps macOS
CoreBluetooth/TCC entirely. It reuses the SAME ported protocol/crypto/cloud code
that the HA integration uses (custom_components/aqara_d100/), so a success here
means the integration's BLE leg works.

What it does:
  1. Cloud login (email/password) → token.
  2. Resolve the lock DID + BLE MAC (auto-discover, or from env).
  3. Connect to the ESP32, scan for the lock advert, connect GATT.
  4. Dump the real GATT services/characteristics (to confirm/fix UUIDs).
  5. Run the 0610/0710 cloud→BLE handshake → sessionKey.
  6. Send openLock (01/74) and read back lock status.

Usage:
  export AQARA_EMAIL=...        AQARA_PASSWORD=...
  export AQARA_AREA=SEA         AQARA_DISTRICT=VN          # optional (defaults)
  export ESP32_HOST=192.168.1.50
  export ESP32_NOISE_PSK="base64=="   # ESPHome api: encryption key  (or ESP32_PASSWORD=...)
  # optional, skip cloud discovery:
  export LOCK_DID=lumi....      LOCK_MAC=AA:BB:CC:DD:EE:FF
  python3 tools/ble_esp32_test.py            # full unlock test
  python3 tools/ble_esp32_test.py --scan     # only list BLE adverts (find the lock)
  python3 tools/ble_esp32_test.py --op close # close instead of open
  python3 tools/ble_esp32_test.py --dry      # connect + dump GATT, no unlock

Requires: pip install aioesphomeapi aiohttp cryptography
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import logging
import os
import pathlib
import sys
import types

from aioesphomeapi import APIClient

# --- import the ported modules WITHOUT running the HA-coupled package __init__ ---
ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / "custom_components" / "aqara_d100"
_ns = types.ModuleType("aqd100")
_ns.__path__ = [str(PKG_DIR)]
sys.modules["aqd100"] = _ns
cloud = importlib.import_module("aqd100.cloud")
protocol = importlib.import_module("aqd100.protocol")
gatt = importlib.import_module("aqd100.gatt")

import aiohttp  # noqa: E402

_LOG = logging.getLogger("d100.esp32test")

HANDSHAKE_TIMEOUT = 9.0
STATUS_TIMEOUT = 3.0
OP_TYPES = {"open": protocol.OPEN_OPEN, "close": protocol.OPEN_CLOSE, "unbolt": protocol.OPEN_UNBOLT}


def _mac_to_int(mac: str) -> int:
    return int("".join(c for c in mac if c in "0123456789abcdefABCDEF"), 16)


def _find_handle(services, uuid: str) -> int | None:
    """Find a characteristic handle by full UUID (case-insensitive), else by suffix."""
    want = uuid.lower()
    short = want.split("-")[0].lstrip("0") or want  # e.g. 'ffb1'
    fallback: int | None = None
    for svc in services.services:
        for ch in svc.characteristics:
            cu = str(ch.uuid).lower()
            if cu == want:
                return ch.handle
            if short and short in cu:
                fallback = ch.handle
    return fallback


class Esp32Lock:
    """Drives the D100 over an ESPHome BLE proxy using raw aioesphomeapi calls."""

    def __init__(self, cli: APIClient, address: int, address_type: int | None) -> None:
        self.cli = cli
        self.addr = address
        self.addr_type = address_type
        self.services = None
        self.h_hs_write: int | None = None
        self.h_hs_notify: int | None = None
        self.h_cmd_write: int | None = None
        self.h_cmd_notify: int | None = None

    async def connect(self) -> None:
        loop = asyncio.get_running_loop()
        connected = loop.create_future()

        def on_state(is_connected: bool, mtu: int, error: int) -> None:
            _LOG.info("BLE state: connected=%s mtu=%s error=%s", is_connected, mtu, error)
            if is_connected and not connected.done():
                connected.set_result(True)
            elif not is_connected and not connected.done():
                connected.set_exception(RuntimeError(f"connect failed (error={error})"))

        _LOG.info("Connecting GATT to %012x (type=%s)…", self.addr, self.addr_type)
        await self.cli.bluetooth_device_connect(
            self.addr, on_state, timeout=30.0, address_type=self.addr_type
        )
        await asyncio.wait_for(connected, 30.0)
        self.services = await self.cli.bluetooth_gatt_get_services(self.addr)
        self._map_handles()

    def _map_handles(self) -> None:
        _LOG.info("=== discovered GATT layout ===")
        for svc in self.services.services:
            chars = ", ".join(
                f"{ch.uuid}#{ch.handle}({ch.properties})" for ch in svc.characteristics
            )
            _LOG.info("svc %s #%s: %s", svc.uuid, svc.handle, chars)
        self.h_hs_write = _find_handle(self.services, gatt.HANDSHAKE_WRITE)
        self.h_hs_notify = _find_handle(self.services, gatt.HANDSHAKE_NOTIFY)
        self.h_cmd_write = _find_handle(self.services, gatt.CMD_WRITE)
        self.h_cmd_notify = _find_handle(self.services, gatt.CMD_NOTIFY)
        _LOG.info(
            "handles: hs_write=%s hs_notify=%s cmd_write=%s cmd_notify=%s",
            self.h_hs_write, self.h_hs_notify, self.h_cmd_write, self.h_cmd_notify,
        )
        missing = [
            n for n, h in (
                ("ffb1", self.h_hs_write), ("ffb2", self.h_hs_notify),
                ("cmd_write", self.h_cmd_write), ("cmd_notify", self.h_cmd_notify),
            ) if h is None
        ]
        if missing:
            _LOG.warning("MISSING characteristics: %s — fix UUIDs in gatt.py", missing)

    async def hs_exchange(self, pack_cmd: int, data: bytes) -> bytes:
        loop = asyncio.get_running_loop()
        reasm = gatt.HsReassembler()
        fut: asyncio.Future[bytes] = loop.create_future()

        def on_notify(_handle: int, payload: bytearray) -> None:
            full = reasm.push(bytes(payload))
            if full is not None and not fut.done():
                fut.set_result(full)

        stop, _cancel = await self.cli.bluetooth_gatt_start_notify(
            self.addr, self.h_hs_notify, on_notify
        )
        try:
            for frame in gatt.build_aiot_frames(pack_cmd, data):
                await self.cli.bluetooth_gatt_write(self.addr, self.h_hs_write, frame, True)
            return await asyncio.wait_for(fut, HANDSHAKE_TIMEOUT)
        finally:
            await stop()

    async def handshake(self, cl: "cloud.AqaraCloud", did: str) -> "protocol.LockKey":
        pk = await cl.publickey(did)
        _LOG.info("cloud publickey ✓ (mac=%s)", pk.get("mac"))
        resp = await self.hs_exchange(0x0610, bytes.fromhex(pk["cloudPublicKey"]))
        device_pub = gatt.extract_pubkey(resp)
        _LOG.info("lock devicePublicKey ✓ %s…", device_pub.hex()[:24])
        v = await cl.verify(did, device_pub.hex())
        _LOG.info("cloud verify ✓ sessionKey=%s nonce=%s", v["sessionKey"], v["nonce"])
        try:
            await self.hs_exchange(0x0710, bytes.fromhex(v["verifyData"]))
        except (asyncio.TimeoutError, TimeoutError):
            _LOG.debug("0710 push returned no status frame (continuing)")
        return protocol.LockKey(
            session_key=bytes.fromhex(v["sessionKey"]), nonce=bytes.fromhex(v["nonce"])
        )

    async def open_lock(self, key: "protocol.LockKey", op_type: int) -> int | None:
        pkt = protocol.build_open_lock(key, op_type)
        _LOG.info("sending openLock op=%s packet=%s", op_type, pkt.hex())
        await self.cli.bluetooth_gatt_write(self.addr, self.h_cmd_write, pkt, True)
        await asyncio.sleep(0.7)
        return await self.read_status(key)

    async def read_status(self, key: "protocol.LockKey") -> int | None:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[int] = loop.create_future()

        def on_notify(_handle: int, payload: bytearray) -> None:
            try:
                frame = protocol.unpack(key, bytes(payload))
            except Exception:  # noqa: BLE001
                return
            status = protocol.parse_door_status(frame)
            if status is not None and not fut.done():
                fut.set_result(status)

        stop, _cancel = await self.cli.bluetooth_gatt_start_notify(
            self.addr, self.h_cmd_notify, on_notify
        )
        try:
            for builder in (
                protocol.build_door_status_report_query,
                protocol.build_door_status_query,
            ):
                await self.cli.bluetooth_gatt_write(self.addr, self.h_cmd_write, builder(key), True)
                try:
                    return await asyncio.wait_for(asyncio.shield(fut), STATUS_TIMEOUT)
                except (asyncio.TimeoutError, TimeoutError):
                    continue
            return None
        finally:
            await stop()

    async def disconnect(self) -> None:
        try:
            await self.cli.bluetooth_device_disconnect(self.addr)
        except Exception:  # noqa: BLE001
            pass


async def discover_address(cli: APIClient, target_mac: int, timeout: float = 30.0):
    """Subscribe to LE adverts and return (address, address_type) for the lock."""
    loop = asyncio.get_running_loop()
    found: asyncio.Future = loop.create_future()
    seen: set[int] = set()

    def on_adv(adv) -> None:
        if adv.address not in seen:
            seen.add(adv.address)
            _LOG.debug("advert %012x rssi=%s name=%r", adv.address, adv.rssi, adv.name)
        if adv.address == target_mac and not found.done():
            found.set_result((adv.address, adv.address_type))

    unsub = cli.subscribe_bluetooth_le_advertisements(on_adv)
    try:
        return await asyncio.wait_for(found, timeout)
    finally:
        unsub()


async def scan_only(cli: APIClient, seconds: float = 20.0) -> None:
    """List every advert seen — use this to find the lock's MAC."""
    rows: dict[int, tuple] = {}

    def on_adv(adv) -> None:
        rows[adv.address] = (adv.rssi, adv.name, list(adv.service_uuids))

    unsub = cli.subscribe_bluetooth_le_advertisements(on_adv)
    _LOG.info("Scanning %.0fs … (look for name 'DP1A' / your lock)", seconds)
    await asyncio.sleep(seconds)
    unsub()
    for addr, (rssi, name, uuids) in sorted(rows.items(), key=lambda x: -x[1][0]):
        mac = ":".join(f"{(addr >> (8 * i)) & 0xFF:02X}" for i in range(5, -1, -1))
        print(f"  {mac}  rssi={rssi:>4}  name={name!r}  svc={uuids}")
    print(f"\n{len(rows)} devices. Set LOCK_MAC=<the lock's MAC> and re-run.")


async def main() -> int:
    parser = argparse.ArgumentParser(description="D100 unlock test via ESP32 proxy")
    parser.add_argument("--op", choices=list(OP_TYPES), default="open")
    parser.add_argument("--scan", action="store_true", help="only list BLE adverts")
    parser.add_argument("--dry", action="store_true", help="connect + dump GATT, no command")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    host = os.environ.get("ESP32_HOST")
    if not host:
        print("ERROR: set ESP32_HOST (the ESPHome proxy IP).", file=sys.stderr)
        return 2
    cli = APIClient(
        host,
        int(os.environ.get("ESP32_PORT", "6053")),
        os.environ.get("ESP32_PASSWORD") or None,
        noise_psk=os.environ.get("ESP32_NOISE_PSK") or None,
    )
    await cli.connect(login=True)
    info = await cli.device_info()
    _LOG.info("ESP32 connected: %s (esphome %s)", info.name, info.esphome_version)

    try:
        if args.scan:
            await scan_only(cli)
            return 0

        async with aiohttp.ClientSession() as session:
            email = os.environ["AQARA_EMAIL"]
            password = os.environ["AQARA_PASSWORD"]
            area = os.environ.get("AQARA_AREA", "SEA")
            district = os.environ.get("AQARA_DISTRICT", "VN")
            _LOG.info("Cloud login as %s (area=%s)…", email, area)
            auth = await cloud.login_with_password(session, email, password, area, district)
            cl = cloud.AqaraCloud(session, area, auth["token"], auth["userId"])
            _LOG.info("Login ✓ userId=%s", auth["userId"])

            did = os.environ.get("LOCK_DID")
            mac = os.environ.get("LOCK_MAC")
            if not did or not mac:
                locks = await cl.list_locks(fallback_did=did)
                if not locks:
                    _LOG.error("No lock found on account — set LOCK_DID/LOCK_MAC.")
                    return 1
                did = did or locks[0]["did"]
                _LOG.info("Lock: %s (%s)", locks[0]["name"], did)
                if not mac:
                    mac = (await cl.publickey(did)).get("mac")
            _LOG.info("Lock DID=%s MAC=%s", did, mac)

            target = _mac_to_int(mac)
            addr, addr_type = await discover_address(cli, target)
            _LOG.info("Lock advert seen ✓ addr=%012x type=%s", addr, addr_type)

            lock = Esp32Lock(cli, addr, addr_type)
            await lock.connect()
            try:
                if args.dry:
                    _LOG.info("--dry: GATT dumped, skipping unlock.")
                    return 0
                key = await lock.handshake(cl, did)
                status = await lock.open_lock(key, OP_TYPES[args.op])
                label = {0: "LOCKED", 1: "UNLOCKED", 2: "ERROR"}.get(status, "unknown")
                _LOG.info("RESULT: op=%s → lock status=%s (%s)", args.op, status, label)
            finally:
                await lock.disconnect()
        return 0
    finally:
        await cli.disconnect()


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
