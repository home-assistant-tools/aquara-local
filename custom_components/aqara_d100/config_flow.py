"""Config flow: email/password login, then auto-discover every D100 on the account."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .cloud import AqaraAuthError, AqaraCloud, AqaraCloudError, login_with_password
from .const import (
    CLOUD_HOSTS,
    CONF_AREA,
    CONF_DISTRICT,
    CONF_EMAIL,
    CONF_LOCK_DID,
    CONF_LOCK_MAC,
    CONF_LOCK_MODEL,
    CONF_LOCK_NAME,
    CONF_LOCKS,
    CONF_PASSWORD,
    CONF_TOKEN,
    CONF_USER_ID,
    DEFAULT_AREA,
    DEFAULT_DISTRICT,
    DOMAIN,
    normalize_mac,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_EMAIL): str,
        vol.Required(CONF_PASSWORD): str,
        vol.Required(CONF_AREA, default=DEFAULT_AREA): vol.In(sorted(CLOUD_HOSTS)),
        vol.Required(CONF_DISTRICT, default=DEFAULT_DISTRICT): str,
    }
)


class AqaraD100ConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the Aqara D100 config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            session = async_get_clientsession(self.hass)
            try:
                auth = await login_with_password(
                    session,
                    user_input[CONF_EMAIL],
                    user_input[CONF_PASSWORD],
                    area=user_input[CONF_AREA],
                    district=user_input[CONF_DISTRICT],
                )
            except AqaraAuthError:
                errors["base"] = "invalid_auth"
            except AqaraCloudError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error during login")
                errors["base"] = "unknown"
            else:
                await self.async_set_unique_id(str(auth["userId"]))
                self._abort_if_unique_id_configured()

                cloud = AqaraCloud(
                    session,
                    area=user_input[CONF_AREA],
                    token=auth["token"],
                    user_id=auth["userId"],
                )
                try:
                    found = await cloud.list_locks()
                    locks = await self._enrich_with_mac(cloud, found)
                except AqaraCloudError:
                    errors["base"] = "cannot_connect"
                else:
                    if not locks:
                        errors["base"] = "no_locks"
                    else:
                        return self.async_create_entry(
                            title=auth.get("nickName") or user_input[CONF_EMAIL],
                            data={
                                CONF_EMAIL: user_input[CONF_EMAIL],
                                CONF_PASSWORD: user_input[CONF_PASSWORD],
                                CONF_AREA: user_input[CONF_AREA],
                                CONF_DISTRICT: user_input[CONF_DISTRICT],
                                CONF_TOKEN: auth["token"],
                                CONF_USER_ID: auth["userId"],
                                CONF_LOCKS: locks,
                            },
                        )

        return self.async_show_form(
            step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors
        )

    async def _enrich_with_mac(
        self, cloud: AqaraCloud, found: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        """Resolve each lock's BLE MAC via the cloud publickey endpoint."""
        locks: list[dict[str, str]] = []
        for lock in found:
            did = lock.get("did")
            if not did:
                continue
            try:
                pk = await cloud.publickey(did)
                mac = pk.get("mac")
            except AqaraCloudError:
                mac = None
            if not mac:
                _LOGGER.warning("No BLE MAC for lock %s — skipping", did)
                continue
            locks.append(
                {
                    CONF_LOCK_DID: did,
                    CONF_LOCK_NAME: lock.get("name", "Aqara D100"),
                    CONF_LOCK_MAC: normalize_mac(mac),
                    CONF_LOCK_MODEL: lock.get("model", ""),
                }
            )
        return locks
