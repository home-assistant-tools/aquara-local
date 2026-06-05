"""BLE unlock path for the D100, routed through an ESPHome Bluetooth proxy.

Per command we:
  1. ask the cloud for `cloudPublicKey` (ECDH is computed cloud-side),
  2. exchange public keys with the lock over the 0xffb1/0xffb2 handshake channel,
  3. ask the cloud to `verify` → sessionKey + nonce + verifyData,
  4. push verifyData back to the lock, then
  5. send the AES-CCM encrypted command on the f2042ffd channel.

The lock is reached via Home Assistant's `bluetooth` integration, so any ESP32
running the ESPHome `bluetooth_proxy` (active mode) placed near the door works
as the radio — no phone required.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING

from bleak.backends.device import BLEDevice
from bleak.exc import BleakError
from bleak_retry_connector import BleakClientWithServiceCache, establish_connection

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

from .cloud import AqaraCloud
from .gatt import (
    CMD_NOTIFY,
    CMD_WRITE,
    HANDSHAKE_NOTIFY,
    HANDSHAKE_WRITE,
    HsReassembler,
    build_aiot_frames,
    extract_pubkey,
)
from .protocol import (
    LockKey,
    OPEN_OPEN,
    build_door_status_query,
    build_door_status_report_query,
    build_open_lock,
    parse_door_status,
    unpack,
)

_LOGGER = logging.getLogger(__name__)

HANDSHAKE_TIMEOUT = 9.0
STATUS_TIMEOUT = 4.0


class LockBleError(Exception):
    """Raised when the BLE leg of an operation fails."""


def _log_services(client: BleakClientWithServiceCache) -> None:
    """Dump discovered GATT layout at debug level — useful for hardware bring-up."""
    if not _LOGGER.isEnabledFor(logging.DEBUG):
        return
    try:
        for service in client.services:
            chars = ", ".join(
                f"{c.uuid}({'/'.join(c.properties)})" for c in service.characteristics
            )
            _LOGGER.debug("svc %s: %s", service.uuid, chars)
    except Exception:  # noqa: BLE001 — diagnostics only
        pass


def _resolve_device(hass: "HomeAssistant", mac: str) -> BLEDevice:
    from homeassistant.components import bluetooth

    device = bluetooth.async_ble_device_from_address(hass, mac.upper(), connectable=True)
    if device is None:
        raise LockBleError(
            f"Lock {mac} is not reachable by any connectable Bluetooth adapter/proxy. "
            "Place an ESP32 (ESPHome bluetooth_proxy, active) near the door."
        )
    return device


async def _hs_exchange(
    client: BleakClientWithServiceCache, pack_cmd: int, data: bytes
) -> bytes:
    """Write one AIOT packCmd on ffb1 and reassemble the 'da' response from ffb2."""
    loop = asyncio.get_running_loop()
    reasm = HsReassembler()
    fut: asyncio.Future[bytes] = loop.create_future()

    def _on_notify(_sender: int, payload: bytearray) -> None:
        full = reasm.push(bytes(payload))
        if full is not None and not fut.done():
            fut.set_result(full)

    await client.start_notify(HANDSHAKE_NOTIFY, _on_notify)
    try:
        for frame in build_aiot_frames(pack_cmd, data):
            await client.write_gatt_char(HANDSHAKE_WRITE, frame, response=True)
        return await asyncio.wait_for(fut, HANDSHAKE_TIMEOUT)
    except (asyncio.TimeoutError, TimeoutError) as err:
        raise LockBleError(f"handshake 0x{pack_cmd:04x} timed out") from err
    finally:
        with contextlib.suppress(BleakError, EOFError, OSError):
            await client.stop_notify(HANDSHAKE_NOTIFY)


async def _handshake(
    client: BleakClientWithServiceCache, did: str, cloud: AqaraCloud
) -> LockKey:
    pk = await cloud.publickey(did)
    cloud_pub = bytes.fromhex(pk["cloudPublicKey"])
    resp = await _hs_exchange(client, 0x0610, cloud_pub)
    device_pub = extract_pubkey(resp)
    v = await cloud.verify(did, device_pub.hex())
    # push verifyData (best effort — sessionKey is already authoritative from the cloud)
    try:
        await _hs_exchange(client, 0x0710, bytes.fromhex(v["verifyData"]))
    except LockBleError:
        _LOGGER.debug("0710 verifyData push did not return a status frame (continuing)")
    return LockKey(
        session_key=bytes.fromhex(v["sessionKey"]),
        nonce=bytes.fromhex(v["nonce"]),
    )


async def _read_status(client: BleakClientWithServiceCache, key: LockKey) -> int | None:
    """Query door/lock status and return 0=locked / 1=unlocked / 2=error, or None."""
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[int] = loop.create_future()

    def _on_notify(_sender: int, payload: bytearray) -> None:
        try:
            frame = unpack(key, bytes(payload))
        except Exception:  # noqa: BLE001 — handshake/fragmented notifies don't decode
            return
        status = parse_door_status(frame)
        if status is not None and not fut.done():
            fut.set_result(status)

    await client.start_notify(CMD_NOTIFY, _on_notify)
    try:
        for builder in (build_door_status_report_query, build_door_status_query):
            try:
                await client.write_gatt_char(CMD_WRITE, builder(key), response=True)
            except BleakError:
                continue
            try:
                return await asyncio.wait_for(asyncio.shield(fut), STATUS_TIMEOUT / 2)
            except (asyncio.TimeoutError, TimeoutError):
                continue
        return None
    finally:
        with contextlib.suppress(BleakError, EOFError, OSError):
            await client.stop_notify(CMD_NOTIFY)


async def open_lock_on_device(
    device: BLEDevice,
    did: str,
    cloud: AqaraCloud,
    op_type: int = OPEN_OPEN,
) -> int | None:
    """Full unlock/lock cycle against an already-resolved BLEDevice.

    Transport-agnostic: works with a HA-resolved device or one from a standalone
    bleak-esphome scanner. Returns the post-command lock status (or None).
    """
    _LOGGER.debug("D100 %s: connecting via %s", did, device.address)
    client = await establish_connection(BleakClientWithServiceCache, device, did)
    try:
        _log_services(client)
        key = await _handshake(client, did, cloud)
        await client.write_gatt_char(CMD_WRITE, build_open_lock(key, op_type), response=True)
        await asyncio.sleep(0.7)
        return await _read_status(client, key)
    except BleakError as err:
        raise LockBleError(f"BLE operation failed: {err}") from err
    finally:
        with contextlib.suppress(BleakError, EOFError, OSError):
            await client.disconnect()


async def run_open_lock(
    hass: "HomeAssistant",
    mac: str,
    did: str,
    cloud: AqaraCloud,
    op_type: int = OPEN_OPEN,
) -> int | None:
    """HA entry point: resolve the lock via the bluetooth stack, then drive it."""
    device = _resolve_device(hass, mac)
    return await open_lock_on_device(device, did, cloud, op_type)
