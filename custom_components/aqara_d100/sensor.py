"""Sensors for the Aqara D100: battery, last event, credential count."""

from __future__ import annotations

from datetime import datetime, timezone

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, EntityCategory
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
    """Set up D100 sensors."""
    coordinator: AqaraD100Coordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SensorEntity] = []
    for lock in coordinator.locks:
        entities.append(AqaraD100BatterySensor(coordinator, lock))
        entities.append(AqaraD100LastEventSensor(coordinator, lock))
        entities.append(AqaraD100CredentialCountSensor(coordinator, lock))
    async_add_entities(entities)


class AqaraD100BatterySensor(AqaraD100Entity, SensorEntity):
    """Reports the lock battery percentage (from the cloud poll)."""

    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_translation_key = "battery"

    def __init__(self, coordinator: AqaraD100Coordinator, lock: LockInfo) -> None:
        super().__init__(coordinator, lock)
        self._attr_unique_id = f"{lock.did}_battery"

    @property
    def native_value(self) -> int | None:
        state = self.coordinator.data.get(self._lock.did) if self.coordinator.data else None
        return state.battery if state else None


class AqaraD100LastEventSensor(AqaraD100Entity, SensorEntity):
    """Timestamp of the most recent lock event (from the cloud event history).

    This is how Home Assistant learns about opens that happened *outside* HA — e.g.
    a PIN/NFC/manual unlock. Polled with the coordinator (~60 s), so it is near-real-time,
    not instant. The raw `lock_local_log` value is exposed as an attribute (decoding the
    who/how is still TODO).
    """

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_translation_key = "last_event"

    def __init__(self, coordinator: AqaraD100Coordinator, lock: LockInfo) -> None:
        super().__init__(coordinator, lock)
        self._attr_unique_id = f"{lock.did}_last_event"

    @property
    def native_value(self) -> datetime | None:
        state = self.coordinator.data.get(self._lock.did) if self.coordinator.data else None
        if not state or not state.last_event_ts:
            return None
        return datetime.fromtimestamp(state.last_event_ts / 1000, tz=timezone.utc)

    @property
    def extra_state_attributes(self) -> dict[str, str] | None:
        state = self.coordinator.data.get(self._lock.did) if self.coordinator.data else None
        if not state or not state.last_event_raw:
            return None
        return {"raw": state.last_event_raw}


class AqaraD100CredentialCountSensor(AqaraD100Entity, SensorEntity):
    """How many credentials (PIN/NFC/fingerprint/face) are registered on the lock."""

    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_translation_key = "credential_count"

    def __init__(self, coordinator: AqaraD100Coordinator, lock: LockInfo) -> None:
        super().__init__(coordinator, lock)
        self._attr_unique_id = f"{lock.did}_credential_count"

    @property
    def native_value(self) -> int | None:
        state = self.coordinator.data.get(self._lock.did) if self.coordinator.data else None
        return len(state.credentials) if state else None
