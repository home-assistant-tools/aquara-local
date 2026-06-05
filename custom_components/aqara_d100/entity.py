"""Shared base entity for Aqara D100 devices."""

from __future__ import annotations

from homeassistant.helpers.device_registry import CONNECTION_BLUETOOTH, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DEFAULT_MODEL, DOMAIN, MANUFACTURER
from .coordinator import AqaraD100Coordinator, LockInfo


class AqaraD100Entity(CoordinatorEntity[AqaraD100Coordinator]):
    """Base entity tied to one lock device."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: AqaraD100Coordinator, lock: LockInfo) -> None:
        super().__init__(coordinator)
        self._lock = lock
        connections = set()
        if lock.mac:
            connections.add((CONNECTION_BLUETOOTH, lock.mac.upper()))
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, lock.did)},
            name=lock.name,
            manufacturer=MANUFACTURER,
            model=DEFAULT_MODEL,
            connections=connections,
        )

    @property
    def available(self) -> bool:
        state = self.coordinator.data.get(self._lock.did) if self.coordinator.data else None
        return super().available and bool(state and state.available)
