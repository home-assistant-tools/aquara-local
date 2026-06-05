"""Account-level coordinator: cloud status polling + serialized BLE operations."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .ble import LockBleError, run_open_lock
from .cloud import AqaraAuthError, AqaraCloud, login_with_password
from .const import (
    CONF_AREA,
    CONF_DISTRICT,
    CONF_EMAIL,
    CONF_LOCK_DID,
    CONF_LOCK_MAC,
    CONF_LOCK_NAME,
    CONF_LOCKS,
    CONF_PASSWORD,
    CONF_TOKEN,
    CONF_USER_ID,
    SCAN_INTERVAL_SECONDS,
)
from .protocol import OPEN_CLOSE, OPEN_OPEN

_LOGGER = logging.getLogger(__name__)


@dataclass
class LockInfo:
    """Static config for one discovered lock."""

    did: str
    name: str
    mac: str


@dataclass
class LockState:
    """Latest known state for one lock."""

    lock_state: str | None = None
    battery: int | None = None
    available: bool = True
    extra: dict[str, Any] = field(default_factory=dict)
    credentials: list[dict[str, Any]] = field(default_factory=list)
    last_event_ts: int | None = None  # ms epoch of the most recent lock event
    last_event_raw: str | None = None  # raw lock_local_log value (decode is TODO)


# Cloud lock_state → is_locked (None = unknown). 0/6 open, 1/4 locked, 2 error.
_UNLOCKED_STATES = {"0", "6"}
_LOCKED_STATES = {"1", "4"}


class AqaraD100Coordinator(DataUpdateCoordinator[dict[str, LockState]]):
    """Polls the cloud and drives BLE unlock/lock for every lock on the account."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="Aqara D100",
            update_interval=timedelta(seconds=SCAN_INTERVAL_SECONDS),
        )
        self.entry = entry
        self._session = async_get_clientsession(hass)
        self.cloud = AqaraCloud(
            self._session,
            area=entry.data[CONF_AREA],
            token=entry.data[CONF_TOKEN],
            user_id=entry.data[CONF_USER_ID],
        )
        self.locks: list[LockInfo] = [
            LockInfo(did=l[CONF_LOCK_DID], name=l[CONF_LOCK_NAME], mac=l[CONF_LOCK_MAC])
            for l in entry.data[CONF_LOCKS]
        ]
        self._ble_lock = asyncio.Lock()
        self._relogin_lock = asyncio.Lock()

    # ---- token refresh ----------------------------------------------------
    async def _relogin(self) -> None:
        async with self._relogin_lock:
            _LOGGER.info("Aqara token rejected — logging in again")
            res = await login_with_password(
                self._session,
                self.entry.data[CONF_EMAIL],
                self.entry.data[CONF_PASSWORD],
                area=self.entry.data[CONF_AREA],
                district=self.entry.data[CONF_DISTRICT],
            )
            self.cloud.token = res["token"]
            self.cloud.user_id = res["userId"]
            self.hass.config_entries.async_update_entry(
                self.entry,
                data={
                    **self.entry.data,
                    CONF_TOKEN: res["token"],
                    CONF_USER_ID: res["userId"],
                },
            )

    async def _with_auth_retry(self, coro_factory):
        """Run a cloud coroutine, re-logging in once on auth failure."""
        try:
            return await coro_factory()
        except AqaraAuthError:
            await self._relogin()
            return await coro_factory()

    # ---- polling ----------------------------------------------------------
    async def _async_update_data(self) -> dict[str, LockState]:
        data: dict[str, LockState] = {}
        for lock in self.locks:
            try:
                res = await self._with_auth_retry(
                    lambda lock=lock: self.cloud.lock_resources(lock.did)
                )
            except AqaraAuthError as err:
                raise UpdateFailed(f"authentication failed: {err}") from err
            except Exception as err:  # noqa: BLE001 — network blips shouldn't crash setup
                _LOGGER.debug("status poll failed for %s: %s", lock.did, err)
                data[lock.did] = LockState(available=False)
                continue
            battery = res.get("batt_0_remain_percentage")
            # NOTE: `device_offline_status` is NOT a reliable offline flag — it reads
            # "1" even when the lock is fully online and responding to commands
            # (verified live: remote unlock worked with this field stuck at "1").
            # So availability tracks only whether the cloud poll itself succeeded;
            # a real network/auth failure is handled in the except branch above.
            state = LockState(
                lock_state=res.get("lock_state"),
                battery=int(battery) if battery and str(battery).isdigit() else None,
                available=True,
                extra=res,
            )
            # Best-effort extras — never let them fail the whole poll.
            await self._poll_extras(lock, state)
            data[lock.did] = state
        return data

    async def _poll_extras(self, lock: LockInfo, state: LockState) -> None:
        """Fetch event history + credential list for sensors. Non-fatal."""
        try:
            hist = await self._with_auth_retry(lambda: self.cloud.lock_history(lock.did, size=20))
            events = hist.get("resultList") or hist.get("data") or [] if isinstance(hist, dict) else []
            if events:
                latest = events[0]
                ts = latest.get("timeStamp") or latest.get("timestamp")
                state.last_event_ts = int(ts) if ts and str(ts).isdigit() else None
                state.last_event_raw = latest.get("value")
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("history poll failed for %s: %s", lock.did, err)
        try:
            state.credentials = await self._with_auth_retry(
                lambda: self.cloud.lock_credentials(lock.did)
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("credentials poll failed for %s: %s", lock.did, err)

    # ---- helpers for entities --------------------------------------------
    def is_locked(self, did: str) -> bool | None:
        state = self.data.get(did) if self.data else None
        if not state or state.lock_state is None:
            return None
        if state.lock_state in _UNLOCKED_STATES:
            return False
        if state.lock_state in _LOCKED_STATES:
            return True
        return None

    def lock_by_did(self, did: str) -> LockInfo | None:
        return next((l for l in self.locks if l.did == did), None)

    async def async_cloud_action(self, label: str, factory) -> Any:
        """Run an arbitrary cloud call (for services) with auth retry + refresh.

        Cloud-only by design: these management commands have no BLE fallback.
        """
        try:
            result = await self._with_auth_retry(factory)
        except AqaraAuthError as err:
            raise HomeAssistantError(f"Aqara authentication failed: {err}") from err
        except Exception as err:  # noqa: BLE001
            raise HomeAssistantError(f"{label} failed: {err}") from err
        _LOGGER.debug("cloud action %s ok: %s", label, result)
        await self.async_request_refresh()
        return result

    # ---- unlock actions ---------------------------------------------------
    async def async_open(self, lock: LockInfo) -> None:
        """Unlock: cloud remote-unlock first, BLE proxy as fallback."""
        await self._command(lock, "unlock", self.cloud.remote_unlock, OPEN_OPEN, "6")

    async def async_close(self, lock: LockInfo) -> None:
        """Lock: cloud remote-lock (Matter lockDoor) first, BLE proxy as fallback."""
        await self._command(lock, "lock", self.cloud.remote_lock, OPEN_CLOSE, "4")

    async def _command(self, lock, verb, cloud_call, ble_op, optimistic_state) -> None:
        """Run a lock command cloud-first, falling back to BLE.

        On cloud success the result is logged (enable debug logging to see the raw
        /matter/write response). On cloud failure we try BLE; if BLE is unavailable
        too, the *cloud* error is surfaced to the UI — not a misleading Bluetooth one.
        """
        try:
            result = await self._with_auth_retry(lambda: cloud_call(lock.did))
        except AqaraAuthError as err:
            raise HomeAssistantError(f"Aqara authentication failed: {err}") from err
        except Exception as cloud_err:  # noqa: BLE001 — cloud may be down / hub offline
            _LOGGER.warning(
                "cloud %s failed for %s (%s) — trying BLE fallback",
                verb, lock.did, cloud_err,
            )
            try:
                await self._ble_op(lock, ble_op)
            except HomeAssistantError as ble_err:
                raise HomeAssistantError(
                    f"{verb.capitalize()} failed. Cloud: {cloud_err}. "
                    f"BLE fallback: {ble_err}"
                ) from cloud_err
            return
        # cloud accepted (code 0); reflect optimistically and re-poll for the real state.
        _LOGGER.debug("cloud %s accepted for %s: %s", verb, lock.did, result)
        state = self.data.get(lock.did) if self.data else None
        if state:
            state.lock_state = optimistic_state
            self.async_set_updated_data(self.data)
        await self.async_request_refresh()

    async def _ble_op(self, lock: LockInfo, op_type: int) -> None:
        async with self._ble_lock:  # one BLE session at a time per account
            try:
                status = await self._with_auth_retry(
                    lambda: run_open_lock(self.hass, lock.mac, lock.did, self.cloud, op_type)
                )
            except LockBleError as err:
                # BLE control still being brought up (see README) — surface a clean
                # action error rather than a coordinator UpdateFailed.
                raise HomeAssistantError(
                    f"Could not reach {lock.name} over Bluetooth: {err}. "
                    "An ESPHome Bluetooth proxy near the door is required for unlock/lock."
                ) from err
        if status is not None:
            # Optimistically reflect the just-read BLE status.
            state = self.data.get(lock.did) if self.data else None
            if state:
                state.lock_state = "6" if status == 1 else "4" if status == 0 else state.lock_state
                self.async_set_updated_data(self.data)
        await self.async_request_refresh()
