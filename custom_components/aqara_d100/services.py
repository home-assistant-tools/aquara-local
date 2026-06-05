"""Home Assistant services for D100 lock management (cloud-only for now).

These expose the cloud functions that don't map onto the standard `lock` entity:
unbolt, identify, credential delete/disable, user-group management, and a generic
Matter trait write for experimenting with the not-yet-captured commands.

All of these go through the Aqara cloud (no BLE). The ones that write Matter
credential/user/schedule traits are UNVERIFIED — see CLOUD_API.md — and are offered
via the generic `matter_write` escape hatch rather than typed services.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .coordinator import AqaraD100Coordinator, LockInfo

_LOGGER = logging.getLogger(__name__)

ATTR_DID = "did"
ATTR_TRAIT = "trait"
ATTR_VALUE = "value"
ATTR_CRED_TYPE = "credential_type"
ATTR_TYPE_VALUE = "type_value"
ATTR_TYPE_GROUP_ID = "type_group_id"
ATTR_TYPE_NAME = "type_name"
ATTR_VALID_RANGE = "valid_range"
ATTR_GROUP_NAME = "group_name"
ATTR_GROUP_KIND = "type_group"

_DID = vol.Schema({vol.Required(ATTR_DID): cv.string})


def _resolve(hass: HomeAssistant, did: str) -> tuple[AqaraD100Coordinator, LockInfo]:
    """Find the coordinator + lock that owns this did."""
    for coordinator in hass.data.get(DOMAIN, {}).values():
        if not isinstance(coordinator, AqaraD100Coordinator):
            continue
        lock = coordinator.lock_by_did(did)
        if lock:
            return coordinator, lock
    raise HomeAssistantError(f"No configured Aqara D100 with did={did}")


def async_setup_services(hass: HomeAssistant) -> None:
    """Register the integration's services once."""
    if hass.services.has_service(DOMAIN, "unbolt"):
        return

    async def unbolt(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        await c.async_cloud_action("unbolt", lambda: c.cloud.remote_unbolt(lock.did))

    async def identify(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        await c.async_cloud_action("identify", lambda: c.cloud.identify(lock.did))

    async def matter_write(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        trait = call.data[ATTR_TRAIT]
        value = call.data.get(ATTR_VALUE, "")
        await c.async_cloud_action(
            f"matter_write {trait}", lambda: c.cloud.matter_write(lock.did, trait, value)
        )

    async def delete_credential(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        await c.async_cloud_action(
            "delete_credential",
            lambda: c.cloud.delete_credential(
                lock.did, int(call.data[ATTR_CRED_TYPE]), call.data[ATTR_TYPE_VALUE]
            ),
        )

    async def set_credential_validity(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        await c.async_cloud_action(
            "set_credential_validity",
            lambda: c.cloud.update_credential(
                lock.did,
                int(call.data[ATTR_CRED_TYPE]),
                call.data[ATTR_TYPE_VALUE],
                call.data[ATTR_TYPE_GROUP_ID],
                call.data.get(ATTR_TYPE_NAME, ""),
                valid_range=call.data.get(ATTR_VALID_RANGE),
            ),
        )

    async def create_user_group(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        await c.async_cloud_action(
            "create_user_group",
            lambda: c.cloud.create_user_group(
                lock.did,
                call.data[ATTR_TYPE_GROUP_ID],
                call.data[ATTR_GROUP_NAME],
                call.data.get(ATTR_GROUP_KIND, "3"),
            ),
        )

    async def delete_user_group(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        await c.async_cloud_action(
            "delete_user_group",
            lambda: c.cloud.delete_user_group(lock.did, call.data[ATTR_TYPE_GROUP_ID]),
        )

    async def rename_user_group(call: ServiceCall) -> None:
        c, lock = _resolve(hass, call.data[ATTR_DID])
        await c.async_cloud_action(
            "rename_user_group",
            lambda: c.cloud.rename_user_group(
                lock.did,
                call.data[ATTR_TYPE_GROUP_ID],
                call.data[ATTR_GROUP_NAME],
                call.data.get(ATTR_GROUP_KIND, "3"),
            ),
        )

    hass.services.async_register(DOMAIN, "unbolt", unbolt, schema=_DID)
    hass.services.async_register(DOMAIN, "identify", identify, schema=_DID)
    hass.services.async_register(
        DOMAIN,
        "matter_write",
        matter_write,
        schema=vol.Schema(
            {
                vol.Required(ATTR_DID): cv.string,
                vol.Required(ATTR_TRAIT): cv.string,
                vol.Optional(ATTR_VALUE, default=""): cv.string,
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        "delete_credential",
        delete_credential,
        schema=vol.Schema(
            {
                vol.Required(ATTR_DID): cv.string,
                vol.Required(ATTR_CRED_TYPE): vol.Coerce(int),
                vol.Required(ATTR_TYPE_VALUE): cv.string,
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        "set_credential_validity",
        set_credential_validity,
        schema=vol.Schema(
            {
                vol.Required(ATTR_DID): cv.string,
                vol.Required(ATTR_CRED_TYPE): vol.Coerce(int),
                vol.Required(ATTR_TYPE_VALUE): cv.string,
                vol.Required(ATTR_TYPE_GROUP_ID): cv.string,
                vol.Optional(ATTR_TYPE_NAME, default=""): cv.string,
                vol.Optional(ATTR_VALID_RANGE): cv.string,
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        "create_user_group",
        create_user_group,
        schema=vol.Schema(
            {
                vol.Required(ATTR_DID): cv.string,
                vol.Required(ATTR_TYPE_GROUP_ID): cv.string,
                vol.Required(ATTR_GROUP_NAME): cv.string,
                vol.Optional(ATTR_GROUP_KIND, default="3"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        "delete_user_group",
        delete_user_group,
        schema=vol.Schema(
            {vol.Required(ATTR_DID): cv.string, vol.Required(ATTR_TYPE_GROUP_ID): cv.string}
        ),
    )
    hass.services.async_register(
        DOMAIN,
        "rename_user_group",
        rename_user_group,
        schema=vol.Schema(
            {
                vol.Required(ATTR_DID): cv.string,
                vol.Required(ATTR_TYPE_GROUP_ID): cv.string,
                vol.Required(ATTR_GROUP_NAME): cv.string,
                vol.Optional(ATTR_GROUP_KIND, default="3"): cv.string,
            }
        ),
    )
    _LOGGER.debug("Aqara D100 services registered")


def async_unload_services(hass: HomeAssistant) -> None:
    for name in (
        "unbolt",
        "identify",
        "matter_write",
        "delete_credential",
        "set_credential_validity",
        "create_user_group",
        "delete_user_group",
        "rename_user_group",
    ):
        hass.services.async_remove(DOMAIN, name)
