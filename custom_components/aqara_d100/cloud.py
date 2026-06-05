"""Aqara private cloud client (login + sign + handshake material).

Ported from app/src/cloud/{login,AqaraCloud}.ts and tools/aqara_sign.py.
Pure Python — no native `.so`, no OTP, no x-aes128gcm needed (verified live).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from typing import Any

import aiohttp

from .const import (
    API_PREFIX,
    APPID,
    APPKEY,
    CLOUD_HOSTS,
    DEFAULT_DISTRICT,
    RSA_E,
    RSA_K,
    RSA_N,
)

LOGIN_PATH = "/app/v1.0/lumi/user/guard-code/login"

BASE_HEADERS = {
    "lang": "en",
    "app-version": "6.1.6",
    "phone-model": "RN-D100",
    "sys-type": "1",
    "sys-version": "14",
    "content-type": "application/json; charset=utf-8",
}


class AqaraAuthError(Exception):
    """Raised when the cloud rejects credentials or the session token."""


class AqaraCloudError(Exception):
    """Raised for any other cloud failure."""


def random_nonce() -> str:
    """32 uppercase hex chars, like the app."""
    return secrets.token_hex(16).upper()


def aqara_sign(nonce: str, time_ms: str, token: str, body: str = "") -> str:
    """Reverse-engineered request signature (native Rust getSignHead, 5/5 verified)."""
    pre = f"Appid={APPID}&Nonce={nonce}&Time={time_ms}"
    if token:  # empty token (login) → drop the &Token= segment entirely
        pre += f"&Token={token}"
    if body:
        pre += "&" + body
    pre += "&" + APPKEY
    return hashlib.md5(pre.encode()).hexdigest()


def _rsa_pkcs1_encrypt(msg: bytes) -> bytes:
    """RSA/ECB/PKCS1Padding (type 2) with the constant Lumi cert. Returns 128 bytes."""
    if len(msg) > RSA_K - 11:
        raise ValueError("RSA: message too long")
    ps_len = RSA_K - 3 - len(msg)
    ps = bytearray()
    while len(ps) < ps_len:
        b = os.urandom(1)[0]
        if b != 0:
            ps.append(b)
    em = b"\x00\x02" + bytes(ps) + b"\x00" + msg
    m = int.from_bytes(em, "big")
    c = pow(m, RSA_E, RSA_N)
    return c.to_bytes(RSA_K, "big")


def encrypt_password(password: str) -> str:
    """password field = base64( RSA-PKCS1( ascii of MD5(password) ) )."""
    md5_hex = hashlib.md5(password.encode()).hexdigest()  # 32 lowercase hex
    enc = _rsa_pkcs1_encrypt(md5_hex.encode("ascii"))
    return base64.b64encode(enc).decode("ascii")


async def login_with_password(
    session: aiohttp.ClientSession,
    email: str,
    password: str,
    area: str = "SEA",
    district: str = DEFAULT_DISTRICT,
) -> dict[str, Any]:
    """Email/password login → {token, userId, nickName}. No OTP required."""
    body = json.dumps(
        {
            "account": email,
            "district": district,
            "encryptType": 2,
            "guardCode": "",
            "password": encrypt_password(password),
        },
        separators=(",", ":"),
    )
    nonce = random_nonce()
    time_ms = str(int(time.time() * 1000))
    sign = aqara_sign(nonce, time_ms, token="", body=body)
    host = CLOUD_HOSTS.get(area, area)
    headers = {
        **BASE_HEADERS,
        "appid": APPID,
        "token": "",
        "sign": sign,
        "nonce": nonce,
        "time": time_ms,
        "area": area,
    }
    async with session.post(host + LOGIN_PATH, data=body, headers=headers) as resp:
        text = await resp.text()
    try:
        j = json.loads(text)
    except ValueError as err:
        raise AqaraCloudError(f"login: non-JSON response: {text[:120]}") from err
    if j.get("code") != 0 or not j.get("result", {}).get("token"):
        msg = j.get("message") or text[:120]
        raise AqaraAuthError(f"login failed (code={j.get('code')}): {msg}")
    result = j["result"]
    return {
        "token": result["token"],
        "userId": result.get("userId") or result.get("userInfo", {}).get("userId"),
        "nickName": result.get("userInfo", {}).get("nickName"),
    }


class AqaraCloud:
    """Authenticated client for the private /app/v1.0/lumi API."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        area: str,
        token: str,
        user_id: str,
    ) -> None:
        self._session = session
        self._area = area
        self._base = CLOUD_HOSTS.get(area, area) + API_PREFIX
        self.token = token
        self.user_id = user_id

    def _headers(self, body: str) -> dict[str, str]:
        nonce = random_nonce()
        time_ms = str(int(time.time() * 1000))
        sign = aqara_sign(nonce, time_ms, token=self.token, body=body)
        return {
            **BASE_HEADERS,
            "appid": APPID,
            "userid": self.user_id,
            "token": self.token,
            "nonce": nonce,
            "time": time_ms,
            "area": self._area,
            "sign": sign,
        }

    def _parse(self, text: str, path: str) -> Any:
        try:
            j = json.loads(text)
        except ValueError as err:
            raise AqaraCloudError(f"[{path}] non-JSON: {text[:120]}") from err
        code = j.get("code")
        if code not in (None, 0):
            # 108/auth-style codes → token expired; surface as auth error to trigger re-login.
            if code in (108, 109, 102, 106):
                raise AqaraAuthError(f"[{path}] auth code={code} {j.get('message', '')}")
            raise AqaraCloudError(f"[{path}] code={code} {j.get('message', '')}")
        return j.get("result", j.get("data", j))

    async def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        s = json.dumps(body or {}, separators=(",", ":"))
        async with self._session.post(
            self._base + path, data=s, headers=self._headers(s)
        ) as resp:
            return self._parse(await resp.text(), path)

    async def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        entries = list(query.items()) if query else []
        sign_body = "&".join(f"{k}={v}" for k, v in entries)  # raw query, unencoded
        async with self._session.get(
            self._base + path,
            params={k: str(v) for k, v in entries},
            headers=self._headers(sign_body),
        ) as resp:
            return self._parse(await resp.text(), path)

    # ---- discovery --------------------------------------------------------
    async def list_locks(self, fallback_did: str | None = None) -> list[dict[str, str]]:
        """home/list → device/query per home, filter lock models (lock/aqgl/dp1a)."""
        locks: list[dict[str, str]] = []
        try:
            home = await self.get(
                "/app/position/query/home/list",
                {"needDefaultRoom": "false", "size": 300, "startIndex": 0},
            )
            for h in home.get("homes", []) if isinstance(home, dict) else []:
                pid = h.get("homeId")
                if not pid:
                    continue
                dev = await self.get(
                    "/app/position/device/query",
                    {"positionId": pid, "size": 300, "startIndex": 0},
                )
                devices = (dev.get("devices") or dev.get("data") or []) if isinstance(dev, dict) else []
                for d in devices:
                    model = d.get("model", "")
                    name = d.get("deviceName") or d.get("name") or "D100"
                    if any(tok in model.lower() for tok in ("lock", "aqgl", "dp1a")):
                        locks.append(
                            {"did": d.get("did") or d.get("subjectId"), "name": name, "model": model}
                        )
        except AqaraCloudError:
            pass
        if locks:
            return locks
        if fallback_did:
            return [{"did": fallback_did, "name": "Aqara D100", "model": "aqara.lock.aqgl01"}]
        return []

    # ---- status -----------------------------------------------------------
    async def lock_resources(
        self, did: str, attrs: list[str] | None = None
    ) -> dict[str, str]:
        """res/query → {attr: value} for battery / lock_state / arm / offline."""
        attrs = attrs or [
            "batt_0_remain_percentage",
            "lock_state",
            "arm_state",
            "device_offline_status",
            "low_battery_power",
        ]
        res = await self.post("/res/query", {"data": [{"options": attrs, "subjectId": did}]})
        out: dict[str, str] = {}
        for r in res if isinstance(res, list) else []:
            if "attr" in r:
                out[r["attr"]] = r.get("value")
        return out

    # ---- remote control via cloud (no BLE) -------------------------------
    # Matter DoorLock trait paths "endpoint.function.command.instance" — decoded from
    # the lock's React Native plugin bundle (CommandSpec, endpoint 2 / function 148).
    # ✅ = captured/verified.  ⚠️ = trait id known but value structure NOT captured.
    MATTER_UNLOCK = "2.148.35011.0"  # unlockDoor   ✅ verified live
    MATTER_LOCK = "2.148.35010.0"  # lockDoor       ✅ wired
    MATTER_UNBOLT = "2.148.40031.0"  # unbolt        (empty value, like unlock)
    MATTER_IDENTIFY = "1.131.32918.0"  # identify    (beep/flash — safe test)
    MATTER_SET_USER = "2.148.40032.0"  # setUser     ⚠️ struct value
    MATTER_GET_USER = "2.148.40033.0"  # getUser     ⚠️
    MATTER_CLEAR_USER = "2.148.40034.0"  # clearUser ⚠️
    MATTER_SET_CRED = "2.148.40035.0"  # setCredential        ⚠️ struct value
    MATTER_GET_CRED_STATUS = "2.148.40036.0"  # getCredentialStatus ⚠️
    MATTER_SET_WEEKDAY = "2.148.40025.0"  # setWeekDaySchedule    ⚠️
    MATTER_GET_WEEKDAY = "2.148.40026.0"  # getWeekDaySchedule    ⚠️
    MATTER_CLEAR_WEEKDAY = "2.148.40027.0"  # clearWeekDaySchedule ⚠️
    MATTER_SET_YEARDAY = "2.148.40028.0"  # setYearDaySchedule    ⚠️
    MATTER_GET_YEARDAY = "2.148.40029.0"  # getYearDaySchedule    ⚠️
    MATTER_CLEAR_YEARDAY = "2.148.40030.0"  # clearYearDaySchedule ⚠️

    async def matter_write(self, did: str, trait: str, value: Any = "") -> Any:
        """Write a Matter trait to the lock via the cloud → hub. No BLE needed.

        This is exactly what the Aqara app's lock plugin does (`writeMatterTrait`):
        POST /matter/write {"data":{<trait>:<value>},"did":did,"pwd":"","type":0}.
        The native layer routes it over the local hub (UDP, libsodium) when on-LAN, or
        the cloud otherwise — same command either way. code=0 = accepted.
        """
        return await self.post(
            "/matter/write",
            {"data": {trait: value}, "did": did, "pwd": "", "type": 0},
        )

    async def remote_unlock(self, did: str) -> Any:
        """Unlock the door (Matter unlockDoor 2.148.35011). ✅ verified."""
        return await self.matter_write(did, self.MATTER_UNLOCK)

    async def remote_lock(self, did: str) -> Any:
        """Lock the door (Matter lockDoor 2.148.35010)."""
        return await self.matter_write(did, self.MATTER_LOCK)

    async def remote_unbolt(self, did: str) -> Any:
        """Fully retract the bolt (Matter unbolt 2.148.40031)."""
        return await self.matter_write(did, self.MATTER_UNBOLT)

    async def identify(self, did: str) -> Any:
        """Make the lock beep/flash to locate it (Matter identify)."""
        return await self.matter_write(did, self.MATTER_IDENTIFY)

    # ---- credential & user management (REST mirror; verified live) --------
    # Credential type: 1=fingerprint 2=password 3=NFC 4=eKey/BLE 5=temp-pwd 6=face 7=NFC-tag
    async def lock_credentials(self, did: str) -> list[dict[str, Any]]:
        """List every credential (fingerprint/PIN/NFC/face) registered on the lock."""
        res = await self.get(
            "/dev/lock/query", {"deviceId": did, "types": "[1,2,3,4,5,6,7]"}
        )
        return res if isinstance(res, list) else res.get("data", []) if isinstance(res, dict) else []

    async def lock_groups(self, did: str) -> list[dict[str, Any]]:
        """List the lock's user groups (Me / family members / scheduled …)."""
        res = await self.get("/dev/lock/user/group/info", {"did": did})
        return res if isinstance(res, list) else res.get("data", []) if isinstance(res, dict) else []

    async def lock_history(
        self, did: str, size: int = 50, start_time: int | None = None, end_time: int | None = None
    ) -> dict[str, Any]:
        """Open/close event log (`lock_local_log`) — how HA can see manual opens."""
        now = int(time.time() * 1000)
        return await self.post(
            "/app/lock/res/history/query",
            {
                "attrs": ["lock_local_log"],
                "startTime": str(start_time if start_time is not None else now - 7 * 86400000),
                "endTime": str(end_time if end_time is not None else now),
                "startIndex": "0",
                "size": str(size),
                "subjectId": did,
            },
        )

    async def delete_credential(self, did: str, cred_type: int, type_value: str) -> Any:
        """Remove one credential (PIN/NFC/fingerprint) by type + value."""
        return await self.post(
            "/dev/lock/user/del",
            {"did": did, "typeInfo": [{"type": str(cred_type), "typeValues": [type_value]}]},
        )

    async def update_credential(
        self,
        did: str,
        cred_type: int,
        type_value: str,
        type_group_id: str,
        type_name: str,
        valid_range: str | None = None,
    ) -> Any:
        """Rename a credential and/or set its validity window (disable/enable)."""
        body: dict[str, Any] = {
            "deviceId": did,
            "typeValue": type_value,
            "typeName": type_name,
            "typeGroupId": type_group_id,
            "type": str(cred_type),
        }
        if valid_range:
            body["validRange"] = valid_range
        return await self.post("/dev/lock/update/name", body)

    async def create_user_group(
        self, did: str, group_id: str, group_name: str, type_group: str = "3"
    ) -> Any:
        """Create a user group (type_group: '3'=scheduled, '2'=normal)."""
        return await self.post(
            "/dev/lock/user/group/add",
            {"did": did, "typeGroup": type_group, "typeGroupId": group_id, "typeGroupName": group_name},
        )

    async def delete_user_group(self, did: str, group_id: str) -> Any:
        """Remove a user group from the cloud mirror."""
        return await self.post(
            "/dev/lock/user/group/del", {"did": did, "typeGroupIds": [str(group_id)]}
        )

    async def rename_user_group(
        self, did: str, group_id: str, group_name: str, type_group: str
    ) -> Any:
        """Rename a user group."""
        return await self.post(
            "/dev/lock/user/group/update",
            {"did": did, "typeGroupId": group_id, "typeGroupName": group_name, "typeGroup": type_group},
        )

    # ---- BLE handshake material ------------------------------------------
    async def publickey(self, device_id: str) -> dict[str, str]:
        """{cloudPublicKey, mac}."""
        return await self.post("/dev/bluetooth/login/assure/publickey", {"deviceId": device_id})

    async def verify(self, device_id: str, device_public_key_hex: str) -> dict[str, str]:
        """{sessionKey, nonce, verifyData, mac}."""
        return await self.post(
            "/dev/bluetooth/login/assure/verify",
            {"deviceId": device_id, "devicePublicKey": device_public_key_hex},
        )

    # ---- local hub (TUTK PPCS) session material --------------------------
    # The lock's local channel rides on the doorbell/hub's ThroughTek (TUTK) P2P tunnel.
    # These two calls hand the app everything it needs to open that tunnel — see api/local.py.
    async def p2p_info(self, did: str) -> dict[str, str]:
        """GET p2p/info → {initStringApp:"<tutk-init-string>:<ppcs-key>", devP2pPublicKey, p2pId}.

        `initStringApp` is "<base64-ish init string>:<ppcs aes key>" (e.g. ...:<ppcs-key>) —
        the PPCS proprietary-encrypt key. `p2pId` is the TUTK DID (e.g. AQARAKR-XXXXXX-XXXXX).
        """
        return await self.get("/devex/camera/p2p/info", {"did": did})

    async def p2p_sign(self, did: str, app_public_key_hex: str, dev_pwd: str = "") -> dict[str, str]:
        """POST p2p/sign → {sign, p2pDevPublicKey, time}.

        The cloud signs the app's ephemeral X25519 public key; `sign` is the `app_sign`
        field of the local-session login JSON. (This is why the local path is still
        cloud-assisted — like the BLE handshake, the cloud authorises the session.)
        """
        return await self.post(
            "/devex/camera/p2p/sign",
            {"devPwd": dev_pwd, "did": did, "p2pAppPublicKey": app_public_key_hex},
        )
