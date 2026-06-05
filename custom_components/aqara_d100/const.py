"""Constants for the Aqara D100 lock integration.

Reverse-engineered values from the Aqara Home app v6.1.6 (see repo README.md).
All of these are public/owner-recoverable interoperability constants.
"""

from __future__ import annotations

DOMAIN = "aqara_d100"

# ---- Cloud (private Aqara API) -------------------------------------------
# Fixed app credentials for Aqara Home v6.1.6 (exposed via native getSignHead).
APPID = "444c476ef7135e53330f46e7"
APPKEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi"

# Base URL per area. The header literal "area" is the *key* below (e.g. "SEA"),
# while the host depends on the data centre. A VN account lives on SEA → rpc-au.
CLOUD_HOSTS: dict[str, str] = {
    "SEA": "https://rpc-au.aqara.com",
    "CN": "https://rpc.aqara.cn",
    "US": "https://rpc-us.aqara.com",
    "EU": "https://rpc-ger.aqara.com",
    "KR": "https://rpc-kr.aqara.com",
}
API_PREFIX = "/app/v1.0/lumi"

DEFAULT_AREA = "SEA"
DEFAULT_DISTRICT = "VN"

# RSA-1024 public key from LumiDevSDK.getCert() — used to wrap the password.
RSA_N = int(
    "86e3ab25079ef4d77249b3856f8f9715c8ca51f5bf81d85f98254eaa8411186e"
    "212621d5a914fa4eb818a40ecd8570f4b5f4c896ab522b9b126d908086baba88"
    "99152de253faf3c2169449aa1df4b14917f6f9a1f4707f15599d8e6999f90d648"
    "81c83c117693133bd6af2cb66a18895d2866cad9cc11ec32e0700382d077107",
    16,
)
RSA_E = 65537
RSA_K = 128  # 1024-bit modulus = 128 bytes

# ---- Config entry keys ----------------------------------------------------
CONF_EMAIL = "email"
CONF_PASSWORD = "password"
CONF_AREA = "area"
CONF_DISTRICT = "district"
CONF_TOKEN = "token"
CONF_USER_ID = "user_id"
CONF_LOCKS = "locks"

CONF_LOCK_DID = "did"
CONF_LOCK_NAME = "name"
CONF_LOCK_MAC = "mac"
CONF_LOCK_MODEL = "model"

# ---- Behaviour ------------------------------------------------------------
# Cloud is polled for lock_state / battery. Unlock/lock goes out over BLE
# (through an ESPHome Bluetooth proxy near the door) after a cloud handshake.
SCAN_INTERVAL_SECONDS = 60
MANUFACTURER = "Aqara"
DEFAULT_MODEL = "Door Lock D100 (dp1a)"


def normalize_mac(raw: str) -> str:
    """Cloud returns a colon-less MAC (e.g. 'AABBCCDDEEFF'); HA wants 'AA:BB:..'."""
    hexs = "".join(c for c in raw if c in "0123456789abcdefABCDEF").upper()
    if len(hexs) != 12:
        return raw  # leave untouched if it isn't a plain 6-byte MAC
    return ":".join(hexs[i : i + 2] for i in range(0, 12, 2))
