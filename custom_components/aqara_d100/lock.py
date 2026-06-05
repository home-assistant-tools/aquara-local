"""Lock platform for the Aqara D100."""

from __future__ import annotations

from typing import Any

from homeassistant.components.lock import LockEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import AqaraD100Coordinator, LockInfo
from .entity import AqaraD100Entity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up D100 lock entities."""
    coordinator: AqaraD100Coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(AqaraD100Lock(coordinator, lock) for lock in coordinator.locks)


class AqaraD100Lock(AqaraD100Entity, LockEntity):
    """A D100 door lock controlled over BLE."""

    _attr_name = None  # use the device name

    def __init__(self, coordinator: AqaraD100Coordinator, lock: LockInfo) -> None:
        super().__init__(coordinator, lock)
        self._attr_unique_id = f"{lock.did}_lock"
        self._unlocking = False
        self._locking = False

    @property
    def is_locked(self) -> bool | None:
        if self._unlocking or self._locking:
            return None
        return self.coordinator.is_locked(self._lock.did)

    @property
    def is_locking(self) -> bool:
        return self._locking

    @property
    def is_unlocking(self) -> bool:
        return self._unlocking

    async def async_unlock(self, **kwargs: Any) -> None:
        self._unlocking = True
        self.async_write_ha_state()
        try:
            await self.coordinator.async_open(self._lock)
        finally:
            self._unlocking = False
            self.async_write_ha_state()

    async def async_lock(self, **kwargs: Any) -> None:
        self._locking = True
        self.async_write_ha_state()
        try:
            await self.coordinator.async_close(self._lock)
        finally:
            self._locking = False
            self.async_write_ha_state()
