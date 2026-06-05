"""Local-hub (LAN) control path for the Aqara D100 — reverse-engineered protocol.

The lock is Zigbee; it has no IP of its own. When the phone is on the same LAN as the
hub (G410), the official app does NOT hit the cloud — it sends the unlock command
*directly to the hub* over a **ThroughTek (TUTK) PPCS peer-to-peer tunnel**, and the hub
relays it to the lock over Zigbee. This module documents and (partially) implements that
path so a fully-local, internet-independent unlock is possible.

═══════════════════════════════════════════════════════════════════════════════════════
PROTOCOL STACK (top → bottom), all reverse-engineered 2026-06 — see docs/REVERSE_ENGINEERING.md
═══════════════════════════════════════════════════════════════════════════════════════

  ┌─ Layer 1 — Application command ────────────────────────────────────────────────────┐
  │  A Matter DoorLock trait write, identical to the cloud `/matter/write` body:        │
  │     {"2.148.35011.0": ""}   (unlock)   /   {"2.148.35010.0": ""}  (lock)            │
  │  (CommandSpec decoded from the lock's React Native plugin bundle.)                   │
  └─────────────────────────────────────────────────────────────────────────────────────┘
  ┌─ Layer 2 — "lumi" framing ─────────────────────────────────────────────────────────┐
  │     b"lumi"(6c756d69) ‖ type(4B LE) ‖ seq(4B LE) ‖ len(4B LE) ‖ payload             │
  │   • login : type=0x1000, payload = LOGIN_JSON (see below)                            │
  │   • keepalive : type=0x1024, len=0                                                   │
  │   • command : payload = the Matter trait JSON                                        │
  └─────────────────────────────────────────────────────────────────────────────────────┘
  ┌─ Layer 3 — TUTK PPCS P2P tunnel (libPPCS_API.so) ──────────────────────────────────┐
  │  `PPCS_Write(handle, channel, plaintext)` → cs2p2p__P2P_Proprietary_Encrypt(KEY, …) │
  │   → UDP datagrams (wire frames begin 0x28…) to the hub. On the LAN there is NO NAT,  │
  │   so no hole-punching / supernode / relay is involved — just direct UDP to hub:port. │
  │  KEY = the part after ':' in p2p_info().initStringApp  (e.g. "<ppcs-key>").         │
  └─────────────────────────────────────────────────────────────────────────────────────┘

LOGIN_JSON (Layer-2 payload, type 0x1000):
    {"app_public_key": <32B hex, ephemeral X25519 pub>,
     "app_sign":       <from cloud p2p_sign()>,
     "device_id":      <did>,
     "timestamp":      <unix-ms>}

SESSION SETUP (cloud-assisted, like the BLE handshake — cacheable):
    1. info = cloud.p2p_info(did)        # → ppcs key, TUTK DID (p2pId), hub pubkey
    2. (app_pub, app_priv) = x25519_keypair()
    3. sign = cloud.p2p_sign(did, app_pub).["sign"]   # cloud authorises the session
    4. open PPCS tunnel to the hub using info["p2pId"]
    5. PPCS_Write( lumi(0x1000, LOGIN_JSON) )          # authenticate
    6. PPCS_Write( lumi(cmd,    matter_json) )          # e.g. unlock

WHAT THIS MODULE PROVIDES
    • LocalSession dataclass + `prepare_local_session()` — does the cloud half (steps 1-3).
    • `build_lumi_frame()` / `parse_lumi_frame()` — Layer-2 framing (pure, testable).
    • `build_login_payload()` / `build_command_payload()` — the JSON payloads.
WHAT IT DOES NOT (yet)
    • The PPCS transport + `cs2p2p__P2P_Proprietary_Encrypt` cipher (Layer 3). That needs
      the TUTK PPCS library (proprietary) or a reimplementation of its cipher. The key is
      known (from p2p_info); the cipher is the TUTK "Kalay" proprietary one (CVE-2021-28372
      class). A `PpcsTransport` Protocol is defined so a concrete backend can be plugged in.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Protocol

from .cloud import AqaraCloud

LUMI_MAGIC = b"lumi"  # 0x6c756d69

# lumi frame types observed on the wire
LUMI_TYPE_LOGIN = 0x1000
LUMI_TYPE_KEEPALIVE = 0x1024


# --- Layer 2: lumi framing -------------------------------------------------------------
def build_lumi_frame(frame_type: int, payload: bytes, seq: int = 1) -> bytes:
    """b"lumi" ‖ type(LE32) ‖ seq(LE32) ‖ len(LE32) ‖ payload."""
    return (
        LUMI_MAGIC
        + frame_type.to_bytes(4, "little")
        + seq.to_bytes(4, "little")
        + len(payload).to_bytes(4, "little")
        + payload
    )


def parse_lumi_frame(data: bytes) -> tuple[int, int, bytes]:
    """→ (type, seq, payload). Raises ValueError if the magic is wrong."""
    if data[:4] != LUMI_MAGIC:
        raise ValueError(f"not a lumi frame: {data[:8].hex()}")
    frame_type = int.from_bytes(data[4:8], "little")
    seq = int.from_bytes(data[8:12], "little")
    length = int.from_bytes(data[12:16], "little")
    return frame_type, seq, data[16 : 16 + length]


def build_login_payload(app_public_key_hex: str, app_sign: str, did: str) -> bytes:
    """The type-0x1000 login JSON (Layer-2 payload)."""
    return json.dumps(
        {
            "app_public_key": app_public_key_hex,
            "app_sign": app_sign,
            "device_id": did,
            "timestamp": str(int(time.time() * 1000)),
        },
        separators=(",", ":"),
    ).encode()


def build_command_payload(trait: str, value: Any = "") -> bytes:
    """The Matter trait command, same shape as the cloud /matter/write `data`."""
    return json.dumps({trait: value}, separators=(",", ":")).encode()


# --- Cloud-assisted session setup (the implementable half) -----------------------------
@dataclass
class LocalSession:
    """Everything (besides the live X25519 secret) needed to drive the PPCS tunnel."""

    did: str
    ppcs_key: str  # AES key for cs2p2p__P2P_Proprietary_Encrypt, from initStringApp
    init_string: str  # full TUTK init string (before the ':')
    p2p_id: str  # TUTK DID, e.g. "AQARAKR-XXXXXX-XXXXX"
    dev_public_key: str  # hub static X25519 public key
    app_public_key: str  # our ephemeral X25519 public key
    app_sign: str  # cloud-issued authorisation over app_public_key


async def prepare_local_session(
    cloud: AqaraCloud, did: str, app_public_key_hex: str, dev_pwd: str = ""
) -> LocalSession:
    """Do the cloud half of the local handshake (p2p_info + p2p_sign).

    Caller supplies a freshly-generated ephemeral X25519 public key. The result holds the
    PPCS key, the TUTK DID and the cloud-issued `app_sign` — feed these to a PpcsTransport.
    """
    info = await cloud.p2p_info(did)
    init_app = str(info.get("initStringApp", ""))
    init_string, _, ppcs_key = init_app.partition(":")
    signed = await cloud.p2p_sign(did, app_public_key_hex, dev_pwd)
    return LocalSession(
        did=did,
        ppcs_key=ppcs_key,
        init_string=init_string,
        p2p_id=str(info.get("p2pId", "")),
        dev_public_key=str(info.get("devP2pPublicKey", "")),
        app_public_key=app_public_key_hex,
        app_sign=str(signed.get("sign", "")),
    )


# --- Layer 3 transport interface (pluggable; needs a TUTK PPCS backend) ----------------
class PpcsTransport(Protocol):
    """A backend that can open a TUTK PPCS tunnel and write/read lumi frames.

    Implement with the TUTK PPCS SDK (or a reimplementation of cs2p2p__P2P_Proprietary_*).
    `session.ppcs_key` is the cipher key; `session.p2p_id` is the DID to connect to.
    """

    async def connect(self, session: LocalSession) -> None: ...
    async def write(self, payload: bytes) -> None: ...  # raw lumi frame; backend encrypts
    async def read(self, timeout: float = 4.0) -> bytes: ...  # decrypted lumi frame
    async def close(self) -> None: ...


async def local_unlock(transport: PpcsTransport, session: LocalSession, trait: str) -> None:
    """Full local unlock once a PpcsTransport is connected: login, then the command."""
    await transport.connect(session)
    try:
        await transport.write(
            build_lumi_frame(
                LUMI_TYPE_LOGIN,
                build_login_payload(session.app_public_key, session.app_sign, session.did),
            )
        )
        await transport.write(
            build_lumi_frame(0x0001, build_command_payload(trait), seq=2)
        )
    finally:
        await transport.close()
